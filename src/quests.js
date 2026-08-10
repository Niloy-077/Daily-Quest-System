'use strict';

const db = require('./db');
const { endOfLocalDay, safeZone } = require('./time');
const { normaliseCategory, createPenaltyForFailure, EXP_PENALTY } = require('./penalty/engine');

const QUEST_EXP = 50;
const MAX_QUEST_LENGTH = 200;
const MAX_ACTIVE_QUESTS = 20;

const RANKS = [
    { from: 25, title: 'S-Rank' },
    { from: 20, title: 'A-Rank' },
    { from: 15, title: 'B-Rank' },
    { from: 10, title: 'C-Rank' },
    { from: 5, title: 'D-Rank' },
    { from: 1, title: 'E-Rank' },
];

/**
 * EXP needed to clear a level.
 *
 * The old build doubled the requirement each level, so level 10 needed 102,400
 * EXP — 2,048 quests — and the game quietly became unplayable. A 1.35x curve
 * keeps level 10 at roughly 3,200 and still slows down sensibly.
 */
function expForLevel(level) {
    return Math.round(200 * 1.35 ** (level - 1));
}

function rankFor(level) {
    return (RANKS.find((r) => level >= r.from) || RANKS[RANKS.length - 1]).title;
}

const stmt = {
    insert: db.prepare(`
        INSERT INTO quests (user_id, text, category, exp_reward, due_at, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?)
    `),
    byId: db.prepare('SELECT * FROM quests WHERE id = ?'),
    activeForUser: db.prepare(
        "SELECT * FROM quests WHERE user_id = ? AND status = 'active' ORDER BY due_at ASC, id ASC",
    ),
    recentForUser: db.prepare(`
        SELECT * FROM quests WHERE user_id = ? AND status != 'active'
        ORDER BY COALESCE(completed_at, created_at) DESC LIMIT 20
    `),
    countActive: db.prepare("SELECT COUNT(*) AS n FROM quests WHERE user_id = ? AND status = 'active'"),
    markFailed: db.prepare(
        "UPDATE quests SET status = 'failed', completed_at = ? WHERE id = ? AND status = 'active'",
    ),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    updateProgress: db.prepare(`
        UPDATE users SET level = ?, current_exp = ?, max_exp = ?, rank_title = ?,
                         stat_str = ?, stat_int = ?, stat_vit = ?
        WHERE id = ?
    `),
};

function createQuest({ userId, text, category, timezone, dueAt, now = Date.now() }) {
    const trimmed = String(text || '').trim();
    if (!trimmed) throw Object.assign(new Error('Quest text is required.'), { status: 400 });
    if (trimmed.length > MAX_QUEST_LENGTH) {
        throw Object.assign(new Error(`Quest text must be under ${MAX_QUEST_LENGTH} characters.`), { status: 400 });
    }
    if (stmt.countActive.get(userId).n >= MAX_ACTIVE_QUESTS) {
        throw Object.assign(new Error(`You cannot hold more than ${MAX_ACTIVE_QUESTS} active quests.`), { status: 400 });
    }

    // Default deadline is the end of the player's own day. A quest accepted at
    // 23:50 is due in ten minutes, which is the intended pressure.
    let deadline = Number(dueAt);
    if (!Number.isFinite(deadline) || deadline <= now) {
        deadline = endOfLocalDay(now, safeZone(timezone));
    }

    const info = stmt.insert.run(
        userId,
        trimmed,
        normaliseCategory(category, trimmed),
        QUEST_EXP,
        deadline,
        now,
    );
    return stmt.byId.get(info.lastInsertRowid);
}

/**
 * Award EXP and roll any level-ups.
 *
 * Overflow carries into the next level instead of being discarded — the old
 * build reset current EXP to zero on level-up, so finishing a quest that
 * overshot the threshold silently burned the excess.
 */
function awardExp(userId, amount) {
    const user = stmt.userById.get(userId);

    let { level, max_exp: maxExp } = user;
    let exp = user.current_exp + amount;
    let { stat_str: str, stat_int: int, stat_vit: vit } = user;
    let levelsGained = 0;

    while (exp >= maxExp) {
        exp -= maxExp;
        level += 1;
        levelsGained += 1;
        str += 1;
        int += 2;
        vit += 1;
        maxExp = expForLevel(level);
    }

    // Losing EXP can empty the bar but never costs a level.
    if (exp < 0) exp = 0;

    const rank = rankFor(level);
    stmt.updateProgress.run(level, exp, maxExp, rank, str, int, vit, userId);

    return { levelsGained, level, currentExp: exp, maxExp, rank, stats: { str, int, vit } };
}

/**
 * Fail a quest, deduct EXP, record a strike and open the matching penalty.
 *
 * One transaction, so a failed quest without a penalty attached is not a state
 * the database can be left in.
 */
function failQuest({ userId, questId, now = Date.now() }) {
    const quest = stmt.byId.get(questId);
    if (!quest || quest.user_id !== userId) {
        throw Object.assign(new Error('Quest not found.'), { status: 404 });
    }
    if (quest.status !== 'active') {
        throw Object.assign(new Error('That quest is already resolved.'), { status: 409 });
    }

    const run = db.transaction(() => {
        const changed = stmt.markFailed.run(now, questId).changes;
        if (changed === 0) return null;
        const progress = awardExp(userId, -EXP_PENALTY);
        const penalty = createPenaltyForFailure({ userId, quest, now });
        return { progress, penalty };
    });

    const result = run();
    if (!result) throw Object.assign(new Error('That quest is already resolved.'), { status: 409 });

    return { quest: { ...quest, status: 'failed', completed_at: now }, ...result };
}

function serialiseQuest(quest) {
    return {
        id: quest.id,
        text: quest.text,
        category: quest.category,
        expReward: quest.exp_reward,
        manaReward: quest.mana_reward,
        dueAt: quest.due_at,
        status: quest.status,
        createdAt: quest.created_at,
        completedAt: quest.completed_at,
    };
}

module.exports = {
    QUEST_EXP,
    MAX_QUEST_LENGTH,
    MAX_ACTIVE_QUESTS,
    expForLevel,
    rankFor,
    createQuest,
    awardExp,
    failQuest,
    serialiseQuest,
    listActive: (userId) => stmt.activeForUser.all(userId),
    listRecent: (userId) => stmt.recentForUser.all(userId),
};
