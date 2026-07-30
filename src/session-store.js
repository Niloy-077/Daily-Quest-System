'use strict';

const session = require('express-session');
const db = require('./db');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Session storage backed by the same SQLite file as everything else.
 *
 * express-session's built-in MemoryStore keeps sessions in the process heap,
 * so every server restart logs everybody out. Persisting them matters here for
 * a specific reason: a player under lockdown must not be able to escape by
 * waiting for (or causing) a restart.
 */
class SqliteSessionStore extends session.Store {
    constructor() {
        super();
        this.stmt = {
            get: db.prepare('SELECT data, expires FROM sessions WHERE sid = ?'),
            set: db.prepare(`INSERT INTO sessions (sid, expires, data) VALUES (@sid, @expires, @data)
                             ON CONFLICT(sid) DO UPDATE SET expires = @expires, data = @data`),
            destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
            touch: db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?'),
            sweep: db.prepare('DELETE FROM sessions WHERE expires <= ?'),
        };

        // Drop anything that expired while the server was down.
        this.stmt.sweep.run(Date.now());
    }

    expiryOf(sess) {
        const cookieExpiry = sess && sess.cookie && sess.cookie.expires;
        if (cookieExpiry) return new Date(cookieExpiry).getTime();
        return Date.now() + DAY_MS;
    }

    get(sid, callback) {
        try {
            const row = this.stmt.get.get(sid);
            if (!row) return callback(null, null);
            if (row.expires <= Date.now()) {
                this.stmt.destroy.run(sid);
                return callback(null, null);
            }
            return callback(null, JSON.parse(row.data));
        } catch (err) {
            return callback(err);
        }
    }

    set(sid, sess, callback) {
        try {
            this.stmt.set.run({
                sid,
                expires: this.expiryOf(sess),
                data: JSON.stringify(sess),
            });
            return callback(null);
        } catch (err) {
            return callback(err);
        }
    }

    destroy(sid, callback) {
        try {
            this.stmt.destroy.run(sid);
            return callback(null);
        } catch (err) {
            return callback(err);
        }
    }

    touch(sid, sess, callback) {
        try {
            this.stmt.touch.run(this.expiryOf(sess), sid);
            return callback(null);
        } catch (err) {
            return callback(err);
        }
    }
}

module.exports = SqliteSessionStore;
