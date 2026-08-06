'use strict';

const bcrypt = require('bcrypt');
const db = require('./db');
const { BCRYPT_ROUNDS } = require('./auth');

/**
 * Authorisation, kept separate from authentication.
 *
 * `requireAuth` (in auth.js) answers "who are you". `requireAdmin` answers
 * "are you allowed to review other players' proof". Splitting them means the
 * admin dashboard is gated by one small, obvious check rather than scattered
 * `if (user.role === ...)` tests through the routes.
 */

const stmt = {
    byUsername: db.prepare('SELECT id, role FROM users WHERE username = ?'),
    insertAdmin: db.prepare(`
        INSERT INTO users (username, password_hash, display_name, role, timezone, created_at)
        VALUES (?, ?, ?, 'admin', 'UTC', ?)
    `),
    // Sets BOTH role and password_hash, deliberately. ADMIN_USERNAME /
    // ADMIN_PASSWORD in .env are meant to be the sole source of truth for this
    // one account, on every boot — never just the first.
    syncAdmin: db.prepare("UPDATE users SET role = 'admin', password_hash = ? WHERE id = ?"),
};

/** Gate for the review dashboard. Assumes requireAuth has already run. */
function requireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ error: 'forbidden', message: 'Agent access only.' });
    }
    return next();
}

/**
 * Make sure the admin account matches ADMIN_USERNAME / ADMIN_PASSWORD.
 *
 * Runs on every boot, and re-syncs on every boot — not just the first. Two
 * things this closes:
 *
 *   1. Privilege escalation by username squatting. If a player registers the
 *      same username the operator later picks for ADMIN_USERNAME, that
 *      account must not keep the player's own password once it is promoted —
 *      otherwise anyone who guessed or squatted the name owns the agent
 *      account with a password the operator never chose. Re-hashing
 *      ADMIN_PASSWORD into that row on every boot removes that path.
 *   2. Changing ADMIN_PASSWORD in .env must actually take effect on restart,
 *      not be silently ignored after the account's first creation.
 *
 * The account this username points to is fully owned by .env, always.
 */
function ensureAdminSeed() {
    const username = process.env.ADMIN_USERNAME;
    const password = process.env.ADMIN_PASSWORD;
    if (!username || !password) return null;

    const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
    const existing = stmt.byUsername.get(username);

    if (existing) {
        stmt.syncAdmin.run(hash, existing.id);
        return { username, created: false };
    }

    stmt.insertAdmin.run(username, hash, username, Date.now());
    return { username, created: true };
}

module.exports = { requireAdmin, ensureAdminSeed };
