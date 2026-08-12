'use strict';

const db = require('./db');

/**
 * The Mana reward ledger.
 *
 * Mana is the in-app reward earned by completing quests. It is deliberately an
 * abstraction: every grant is an immutable row in `mana_ledger`, and a user's
 * balance is the running total. A later phase can mint a crypto token by
 * reading this ledger — so the reward economy is fully modelled now, with none
 * of the blockchain, custody or regulatory surface in the app yet.
 *
 * Nothing here ever mutates a past row. Corrections are new rows (a negative
 * delta), never edits, so the ledger stays a truthful audit trail.
 */

const stmt = {
    balance: db.prepare('SELECT mana FROM users WHERE id = ?'),
    bumpCache: db.prepare('UPDATE users SET mana = ? WHERE id = ?'),
    insert: db.prepare(`
        INSERT INTO mana_ledger (user_id, delta, balance_after, reason, source_kind, source_id, created_at)
        VALUES (@user_id, @delta, @balance_after, @reason, @source_kind, @source_id, @created_at)
    `),
    history: db.prepare(`
        SELECT id, delta, balance_after, reason, source_kind, source_id, created_at
        FROM mana_ledger WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
    `),
    total: db.prepare('SELECT COALESCE(SUM(delta), 0) AS n FROM mana_ledger WHERE user_id = ?'),
};

function balanceOf(userId) {
    const row = stmt.balance.get(userId);
    return row ? row.mana : 0;
}

/**
 * Grant (or, with a negative delta, deduct) Mana and record it.
 *
 * Caller passes a `now` so the award can share the transaction and timestamp
 * of whatever triggered it — an admin approving a quest, for instance.
 */
function award({ userId, delta, reason, sourceKind = null, sourceId = null, now = Date.now() }) {
    const balanceAfter = balanceOf(userId) + delta;

    stmt.insert.run({
        user_id: userId,
        delta,
        balance_after: balanceAfter,
        reason,
        source_kind: sourceKind,
        source_id: sourceId,
        created_at: now,
    });
    stmt.bumpCache.run(balanceAfter, userId);

    return balanceAfter;
}

function history(userId, limit = 30) {
    return stmt.history.all(userId, limit).map((row) => ({
        id: row.id,
        delta: row.delta,
        balanceAfter: row.balance_after,
        reason: row.reason,
        sourceKind: row.source_kind,
        sourceId: row.source_id,
        createdAt: row.created_at,
    }));
}

/** Recompute the cached balance from the ledger. A self-heal / audit helper. */
function reconcile(userId) {
    const total = stmt.total.get(userId).n;
    stmt.bumpCache.run(total, userId);
    return total;
}

module.exports = { balanceOf, award, history, reconcile };
