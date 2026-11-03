import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, formatPercent, dailyUptime, isStale, serviceLines } from '../site/format.js';

test('formatDuration picks the two largest units', () => {
  assert.equal(formatDuration(0), '0 seconds');
  assert.equal(formatDuration(1), '1 second');
  assert.equal(formatDuration(59), '59 seconds');
  assert.equal(formatDuration(60), '1 minute');
  assert.equal(formatDuration(3 * 3600 + 2 * 60 + 9), '3 hours 2 minutes');
  assert.equal(formatDuration(86400), '1 day');
  assert.equal(formatDuration(53 * 86400 + 4 * 3600 + 59), '53 days 4 hours');
});

test('formatDuration never shows negative time (clock skew)', () => {
  assert.equal(formatDuration(-30), '0 seconds');
});

test('formatPercent', () => {
  assert.equal(formatPercent(100), '100%');
  assert.equal(formatPercent(99.65), '99.65%');
  assert.equal(formatPercent(null), 'no data yet');
});

test('dailyUptime lists days that have checks, newest first, as percentages', () => {
  const days = [
    { date: '2026-11-01', up_pct: 100, avg_ms: 120 },
    { date: '2026-11-02', up_pct: 99.65, avg_ms: 130 },
    { date: '2026-10-31', up_pct: 0, avg_ms: null },
  ];
  assert.deepEqual(dailyUptime(days), [
    '2026-11-02: 99.65%',
    '2026-11-01: 100%',
    '2026-10-31: 0%',
  ]);
});

test('dailyUptime keeps at most 30 days and handles none', () => {
  const days = Array.from({ length: 35 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, up_pct: 100 }));
  assert.equal(dailyUptime(days).length, 30);
  assert.equal(dailyUptime(days)[0], '2026-10-35: 100%');
  assert.deepEqual(dailyUptime([]), []);
});

test('isStale after 30 minutes without a check', () => {
  const now = Date.parse('2026-11-02T12:00:00Z');
  assert.equal(isStale('2026-11-02T11:30:00Z', now), false);
  assert.equal(isStale('2026-11-02T11:29:59Z', now), true);
  assert.equal(isStale(null, now), true);
});

test('serviceLines gives each hosted thing a plain-English line', () => {
  const lines = serviceLines({
    'email-pixel-tracker': { up: true, uptime: { '24h': 100, '7d': 99.5, '30d': 99.9 } },
    nginx: { up: false, uptime: { '24h': 50, '7d': 90, '30d': 97 } },
    minecraft: { up: null, uptime: { '24h': null, '7d': null, '30d': null } },
  });
  assert.deepEqual(lines, [
    'Email tracker: up. Uptime 100% (24 hours), 99.5% (7 days), 99.9% (30 days)',
    'Website (nginx): DOWN. Uptime 50% (24 hours), 90% (7 days), 97% (30 days)',
    'Minecraft server: no data yet',
  ]);
});

test('serviceLines copes with a missing services section (older data)', () => {
  assert.deepEqual(serviceLines(undefined), []);
});
