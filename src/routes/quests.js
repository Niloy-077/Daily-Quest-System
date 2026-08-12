'use strict';

const express = require('express');
const quests = require('../quests');
const submissions = require('../submissions');
const precheck = require('../precheck');
const { upload, fileFrom, store } = require('../uploads');
const { CATEGORIES } = require('../penalty/engine');
const { serialisePenalty } = require('../middleware/lockdown');
const { playerPayload } = require('./auth');

const router = express.Router();

/**
 * Every route here sits behind requireAuth, the sweeper and enforceLockdown,
 * so by the time a handler runs the player is authenticated and provably not
 * under an open penalty.
 */

router.get('/', (req, res) => {
    res.json({
        player: playerPayload(req.user),
        active: quests.listActive(req.user.id).map(quests.serialiseQuest),
        recent: quests.listRecent(req.user.id).map(quests.serialiseQuest),
        categories: CATEGORIES,
    });
});

router.post('/', (req, res, next) => {
    try {
        const { text, category, dueAt } = req.body || {};
        const quest = quests.createQuest({
            userId: req.user.id,
            text,
            category,
            dueAt,
            // Session zone is fresher than the stored one — it follows the
            // player if they travel.
            timezone: req.session.timezone || req.user.timezone,
        });
        res.status(201).json({ quest: quests.serialiseQuest(quest) });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: 'invalid', message: err.message });
        return next(err);
    }
});

/**
 * Claim a quest is complete, with proof.
 *
 * Completion is no longer a button that pays out instantly — that could not be
 * trusted. The player submits evidence, the quest moves to 'pending_review',
 * and the reward (EXP + Mana) only lands when an agent approves it in the
 * review queue. The automated pre-check rides along to advise the agent.
 */
router.post('/:id/complete', upload.single('file'), (req, res, next) => {
    try {
        const notes = String((req.body && req.body.notes) || '');
        const file = fileFrom(req.file);

        const pre = precheck.forQuest({ notes, file, userId: req.user.id });
        const fileMeta = file ? store(file, `quest-${req.params.id}`) : null;

        const submission = submissions.submitQuestProof({
            userId: req.user.id,
            questId: Number(req.params.id),
            notes,
            fileMeta,
            precheck: pre,
        });

        res.status(202).json({
            status: 'pending_review',
            message: 'Proof submitted. An agent will review it shortly.',
            submissionId: submission.id,
            precheck: pre,
        });
    } catch (err) {
        if (err && err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ error: 'too_large', message: 'File is too large.' });
        }
        if (err.status) return res.status(err.status).json({ error: 'invalid', message: err.message });
        return next(err);
    }
});

/**
 * Give up on a quest.
 *
 * Kept from the original build, but it is now a real forfeit: EXP is deducted,
 * a strike is recorded, and the resulting penalty locks the account. It is not
 * a way to clear the board.
 */
router.post('/:id/fail', (req, res, next) => {
    try {
        const result = quests.failQuest({
            userId: req.user.id,
            questId: Number(req.params.id),
        });
        res.status(423).json({
            error: 'locked',
            message: 'QUEST FAILED. PENALTY PROTOCOL ACTIVE.',
            quest: quests.serialiseQuest(result.quest),
            progress: result.progress,
            // serialisePenalty carries the machine rules too, so the client can
            // render the live requirement checklist straight from this response.
            penalty: serialisePenalty(result.penalty),
        });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: 'invalid', message: err.message });
        return next(err);
    }
});

module.exports = router;
