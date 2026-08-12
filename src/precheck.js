'use strict';

const db = require('./db');
const judge = require('./penalty/judge');

/**
 * The automated pre-check.
 *
 * This does NOT decide anything. It runs the deterministic rules over a
 * submission and hands the admin a verdict to lean on — obvious passes and
 * obvious junk get flagged so a human is not reading every word of a
 * three-line "trust me". The admin always makes the final call in the
 * dashboard; a later phase can hand that call to an AI, and this same
 * pre-check becomes its first-pass filter.
 *
 * Two kinds of evidence go through it:
 *   - penalty proof, judged against the penalty's frozen rules
 *   - quest-completion proof, which has no fixed rule set (the player wrote
 *     the quest), so it is judged for basic plausibility and anti-replay only
 */

const MIN_QUEST_WORDS = 15;

const stmt = {
    hashSeen: db.prepare('SELECT id FROM submissions WHERE sha256 = ? LIMIT 1'),
};

/** Advisory pre-check for penalty proof. Wraps the deterministic judge. */
function forPenalty({ penalty, notes, file }) {
    const result = judge.evaluate({ penalty, notes, file });
    return {
        pass: result.verdict === 'approved',
        summary: result.reasoning,
        reasons: result.unmet,
    };
}

/**
 * Advisory pre-check for quest-completion proof.
 *
 * A player-authored quest has no machine-checkable target, so this only
 * catches the cheap fakes: empty evidence, a mistyped file, a recycled file.
 * Everything subtler is the admin's judgement.
 */
function forQuest({ notes, file, userId }) {
    const reasons = [];
    const text = String(notes || '');
    const wordCount = (text.toLowerCase().match(/[a-z0-9'’-]+/g) || []).length;

    const hasFile = !!(file && file.buffer && file.buffer.length > 0);

    if (wordCount < MIN_QUEST_WORDS && !hasFile) {
        reasons.push(`Only ${wordCount} words and no file — thin evidence for a completed quest.`);
    }

    if (hasFile) {
        const kind = judge.sniffFileKind(file.buffer);
        if (kind === 'unknown') {
            reasons.push('Attached file is not a recognised image, video or document.');
        }
        if (file.buffer.length < judge.MIN_FILE_BYTES) {
            reasons.push(`Attached file is only ${file.buffer.length} bytes — too small to be real evidence.`);
        }
        const seen = stmt.hashSeen.get(file.sha256);
        if (seen) reasons.push('This exact file has already been submitted before.');
    }

    return {
        pass: reasons.length === 0,
        summary: reasons.length === 0
            ? 'Evidence present and looks genuine.'
            : `${reasons.length} thing${reasons.length === 1 ? '' : 's'} for the agent to check.`,
        reasons,
    };
}

module.exports = { forPenalty, forQuest, MIN_QUEST_WORDS };
