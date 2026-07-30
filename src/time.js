'use strict';

/**
 * Timezone maths without a date library.
 *
 * A quest's deadline defaults to the end of the *player's own* day, not the
 * server's. A player in Dhaka and a server in UTC are six hours apart, so
 * getting this wrong would either fail quests early or hand out six free
 * hours every night.
 */

const MINUTE_MS = 60 * 1000;

function isValidTimezone(tz) {
    if (typeof tz !== 'string' || !tz) return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

function safeZone(tz) {
    return isValidTimezone(tz) ? tz : 'UTC';
}

const partsCache = new Map();
function formatterFor(tz) {
    let fmt = partsCache.get(tz);
    if (!fmt) {
        fmt = new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            hourCycle: 'h23',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
        });
        partsCache.set(tz, fmt);
    }
    return fmt;
}

/** The wall-clock fields an instant shows in the given zone. */
function wallClockIn(timestamp, tz) {
    const parts = formatterFor(tz).formatToParts(timestamp);
    const out = {};
    for (const part of parts) {
        if (part.type !== 'literal') out[part.type] = Number(part.value);
    }
    return out;
}

/** Zone offset from UTC, in milliseconds, at a particular instant. */
function offsetMsAt(timestamp, tz) {
    const w = wallClockIn(timestamp, tz);
    const asIfUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
    return asIfUtc - Math.floor(timestamp / 1000) * 1000;
}

/**
 * The UTC instant at which the given wall-clock time occurs in `tz`.
 *
 * Iterates because the offset depends on the instant we are still solving for —
 * two passes settle it, including across a daylight-saving boundary.
 */
function zonedWallClockToUtc(year, month, day, hour, minute, second, tz) {
    const naive = Date.UTC(year, month - 1, day, hour, minute, second);
    let guess = naive;
    for (let i = 0; i < 3; i += 1) {
        const next = naive - offsetMsAt(guess, tz);
        if (next === guess) break;
        guess = next;
    }
    return guess;
}

/**
 * The last millisecond of the player's current local day.
 *
 * Computed as (next local midnight − 1 ms) rather than "now + 24h", so every
 * quest created today shares one deadline and the day genuinely rolls over at
 * midnight where the player lives.
 */
function endOfLocalDay(timestamp, timezone) {
    const tz = safeZone(timezone);
    const w = wallClockIn(timestamp, tz);
    // Date.UTC normalises an out-of-range day, so day + 1 rolls the month and
    // year correctly on the last day of either.
    return zonedWallClockToUtc(w.year, w.month, w.day + 1, 0, 0, 0, tz) - 1;
}

/** Human-facing countdown, e.g. "4h 12m left" or "overdue". */
function describeRemaining(dueAt, now = Date.now()) {
    const remaining = dueAt - now;
    if (remaining <= 0) return 'overdue';

    const minutes = Math.floor(remaining / MINUTE_MS);
    const hours = Math.floor(minutes / 60);
    if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h left`;
    if (hours >= 1) return `${hours}h ${minutes % 60}m left`;
    return `${minutes}m left`;
}

module.exports = {
    isValidTimezone,
    safeZone,
    wallClockIn,
    offsetMsAt,
    zonedWallClockToUtc,
    endOfLocalDay,
    describeRemaining,
};
