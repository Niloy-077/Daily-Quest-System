'use strict';

const express = require('express');
const mana = require('../mana');
const submissions = require('../submissions');

const router = express.Router();

/**
 * The player's Mana wallet: current balance plus the ledger behind it, and
 * their recent submissions so the client can show "awaiting review" states.
 *
 * Read-only. Mana is only ever granted by an admin approving a quest — there
 * is no endpoint a player could call to award themselves any.
 */
router.get('/', (req, res) => {
    res.json({
        balance: mana.balanceOf(req.user.id),
        ledger: mana.history(req.user.id, 30),
        submissions: submissions.recentForUser(req.user.id),
    });
});

module.exports = router;
