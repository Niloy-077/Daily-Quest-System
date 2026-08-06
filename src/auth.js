'use strict';

const bcrypt = require('bcrypt');
const db = require('./db');

const BCRYPT_ROUNDS = 12;

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const MIN_PASSWORD_LENGTH = 8;
// bcrypt only hashes the first 72 bytes; reject longer rather than silently
// truncating, which would make two different passwords equivalent.
const MAX_PASSWORD_BYTES = 72;

const PUBLIC_USER_COLUMNS = `
    id, username, display_name, role, rank_title, level, current_exp, max_exp,
    mana, stat_str, stat_int, stat_vit, timezone, created_at
`;

const stmt = {
    byUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
    byId: db.prepare(`SELECT ${PUBLIC_USER_COLUMNS} FROM users WHERE id = ?`),
    insert: db.prepare(`
        INSERT INTO users (username, password_hash, display_name, timezone, created_at)
        VALUES (?, ?, ?, ?, ?)
    `),
};

function validateCredentials(username, password) {
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
        return '3-20 characters, letters, numbers and underscore only.';
    }
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
        return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
    }
    if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
        return `Password must be at most ${MAX_PASSWORD_BYTES} bytes.`;
    }
    return null;
}

async function registerUser({ username, password, displayName, timezone }) {
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const info = stmt.insert.run(
        username,
        hash,
        (displayName || username).slice(0, 40),
        timezone || 'UTC',
        Date.now(),
    );
    return stmt.byId.get(info.lastInsertRowid);
}

async function verifyLogin(username, password) {
    const row = typeof username === 'string' ? stmt.byUsername.get(username) : undefined;

    // Hash against a dummy even when the user does not exist, so that a missing
    // username and a wrong password take the same time to answer. Otherwise the
    // response time alone tells an attacker which usernames are registered.
    const hash = row ? row.password_hash : '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
    const ok = await bcrypt.compare(typeof password === 'string' ? password : '', hash);

    if (!row || !ok) return null;
    return stmt.byId.get(row.id);
}

function getUser(id) {
    return stmt.byId.get(id);
}

/** Gate for every route that needs a logged-in player. */
function requireAuth(req, res, next) {
    if (!req.session || !req.session.userId) {
        return res.status(401).json({ error: 'unauthenticated', message: 'Log in to access the System.' });
    }
    const user = getUser(req.session.userId);
    if (!user) {
        // The account was deleted while the session was still alive.
        return req.session.destroy(() =>
            res.status(401).json({ error: 'unauthenticated', message: 'Session no longer valid.' }));
    }
    req.user = user;
    return next();
}

module.exports = {
    BCRYPT_ROUNDS,
    MIN_PASSWORD_LENGTH,
    validateCredentials,
    registerUser,
    verifyLogin,
    getUser,
    requireAuth,
};
