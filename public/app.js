'use strict';

/**
 * Questism player client (Ascent).
 *
 * Draws the game; never decides it. Level, EXP, Mana and lock status all come
 * from the server on every response. Completion and penalty proof go to an
 * agent's review queue, so this client also renders the in-between "awaiting
 * review" states and polls for the agent's verdict.
 */

const el = (id) => document.getElementById(id);
const CAT = { mind: 'Mind', body: 'Body', discipline: 'Discipline', craft: 'Craft' };
const GLYPH = {
    mind: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><ellipse cx="12" cy="12" rx="10" ry="4.6"/></svg>',
    body: '<svg viewBox="0 0 24 24"><path d="M12 2 5 13h5l-1.5 9L19 10h-5.5L15 2z"/></svg>',
    discipline: '<svg viewBox="0 0 24 24"><path d="M12 2 3 6v6c0 5 3.8 9.2 9 10 5.2-.8 9-5 9-10V6z"/></svg>',
    craft: '<svg viewBox="0 0 24 24"><path d="M12 2 22 12 12 22 2 12z"/></svg>',
};

let selectedCat = null;
let currentPenalty = null;
let lastLevel = null;
let activeProofQuestId = null;
let pollTimer = null;

// --- transport --------------------------------------------------------------

async function api(path, options = {}) {
    const res = await fetch(path, { credentials: 'same-origin', ...options });
    if (res.status === 401) { window.location.href = '/login'; throw new Error('unauth'); }
    const data = await res.json().catch(() => ({}));
    if (res.status === 423) {
        if (data.penalty) openPenalty(data.penalty);
        const e = new Error(data.message || 'Locked'); e.locked = true; e.data = data; throw e;
    }
    if (!res.ok) { const e = new Error(data.message || 'Request failed'); e.data = data; throw e; }
    return data;
}

// --- helpers ----------------------------------------------------------------

let toastTimer;
function toast(text) {
    const t = el('toast'); t.textContent = text;
    t.classList.remove('in'); void t.offsetWidth; t.classList.add('in');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('in'), 2800);
}

function msg(box, text) { box.textContent = text; box.hidden = false; }
function clearMsg(box) { box.hidden = true; }

function remaining(dueAt) {
    const ms = dueAt - Date.now();
    if (ms <= 0) return ['OVERDUE', 'crit'];
    const m = Math.floor(ms / 60000), h = Math.floor(m / 60);
    if (h >= 24) return [`${Math.floor(h / 24)}d ${h % 24}h left`, ''];
    if (h >= 1) return [`${h}h ${m % 60}m left`, h < 2 ? 'tight' : ''];
    return [`${m}m left`, 'crit'];
}

// --- deterministic mirrors of the server rules (for live validation) --------

