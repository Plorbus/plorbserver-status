import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, formatPercent, historyBar, isStale } from '../site/format.js';

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

test('historyBar has one cell per day, oldest first, ending today', () => {
  const days = [
    { date: '2026-11-01', up_pct: 100, avg_ms: 120 },
    { date: '2026-11-02', up_pct: 50, avg_ms: 130 },
    { date: '2026-10-31', up_pct: 0, avg_ms: null },
  ];
  const cells = historyBar(days, Date.parse('2026-11-02T12:00:00Z'), 4);
  assert.deepEqual(cells.map((c) => c.date), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  assert.deepEqual(cells.map((c) => c.char).join(''), '░▁█▄');
  assert.equal(cells[0].label, '2026-10-30: no data');
  assert.equal(cells[3].label, '2026-11-02: 50% up');
});

test('isStale after 30 minutes without a check', () => {
  const now = Date.parse('2026-11-02T12:00:00Z');
  assert.equal(isStale('2026-11-02T11:30:00Z', now), false);
  assert.equal(isStale('2026-11-02T11:29:59Z', now), true);
  assert.equal(isStale(null, now), true);
});
