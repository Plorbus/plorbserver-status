// Everything the Worker keeps lives in D1 (Cloudflare's SQLite). See
// worker/migrations/ for the tables.

import { SERVICES } from './check.js';

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

// A service is up only if its unit is active AND it answered its probe.
// If the server itself didn't answer, there are no details, so it's down.
export function serviceUp(details, name) {
  const service = details?.services?.[name];
  return service?.unit === 'active' && service?.responding === true;
}

// Store one check, count it in its day, and drop anything too old. All in
// one batch, so a failure leaves the tables exactly as they were.
export async function recordCheck(db, check) {
  const up = check.up ? 1 : 0;
  const hasMs = check.ms == null ? 0 : 1;
  const day = dayOf(check.t);
  const perService = SERVICES.flatMap((name) => {
    const serviceIsUp = check.up && serviceUp(check.details, name) ? 1 : 0;
    return [
      db.prepare('INSERT OR REPLACE INTO service_checks (t, service, up) VALUES (?, ?, ?)')
        .bind(check.t, name, serviceIsUp),
      db.prepare(`INSERT INTO service_days (date, service, total, up) VALUES (?, ?, 1, ?)
                  ON CONFLICT (date, service) DO UPDATE SET total = total + 1, up = up + excluded.up`)
        .bind(day, name, serviceIsUp),
    ];
  });
  return db.batch([
    ...perService,
    db.prepare('DELETE FROM service_checks WHERE t < ?').bind(check.t - KEEP_RAW_MS),
    db.prepare('DELETE FROM service_days WHERE date < ?').bind(dayOf(check.t - (KEEP_DAYS - 1) * DAY)),
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

  const services = {};
  for (const name of SERVICES) {
    const current = latest
      ? await db.prepare('SELECT up FROM service_checks WHERE service = ? AND t = ?').bind(name, latest.t).first()
      : null;
    const serviceWindow = (n) => db.prepare('SELECT COALESCE(SUM(total), 0) AS total, COALESCE(SUM(up), 0) AS up FROM service_days WHERE service = ? AND date >= ?')
      .bind(name, dayOf(now - (n - 1) * DAY)).first();
    services[name] = {
      up: current ? current.up === 1 : null,
      uptime: {
        '24h': percent(await db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(up), 0) AS up FROM service_checks WHERE service = ? AND t > ?')
          .bind(name, now - 24 * HOUR).first()),
        '7d': percent(await serviceWindow(7)),
        '30d': percent(await serviceWindow(30)),
      },
    };
  }

  return {
    generated_at: iso(now),
    latest: latest && { t: iso(latest.t), up: latest.up === 1, ms: latest.ms, code: latest.code },
    last_up: lastUp && { t: iso(lastUp.t), details: JSON.parse(lastUp.details) },
    uptime: {
      '24h': percent(last24h),
      '7d': percent(await window(7)),
      '30d': percent(await window(30)),
    },
    services,
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
