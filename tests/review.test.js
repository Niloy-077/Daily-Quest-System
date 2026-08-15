'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
    useTempDatabase, startTestServer, json, GOOD_MIND_NOTES,
    promoteToAdmin, pngBuffer, proofBody,
} = require('./helpers');
useTempDatabase();

const db = require('../src/db');

let server;
test.before(async () => { server = await startTestServer(); });
test.after(async () => { if (server) await server.close(); });

async function registerPlayer(username) {
    const client = server.client();
    const res = await client('/api/auth/register', json({
        username, password: 'correcthorsebattery', displayName: username, timezone: 'Asia/Dhaka',
    }));
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return client;
}

/** Register an account, promote it to admin, return a logged-in admin client. */
async function makeAdmin(username) {
    const client = await registerPlayer(username);
    promoteToAdmin(username);
    // Re-login so req.user reflects the new role on subsequent requests.
    await client('/api/auth/logout', { method: 'POST' });
    const res = await client('/api/auth/login', json({ username, password: 'correcthorsebattery' }));
    assert.strictEqual(res.status, 200);
    return client;
}

async function addQuest(client, text, category) {
    const res = await client('/api/quests', json({ text, category }));
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return res.body.quest.id;
}

async function failAQuest(client) {
    const id = await addQuest(client, 'Read 20 pages of the OS book', 'mind');
    const res = await client(`/api/quests/${id}/fail`, { method: 'POST' });
    assert.strictEqual(res.status, 423);
    return res.body;
}

// ---------------------------------------------------------------------------
// roles & authorisation
// ---------------------------------------------------------------------------

test('a new account is a player with zero mana', async () => {
    const client = await registerPlayer('roleplayer');
    const res = await client('/api/auth/me');
    assert.strictEqual(res.body.player.role, 'player');
    assert.strictEqual(res.body.player.mana, 0);
});

test('players cannot reach the review queue; admins can', async () => {
    const player = await registerPlayer('nosy');
    const asPlayer = await player('/api/admin/review');
    assert.strictEqual(asPlayer.status, 403);

    const admin = await makeAdmin('agent1');
    const asAdmin = await admin('/api/admin/review');
    assert.strictEqual(asAdmin.status, 200);
    assert.ok(Array.isArray(asAdmin.body.queue));
});

test('the review queue rejects anonymous callers', async () => {
    const anon = server.client();
    assert.strictEqual((await anon('/api/admin/review')).status, 401);
});

// ---------------------------------------------------------------------------
// quest completion → review → reward
// ---------------------------------------------------------------------------

test('completing a quest submits it for review and grants nothing yet', async () => {
    const client = await registerPlayer('claimant');
    const id = await addQuest(client, 'Finish the graph theory problem set', 'mind');

    const res = await client(`/api/quests/${id}/complete`, proofBody(GOOD_MIND_NOTES, pngBuffer()));
    assert.strictEqual(res.status, 202);
    assert.strictEqual(res.body.status, 'pending_review');

    const me = await client('/api/auth/me');
    assert.strictEqual(me.body.player.currentExp, 0, 'no EXP before an agent approves');
    assert.strictEqual(me.body.player.mana, 0, 'no Mana before an agent approves');
});

test('an agent approving a quest awards EXP and Mana, once', async () => {
    const player = await registerPlayer('earner');
    const admin = await makeAdmin('agent2');
    const id = await addQuest(player, 'Build the login page', 'craft');
    await player(`/api/quests/${id}/complete`, proofBody('Shipped the login page. 3 components, 120 lines.', pngBuffer()));

    const queue = (await admin('/api/admin/review')).body.queue;
    const mine = queue.find((s) => s.kind === 'quest' && s.target.text.includes('login page'));
    assert.ok(mine, 'submission should be in the queue');

    const approve = await admin(`/api/admin/review/${mine.id}/approve`, json({ note: 'looks good' }));
    assert.strictEqual(approve.status, 200);

    const me = await player('/api/auth/me');
    assert.strictEqual(me.body.player.currentExp, 50);
    assert.strictEqual(me.body.player.mana, 20);

    // Approving again must not double-pay.
    const twice = await admin(`/api/admin/review/${mine.id}/approve`, json({}));
    assert.strictEqual(twice.status, 409);
});

