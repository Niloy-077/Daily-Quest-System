'use strict';

const express = require('express');
const auth = require('../auth');
const { openPenaltyFor, serialisePenalty } = require('../middleware/lockdown');

const router = express.Router();

/** Shape a user row for the client. Never includes password_hash. */
function playerPayload(user) {
    return {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        role: user.role,
        rankTitle: user.rank_title,
        level: user.level,
        currentExp: user.current_exp,
        maxExp: user.max_exp,
        mana: user.mana,
        stats: { str: user.stat_str, int: user.stat_int, vit: user.stat_vit },
        timezone: user.timezone,
    };
}

router.post('/register', async (req, res, next) => {
    try {
        const { username, password, displayName, timezone } = req.body || {};

        const problem = auth.validateCredentials(username, password);
        if (problem) return res.status(400).json({ error: 'invalid', message: problem });

        const user = await auth.registerUser({ username, password, displayName, timezone });

        // Guard against session fixation: a pre-login session id must not
        // survive to become an authenticated one.
        return req.session.regenerate((err) => {
            if (err) return next(err);
            req.session.userId = user.id;
            return res.status(201).json({ player: playerPayload(user) });
        });
    } catch (err) {
        if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return res.status(409).json({ error: 'taken', message: 'That username is already registered.' });
        }
        return next(err);
    }
});

router.post('/login', async (req, res, next) => {
    try {
        const { username, password, timezone } = req.body || {};
        const user = await auth.verifyLogin(username, password);

        if (!user) {
            // Deliberately vague: never reveal whether the username exists.
            return res.status(401).json({ error: 'bad_credentials', message: 'Incorrect username or password.' });
        }

        return req.session.regenerate((err) => {
            if (err) return next(err);
            req.session.userId = user.id;
            if (timezone) req.session.timezone = timezone;

            const penalty = openPenaltyFor(user.id);
            return res.json({
                player: playerPayload(user),
                // Logging in from a fresh browser lands straight back on the
                // lockdown screen. That is the point.
                penalty: penalty ? serialisePenalty(penalty) : null,
            });
        });
    } catch (err) {
        return next(err);
    }
});

// Always reachable, including under lockdown — being locked must not trap the
// session open. Logging out changes nothing about the penalty.
router.post('/logout', (req, res, next) => {
    if (!req.session) return res.status(204).end();
    return req.session.destroy((err) => {
        if (err) return next(err);
        res.clearCookie('questism.sid');
        return res.status(204).end();
    });
});

router.get('/me', auth.requireAuth, (req, res) => {
    const penalty = openPenaltyFor(req.user.id);
    res.json({
        player: playerPayload(req.user),
        penalty: penalty ? serialisePenalty(penalty) : null,
    });
});

module.exports = router;
module.exports.playerPayload = playerPayload;
