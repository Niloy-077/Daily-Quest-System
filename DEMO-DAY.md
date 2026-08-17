# Demo Day

## Start fresh

```bash
npm install
npm start                  # http://localhost:3000
```

`data/questism.sqlite` and `uploads/` are already wiped clean — first boot
recreates the schema and seeds the `@agent` account from `.env`
(`ADMIN_USERNAME` / `ADMIN_PASSWORD`). No AI key is set, so proof judging is
100% deterministic — no network call, nothing that can fail on a bad wifi.

Open two browser windows (or one normal + one incognito, since sessions are
cookie-based): one for the player, one for the agent.

## Two-window script

**Window A — player**
1. Go to `http://localhost:3000` → redirected to `/login` → tab **Awaken**,
   register a player account.
2. Type a quest, pick a category sigil (or leave it — the System infers one
   from the wording), hit **Open the gate**.
3. Click the checkmark on the gate → **Clear the gate** modal → write a note
   (or attach a file) → **Submit proof**. Quest moves to "Awaiting the agent."

**Window B — agent**
4. Log in as `ADMIN_USERNAME` / `ADMIN_PASSWORD` from `.env` → lands on
   `/admin`, the review console.
5. The submission appears in the queue with the deterministic pre-check
   verdict shown. Click **Approve · reward**.

**Back to Window A**
6. Refresh (or wait ~12s for the poll) — EXP and Mana are up, the gate is
   gone from the open list.

**Fail path, same player**
7. Open a new gate, then click the ✕ (**Give up**) instead of clearing it —
   confirms the forfeit. The System responds `423 Locked` and the penalty
   takeover screen appears immediately, with a live requirement checklist
   (word count / facts / sources) as you type.
8. Write enough to satisfy the checklist, **Submit proof**.

**Window B — agent**
9. Refresh the queue, the penalty submission is there. **Approve · unlock**.

**Window A**
10. Within ~12s the lock screen clears itself — no manual refresh needed,
    the client is polling `/api/penalties/current`.

## Why does this need a backend at all?

The whole point is that the browser can't be trusted to enforce its own
game. In an earlier version everything — level, EXP, the lock — lived in
`localStorage`, so `localStorage.clear()` or one line typed into DevTools
ended any penalty instantly. Now every one of those facts is a row in a
server-side SQLite database, checked on every request by `enforceLockdown`
before a route handler ever runs — not something the client asserts about
itself. That's also why rewards aren't instant: completing a quest submits
proof into a review queue, and only an admin's approval (server-side, one
transaction) grants EXP and Mana or lifts a lock. If you're asked "couldn't
this just be a frontend app," the answer is: it was, and that version could
not actually stop anyone from cheating.
