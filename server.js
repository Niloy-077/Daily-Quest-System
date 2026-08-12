'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');
const multer = require('multer');

const db = require('./src/db');
const SqliteSessionStore = require('./src/session-store');
const { requireAuth } = require('./src/auth');
const { ensureAdminSeed } = require('./src/roles');
const { enforceLockdown } = require('./src/middleware/lockdown');
const { sweepMiddleware, startSweeper } = require('./src/sweeper');
const authRoutes = require('./src/routes/auth');
const questRoutes = require('./src/routes/quests');
const penaltyRoutes = require('./src/routes/penalties');
const manaRoutes = require('./src/routes/mana');
const adminRoutes = require('./src/routes/admin');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const IN_PRODUCTION = process.env.NODE_ENV === 'production';

if (!process.env.SESSION_SECRET) {
    if (IN_PRODUCTION) {
        console.error('FATAL: SESSION_SECRET must be set in production. See .env.example.');
        process.exit(1);
    }
    console.warn('WARNING: SESSION_SECRET is not set — using a throwaway dev secret.');
    console.warn('         Copy .env.example to .env and set one. Sessions reset on restart.');
}

// Trust the first proxy hop so Secure cookies survive a platform load balancer.
if (IN_PRODUCTION) app.set('trust proxy', 1);

app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));

app.use(session({
    name: 'questism.sid',
    secret: process.env.SESSION_SECRET || require('crypto').randomBytes(32).toString('hex'),
    store: new SqliteSessionStore(),
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
        httpOnly: true,   // JavaScript in the page cannot read or forge it
        sameSite: 'lax',  // not sent on cross-site POSTs, which blunts CSRF
        secure: IN_PRODUCTION,
        maxAge: 7 * 24 * 60 * 60 * 1000,
    },
}));

// --- route order is the security model -------------------------------------
//
//   requireAuth      → who are you
//   sweepMiddleware  → expire anything overdue FIRST, so a deadline that
//                      passed while you were away locks you on this request
//   enforceLockdown  → refuse everything while a penalty is open
//
// Penalty routes are mounted without enforceLockdown, and they are the only
// ones: read your penalty, submit proof, log out. Everything else is sealed.

app.use('/api/auth', authRoutes);

// Agents review the queue; mounted before the player routes and gated by
// requireAdmin inside the router. No lockdown — an agent holds no penalties.
app.use('/api/admin', adminRoutes);

app.use('/api/penalties', requireAuth, sweepMiddleware, penaltyRoutes);

// Mana is the reward wallet — read-only, and blocked under lockdown like the
// rest of the game, so a locked player cannot browse their winnings.
app.use('/api/mana', requireAuth, sweepMiddleware, enforceLockdown, manaRoutes);

app.use('/api/quests', requireAuth, sweepMiddleware, enforceLockdown, questRoutes);

app.get('/api/health', (req, res) => {
    res.json({ ok: true, time: Date.now() });
});

// Route by role. A logged-out visitor goes to login; an agent lands on the
// review dashboard rather than the player's game.
app.get('/', (req, res, next) => {
    if (!req.session || !req.session.userId) return res.redirect('/login');
    const { getUser } = require('./src/auth');
    const user = getUser(req.session.userId);
    if (user && user.role === 'admin') return res.redirect('/admin');
    return next();
});

app.get('/admin', (req, res, next) => {
    if (!req.session || !req.session.userId) return res.redirect('/login');
    return next();
});

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// Unknown API paths get JSON, not the HTML 404 page, so the client's fetch
// error handling stays uniform.
app.use('/api', (req, res) => {
    res.status(404).json({ error: 'not_found', message: 'No such endpoint.' });
});

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);

    // Multer throws before any route handler body runs, so a too-large or
    // malformed upload never reaches a route's own try/catch — it lands here.
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ error: 'too_large', message: 'File is too large.' });
        }
        return res.status(400).json({ error: 'invalid', message: 'Upload rejected: ' + err.message });
    }

    console.error('[error]', err && err.stack ? err.stack : err);
    res.status(500).json({ error: 'server_error', message: 'The System encountered a fault.' });
});

function start() {
    const server = app.listen(PORT, () => {
        console.log('');
        console.log('  ╔════════════════════════════════════════════╗');
        console.log('  ║            Q U E S T I S M                  ║');
        console.log('  ╚════════════════════════════════════════════╝');
        console.log(`  System online     http://localhost:${PORT}`);
        console.log(`  Database          ${db.DB_PATH}`);
        console.log(`  Proof judge       pre-check rules${process.env.ANTHROPIC_API_KEY ? ' + AI' : ''} → agent review`);
        const seed = ensureAdminSeed();
        if (seed) {
            console.log(`  Agent account     @${seed.username}${seed.created ? ' (created)' : ' (ready)'}`);
        } else {
            console.log('  Agent account     none — set ADMIN_USERNAME / ADMIN_PASSWORD in .env');
        }
        startSweeper();
        console.log('');
    });

    const shutdown = () => {
        server.close(() => {
            db.close();
            process.exit(0);
        });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    return server;
}

if (require.main === module) start();

module.exports = { app, start };
