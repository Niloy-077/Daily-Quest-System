'use strict';

const db = require('./db');
const quests = require('./quests');
const mana = require('./mana');

/**
 * The review queue.
 *
 * A submission is a claim plus evidence, waiting for an admin's verdict.
 * Creating one never grants anything — it only moves the quest or penalty into
 * a "pending review" state and drops a row in the queue. Reward and unlock
 * happen exactly once, inside `approve`, in a single transaction, so a crash
 * between "approved" and "rewarded" is not a state the database can hold.
 */

const stmt = {
    insert: db.prepare(`
        INSERT INTO submissions
            (user_id, kind, quest_id, penalty_id, notes, stored_path, original_name,
             mime, size, sha256, precheck_pass, precheck_json, status, submitted_at)
        VALUES (@user_id, @kind, @quest_id, @penalty_id, @notes, @stored_path, @original_name,
                @mime, @size, @sha256, @precheck_pass, @precheck_json, 'pending', @submitted_at)
    `),
    byId: db.prepare('SELECT * FROM submissions WHERE id = ?'),
    setQuestStatus: db.prepare('UPDATE quests SET status = ? WHERE id = ? AND user_id = ?'),
    questById: db.prepare('SELECT * FROM quests WHERE id = ?'),
    penaltyById: db.prepare('SELECT * FROM penalties WHERE id = ?'),
    approvePenalty: db.prepare("UPDATE penalties SET status = 'approved', resolved_at = ? WHERE id = ?"),
    reopenPenalty: db.prepare("UPDATE penalties SET status = 'pending' WHERE id = ?"),
    resolveSub: db.prepare(`
        UPDATE submissions SET status = ?, reviewer_id = ?, review_note = ?, reviewed_at = ?
        WHERE id = ? AND status = 'pending'
    `),
    pending: db.prepare(`
        SELECT s.*, u.username, u.display_name,
               q.text AS quest_text, q.category AS quest_category,
               p.task_text AS penalty_task, p.category AS penalty_category, p.severity
        FROM submissions s
        JOIN users u ON u.id = s.user_id
        LEFT JOIN quests q   ON q.id = s.quest_id
        LEFT JOIN penalties p ON p.id = s.penalty_id
        WHERE s.status = 'pending'
        ORDER BY s.submitted_at ASC
    `),
    recentForUser: db.prepare(`
        SELECT id, kind, status, review_note, submitted_at, reviewed_at
        FROM submissions WHERE user_id = ? ORDER BY submitted_at DESC LIMIT 20
    `),
};

function baseRow({ userId, kind, questId, penaltyId, notes, fileMeta, precheck, now }) {
    return {
        user_id: userId,
        kind,
        quest_id: questId || null,
        penalty_id: penaltyId || null,
        notes: String(notes || '').slice(0, 20000),
        stored_path: fileMeta ? fileMeta.storedPath : null,
        original_name: fileMeta ? String(fileMeta.originalName || '').slice(0, 200) : null,
        mime: fileMeta ? fileMeta.mime : null,
        size: fileMeta ? fileMeta.size : null,
        sha256: fileMeta ? fileMeta.sha256 : null,
        precheck_pass: precheck.pass ? 1 : 0,
        precheck_json: JSON.stringify(precheck),
        submitted_at: now,
    };
}

/**
 * A player claims a quest is done and attaches evidence.
 *
 * The quest moves to 'pending_review'. It earns nothing yet — that waits on
 * the admin. The quest is locked out of a second claim in the meantime.
 */
function submitQuestProof({ userId, questId, notes, fileMeta, precheck, now = Date.now() }) {
    const quest = stmt.questById.get(questId);
    if (!quest || quest.user_id !== userId) {
        throw Object.assign(new Error('Quest not found.'), { status: 404 });
    }
    if (quest.status !== 'active') {
        throw Object.assign(new Error('That quest is not awaiting completion.'), { status: 409 });
    }
    if (quest.due_at <= now) {
        throw Object.assign(new Error('That quest is past its deadline.'), { status: 409 });
    }

    const run = db.transaction(() => {
        stmt.setQuestStatus.run('pending_review', questId, userId);
        const info = stmt.insert.run(baseRow({ userId, kind: 'quest', questId, notes, fileMeta, precheck, now }));
        return stmt.byId.get(info.lastInsertRowid);
    });
    return run();
}

