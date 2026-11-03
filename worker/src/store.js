// Everything the Worker keeps lives in D1 (Cloudflare's SQLite). See
// worker/migrations/0001_init.sql for the tables.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const KEEP_RAW_MS = 48 * HOUR;
export const KEEP_DAYS = 90;
export const BAR_DAYS = 30;

export const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const iso = (ms) => new Date(ms).toISOString();

export function percent({ total, up }) {
  return total ? Math.round((up / total) * 10_000) / 100 : null;
}

// Store one check, count it in its day, and drop anything too old. All in
// one batch, so a failure leaves the tables exactly as they were.
export async function recordCheck(db, check) {
  const up = check.up ? 1 : 0;
  const hasMs = check.ms == null ? 0 : 1;
  return db.batch([
    db.prepare('INSERT OR REPLACE INTO checks (t, up, ms, code, details) VALUES (?, ?, ?, ?, ?)')
      .bind(check.t, up, check.ms ?? null, check.code ?? null, check.details ? JSON.stringify(check.details) : null),
    db.prepare(`INSERT INTO days (date, total, up, ms_sum, ms_n) VALUES (?, 1, ?, ?, ?)
                ON CONFLICT (date) DO UPDATE SET
                  total  = total + 1,
                  up     = up + excluded.up,
                  ms_sum = ms_sum + excluded.ms_sum,
                  ms_n   = ms_n + excluded.ms_n`)
      .bind(dayOf(check.t), up, check.ms ?? 0, hasMs),
    // Keep the newest "up" row even when it's old, so a long outage can
    // still say when the server was last seen up. `IS NOT` (not `<>`) so
    // that when there's no up row at all (NULL), old rows still go.
    db.prepare('DELETE FROM checks WHERE t < ? AND t IS NOT (SELECT MAX(t) FROM checks WHERE up = 1)')
      .bind(check.t - KEEP_RAW_MS),
    db.prepare('DELETE FROM days WHERE date < ?').bind(dayOf(check.t - (KEEP_DAYS - 1) * DAY)),
  ]);
}

// Uptime windows count the checks that actually ran. If Cloudflare skipped
// some runs, those minutes are unknown, not "up" and not "down".
export async function buildSummary(db, now) {
  const latest = await db.prepare('SELECT t, up, ms, code FROM checks ORDER BY t DESC LIMIT 1').first();
  const lastUp = await db.prepare('SELECT t, details FROM checks WHERE up = 1 ORDER BY t DESC LIMIT 1').first();
  const last24h = await db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(up), 0) AS up FROM checks WHERE t > ?')
    .bind(now - 24 * HOUR).first();
  const window = (days) => db.prepare('SELECT COALESCE(SUM(total), 0) AS total, COALESCE(SUM(up), 0) AS up FROM days WHERE date >= ?')
    .bind(dayOf(now - (days - 1) * DAY)).first();
  const { results: days } = await db.prepare('SELECT date, total, up, ms_sum, ms_n FROM days WHERE date >= ? ORDER BY date')
    .bind(dayOf(now - (BAR_DAYS - 1) * DAY)).all();

  return {
    generated_at: iso(now),
    latest: latest && { t: iso(latest.t), up: latest.up === 1, ms: latest.ms, code: latest.code },
    last_up: lastUp && { t: iso(lastUp.t), details: JSON.parse(lastUp.details) },
    uptime: {
      '24h': percent(last24h),
      '7d': percent(await window(7)),
      '30d': percent(await window(30)),
    },
    days: days.map((d) => ({
      date: d.date,
      up_pct: percent(d),
      avg_ms: d.ms_n ? Math.round(d.ms_sum / d.ms_n) : null,
    })),
  };
}

export async function saveSummary(db, summary) {
  await db.prepare('INSERT OR REPLACE INTO summary (id, json) VALUES (1, ?)').bind(JSON.stringify(summary)).run();
}

export async function loadSummary(db) {
  const json = await db.prepare('SELECT json FROM summary WHERE id = 1').first('json');
  return json ? JSON.parse(json) : null;
}
