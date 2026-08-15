'use strict';

const test = require('node:test');
const assert = require('node:assert');

require('./helpers').useTempDatabase();
const { endOfLocalDay, wallClockIn, isValidTimezone } = require('../src/time');

test('end of day lands on the last millisecond before local midnight', () => {
    const now = Date.UTC(2026, 2, 10, 9, 0, 0);
    const end = endOfLocalDay(now, 'Asia/Dhaka');

    const atEnd = wallClockIn(end, 'Asia/Dhaka');
    assert.strictEqual(atEnd.hour, 23);
    assert.strictEqual(atEnd.minute, 59);
    assert.strictEqual(atEnd.second, 59);

    const justAfter = wallClockIn(end + 1, 'Asia/Dhaka');
    assert.strictEqual(justAfter.hour, 0);
    assert.strictEqual(justAfter.day, atEnd.day + 1);
});

test('the deadline is anchored to the player zone, not the server zone', () => {
    // 20:00 UTC is already the next day in Dhaka (UTC+6), so the two players
    // must get deadlines a day apart.
    const now = Date.UTC(2026, 5, 15, 20, 0, 0);
    const dhaka = endOfLocalDay(now, 'Asia/Dhaka');
    const utc = endOfLocalDay(now, 'UTC');

    assert.ok(dhaka > utc, 'Dhaka player should have the later deadline');
    assert.strictEqual(wallClockIn(dhaka, 'Asia/Dhaka').day, 16);
    assert.strictEqual(wallClockIn(utc, 'UTC').day, 15);
});

test('deadline is always in the future, even at 23:59 local', () => {
    const now = Date.UTC(2026, 0, 1, 17, 59, 0); // 23:59 in Dhaka
    const end = endOfLocalDay(now, 'Asia/Dhaka');
    assert.ok(end > now);
    assert.ok(end - now < 2 * 60 * 1000, 'should be about a minute of runway, not a full day');
});

test('rolls the month and the year correctly', () => {
    const end = endOfLocalDay(Date.UTC(2026, 11, 31, 12, 0, 0), 'UTC');
    const w = wallClockIn(end + 1, 'UTC');
    assert.strictEqual(w.year, 2027);
    assert.strictEqual(w.month, 1);
    assert.strictEqual(w.day, 1);
});

test('survives a daylight-saving transition', () => {
    // US DST began 2026-03-08. The local day is 23 hours long.
    const now = Date.UTC(2026, 2, 8, 12, 0, 0);
    const end = endOfLocalDay(now, 'America/New_York');
    const w = wallClockIn(end, 'America/New_York');
    assert.strictEqual(w.hour, 23);
    assert.strictEqual(w.day, 8);
});

test('an unknown timezone falls back to UTC instead of throwing', () => {
    assert.strictEqual(isValidTimezone('Mars/Olympus_Mons'), false);
    const end = endOfLocalDay(Date.UTC(2026, 4, 1, 10, 0, 0), 'Mars/Olympus_Mons');
    assert.strictEqual(wallClockIn(end, 'UTC').hour, 23);
});
