'use strict';

const db = require('./db');
const { failQuest } = require('./quests');

/**
 * Deadline enforcement.
 *
 * The old build had a "Fail Quest" button, so nothing ever failed unless the
 * player chose to fail it — the one action nobody takes voluntarily. Here a
 * quest that is still active past its deadline is failed by the server.
 *
 * It runs in three places on purpose:
 *
 *   1. on boot      — catches everything that expired while the server was off
 *   2. on a timer   — catches midnight passing on a server that stays up
 *   3. per request  — catches the gap on a server that sleeps between requests
 *                     (free hosting tiers idle out, and a timer that is not
 *                     running cannot fire)
 *
 * Any one of these alone leaves a hole. Together, a quest cannot survive its
 * deadline no matter how the process happened to be scheduled.
 */

const SWEEP_INTERVAL_MS = 60 * 1000;

const stmt = {
    overdueAll: db.prepare(
        "SELECT id, user_id FROM quests WHERE status = 'active' AND due_at <= ? ORDER BY due_at ASC",
    ),
    overdueForUser: db.prepare(
        "SELECT id, user_id FROM quests WHERE status = 'active' AND due_at <= ? AND user_id = ? ORDER BY due_at ASC",
    ),
};

function failOverdue(rows, now) {
    let failed = 0;
    for (const row of rows) {
        try {
            failQuest({ userId: row.user_id, questId: row.id, now });
            failed += 1;
        } catch (err) {
            // A quest resolved by a concurrent request is not an error worth
            // aborting the whole sweep for.
            if (err.status !== 409 && err.status !== 404) {
                console.error('[sweeper] failed to expire quest %d:', row.id, err.message);
            }
        }
    }
    return failed;
}

/** Expire every overdue quest for every player. */
function sweepAll(now = Date.now()) {
    return failOverdue(stmt.overdueAll.all(now), now);
}

/** Expire one player's overdue quests. Indexed, so it is cheap per request. */
function sweepUser(userId, now = Date.now()) {
    return failOverdue(stmt.overdueForUser.all(now, userId), now);
}

/**
 * Sweep the current player before their request is served.
 *
 * Deliberately ahead of enforceLockdown in the chain: a quest that expired
 * while the player was away must turn into a penalty *before* the lockdown
 * check reads the penalty table, so the lock takes hold on this request rather
 * than the next one.
 */
function sweepMiddleware(req, res, next) {
    try {
        if (req.user) sweepUser(req.user.id);
    } catch (err) {
        console.error('[sweeper] request sweep failed:', err.message);
    }
    return next();
}

let timer = null;

function startSweeper() {
    const boot = sweepAll();
    if (boot > 0) {
        console.log(`  Sweeper          expired ${boot} overdue quest${boot === 1 ? '' : 's'} on boot`);
    }

    timer = setInterval(() => {
        try {
            sweepAll();
        } catch (err) {
            console.error('[sweeper] scheduled sweep failed:', err.message);
        }
    }, SWEEP_INTERVAL_MS);

    // Do not hold the process open on shutdown.
    if (timer.unref) timer.unref();
    return timer;
}

function stopSweeper() {
    if (timer) clearInterval(timer);
    timer = null;
}

module.exports = { SWEEP_INTERVAL_MS, sweepAll, sweepUser, sweepMiddleware, startSweeper, stopSweeper };
