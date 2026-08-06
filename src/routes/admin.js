'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');

const { requireAuth } = require('../auth');
const { requireAdmin } = require('../roles');
const submissions = require('../submissions');
const { UPLOAD_DIR } = require('../uploads');

const router = express.Router();

// Every route here is agents-only. requireAuth first (who are you), then
// requireAdmin (are you an agent). No sweeper or lockdown — an agent is not a
// player and holds no penalties.
router.use(requireAuth, requireAdmin);

/** The pending review queue — quest claims and penalty proof, oldest first. */
router.get('/review', (req, res) => {
    res.json({ queue: submissions.listPending() });
});

router.post('/review/:id/approve', (req, res, next) => {
    try {
        const result = submissions.approve({
            submissionId: Number(req.params.id),
            reviewerId: req.user.id,
            note: String((req.body && req.body.note) || '').slice(0, 500),
        });
        res.json({ ok: true, result });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: 'invalid', message: err.message });
        return next(err);
    }
});

router.post('/review/:id/reject', (req, res, next) => {
    try {
        const result = submissions.reject({
            submissionId: Number(req.params.id),
            reviewerId: req.user.id,
            note: String((req.body && req.body.note) || '').slice(0, 500),
        });
        res.json({ ok: true, result });
    } catch (err) {
        if (err.status) return res.status(err.status).json({ error: 'invalid', message: err.message });
        return next(err);
    }
});

/**
 * Stream an uploaded evidence file to the reviewing agent.
 *
 * Uploads live outside the webroot; this is the only way to see them, and only
 * an agent can. The name is forced to a bare filename so `..` or an absolute
 * path cannot escape the uploads directory.
 */
router.get('/evidence/:name', (req, res) => {
    const safe = path.basename(req.params.name);
    const full = path.join(UPLOAD_DIR, safe);
    if (!full.startsWith(UPLOAD_DIR) || !fs.existsSync(full)) {
        return res.status(404).json({ error: 'not_found', message: 'No such file.' });
    }
    return res.sendFile(full);
});

module.exports = router;
