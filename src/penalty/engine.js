'use strict';

const db = require('../db');

/**
 * Penalty generation.
 *
 * The old build drew from one flat pool at random, so failing "read 20 pages"
 * could hand you five push-ups. Here every quest carries a category, and the
 * penalty is drawn from the matching pool and scaled by how many strikes the
 * player has taken in the last seven days.
 */

const CATEGORIES = ['mind', 'body', 'discipline', 'craft'];
const DEFAULT_CATEGORY = 'discipline';

const STRIKE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const EXP_PENALTY = 25;
const MAX_SEVERITY = 3;

// Keyword hints used when the player does not pick a category themselves.
const CATEGORY_HINTS = {
    mind: ['study', 'read', 'learn', 'revise', 'lecture', 'course', 'chapter', 'note',
        'research', 'exam', 'assignment', 'math', 'theory', 'book', 'paper', 'solve'],
    body: ['train', 'run', 'gym', 'workout', 'exercise', 'push', 'pull', 'squat', 'walk',
        'jog', 'cycle', 'swim', 'stretch', 'yoga', 'cardio', 'lift', 'sport'],
    discipline: ['sleep', 'wake', 'clean', 'tidy', 'habit', 'water', 'meditat', 'journal',
        'budget', 'organis', 'organiz', 'laundry', 'dish', 'screen', 'phone', 'fast'],
    craft: ['build', 'write', 'design', 'code', 'project', 'draw', 'practice', 'compose',
        'record', 'edit', 'ship', 'prototype', 'debug', 'refactor'],
};

/**
 * Guess a category from the wording of a quest.
 *
 * Only a fallback — an explicit category from the player always wins. Scores
 * every pool and takes the best, so "read about training" lands on mind (two
 * hints) rather than on whichever keyword happened to appear first.
 */
function inferCategory(text) {
    const haystack = String(text || '').toLowerCase();
    let best = DEFAULT_CATEGORY;
    let bestScore = 0;

    for (const category of CATEGORIES) {
        let score = 0;
        for (const hint of CATEGORY_HINTS[category]) {
            if (haystack.includes(hint)) score += 1;
        }
        if (score > bestScore) {
            bestScore = score;
            best = category;
        }
    }
    return best;
}

function normaliseCategory(category, questText) {
    if (typeof category === 'string' && CATEGORIES.includes(category.toLowerCase())) {
        return category.toLowerCase();
    }
    return inferCategory(questText);
}

/**
 * Penalty templates, indexed by category then severity (1-3).
 *
 * `requirements` is what the player is shown. `rules` is the same bar
 * expressed so a machine can check it — the two are written side by side on
 * purpose, so the stated requirement and the enforced one cannot drift apart.
 */
