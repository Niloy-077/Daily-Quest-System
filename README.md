# Questism

A gamified quest tracker, styled as the *System* from Solo Leveling. You
declare daily quests; the System sets a hard deadline; completing one earns
**EXP and Mana** once an agent verifies your proof; missing one drops a
real-world **penalty** and locks the System until you prove you served it.

The enforcement is the point. Level, EXP, Mana and the lock all live on the
server, so the browser can only draw the game — it can never decide it.

---

## The loop

```
Register → declare a quest → deadline (end of your day)
   ├─ claim complete + submit proof → AGENT REVIEW QUEUE
   │       agent approves → +EXP, +Mana (reward ledger)
   │       agent rejects  → back to active, no reward
   └─ miss the deadline → the System auto-fails it → PENALTY → LOCKED (423)
           submit penalty proof → AGENT REVIEW QUEUE
               agent approves → System unlocked
               agent rejects  → still locked, try again
```

Three actors:

- **Player** — declares quests, submits proof.
- **Agent (admin)** — works the review queue, approving or rejecting proof.
- **The System** (automated) — sets deadlines, auto-fails overdue quests,
  holds the lock. No human in that loop.

---

## Why there is a backend

Questism began as three files served from the browser with all state in
`localStorage`. That version could not enforce anything it claimed:

| Claim | localStorage build | Now |
|---|---|---|
| The lock is inescapable | `localStorage.clear()` ended it | a DB row checked by middleware → **HTTP 423** |
| Completing a quest is earned | one button, instant points | proof → **agent review** → reward |
| A missed quest costs you | a manual "fail" button | the server auto-fails at your midnight |
| Level / EXP / Mana | editable in the console | authoritative in the database |

---

## Running it

```bash
npm install
cp .env.example .env       # set SESSION_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD
npm start                  # http://localhost:3000
npm test                   # 53 tests, no network required
```

The SQLite schema builds itself on first boot. On startup the server ensures
one **agent** account exists (from `ADMIN_USERNAME` / `ADMIN_PASSWORD`) so the
review queue has someone to work it. Players land on the game; the agent is
routed to `/admin`, the review console.

No API key is needed anywhere — the proof pre-check is deterministic.

---

## Roles and the review queue

Completion and penalty proof both flow into **one queue** (`submissions`),
worked by an agent at `/admin`. A single table means one review screen handles
both kinds of evidence and one audit trail records who reviewed what, when.

Every submission carries an **automated pre-check**. It never decides — it runs
the deterministic rules and flags the submission pass/fail so the agent isn't
reading every three-line "trust me" by hand. A later phase can hand the final
call to an AI; this same pre-check becomes its first-pass filter.

| Verdict | Quest submission | Penalty submission |
|---|---|---|
| **Approve** | quest completed, +EXP +Mana | penalty cleared, System unlocked |
| **Reject** | back to active, no reward | stays locked, player may resubmit |

Approval is the **only** path that grants a reward or lifts a lock, and it runs
in one transaction — a crash between "approved" and "rewarded" is not a state
the database can hold.

---

## Mana — the reward ledger

Mana is the in-app reward for completing quests. It is deliberately an
abstraction: every grant is an immutable row in `mana_ledger`, and a balance is
the running total. A later phase can mint a crypto token by *reading* this
ledger — so the reward economy is modelled now, with none of the wallet,
custody or regulatory surface of real tokens in the app yet. Nothing here is
financial.

---

## How the lock holds

Route order in `server.js` *is* the security model:

```
requireAuth       → who are you
sweepMiddleware   → expire anything overdue FIRST
enforceLockdown   → refuse everything while a penalty is unresolved
```

`enforceLockdown` returns **HTTP 423 Locked** for as long as any penalty row is
not `approved`. Only three routes sit ahead of it and stay reachable while
locked: read your penalty, submit penalty proof, log out.