function countWords(t) { return (String(t).toLowerCase().match(/[a-z0-9'’-]+/g) || []).length; }
function countFacts(t) {
    return String(t).split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim())
        .filter((s) => /\d/.test(s) && countWords(s) >= 4).length;
}
function countSources(t) {
    const u = {}; let n = 0;
    (String(t).match(/https?:\/\/[^\s<>"')]+/gi) || []).forEach((x) => {
        const k = x.replace(/[.,;]+$/, '').toLowerCase(); if (!u[k]) { u[k] = 1; n += 1; }
    });
    return n + (String(t).match(/^\s*(?:source|ref|reference|book|paper)\s*[:\-–]\s*\S+/gim) || []).length;
}

// --- rendering: player + gates ---------------------------------------------

function renderPlayer(p) {
    el('hero-name').textContent = p.displayName;
    el('level').textContent = p.level;
    el('floor').textContent = `Floor ${p.rankTitle[0]} · ${p.rankTitle}`;
    el('hero-exp').textContent = `${p.currentExp} / ${p.maxExp} EXP`;
    el('orb').style.setProperty('--exp', `${Math.min(100, (p.currentExp / p.maxExp) * 100)}%`);
    el('str').textContent = p.stats.str;
    el('int').textContent = p.stats.int;
    el('vit').textContent = p.stats.vit;
    el('mana').textContent = p.mana;

    if (lastLevel !== null && p.level > lastLevel) arise(p);
    lastLevel = p.level;
}

function gateNode(q, reviewing) {
    const g = document.createElement('div');
    g.className = `gate ${reviewing ? 'reviewing' : ''}`;
    g.dataset.cat = q.category; g.dataset.id = q.id;
    const [lt, cls] = remaining(q.dueAt);

    const node = document.createElement('div');
    node.className = 'gate-node';
    node.innerHTML = GLYPH[q.category] || '';

    const card = document.createElement('div');
    card.className = 'gate-card';

    const body = document.createElement('div');
    const text = document.createElement('div');
    text.className = 'gate-text';
    text.textContent = q.text;
    const meta = document.createElement('div');
    meta.className = 'gate-meta';
    meta.innerHTML = `<span class="cat">${CAT[q.category] || q.category}</span> · `
        + (reviewing ? '<span>with the agent</span>' : `<span class="lt ${cls}">${lt}</span> · +${q.expReward} EXP · +${q.manaReward} Mana`);
    body.append(text, meta);

    const acts = document.createElement('div');
    if (reviewing) {
        const badge = document.createElement('span');
        badge.className = 'review-badge';
        badge.textContent = 'Under review';
        acts.appendChild(badge);
    } else {
        acts.className = 'gate-acts';
        const done = document.createElement('button');
        done.className = 'done'; done.title = 'Clear (submit proof)';
        done.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 12.5 9.5 18 20 6.5"/></svg>';
        done.addEventListener('click', () => openQuestProof(q));
        const quit = document.createElement('button');
        quit.className = 'quit'; quit.title = 'Give up';
        quit.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
        quit.addEventListener('click', () => failQuest(q.id));
        acts.append(done, quit);
    }

    card.append(body, acts);
    g.append(node, card);
    return g;
}

function renderGates(active, reviewing) {
    const list = el('gates');
    list.replaceChildren();
    el('active-count').textContent = active.length ? `· ${active.length}` : '';
    if (!active.length) {
        const e = document.createElement('p'); e.className = 'empty';
        e.textContent = 'No open gates. Declare one to ascend.';
        list.appendChild(e);
    } else {
        active.forEach((q) => list.appendChild(gateNode(q, false)));
    }

    const rlist = el('review-gates');
    rlist.replaceChildren();
    if (reviewing.length) {
        el('review-section').classList.remove('hidden');
        reviewing.forEach((q) => rlist.appendChild(gateNode(q, true)));
    } else {
        el('review-section').classList.add('hidden');
    }
}

function arise(p) {
    el('lu-sub').textContent = `You have reached Level ${p.level} — ${p.rankTitle}`;
    el('lu-str').textContent = p.stats.str;
    el('lu-int').textContent = p.stats.int;
    el('lu-vit').textContent = p.stats.vit;
    el('levelup').classList.add('on');
    setTimeout(() => el('levelup').classList.remove('on'), 3400);
}

// --- deadline pressure ------------------------------------------------------

function paintDeadline(active) {
    // Soonest deadline drives the clock and the ambient pressure.
    if (!active.length) { el('clock').textContent = '—'; document.documentElement.setAttribute('data-pressure', 'calm'); return; }
    const soonest = active.reduce((a, b) => (a.dueAt < b.dueAt ? a : b));
    const ms = Math.max(0, soonest.dueAt - Date.now());
    const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
    el('clock').textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    const hours = ms / 3600000;
    document.documentElement.setAttribute('data-pressure', hours < 1 ? 'crit' : hours < 2 ? 'warn' : 'calm');
}

// --- load / poll ------------------------------------------------------------

let latestActive = [];
async function load() {
    try {
        const data = await api('/api/quests');
        el('penalty').classList.remove('on'); currentPenalty = null;
        renderPlayer(data.player);
        latestActive = data.active;
        const reviewing = (data.recent || []).filter((q) => q.status === 'pending_review');
        renderGates(data.active, reviewing);
        paintDeadline(data.active);
    } catch (err) {
        if (!err.locked && err.message !== 'unauth') toast(err.message);
    }
}

// --- composer ---------------------------------------------------------------

Array.prototype.forEach.call(el('sigils').children, (btn) => {
    btn.addEventListener('click', () => {
        const cat = btn.getAttribute('data-cat');
        selectedCat = selectedCat === cat ? null : cat;
        Array.prototype.forEach.call(el('sigils').children, (b) => {
            b.setAttribute('aria-pressed', String(b === btn && selectedCat !== null));
        });
        el('sigil-hint').textContent = selectedCat
            ? `${CAT[selectedCat]} gate — a failed one returns a ${CAT[selectedCat].toLowerCase()} penalty.`
            : 'Pick a discipline, or leave it and the System will read your intent.';
    });
});

async function addQuest() {
    const input = el('quest-input');
    const text = input.value.trim();
    if (!text) return;
    clearMsg(el('quest-message'));
    el('add-btn').disabled = true;
    try {
        await api('/api/quests', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, category: selectedCat || undefined }),
        });
        input.value = '';
        toast('A gate has appeared · due at midnight');
        await load();
    } catch (err) {
        if (!err.locked) msg(el('quest-message'), err.message);
    } finally {
        el('add-btn').disabled = false;
    }
}
el('add-btn').addEventListener('click', addQuest);
el('quest-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addQuest(); });

// --- quest proof modal ------------------------------------------------------

let qpFile = null;
function openQuestProof(q) {
    activeProofQuestId = q.id;
    qpFile = null;
    el('qp-task').textContent = q.text;
    el('qp-reward').textContent = `+${q.expReward} EXP · +${q.manaReward} Mana`;
    el('qp-notes').value = '';
    el('qp-drop').classList.remove('filled');
    el('qp-drop-label').textContent = 'Drop a photo or file, or click to choose (optional)';
    clearMsg(el('qp-message'));
    el('quest-proof').classList.add('on');
    setTimeout(() => el('qp-notes').focus(), 300);
}
function closeQuestProof() { el('quest-proof').classList.remove('on'); activeProofQuestId = null; }
el('qp-cancel').addEventListener('click', closeQuestProof);

wireDrop(el('qp-drop'), (f) => {
    qpFile = f;
    el('qp-drop').classList.add('filled');
    el('qp-drop-label').textContent = `${f.name} · ready`;
});

el('qp-submit').addEventListener('click', async () => {
    const notes = el('qp-notes').value.trim();
    if (!notes && !qpFile) { msg(el('qp-message'), 'Add a note or a file as proof.'); return; }
    el('qp-submit').disabled = true;
    const form = new FormData();
    form.append('notes', notes);
    if (qpFile) form.append('file', qpFile);
    try {
        await api(`/api/quests/${activeProofQuestId}/complete`, { method: 'POST', body: form });
        closeQuestProof();
        toast('Proof submitted · awaiting the agent');
        await load();
    } catch (err) {
        if (!err.locked) msg(el('qp-message'), err.message);
    } finally {
        el('qp-submit').disabled = false;
    }
});

// --- give up → penalty ------------------------------------------------------

async function failQuest(id) {
    if (!window.confirm('Give up on this gate? You lose 25 EXP and the System locks until you clear a penalty.')) return;
    try {
        await api(`/api/quests/${id}/fail`, { method: 'POST' });
    } catch (err) {
        if (!err.locked) toast(err.message);
    }
}

// --- penalty takeover -------------------------------------------------------

let penFile = null;
function openPenalty(penalty) {
    currentPenalty = penalty;
    el('pen-sub').textContent = `${CAT[penalty.category] || penalty.category} · Severity ${penalty.severity} of 3 · ${penalty.durationMinutes} min`;
    el('pen-task').textContent = penalty.task;

    // Awaiting-review vs proof-form state.
    const awaiting = penalty.status === 'submitted';
    el('pen-awaiting').classList.toggle('hidden', !awaiting);
    el('pen-form').classList.toggle('hidden', awaiting);

    if (!awaiting) buildChecks(penalty);
    el('penalty').classList.add('on');
}

function buildChecks(penalty) {
    penFile = null;
    el('pen-notes').value = '';
    clearMsg(el('pen-message'));
    const rules = penalty.rules || {};
    const needFile = !!rules.requireFile;
    el('pen-drop').classList.toggle('hidden', !needFile);
    el('pen-drop').classList.remove('filled');
    el('pen-drop-label').textContent = 'Drop evidence, or click to choose';

    const checks = el('pen-checks');
    checks.replaceChildren();
    const rows = [];
    if (rules.minWords) rows.push(['words', `At least ${rules.minWords} words in your notes`, rules.minWords]);
    if (rules.minFacts) rows.push(['facts', `${rules.minFacts} concrete facts — a sentence with a number`, rules.minFacts]);
    if (rules.minSources) rows.push(['sources', `${rules.minSources} sources — a link or "Source:" line`, rules.minSources]);
    if (needFile) rows.push(['file', 'A photo or file attached', 1]);

    rows.forEach(([rule, label, need]) => {
        const row = document.createElement('div');
        row.className = 'check'; row.dataset.rule = rule; row.dataset.need = need;
        row.innerHTML = `<span class="check-box"><svg viewBox="0 0 24 24"><path d="M4 12.5 9.5 18 20 6.5"/></svg></span>`
            + `<span class="check-text">${label}</span><span class="check-count"><span class="cur">0</span>/${need}</span>`;
        checks.appendChild(row);
    });
    runPenChecks();
}

function runPenChecks() {
    const t = el('pen-notes').value;
    const got = { words: countWords(t), facts: countFacts(t), sources: countSources(t), file: penFile ? 1 : 0 };
    let allMet = true;
    Array.prototype.forEach.call(el('pen-checks').children, (row) => {
        const rule = row.dataset.rule, need = Number(row.dataset.need), have = got[rule] || 0;
        const met = have >= need;
        row.classList.toggle('met', met);
        row.style.setProperty('--pct', `${Math.min(100, (have / need) * 100)}%`);
        row.querySelector('.cur').textContent = have;
        if (!met) allMet = false;
    });
    // Submit stays enabled once there is real content — the agent decides;
    // the checklist mirrors the server's advisory pre-check.
    el('pen-submit').disabled = countWords(t) === 0 && !penFile;
    return allMet;
}
el('pen-notes').addEventListener('input', runPenChecks);

wireDrop(el('pen-drop'), (f) => {
    penFile = f;
    el('pen-drop').classList.add('filled');
    el('pen-drop-label').textContent = `${f.name} · ready`;
    runPenChecks();
});

el('pen-submit').addEventListener('click', async () => {
    el('pen-submit').disabled = true;
    const form = new FormData();
    form.append('notes', el('pen-notes').value);
    if (penFile) form.append('file', penFile);
    try {
        const res = await fetch('/api/penalties/current/proof', { method: 'POST', body: form, credentials: 'same-origin' });
        const data = await res.json().catch(() => ({}));
        if (res.status === 202) {
            // Submitted for review — still locked. Flip to the awaiting state.
            el('pen-awaiting').classList.remove('hidden');
            el('pen-form').classList.add('hidden');
            toast('Proof submitted · awaiting the agent');
        } else if (res.status === 429) {
            msg(el('pen-message'), data.message); el('pen-submit').disabled = false;
        } else {
            msg(el('pen-message'), data.message || 'Submission failed.'); el('pen-submit').disabled = false;
        }
    } catch (err) {
        msg(el('pen-message'), 'Cannot reach the System.'); el('pen-submit').disabled = false;
    }
});

// Poll the penalty while locked so an agent's approval unlocks the screen.
async function pollPenalty() {
    if (!currentPenalty) return;
    try {
        const data = await api('/api/penalties/current');
        if (!data.penalty) { el('penalty').classList.remove('on'); currentPenalty = null; toast('Penalty cleared · System unlocked'); load(); return; }
        if (data.penalty.status !== 'submitted' && el('pen-awaiting').classList.contains('hidden') === false) {
            // Rejected → back to a fresh proof form, with the agent's note.
            openPenalty(data.penalty);
            if (data.lastReviewNote) msg(el('pen-message'), `Agent: ${data.lastReviewNote}`);
        }
    } catch (err) { /* still locked; try again next tick */ }
}

// --- misc -------------------------------------------------------------------

function wireDrop(zone, onFile) {
    const pick = document.createElement('input');
    pick.type = 'file'; pick.accept = 'image/*,video/*,application/pdf'; pick.style.display = 'none';
    zone.appendChild(pick);
    zone.addEventListener('click', () => pick.click());
    pick.addEventListener('change', () => { if (pick.files[0]) onFile(pick.files[0]); });
    ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('over'); }));
    zone.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) onFile(f); });
}

async function logout() {
    try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); }
    finally { window.location.href = '/login'; }
}
el('logout').addEventListener('click', logout);
el('pen-logout').addEventListener('click', logout);

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeQuestProof(); el('levelup').classList.remove('on'); }
});

// tick the clock every second; reload / re-poll on a slower cadence so agent
// verdicts and passing deadlines surface without a manual refresh.
setInterval(() => paintDeadline(latestActive), 1000);
setInterval(() => { if (currentPenalty) pollPenalty(); else if (!el('quest-proof').classList.contains('on')) load(); }, 12000);

load();
setTimeout(() => toast('System online · welcome, Hunter'), 500);
