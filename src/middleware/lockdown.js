'use strict';

const db = require('../db');

const LOCKED = 423; // HTTP 423 Locked (RFC 4918)

const stmt = {
    openPenalty: db.prepare(`
        SELECT * FROM penalties
        WHERE user_id = ? AND status != 'approved'
        ORDER BY created_at ASC
        LIMIT 1
    `),
};

/**
 * The one open penalty holding this user, or undefined if the System is clear.
 *
 * A penalty is only released when its status reaches 'approved', which happens
 * in exactly one place: proof passing the judge. Nothing in the browser can
 * reach this row.
 */
function openPenaltyFor(userId) {
    return stmt.openPenalty.get(userId);
}

function serialisePenalty(penalty) {
    return {
        id: penalty.id,
        task: penalty.task_text,
        category: penalty.category,
        durationMinutes: penalty.duration_minutes,
        proofKind: penalty.proof_kind,
        requirements: JSON.parse(penalty.requirements_json),
        // The machine-checkable thresholds, so the client can show a live
        // requirement checklist as the player types. Not secret — the same
        // bar is printed in `requirements` above; this is just the numbers.
        rules: JSON.parse(penalty.rules_json),
        severity: penalty.severity,
        status: penalty.status,
        createdAt: penalty.created_at,
    };
}

/**
 * Refuses every authenticated route while a penalty is unresolved.
 *
 * This is the whole reason the app has a backend. In the old localStorage
 * build the lock was an overlay `<div>`, so `localStorage.clear()` or a line
 * of CSS in DevTools ended it. Here the lock is a row in the database and the
 * check runs on the server, ahead of the route:
 *
 *   - clearing site data       — there is no client state to clear
 *   - editing the DOM/console  — fakes pixels, never EXP or lock status
 *   - deleting the cookie      — logs you out; the lock is waiting on return
 *   - a different browser      — same account, same row, same lock
 *   - a different machine      — likewise
 *
 * Mount it AFTER requireAuth. Routes that must stay reachable while locked
 * (read the penalty, submit proof, log out) are registered before it.
 */
function enforceLockdown(req, res, next) {
    const penalty = openPenaltyFor(req.user.id);
    if (!penalty) return next();

    return res.status(LOCKED).json({
        error: 'locked',
        message: 'PENALTY PROTOCOL ACTIVE. The System is locked until proof is accepted.',
        penalty: serialisePenalty(penalty),
    });
}

module.exports = { enforceLockdown, openPenaltyFor, serialisePenalty, LOCKED };