| Escape attempt | What happens |
|---|---|
| `localStorage.clear()` | nothing to clear — no game state in the browser |
| DevTools: hide the overlay | pixels change; every route still answers 423 |
| Delete the cookie | logs you out; the lock waits on return |
| Another browser / machine | same account, same row, same lock |
| Restart the server | sessions and penalties are both on disk |

`tests/review.test.js` asserts each of these.

---

## Deadlines and the sweeper

Every quest is due at the end of **your** day, computed in your own IANA
timezone. The sweeper auto-fails anything still `active` past its deadline, and
runs in three places because each alone leaves a hole: **on boot** (caught up
after downtime), **on a 60s timer** (midnight on a live server), and **on every
request** (a server that idled out can't fire a timer). A quest already in
review is safe — submitting before the deadline is enough; the agent's delay
never costs you.

---

## Penalties are derived and provable

The penalty is drawn from the failed quest's category, not at random, so a
missed study quest returns research, not push-ups. Strikes inside a rolling
7-day window escalate the next penalty through three severity tiers.

A design rule the code holds to: **every penalty must produce evidence the
system can check.** Behavioural streaks ("don't do X for N days") are
unprovable and have no place in the lock — a penalty is only valid if serving
it yields something an agent can look at.

| Failed category | Penalty | Provable by |
|---|---|---|
| Mind | research write-up | 150+ words, 3+ facts, 2+ sources |
| Body | 30 push-ups | photo/video from today + a log |
| Discipline | clean & reset a space | before/after photo |
| Craft | 15 min deliberate practice | the artifact + a log |

The pre-check enforces those thresholds mechanically; magic-byte file typing,
SHA-256 replay detection, EXIF dates and a distinct-word padding check back it
up. The agent makes the final call.

---

## Security

The app is designed to run behind **Cloudflare** as a reverse proxy — which
provides DDoS protection, HTTPS and rate limiting at the edge, before traffic
reaches the origin server. On the origin: bcrypt password hashing (12 rounds),
an httpOnly + SameSite session cookie, session regeneration on login to stop
fixation, uploads stored outside the webroot and served only to an authenticated
agent, and the 423 lockdown.

---

## Schema

| Table | Holds |
|---|---|
| `users` | credentials, **role**, level, EXP, **mana**, stats, timezone |
| `quests` | text, category, EXP + Mana reward, deadline, status |
| `submissions` | the review queue — quest and penalty proof, pre-check, verdict |
| `penalties` | task, category, severity, frozen requirements, status |
| `mana_ledger` | append-only reward record (crypto reads this later) |
| `strikes` | failure history, drives 7-day escalation |
| `sessions` | persisted logins |

---

## API

| Method | Route | Who |
|---|---|---|
| `POST` | `/api/auth/register` · `/login` · `/logout` | anyone |
| `GET` | `/api/auth/me` | logged in |
| `GET` | `/api/quests` | player, unlocked |
| `POST` | `/api/quests` | player, unlocked |
| `POST` | `/api/quests/:id/complete` | player — submits proof for review |
| `POST` | `/api/quests/:id/fail` | player — forfeit → penalty |
| `GET` | `/api/mana` | player, unlocked |
| `GET` | `/api/penalties/current` | reachable while locked |
| `POST` | `/api/penalties/current/proof` | reachable while locked → queue |
| `GET` | `/api/admin/review` | **agent only** |
| `POST` | `/api/admin/review/:id/approve` · `/reject` | **agent only** |
| `GET` | `/api/admin/evidence/:name` | **agent only** |

---

## Roadmap

- **Phase 1 (this build):** accounts, roles, quests, deadlines, sweeper,
  lockdown, agent review queue, Mana ledger. Deployed behind Cloudflare.
- **Phase 2:** AI-assisted review — the deterministic pre-check becomes the
  first-pass filter, the agent keeps the final call, then AI takes over.
- **Phase 3:** tokenize the Mana ledger (crypto); optional habit pledges.

---

## Authors

Course project — Desktop & Web Programming lab.

- **MD Monirul Islam**
- **Mehedi Hasan Niloy**
