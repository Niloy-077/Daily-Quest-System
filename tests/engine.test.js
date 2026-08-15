'use strict';

const test = require('node:test');
const assert = require('node:assert');

require('./helpers').useTempDatabase();

const db = require('../src/db');
const engine = require('../src/penalty/engine');
const { expForLevel, rankFor, awardExp } = require('../src/quests');

function makeUser(username) {
    const info = db.prepare(
        'INSERT INTO users (username, password_hash, display_name, created_at) VALUES (?, ?, ?, ?)',
    ).run(username, 'x', username, Date.now());
    return info.lastInsertRowid;
}

function makeQuest(userId, text, category) {
    const info = db.prepare(`
        INSERT INTO quests (user_id, text, category, exp_reward, due_at, status, created_at)
        VALUES (?, ?, ?, 50, ?, 'active', ?)
    `).run(userId, text, category, Date.now() + 1000, Date.now());
    return db.prepare('SELECT * FROM quests WHERE id = ?').get(info.lastInsertRowid);
}

test('categories are inferred from the wording of the quest', () => {
    assert.strictEqual(engine.inferCategory('Read 20 pages of the operating systems book'), 'mind');
    assert.strictEqual(engine.inferCategory('Go to the gym and do a leg workout'), 'body');
    assert.strictEqual(engine.inferCategory('Clean my desk and sleep before midnight'), 'discipline');
    assert.strictEqual(engine.inferCategory('Build the login page for the project'), 'craft');
});

test('the strongest signal wins rather than the first keyword seen', () => {
    // "read" and "study" both point at mind; "training" alone should not win.
    assert.strictEqual(engine.inferCategory('Read and study a paper about training methods'), 'mind');
});

test('an explicit category always beats inference', () => {
    assert.strictEqual(engine.normaliseCategory('body', 'Read 20 pages of a book'), 'body');
    assert.strictEqual(engine.normaliseCategory('nonsense', 'Read 20 pages of a book'), 'mind');
});

test('the penalty matches the category of the quest that was failed', () => {
    const userId = makeUser('categoryplayer');

    const mind = engine.createPenaltyForFailure({ userId, quest: makeQuest(userId, 'Read 20 pages', 'mind') });
    assert.strictEqual(mind.category, 'mind');
    assert.match(mind.task_text, /[Rr]esearch/);

    // A different user, so this is also a first strike rather than an escalation.
    const otherId = makeUser('bodyplayer');
    const body = engine.createPenaltyForFailure({ userId: otherId, quest: makeQuest(otherId, 'Gym session', 'body') });
    assert.strictEqual(body.category, 'body');
    assert.match(body.task_text, /push-ups/);
});

test('repeat failures in the same week escalate in severity', () => {
    const userId = makeUser('repeatplayer');

    const first = engine.createPenaltyForFailure({ userId, quest: makeQuest(userId, 'Read a chapter', 'mind') });
    const second = engine.createPenaltyForFailure({ userId, quest: makeQuest(userId, 'Read a chapter', 'mind') });
    const third = engine.createPenaltyForFailure({ userId, quest: makeQuest(userId, 'Read a chapter', 'mind') });
    const fourth = engine.createPenaltyForFailure({ userId, quest: makeQuest(userId, 'Read a chapter', 'mind') });

    assert.strictEqual(first.severity, 1);
    assert.strictEqual(second.severity, 2);
    assert.strictEqual(third.severity, 3);
    assert.strictEqual(fourth.severity, 3, 'severity is capped at 3');

    assert.ok(second.duration_minutes > first.duration_minutes);
    assert.ok(JSON.parse(second.rules_json).minWords > JSON.parse(first.rules_json).minWords);
});

test('strikes older than the window stop counting', () => {
    const userId = makeUser('coldplayer');
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;

    engine.createPenaltyForFailure({ userId, quest: makeQuest(userId, 'Read', 'mind'), now: eightDaysAgo });
    const fresh = engine.createPenaltyForFailure({ userId, quest: makeQuest(userId, 'Read', 'mind') });

    assert.strictEqual(fresh.severity, 1, 'a stale strike should not escalate today');
});

test('every penalty ships with machine-checkable rules', () => {
    for (const category of engine.CATEGORIES) {
        for (const template of engine.TEMPLATES[category]) {
            const keys = Object.keys(template.rules);
            assert.ok(keys.length > 0, `${category} template has no rules`);
            assert.ok(
                template.requirements.length >= keys.length - 1,
                `${category}: stated requirements should cover the enforced rules`,
            );
        }
    }
});

test('the level curve stays reachable instead of doubling', () => {
    assert.strictEqual(expForLevel(1), 200);
    assert.ok(expForLevel(10) < 4000, `level 10 needs ${expForLevel(10)} EXP — the old curve needed 102400`);
    assert.ok(expForLevel(10) > expForLevel(9));
});

test('rank titles follow level', () => {
    assert.strictEqual(rankFor(1), 'E-Rank');
    assert.strictEqual(rankFor(5), 'D-Rank');
    assert.strictEqual(rankFor(25), 'S-Rank');
});

test('overflow EXP carries into the next level instead of being discarded', () => {
    const userId = makeUser('expplayer');
    const progress = awardExp(userId, 250); // 200 clears level 1, 50 should carry

    assert.strictEqual(progress.level, 2);
    assert.strictEqual(progress.currentExp, 50);
});

test('a single award can clear more than one level', () => {
    const userId = makeUser('bigexpplayer');
    const progress = awardExp(userId, 1000);
    assert.ok(progress.level >= 3, `expected multiple level-ups, got level ${progress.level}`);
});

test('losing EXP empties the bar but never costs a level', () => {
    const userId = makeUser('lossplayer');
    awardExp(userId, 210); // level 2, 10 EXP in
    const progress = awardExp(userId, -25);

    assert.strictEqual(progress.level, 2);
    assert.strictEqual(progress.currentExp, 0);
});
