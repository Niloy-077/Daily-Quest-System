'use strict';

const express = require('express');

const db = require('../db');
const judge = require('../penalty/judge');
const precheck = require('../precheck');
const submissions = require('../submissions');
const { upload, fileFrom, store } = require('../uploads');
const { openPenaltyFor, serialisePenalty } = require('../middleware/lockdown');

const router = express.Router();

const stmt = {
    lastSubmission: db.prepare(`
        SELECT status, review_note, submitted_at, reviewed_at
        FROM submissions WHERE penalty_id = ? ORDER BY submitted_at DESC LIMIT 1
    `),
    attemptCount: db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE penalty_id = ?'),
    history: db.prepare(`
        SELECT p.id, p.task_text, p.category, p.severity, p.status, p.created_at, p.resolved_at,
               (SELECT COUNT(*) FROM submissions s WHERE s.penalty_id = p.id) AS attempts
        FROM penalties p WHERE p.user_id = ? ORDER BY p.created_at DESC LIMIT 50
    `),
};

/**
 * The player's open penalty, or null. Reachable while locked.
 *
 * `awaitingReview` tells the client the difference between "you still owe
 * proof" and "you submitted, an agent is looking" — the second is not a
 * failure state, just a wait.
 */
router.get('/current', (req, res) => {
    const penalty = openPenaltyFor(req.user.id);
    if (!penalty) return res.json({ penalty: null });

    const last = stmt.lastSubmission.get(penalty.id);
    return res.json({
        penalty: serialisePenalty(penalty),
        awaitingReview: penalty.status === 'submitted',
        lastReviewNote: last && last.status === 'rejected' ? last.review_note : null,
        attempts: stmt.attemptCount.get(penalty.id).n,
        cooldownMs: judge.cooldownRemaining(penalty.id),
    });
});

/**
 * Submit proof that the penalty was served.
 *
 * This does NOT unlock the account. It places the evidence in the review queue
 * and runs the deterministic pre-check to advise the agent. The lock lifts only
 * when an agent approves the submission — the client has no path to unlock
 * itself.
 */
router.post('/current/proof', upload.single('file'), async (req, res, next) => {
    try {
        const penalty = openPenaltyFor(req.user.id);
        if (!penalty) {
            return res.status(404).json({ error: 'no_penalty', message: 'You have no active penalty.' });
        }
        if (penalty.status === 'submitted') {
            return res.status(409).json({ error: 'in_review', message: 'Your proof is already awaiting review.' });
        }

        const now = Date.now();
        const cooldown = judge.cooldownRemaining(penalty.id, now);
        if (cooldown > 0) {
            return res.status(429).json({
                error: 'cooldown',
                message: `Wait ${Math.ceil(cooldown / 1000)}s before submitting again.`,
                cooldownMs: cooldown,
            });
        }

        const notes = String((req.body && req.body.notes) || '');
        const file = fileFrom(req.file);
        const pre = precheck.forPenalty({ penalty, notes, file });
        const fileMeta = file ? store(file, `penalty-${penalty.id}`) : null;

        submissions.submitPenaltyProof({
            userId: req.user.id,
            penaltyId: penalty.id,
            notes,
            fileMeta,
            precheck: pre,
            now,
        });

        // Still locked — 202 Accepted, awaiting review.
        return res.status(202).json({
            status: 'pending_review',
            message: 'Proof submitted. An agent will review it — the System stays locked until then.',
            precheck: pre,
            penalty: serialisePenalty(penalty),
        });
    } catch (err) {
        if (err && err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({
                error: 'too_large',
                message: `File exceeds ${Math.round(judge.MAX_FILE_BYTES / (1024 * 1024))} MB.`,
            });
        }
        if (err.status) return res.status(err.status).json({ error: 'invalid', message: err.message });
        return next(err);
    }
});

/** The player's own penalty record — every penalty and its attempts. */
router.get('/history', (req, res) => {
    res.json({
        penalties: stmt.history.all(req.user.id).map((row) => ({
            id: row.id,
            task: row.task_text,
            category: row.category,
            severity: row.severity,
            status: row.status,
            attempts: row.attempts,
            createdAt: row.created_at,
            resolvedAt: row.resolved_at,
        })),
    });
});

module.exports = router;