test('the Mana ledger records every award immutably', async () => {
    const player = await registerPlayer('ledgerer');
    const admin = await makeAdmin('agent3');
    const id = await addQuest(player, 'Read a chapter on TCP', 'mind');
    await player(`/api/quests/${id}/complete`, proofBody(GOOD_MIND_NOTES, pngBuffer()));

    const sub = (await admin('/api/admin/review')).body.queue.find((s) => s.player.username === 'ledgerer');
    await admin(`/api/admin/review/${sub.id}/approve`, json({}));

    const wallet = await player('/api/mana');
    assert.strictEqual(wallet.body.balance, 20);
    assert.strictEqual(wallet.body.ledger.length, 1);
    assert.strictEqual(wallet.body.ledger[0].delta, 20);
    assert.strictEqual(wallet.body.ledger[0].balanceAfter, 20);
    assert.strictEqual(wallet.body.ledger[0].sourceKind, 'quest');
});

test('an agent rejecting a quest returns it to active with no reward', async () => {
    const player = await registerPlayer('rejected1');
    const admin = await makeAdmin('agent4');
    const id = await addQuest(player, 'Go for a 5k run', 'body');
    await player(`/api/quests/${id}/complete`, proofBody('did it', null));

    const sub = (await admin('/api/admin/review')).body.queue.find((s) => s.player.username === 'rejected1');
    const rej = await admin(`/api/admin/review/${sub.id}/reject`, json({ note: 'need a photo' }));
    assert.strictEqual(rej.status, 200);

    const me = await player('/api/auth/me');
    assert.strictEqual(me.body.player.mana, 0);
    const active = (await player('/api/quests')).body.active;
    assert.ok(active.some((q) => q.id === id), 'quest should be active again');
});

test('a quest awaiting review cannot be claimed a second time', async () => {
    const player = await registerPlayer('doubleclaim');
    const id = await addQuest(player, 'Write the lab report', 'craft');
    await player(`/api/quests/${id}/complete`, proofBody('done once', pngBuffer()));
    const again = await player(`/api/quests/${id}/complete`, proofBody('done twice', pngBuffer()));
    assert.strictEqual(again.status, 409);
});

// ---------------------------------------------------------------------------
// penalty proof → review → unlock
// ---------------------------------------------------------------------------

test('submitting penalty proof does NOT unlock — it waits for review', async () => {
    const player = await registerPlayer('locked1');
    await failAQuest(player);

    const res = await player('/api/penalties/current/proof', proofBody(GOOD_MIND_NOTES, null));
    assert.strictEqual(res.status, 202, 'accepted for review, not approved');

    const still = await player('/api/quests');
    assert.strictEqual(still.status, 423, 'the lock holds until an agent approves');

    const cur = await player('/api/penalties/current');
    assert.strictEqual(cur.body.awaitingReview, true);
});

test('an agent approving penalty proof lifts the lock', async () => {
    const player = await registerPlayer('locked2');
    const admin = await makeAdmin('agent5');
    await failAQuest(player);
    await player('/api/penalties/current/proof', proofBody(GOOD_MIND_NOTES, null));

    const sub = (await admin('/api/admin/review')).body.queue.find((s) => s.kind === 'penalty' && s.player.username === 'locked2');
    assert.ok(sub, 'penalty proof should be queued');
    const approve = await admin(`/api/admin/review/${sub.id}/approve`, json({}));
    assert.strictEqual(approve.status, 200);

    const now = await player('/api/quests');
    assert.strictEqual(now.status, 200, 'System unlocked after approval');
});

test('clearing a penalty grants no EXP or Mana — it is not a reward', async () => {
    const player = await registerPlayer('locked3');
    const admin = await makeAdmin('agent6');
    await failAQuest(player);
    await player('/api/penalties/current/proof', proofBody(GOOD_MIND_NOTES, null));
    const sub = (await admin('/api/admin/review')).body.queue.find((s) => s.player.username === 'locked3');
    await admin(`/api/admin/review/${sub.id}/approve`, json({}));

    const me = await player('/api/auth/me');
    assert.strictEqual(me.body.player.mana, 0);
    assert.strictEqual(me.body.player.currentExp, 0);
});

