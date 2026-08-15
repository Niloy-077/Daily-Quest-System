'use strict';

/**
 * Agent console. Reads the review queue and posts approve/reject verdicts.
 * The server enforces the agent role — this page is only the operator's view;
 * a player who opens /admin gets 403 from every call and is bounced to login.
 */

const el = (id) => document.getElementById(id);
const CAT = { mind: 'Mind', body: 'Body', discipline: 'Discipline', craft: 'Craft' };

let toastTimer;
function toast(text) {
    const t = el('toast'); t.textContent = text;
    t.classList.remove('in'); void t.offsetWidth; t.classList.add('in');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('in'), 2400);
}

async function api(path, options) {
    const res = await fetch(path, { credentials: 'same-origin', ...options });
    if (res.status === 401) { window.location.href = '/login'; throw new Error('unauth'); }
    if (res.status === 403) { window.location.href = '/'; throw new Error('forbidden'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.message || 'Request failed.'), { data });
    return data;
}

function evidenceNode(file) {
    const wrap = document.createElement('div');
    wrap.className = 'rev-evidence';
    const url = `/api/admin/evidence/${encodeURIComponent(file.path)}`;
    if (file.mime && file.mime.startsWith('image/')) {
        const img = document.createElement('img');
        img.src = url; img.alt = 'submitted evidence';
        wrap.appendChild(img);
    } else {
        const a = document.createElement('a');
        a.href = url; a.target = '_blank'; a.rel = 'noopener';
        a.textContent = `Open evidence file (${file.name || file.mime || 'file'})`;
        wrap.appendChild(a);
    }
    return wrap;
}

function card(sub) {
    const c = document.createElement('div');
    c.className = 'rev-card'; c.dataset.kind = sub.kind;

    const head = document.createElement('div');
    head.className = 'rev-head';
    const who = document.createElement('div');
    who.className = 'who';
    who.append(document.createTextNode('Player: '));
    const b = document.createElement('b');
    b.textContent = sub.player.displayName || sub.player.username;
    who.append(b, document.createTextNode(` (@${sub.player.username})`));
    const tag = document.createElement('span');
    tag.className = 'kind-tag';
    tag.textContent = sub.kind === 'quest' ? 'Quest completion' : `Penalty · Sev ${sub.target.severity || 1}`;
    head.append(who, tag);

    const target = document.createElement('div');
    target.className = 'rev-target';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = sub.kind === 'quest' ? 'Claimed complete' : 'Penalty task';
    const txt = document.createElement('div');
    txt.textContent = sub.target.text;
    const cat = document.createElement('span');
    cat.className = 'cat';
    cat.textContent = CAT[sub.target.category] || sub.target.category || '';
    target.append(label, txt, cat);

    c.append(head, target);

    if (sub.notes && sub.notes.trim()) {
        const notes = document.createElement('div');
        notes.className = 'rev-notes';
        notes.textContent = sub.notes;
        c.appendChild(notes);
    }
    if (sub.file) c.appendChild(evidenceNode(sub.file));

    const pre = document.createElement('div');
    pre.className = `precheck ${sub.precheck.pass ? 'pass' : 'fail'}`;
    const ptag = document.createElement('span');
    ptag.className = 'tag';
    ptag.textContent = sub.precheck.pass ? 'AUTO ✓' : 'AUTO ⚠';
    const pbody = document.createElement('div');
    const psum = document.createElement('div');
    psum.textContent = sub.precheck.summary || (sub.precheck.pass ? 'Checks passed.' : 'Needs a look.');
    pbody.appendChild(psum);
    if (sub.precheck.reasons && sub.precheck.reasons.length) {
        const ul = document.createElement('ul');
        sub.precheck.reasons.forEach((r) => { const li = document.createElement('li'); li.textContent = r; ul.appendChild(li); });
        pbody.appendChild(ul);
    }
    pre.append(ptag, pbody);
    c.appendChild(pre);

    const actions = document.createElement('div');
    actions.className = 'rev-actions';
    const note = document.createElement('input');
    note.type = 'text'; note.placeholder = 'Optional note to the player…'; note.maxLength = 500;
    const approve = document.createElement('button');
    approve.className = 'btn small';
    approve.textContent = sub.kind === 'quest' ? 'Approve · reward' : 'Approve · unlock';
    const reject = document.createElement('button');
    reject.className = 'btn danger small';
    reject.textContent = 'Reject';
    approve.addEventListener('click', () => verdict(sub.id, 'approve', note.value, approve, reject));
    reject.addEventListener('click', () => verdict(sub.id, 'reject', note.value, approve, reject));
    actions.append(note, approve, reject);
    c.appendChild(actions);
    return c;
}

async function verdict(id, action, note, ...buttons) {
    buttons.forEach((b) => { b.disabled = true; });
    try {
        await api(`/api/admin/review/${id}/${action}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ note }),
        });
        toast(action === 'approve' ? 'Approved' : 'Rejected');
        load();
    } catch (err) {
        toast(err.message || 'Failed');
        buttons.forEach((b) => { b.disabled = false; });
    }
}

async function load() {
    try {
        const data = await api('/api/admin/review');
        const queue = el('queue');
        queue.replaceChildren();
        el('count').textContent = data.queue.length;
        if (!data.queue.length) {
            const e = document.createElement('p');
            e.className = 'empty';
            e.textContent = 'The queue is clear. Nothing awaiting review.';
            queue.appendChild(e);
            return;
        }
        data.queue.forEach((sub) => queue.appendChild(card(sub)));
    } catch (err) {
        if (err.message !== 'unauth' && err.message !== 'forbidden') toast('Could not load the queue.');
    }
}

el('refresh').addEventListener('click', load);
el('logout').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    window.location.href = '/login';
});

load();
setInterval(load, 15000);
