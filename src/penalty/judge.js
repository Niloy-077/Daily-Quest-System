'use strict';

const crypto = require('crypto');
const db = require('../db');

/**
 * Proof judging.
 *
 * The deterministic rules below are the judge. They need no API key and no
 * network, so the System behaves identically on a laptop with no internet as
 * it does in production — which matters, because a lock that fails open when
 * a network call fails is not a lock.
 *
 * An AI reviewer can be layered on top when ANTHROPIC_API_KEY is set. It is
 * strictly a second opinion with veto power: it can REJECT something the rules
 * passed, but it can never approve something they failed.
 */

const MIN_FILE_BYTES = 4 * 1024;
const MAX_FILE_BYTES = 12 * 1024 * 1024;
const ATTEMPT_COOLDOWN_MS = 60 * 1000;
// Padding guard: fewer than this share of distinct words means the same few
// words are being repeated to pad a word count.
const MIN_DISTINCT_WORD_RATIO = 0.32;

const URL_RE = /https?:\/\/[^\s<>"')]+/gi;
const SOURCE_LINE_RE = /^\s*(?:source|ref|reference|from|citation|book|paper)\s*[:\-–]\s*\S+/gim;

const stmt = {
    lastAttempt: db.prepare(
        'SELECT submitted_at FROM submissions WHERE penalty_id = ? ORDER BY submitted_at DESC LIMIT 1',
    ),
    hashSeen: db.prepare(
        'SELECT penalty_id FROM submissions WHERE sha256 = ? LIMIT 1',
    ),
    notesSeen: db.prepare(
        `SELECT id FROM submissions
         WHERE user_id = ? AND (penalty_id IS NULL OR penalty_id != ?) AND notes = ? LIMIT 1`,
    ),
};

// --- text analysis ----------------------------------------------------------

function words(text) {
    return String(text || '').toLowerCase().match(/[a-z0-9'’-]+/g) || [];
}

function countWords(text) {
    return words(text).length;
}

function sentences(text) {
    return String(text || '')
        .split(/(?<=[.!?])\s+|\n+/)
        .map((s) => s.trim())
        .filter(Boolean);
}

/**
 * A "concrete fact" is a sentence carrying a number — a quantity, date, year,
 * measurement or count.
 *
 * Deliberately a narrow, mechanical definition. It cannot judge whether a
 * claim is true, but it does separate "I learned about the water cycle" from
 * "roughly 505,000 km³ of water cycles through the atmosphere each year",
 * which is the difference the penalty is actually asking for.
 */
function countFacts(text) {
    return sentences(text).filter((s) => /\d/.test(s) && countWords(s) >= 4).length;
}

/** Sources: distinct URLs plus explicitly labelled "Source: ..." lines. */
function countSources(text) {
    const body = String(text || '');
    const urls = new Set((body.match(URL_RE) || []).map((u) => u.replace(/[.,;]+$/, '').toLowerCase()));
    const labelled = (body.match(SOURCE_LINE_RE) || []).length;
    return urls.size + labelled;
}

/** Share of words that are distinct — low means copy-paste padding. */
function distinctWordRatio(text) {
    const all = words(text);
    if (all.length < 25) return 1;
    return new Set(all).size / all.length;
}

// --- file analysis ----------------------------------------------------------

/**
 * Identify a file from its leading bytes rather than its name or its
 * Content-Type, both of which the client controls. Renaming `notes.txt` to
 * `proof.jpg` does not get past this.
 */
function sniffFileKind(buffer) {
    if (!buffer || buffer.length < 12) return 'unknown';

    const hex = buffer.subarray(0, 12).toString('hex').toLowerCase();
    const ascii = buffer.subarray(0, 12).toString('latin1');

    if (hex.startsWith('ffd8ff')) return 'image';                       // JPEG
    if (hex.startsWith('89504e470d0a1a0a')) return 'image';             // PNG
    if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) return 'image';
    if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') return 'image';
    if (ascii.slice(4, 8) === 'ftyp') {
        const brand = ascii.slice(8, 12);
        // HEIC/AVIF stills vs. MP4/MOV video containers.
        return /heic|heix|hevc|mif1|avif/i.test(brand) ? 'image' : 'video';
    }
    if (hex.startsWith('1a45dfa3')) return 'video';                     // Matroska / WebM
    if (hex.startsWith('25504446')) return 'document';                  // PDF
    if (hex.startsWith('504b0304')) return 'document';                  // docx/xlsx/zip
    if (hex.startsWith('d0cf11e0')) return 'document';                  // legacy Office
    return 'unknown';
}

function sha256Of(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * JPEG DateTimeOriginal, when the camera wrote one.
 *
 * Best-effort by design: most images arriving from a phone screenshot or a
 * messaging app have had EXIF stripped, so a missing date is normal and never
 * counts against the player. A date that *is* present and predates the penalty
 * is a genuine signal that an old photo is being recycled.
 */
function exifDateTimeOriginal(buffer) {
    if (!buffer || buffer.length < 4 || buffer.readUInt16BE(0) !== 0xffd8) return null;

    // Scan only the header region where EXIF lives, not the whole image.
    const region = buffer.subarray(0, Math.min(buffer.length, 128 * 1024)).toString('latin1');
    const match = region.match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
    if (!match) return null;

    const [, y, mo, d, h, mi, s] = match.map(Number);
    if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;

    // EXIF timestamps carry no zone. Read as UTC and allow a generous margin
    // at the comparison site rather than guessing the camera's offset.
    return Date.UTC(y, mo - 1, d, h, mi, s);
}

// --- the judge --------------------------------------------------------------

/** Milliseconds still to wait before another attempt is allowed, or 0. */
function cooldownRemaining(penaltyId, now = Date.now()) {
    const last = stmt.lastAttempt.get(penaltyId);
    if (!last) return 0;
    return Math.max(0, ATTEMPT_COOLDOWN_MS - (now - last.submitted_at));
}

/**
 * Check a submission against the rules frozen onto the penalty at creation.
 *
 * Returns every unmet requirement at once, not just the first, so the player
 * gets one honest list instead of discovering the bar one attempt at a time.
 */
function evaluate({ penalty, notes, file, now = Date.now() }) {
    const rules = JSON.parse(penalty.rules_json);
    const unmet = [];
    const text = String(notes || '');

    // --- written notes ---
    if (rules.minWords) {
        const n = countWords(text);
        if (n < rules.minWords) {
            unmet.push(`Notes are ${n} words; ${rules.minWords} required.`);
        } else if (distinctWordRatio(text) < MIN_DISTINCT_WORD_RATIO) {
            unmet.push('Notes look padded — the same few words repeat throughout.');
        }
    }

    if (rules.minFacts) {
        const n = countFacts(text);
        if (n < rules.minFacts) {
            unmet.push(
                `Found ${n} concrete fact${n === 1 ? '' : 's'}; ${rules.minFacts} required. ` +
                'A concrete fact is a sentence containing a number, date or measurement.',
            );
        }
    }

    if (rules.minSources) {
        const n = countSources(text);
        if (n < rules.minSources) {
            unmet.push(
                `Found ${n} source${n === 1 ? '' : 's'}; ${rules.minSources} required. ` +
                'List a URL, or a line starting with "Source: ".',
            );
        }
    }

    // --- attached file ---
    if (rules.requireFile) {
        if (!file) {
            unmet.push('No file attached. This penalty requires evidence you can point at.');
        } else {
            const kind = sniffFileKind(file.buffer);

            if (file.buffer.length < MIN_FILE_BYTES) {
                unmet.push(`Attached file is only ${file.buffer.length} bytes — too small to be real evidence.`);
            }

            if (rules.fileKind === 'image' && kind !== 'image' && kind !== 'video') {
                unmet.push(`Attached file is not a photo or video (detected: ${kind}).`);
            } else if (kind === 'unknown') {
                unmet.push('Attached file is not a recognised image, video or document.');
            }

            const seen = stmt.hashSeen.get(file.sha256);
            if (seen && seen.penalty_id !== penalty.id) {
                unmet.push('This exact file has already been submitted as proof before.');
            }

            const shotAt = exifDateTimeOriginal(file.buffer);
            // 26h of slack absorbs the unknown camera timezone (max real-world
            // offset is 14h) plus a little clock drift.
            if (shotAt !== null && shotAt < penalty.created_at - 26 * 60 * 60 * 1000) {
                unmet.push('Photo metadata says it was taken before this penalty was issued.');
            }
        }
    }

    // --- recycled writing ---
    if (text.trim().length > 0) {
        const reused = stmt.notesSeen.get(penalty.user_id, penalty.id, text);
        if (reused) unmet.push('These notes were already submitted before.');
    }

    return {
        verdict: unmet.length === 0 ? 'approved' : 'rejected',
        unmet,
        judgedBy: 'rules',
        confidence: 1,
        reasoning: unmet.length === 0
            ? 'All stated requirements were met.'
            : `${unmet.length} requirement${unmet.length === 1 ? '' : 's'} not met.`,
    };
}

/**
 * Optional AI review, run only after the rules have already passed.
 *
 * Catches what counting cannot: notes that hit every threshold while being
 * irrelevant to the task, or a photo that is real but shows nothing related.
 * Any failure here — no key, network down, bad response, low confidence —
 * leaves the deterministic verdict untouched, so the AI is never a dependency.
 */
async function aiReview({ penalty, notes, file }) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return null;

    const requirements = JSON.parse(penalty.requirements_json);
    const content = [{
        type: 'text',
        text:
            `You are reviewing evidence that someone completed a penalty task.\n\n` +
            `TASK: ${penalty.task_text}\n\n` +
            `REQUIREMENTS:\n${requirements.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n\n` +
            `SUBMITTED NOTES:\n"""\n${String(notes || '').slice(0, 6000)}\n"""\n\n` +
            `Automated checks already confirmed the counts (words, facts, sources, file type).\n` +
            `Judge only what counting cannot: is this evidence genuinely about the task, ` +
            `and is it real work rather than filler that happens to hit the numbers?\n\n` +
            `Reply with JSON only: {"verdict":"approved"|"rejected","confidence":0.0-1.0,` +
            `"reasoning":"one sentence","unmet":["..."]}`,
    }];

    if (file && sniffFileKind(file.buffer) === 'image' && file.buffer.length < 5 * 1024 * 1024) {
        content.push({
            type: 'image',
            source: { type: 'base64', media_type: file.mime, data: file.buffer.toString('base64') },
        });
    }

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
                max_tokens: 512,
                messages: [{ role: 'user', content }],
            }),
            signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!response.ok) {
            console.warn('[judge] AI review unavailable (HTTP %d) — rules verdict stands.', response.status);
            return null;
        }

        const payload = await response.json();
        const raw = (payload.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
        const parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));

        return {
            verdict: parsed.verdict === 'approved' ? 'approved' : 'rejected',
            confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
            reasoning: String(parsed.reasoning || '').slice(0, 500),
            unmet: Array.isArray(parsed.unmet) ? parsed.unmet.map(String).slice(0, 6) : [],
        };
    } catch (err) {
        console.warn('[judge] AI review failed (%s) — rules verdict stands.', err.message);
        return null;
    }
}

/**
 * Full judgement: rules first, then the optional AI veto.
 */
async function judge({ penalty, notes, file, now = Date.now() }) {
    const base = evaluate({ penalty, notes, file, now });
    if (base.verdict === 'rejected') return base;

    const ai = await aiReview({ penalty, notes, file });
    if (!ai) return base;

    if (ai.verdict === 'rejected') {
        return {
            verdict: 'rejected',
            unmet: ai.unmet.length ? ai.unmet : ['The evidence does not appear to match the task.'],
            judgedBy: 'rules+ai',
            confidence: ai.confidence,
            reasoning: ai.reasoning || 'AI review rejected the submission.',
        };
    }

    return { ...base, judgedBy: 'rules+ai', confidence: ai.confidence, reasoning: ai.reasoning || base.reasoning };
}

module.exports = {
    MIN_FILE_BYTES,
    MAX_FILE_BYTES,
    ATTEMPT_COOLDOWN_MS,
    MIN_DISTINCT_WORD_RATIO,
    countWords,
    countFacts,
    countSources,
    distinctWordRatio,
    sniffFileKind,
    sha256Of,
    exifDateTimeOriginal,
    cooldownRemaining,
    evaluate,
    aiReview,
    judge,
};