test('an agent rejecting penalty proof keeps the lock and can be re-submitted', async () => {
    const player = await registerPlayer('locked4');
    const admin = await makeAdmin('agent7');
    await failAQuest(player);
    await player('/api/penalties/current/proof', proofBody('nope', null));

    const sub = (await admin('/api/admin/review')).body.queue.find((s) => s.player.username === 'locked4');
    await admin(`/api/admin/review/${sub.id}/reject`, json({ note: 'not enough detail' }));

    const cur = await player('/api/penalties/current');
    assert.strictEqual(cur.status, 200);
    assert.strictEqual(cur.body.awaitingReview, false, 'reopened for another attempt');
    assert.strictEqual(cur.body.lastReviewNote, 'not enough detail');
    assert.strictEqual((await player('/api/quests')).status, 423, 'still locked');
});

// ---------------------------------------------------------------------------
// the lock still holds the same way it always did
// ---------------------------------------------------------------------------

test('a fresh browser lands back on the lock after login', async () => {
    const player = await registerPlayer('persist1');
    await failAQuest(player);
    await player('/api/auth/logout', { method: 'POST' });

    const fresh = server.client();
    const login = await fresh('/api/auth/login', json({ username: 'persist1', password: 'correcthorsebattery' }));
    assert.ok(login.body.penalty, 'the lock is waiting at login');
    assert.strictEqual((await fresh('/api/quests')).status, 423);
});

test('the Mana wallet is sealed under lockdown', async () => {
    const player = await registerPlayer('walletlock');
    await failAQuest(player);
    assert.strictEqual((await player('/api/mana')).status, 423);
});

test('the sweeper auto-fails an overdue quest and locks the player', async () => {
    const player = await registerPlayer('swept1');
    const id = await addQuest(player, 'Revise for the exam tonight', 'mind');
    db.prepare('UPDATE quests SET due_at = ? WHERE id = ?').run(Date.now() - 60_000, id);

    const { sweepAll } = require('../src/sweeper');
    assert.ok(sweepAll() >= 1);
    assert.strictEqual((await player('/api/quests')).status, 423);
});

test('a quest already in review is safe from the sweeper', async () => {
    const player = await registerPlayer('swept2');
    const id = await addQuest(player, 'Submit the assignment', 'mind');
    await player(`/api/quests/${id}/complete`, proofBody(GOOD_MIND_NOTES, pngBuffer()));
    db.prepare('UPDATE quests SET due_at = ? WHERE id = ?').run(Date.now() - 60_000, id);

    const { sweepAll } = require('../src/sweeper');
    sweepAll();
    const row = db.prepare('SELECT status FROM quests WHERE id = ?').get(id);
    assert.strictEqual(row.status, 'pending_review', 'a submitted claim is not failed for the deadline');
});

// ---------------------------------------------------------------------------
// anti-cheat advisories & privacy
// ---------------------------------------------------------------------------

test('the pre-check flags a recycled file for the agent', async () => {
    const player = await registerPlayer('replayer');
    const admin = await makeAdmin('agent8');
    const img = pngBuffer();

    const id1 = await addQuest(player, 'First craft task', 'craft');
    await player(`/api/quests/${id1}/complete`, proofBody('first artifact done here', img));
    const first = (await admin('/api/admin/review')).body.queue.find((s) => s.player.username === 'replayer');
    await admin(`/api/admin/review/${first.id}/approve`, json({}));

    const id2 = await addQuest(player, 'Second craft task', 'craft');
    const res = await player(`/api/quests/${id2}/complete`, proofBody('second artifact, same photo', img));
    assert.strictEqual(res.body.precheck.pass, false);
    assert.ok(res.body.precheck.reasons.some((r) => r.includes('already been submitted')));
});

test('the client is never sent a password hash', async () => {
    const player = await registerPlayer('privacy2');
    const res = await player('/api/auth/me');
    assert.ok(!JSON.stringify(res.body).includes('password'));
});
