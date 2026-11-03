// Small formatting helpers for the page. No DOM in here, so they can be
// tested with node --test.

const UNITS = [['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]];

const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;

// "53 days 4 hours", "3 hours 2 minutes", "45 seconds"
export function formatDuration(totalSeconds) {
  let rest = Math.max(0, Math.floor(totalSeconds));
  const parts = [];
  for (const [unit, size] of UNITS) {
    const n = Math.floor(rest / size);
    rest -= n * size;
    if (n > 0 || parts.length > 0) parts.push([n, unit]);
    if (parts.length === 2) break;
  }
  if (parts.length === 0) return '0 seconds';
  return parts.filter(([n], i) => i === 0 || n > 0).map(([n, unit]) => plural(n, unit)).join(' ');
}

export function formatPercent(value) {
  return value == null ? 'no data yet' : `${value}%`;
}

// One line per UTC day that has checks, newest first: "2026-11-02: 99.65%".
// Days with no checks are left out rather than listed as "no data".
export function dailyUptime(days, count = 30) {
  return [...days]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, count)
    .map((day) => `${day.date}: ${formatPercent(day.up_pct)}`);
}

// Checks run every 5 minutes; half an hour of silence means the checker
// itself has a problem, which the page should admit.
export function isStale(lastCheckIso, nowMs, maxMinutes = 30) {
  if (!lastCheckIso) return true;
  return nowMs - Date.parse(lastCheckIso) > maxMinutes * 60_000;
}