const TEMPLATES = {
    mind: [
        {
            task: 'Research one subject you do not already know for 10 minutes, then write up what you learned.',
            durationMinutes: 10,
            proofKind: 'notes',
            requirements: [
                'Write at least 150 words of your own notes.',
                'State at least 3 concrete facts (numbers, dates, names or definitions).',
                'List at least 2 sources — a URL, book title or paper title each.',
            ],
            rules: { minWords: 150, minFacts: 3, minSources: 2 },
        },
        {
            task: 'Research a subject for 20 minutes and write a summary you could teach from.',
            durationMinutes: 20,
            proofKind: 'notes',
            requirements: [
                'Write at least 300 words of your own notes.',
                'State at least 5 concrete facts (numbers, dates, names or definitions).',
                'List at least 3 sources.',
                'End with a short paragraph explaining the idea in your own words.',
            ],
            rules: { minWords: 300, minFacts: 5, minSources: 3 },
        },
        {
            task: 'Study one topic for 40 minutes, write it up, and photograph your handwritten notes.',
            durationMinutes: 40,
            proofKind: 'image_and_notes',
            requirements: [
                'Write at least 400 words of your own notes.',
                'State at least 6 concrete facts.',
                'List at least 3 sources.',
                'Attach a photo of the handwritten notes you made while studying.',
            ],
            rules: {
                minWords: 400, minFacts: 6, minSources: 3,
                requireFile: true, fileKind: 'image',
            },
        },
    ],
    body: [
        {
            task: 'Perform 30 push-ups in one session.',
            durationMinutes: 5,
            proofKind: 'image_and_notes',
            requirements: [
                'Attach a photo or video taken today showing the set.',
                'Write at least 40 words: how many sets, how it felt, where you did it.',
            ],
            rules: { minWords: 40, requireFile: true, fileKind: 'image' },
        },
        {
            task: 'Perform 50 push-ups and hold a 90-second plank.',
            durationMinutes: 12,
            proofKind: 'image_and_notes',
            requirements: [
                'Attach a photo or video taken today showing the work.',
                'Write at least 80 words describing the sets, rest gaps and how it felt.',
                'State at least 2 concrete numbers (sets, reps, times).',
            ],
            rules: { minWords: 80, minFacts: 2, requireFile: true, fileKind: 'image' },
        },
        {
            task: 'Complete a 30-minute training session: warm-up, main work, cool-down.',
            durationMinutes: 30,
            proofKind: 'image_and_notes',
            requirements: [
                'Attach a photo or video taken today from the session.',
                'Write at least 120 words logging every block of the session.',
                'State at least 4 concrete numbers (durations, reps, distances).',
            ],
            rules: { minWords: 120, minFacts: 4, requireFile: true, fileKind: 'image' },
        },
    ],
    discipline: [
        {
            task: 'Clean and reset one space you have been ignoring — a desk, a shelf, a room.',
            durationMinutes: 15,
            proofKind: 'image_and_notes',
            requirements: [
                'Attach an "after" photo of the space taken today.',
                'Write at least 50 words on what state it was in and what you actually did.',
            ],
            rules: { minWords: 50, requireFile: true, fileKind: 'image' },
        },
        {
            task: 'Clean and reset one space, then plan tomorrow in writing before you sleep.',
            durationMinutes: 25,
            proofKind: 'image_and_notes',
            requirements: [
                'Attach an "after" photo of the space taken today.',
                'Write at least 100 words: what you cleaned, plus tomorrow\'s plan.',
                'List at least 3 concrete things you will do tomorrow, with times.',
            ],
            rules: { minWords: 100, minFacts: 3, requireFile: true, fileKind: 'image' },
        },
        {
            task: 'Reset your whole working environment and write an honest review of the habit you keep dropping.',
            durationMinutes: 40,
            proofKind: 'image_and_notes',
            requirements: [
                'Attach a photo of the finished space taken today.',
                'Write at least 200 words on the habit: when it breaks, what triggers it.',
                'State at least 3 concrete changes you will make, each with a time or number.',
            ],
            rules: { minWords: 200, minFacts: 3, requireFile: true, fileKind: 'image' },
        },
    ],
    craft: [
        {
            task: 'Spend 15 minutes on deliberate practice of your craft, and keep what you produce.',
            durationMinutes: 15,
            proofKind: 'image_and_notes',
            requirements: [
                'Attach the artifact — a screenshot, photo or export of what you made.',
                'Write at least 60 words on what you practised and what went wrong.',
            ],
            rules: { minWords: 60, requireFile: true },
        },
        {
            task: 'Spend 30 minutes building or writing something small, start to finish.',
            durationMinutes: 30,
            proofKind: 'image_and_notes',
            requirements: [
                'Attach the artifact you produced.',
                'Write at least 120 words: what you set out to do, what you got, what broke.',
                'State at least 2 concrete details (file names, line counts, word counts, times).',
            ],
            rules: { minWords: 120, minFacts: 2, requireFile: true },
        },
        {
            task: 'Spend 45 minutes shipping one finished small piece of work, then review it in writing.',
            durationMinutes: 45,
            proofKind: 'image_and_notes',
            requirements: [
                'Attach the artifact you produced.',
                'Write at least 200 words covering the work and an honest self-review.',
                'State at least 4 concrete details.',
                'Name at least 1 thing you would do differently next time.',
            ],
            rules: { minWords: 200, minFacts: 4, requireFile: true },
        },
    ],
};

const stmt = {
    recentStrikes: db.prepare(
        'SELECT COUNT(*) AS n FROM strikes WHERE user_id = ? AND created_at >= ?',
    ),
    insertStrike: db.prepare(
        'INSERT INTO strikes (user_id, quest_id, category, created_at) VALUES (?, ?, ?, ?)',
    ),
    insertPenalty: db.prepare(`
        INSERT INTO penalties
            (user_id, origin_quest_id, task_text, category, duration_minutes, proof_kind,
             requirements_json, rules_json, severity, status, created_at)
        VALUES (@user_id, @origin_quest_id, @task_text, @category, @duration_minutes, @proof_kind,
                @requirements_json, @rules_json, @severity, 'pending', @created_at)
    `),
    penaltyById: db.prepare('SELECT * FROM penalties WHERE id = ?'),
};

/** Strikes in the trailing 7 days, which is what drives escalation. */
function recentStrikeCount(userId, now = Date.now()) {
    return stmt.recentStrikes.get(userId, now - STRIKE_WINDOW_MS).n;
}

/**
 * Severity 1-3, from the strike count *including* the one being recorded now.
 * First failure of the week is severity 1; the third and beyond are severity 3.
 */
function severityFor(strikeCount) {
    return Math.min(MAX_SEVERITY, Math.max(1, strikeCount));
}

/**
 * Record a strike and open the matching penalty.
 *
 * Callers run this inside the same transaction that marks the quest failed, so
 * a quest can never end up failed without a penalty attached to it.
 */
function createPenaltyForFailure({ userId, quest, now = Date.now() }) {
    const category = normaliseCategory(quest.category, quest.text);

    stmt.insertStrike.run(userId, quest.id, category, now);
    const severity = severityFor(recentStrikeCount(userId, now));

    const template = TEMPLATES[category][severity - 1];

    const info = stmt.insertPenalty.run({
        user_id: userId,
        origin_quest_id: quest.id,
        task_text: template.task,
        category,
        duration_minutes: template.durationMinutes,
        proof_kind: template.proofKind,
        requirements_json: JSON.stringify(template.requirements),
        // Frozen at creation: the bar cannot be renegotiated at judging time.
        rules_json: JSON.stringify(template.rules),
        severity,
        created_at: now,
    });

    return stmt.penaltyById.get(info.lastInsertRowid);
}

module.exports = {
    CATEGORIES,
    DEFAULT_CATEGORY,
    EXP_PENALTY,
    STRIKE_WINDOW_MS,
    MAX_SEVERITY,
    TEMPLATES,
    inferCategory,
    normaliseCategory,
    recentStrikeCount,
    severityFor,
    createPenaltyForFailure,
};
