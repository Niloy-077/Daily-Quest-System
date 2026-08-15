'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { useTempDatabase, startTestServer, json } = require('./helpers');
useTempDatabase();

const { ensureAdminSeed } = require('../src/roles');

let server;
test.before(async () => { server = await startTestServer(); });
test.after(async () => { if (server) await server.close(); });

test('ensureAdminSeed creates the account fresh when it does not exist', () => {
    process.env.ADMIN_USERNAME = 'freshagent';
    process.env.ADMIN_PASSWORD = 'firstpass123';
    const result = ensureAdminSeed();
    assert.strictEqual(result.created, true);
});

test('a player cannot steal the admin role by squatting the username first', async () => {
    // A player registers "agent" — with a password the operator never chose —
    // BEFORE the operator ever sets ADMIN_USERNAME=agent.
    const client = server.client();
    await client('/api/auth/register', json({
        username: 'squatter', password: 'squattersownpassword', displayName: 'squatter', timezone: 'UTC',
    }));

    process.env.ADMIN_USERNAME = 'squatter';
    process.env.ADMIN_PASSWORD = 'the-real-operator-password';
    ensureAdminSeed();

    // The account is now admin — but logging in with the squatter's own
    // password must no longer work. Ownership of the seat, not just the role,
    // has to move to whoever controls .env.
    const withOwnPassword = await client('/api/auth/login', json({
        username: 'squatter', password: 'squattersownpassword',
    }));
    assert.strictEqual(withOwnPassword.status, 401, 'the squatter\'s original password must be invalidated');

    const withOperatorPassword = await client('/api/auth/login', json({
        username: 'squatter', password: 'the-real-operator-password',
    }));
    assert.strictEqual(withOperatorPassword.status, 200);
    assert.strictEqual(withOperatorPassword.body.player.role, 'admin');
});

test('changing ADMIN_PASSWORD in .env takes effect on the next boot', async () => {
    process.env.ADMIN_USERNAME = 'rotatingagent';
    process.env.ADMIN_PASSWORD = 'passwordone';
    ensureAdminSeed(); // boot 1

    process.env.ADMIN_PASSWORD = 'passwordtwo';
    ensureAdminSeed(); // boot 2 — simulates a restart with a rotated password

    const client = server.client();
    const stale = await client('/api/auth/login', json({ username: 'rotatingagent', password: 'passwordone' }));
    assert.strictEqual(stale.status, 401, 'the old password should no longer work after rotation');

    const current = await client('/api/auth/login', json({ username: 'rotatingagent', password: 'passwordtwo' }));
    assert.strictEqual(current.status, 200);
});

test('re-seeding the same account twice is idempotent and does not error', () => {
    process.env.ADMIN_USERNAME = 'steadyagent';
    process.env.ADMIN_PASSWORD = 'steadypass';
    const first = ensureAdminSeed();
    const second = ensureAdminSeed();
    assert.strictEqual(first.created, true);
    assert.strictEqual(second.created, false);
});

test('no ADMIN_USERNAME/PASSWORD configured means no seed and no crash', () => {
    delete process.env.ADMIN_USERNAME;
    delete process.env.ADMIN_PASSWORD;
    assert.strictEqual(ensureAdminSeed(), null);
});