/** A player submits proof that they served their penalty. */
function submitPenaltyProof({ userId, penaltyId, notes, fileMeta, precheck, now = Date.now() }) {
    const penalty = stmt.penaltyById.get(penaltyId);
    if (!penalty || penalty.user_id !== userId) {
        throw Object.assign(new Error('Penalty not found.'), { status: 404 });
    }
    if (penalty.status === 'approved') {
        throw Object.assign(new Error('That penalty is already cleared.'), { status: 409 });
    }

    const run = db.transaction(() => {
        db.prepare("UPDATE penalties SET status = 'submitted' WHERE id = ?").run(penaltyId);
        const info = stmt.insert.run(baseRow({ userId, kind: 'penalty', penaltyId, notes, fileMeta, precheck, now }));
        return stmt.byId.get(info.lastInsertRowid);
    });
    return run();
}

/**
 * Admin approves a submission — the ONLY path that grants a reward or lifts a
 * lock. Quest approval awards EXP and Mana; penalty approval clears the lock.
 */
function approve({ submissionId, reviewerId, note = '', now = Date.now() }) {
    const sub = stmt.byId.get(submissionId);
    if (!sub) throw Object.assign(new Error('Submission not found.'), { status: 404 });
    if (sub.status !== 'pending') throw Object.assign(new Error('Already reviewed.'), { status: 409 });

    const run = db.transaction(() => {
        const changed = stmt.resolveSub.run('approved', reviewerId, note, now, submissionId).changes;
        if (changed === 0) throw Object.assign(new Error('Already reviewed.'), { status: 409 });

        if (sub.kind === 'quest') {
            const quest = stmt.questById.get(sub.quest_id);
            if (!quest) throw Object.assign(new Error('Quest gone.'), { status: 410 });
            stmt.setQuestStatus.run('completed', quest.id, sub.user_id);
            db.prepare('UPDATE quests SET completed_at = ? WHERE id = ?').run(now, quest.id);

            const progress = quests.awardExp(sub.user_id, quest.exp_reward);
            const balance = mana.award({
                userId: sub.user_id,
                delta: quest.mana_reward,
                reason: `Quest cleared: ${quest.text.slice(0, 60)}`,
                sourceKind: 'quest',
                sourceId: quest.id,
                now,
            });
            return { kind: 'quest', progress, manaAwarded: quest.mana_reward, manaBalance: balance };
        }

        // penalty
        stmt.approvePenalty.run(now, sub.penalty_id);
        return { kind: 'penalty', unlocked: true };
    });
    return run();
}

/** Admin rejects — the claim is refused and the player is put back to work. */
function reject({ submissionId, reviewerId, note = '', now = Date.now() }) {
    const sub = stmt.byId.get(submissionId);
    if (!sub) throw Object.assign(new Error('Submission not found.'), { status: 404 });
    if (sub.status !== 'pending') throw Object.assign(new Error('Already reviewed.'), { status: 409 });

    const run = db.transaction(() => {
        const changed = stmt.resolveSub.run('rejected', reviewerId, note, now, submissionId).changes;
        if (changed === 0) throw Object.assign(new Error('Already reviewed.'), { status: 409 });

        if (sub.kind === 'quest') {
            // Back to active. If its deadline has since passed, the sweeper will
            // fail it on the next pass — a refused claim does not buy time.
            stmt.setQuestStatus.run('active', sub.quest_id, sub.user_id);
            return { kind: 'quest' };
        }
        // Penalty stays unresolved: reopen it so the player can submit again.
        stmt.reopenPenalty.run(sub.penalty_id);
        return { kind: 'penalty', stillLocked: true };
    });
    return run();
}

function listPending() {
    return stmt.pending.all().map((s) => ({
        id: s.id,
        kind: s.kind,
        player: { id: s.user_id, username: s.username, displayName: s.display_name },
        notes: s.notes,
        file: s.stored_path
            ? { path: s.stored_path, name: s.original_name, mime: s.mime, size: s.size }
            : null,
        precheck: JSON.parse(s.precheck_json),
        target: s.kind === 'quest'
            ? { text: s.quest_text, category: s.quest_category }
            : { text: s.penalty_task, category: s.penalty_category, severity: s.severity },
        submittedAt: s.submitted_at,
    }));
}

function recentForUser(userId) {
    return stmt.recentForUser.all(userId);
}

module.exports = {
    submitQuestProof,
    submitPenaltyProof,
    approve,
    reject,
    listPending,
    recentForUser,
    _byId: (id) => stmt.byId.get(id),
};
