'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'questism.sqlite');

// The database file builds itself on first boot — there is no migration step
// to run by hand and nothing to import before `npm start` works.
if (DB_PATH !== ':memory:') {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT    NOT NULL,
    display_name  TEXT    NOT NULL,
    -- 'player' declares quests and submits proof; 'admin' reviews the queue.
    -- One role column keeps the whole authorisation model in one place.
    role          TEXT    NOT NULL DEFAULT 'player'
                          CHECK (role IN ('player','admin')),
    rank_title    TEXT    NOT NULL DEFAULT 'E-Rank',
    level         INTEGER NOT NULL DEFAULT 1,
    current_exp   INTEGER NOT NULL DEFAULT 0,
    max_exp       INTEGER NOT NULL DEFAULT 200,
    -- Cached balance. The mana_ledger is the source of truth; this column is a
    -- denormalised running total so the status window never has to re-sum it.
    mana          INTEGER NOT NULL DEFAULT 0,
    stat_str      INTEGER NOT NULL DEFAULT 10,
    stat_int      INTEGER NOT NULL DEFAULT 10,
    stat_vit      INTEGER NOT NULL DEFAULT 10,
    timezone      TEXT    NOT NULL DEFAULT 'UTC',
    created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS quests (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text         TEXT    NOT NULL,
    category     TEXT    NOT NULL CHECK (category IN ('mind','body','discipline','craft')),
    exp_reward   INTEGER NOT NULL DEFAULT 50,
    mana_reward  INTEGER NOT NULL DEFAULT 20,
    due_at       INTEGER NOT NULL,
    -- 'pending_review' is the new middle state: the player claims completion
    -- and submits proof, but no reward lands until an admin approves it.
    status       TEXT    NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active','pending_review','completed','failed')),
    created_at   INTEGER NOT NULL,
    completed_at INTEGER
);

-- The sweeper's hot path: "every active quest that is now past its deadline".
CREATE INDEX IF NOT EXISTS idx_quests_sweep ON quests(status, due_at);
CREATE INDEX IF NOT EXISTS idx_quests_user  ON quests(user_id, status);

CREATE TABLE IF NOT EXISTS penalties (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    origin_quest_id   INTEGER REFERENCES quests(id) ON DELETE SET NULL,
    task_text         TEXT    NOT NULL,
    category          TEXT    NOT NULL,
    duration_minutes  INTEGER NOT NULL,
    proof_kind        TEXT    NOT NULL
                              CHECK (proof_kind IN ('notes','image','image_and_notes')),
    -- Human-readable requirements shown to the player.
    requirements_json TEXT    NOT NULL,
    -- Machine-checkable version of the same requirements, evaluated by the
    -- deterministic judge. Written once at creation so the bar cannot move.
    rules_json        TEXT    NOT NULL,
    severity          INTEGER NOT NULL DEFAULT 1,
    status            TEXT    NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending','submitted','approved')),
    created_at        INTEGER NOT NULL,
    resolved_at       INTEGER
);

-- Backs the lockdown check, which runs ahead of every authenticated request.
CREATE INDEX IF NOT EXISTS idx_penalties_lock ON penalties(user_id, status);

-- One queue for two kinds of evidence: proof that a quest was completed
-- (kind='quest', earns a reward) and proof that a penalty was served
-- (kind='penalty', lifts the lock). A single table means one admin review
-- screen handles both, and the "who reviewed what, when" trail lives in one place.
CREATE TABLE IF NOT EXISTS submissions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind          TEXT    NOT NULL CHECK (kind IN ('quest','penalty')),
    quest_id      INTEGER REFERENCES quests(id) ON DELETE CASCADE,
    penalty_id    INTEGER REFERENCES penalties(id) ON DELETE CASCADE,
    notes         TEXT    NOT NULL DEFAULT '',
    stored_path   TEXT,
    original_name TEXT,
    mime          TEXT,
    size          INTEGER,
    sha256        TEXT,
    -- Advisory automated pre-check. It never decides; it only tells the admin
    -- whether the deterministic rules were satisfied, so obvious passes and
    -- obvious junk are flagged before a human looks.
    precheck_pass INTEGER NOT NULL DEFAULT 0,
    precheck_json TEXT    NOT NULL DEFAULT '{}',
    -- The human verdict. 'pending' sits in the queue; the admin moves it.
    status        TEXT    NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','approved','rejected')),
    reviewer_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
    review_note   TEXT,
    reviewed_at   INTEGER,
    submitted_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sub_queue ON submissions(status, submitted_at);
CREATE INDEX IF NOT EXISTS idx_sub_user  ON submissions(user_id, submitted_at);
-- Replay defence: the same file can never be used as proof twice.
CREATE INDEX IF NOT EXISTS idx_sub_hash  ON submissions(sha256);

-- Append-only reward ledger. Every grant of Mana is one immutable row; the
-- user's balance is their running total. A later phase can mint a crypto
-- token by reading this ledger — the economic record is decoupled from any
-- blockchain, so nothing financial lives in the app itself yet.
CREATE TABLE IF NOT EXISTS mana_ledger (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delta         INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    reason        TEXT    NOT NULL,
    source_kind   TEXT,
    source_id     INTEGER,
    created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ledger_user ON mana_ledger(user_id, created_at);

CREATE TABLE IF NOT EXISTS strikes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    quest_id   INTEGER REFERENCES quests(id) ON DELETE SET NULL,
    category   TEXT    NOT NULL,
    created_at INTEGER NOT NULL
);

-- Escalation reads this by user and time window.
CREATE INDEX IF NOT EXISTS idx_strikes_window ON strikes(user_id, created_at);

CREATE TABLE IF NOT EXISTS sessions (
    sid     TEXT    PRIMARY KEY,
    expires INTEGER NOT NULL,
    data    TEXT    NOT NULL
);
`;

db.exec(SCHEMA);

module.exports = db;
module.exports.DB_PATH = DB_PATH;
