'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

/**
 * Point the database at a throwaway file BEFORE any module requires src/db,
 * so tests never touch data/questism.sqlite.
 */
function useTempDatabase() {
    const file = path.join(os.tmpdir(), `questism-test-${crypto.randomBytes(6).toString('hex')}.sqlite`);
    process.env.DB_PATH = file;
    process.env.SESSION_SECRET = 'test-secret';
    process.env.NODE_ENV = 'test';
    delete process.env.ANTHROPIC_API_KEY; // keep the judge deterministic

    process.on('exit', () => {
        for (const suffix of ['', '-wal', '-shm']) {
            try { fs.unlinkSync(file + suffix); } catch { /* already gone */ }
        }
    });

    return file;
}

/** Start the app on an ephemeral port and return a cookie-aware client. */
async function startTestServer() {
    const { app } = require('../server');

    const server = await new Promise((resolve) => {
        const s = app.listen(0, () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}`;

    const makeClient = () => {
        let cookie = '';
        return async function request(pathname, options = {}) {
            const headers = { ...(options.headers || {}) };
            if (cookie) headers.cookie = cookie;

            const response = await fetch(base + pathname, { ...options, headers, redirect: 'manual' });

            const setCookie = response.headers.getSetCookie
                ? response.headers.getSetCookie()
                : [response.headers.get('set-cookie')].filter(Boolean);
            for (const raw of setCookie) {
                const pair = raw.split(';')[0];
                if (pair.startsWith('questism.sid=')) cookie = pair;
            }

            const text = await response.text();
            let body;
            try { body = JSON.parse(text); } catch { body = text; }

            return { status: response.status, body };
        };
    };

    return {
        base,
        client: makeClient,
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}

const json = (payload) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
});

/** Promote an existing account to admin. Lazy-requires db so it binds to the
 *  temp database chosen by useTempDatabase(). */
function promoteToAdmin(username) {
    const db = require('../src/db');
    db.prepare("UPDATE users SET role = 'admin' WHERE username = ?").run(username);
}

/** An 8x8 PNG's worth of bytes — a real image header padded past the min size. */
function pngBuffer(size = 8192) {
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(size, 7),
    ]);
}

/** Build a multipart proof body (notes + optional file) for the request client. */
function proofBody(notes, file) {
    const form = new FormData();
    form.append('notes', notes);
    if (file) {
        form.append('file', new Blob([file], { type: 'image/png' }), 'proof.png');
    }
    return { method: 'POST', body: form };
}

/** Notes that satisfy the severity-1 Mind penalty: 150+ words, 3+ facts, 2+ sources. */
const GOOD_MIND_NOTES = `
Today I researched how sea otters affect kelp forests along the Pacific coast, because
the topic came up while reading about coastal ecosystems and I realised I knew nothing
concrete about it. Sea otters were hunted to near extinction during the maritime fur
trade, and by 1911 fewer than 2000 animals remained worldwide across their entire
historic range. Their disappearance let sea urchin populations expand without check,
and the urchins grazed kelp holdfasts until dense forests collapsed into bare rock
called urchin barrens. An adult sea otter eats roughly 25 percent of its body weight
every single day, which is what makes their predation pressure on urchins so decisive
compared with other predators in the same waters. Where otter populations recovered
after protection, kelp canopy returned within about 10 years and carried roughly 3
times more fish biomass than the barrens it replaced. What surprised me most is that the effect is
better described as a chain of consequences than a simple predator prey pair, and
ecologists use this system as the original textbook example of a keystone species.
I want to read next about whether the same pattern holds in southern hemisphere kelp.

Source: https://www.nationalgeographic.com/animals/mammals/facts/sea-otter
Source: Estes and Palmisano, Sea Otters, Their Role in Structuring Nearshore Communities
`.trim();

module.exports = {
    useTempDatabase, startTestServer, json, GOOD_MIND_NOTES,
    promoteToAdmin, pngBuffer, proofBody,
};
