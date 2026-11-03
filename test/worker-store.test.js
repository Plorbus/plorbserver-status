import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeD1 } from './helpers/fake-d1.js';
import { recordCheck, buildSummary, saveSummary, loadSummary, dayOf, percent, serviceUp } from '../worker/src/store.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.parse('2026-11-02T12:00:00Z');
const ALL_UP = {
  'email-pixel-tracker': { unit: 'active', responding: true },
  nginx: { unit: 'active', responding: true },
  minecraft: { unit: 'active', responding: true },
};
const DETAILS = { boot_time: '2026-09-10T02:10:11.000Z', services: ALL_UP, load_1m: 0.1, cpus: 16, memory_used_percent: 39, disk_used_percent: 4 };

const up = (t, ms = 100) => ({ t, up: true, ms, code: 200, details: DETAILS });
const down = (t) => ({ t, up: false, ms: null, code: null, details: null });

test('dayOf uses UTC dates', () => {
  assert.equal(dayOf(Date.parse('2026-11-02T23:59:59Z')), '2026-11-02');
  assert.equal(dayOf(Date.parse('2026-11-03T00:00:01Z')), '2026-11-03');
});

test('percent rounds to 2 decimals and is null with no checks', () => {
  assert.equal(percent({ total: 3, up: 2 }), 66.67);
  assert.equal(percent({ total: 0, up: 0 }), null);
});

test('each check is stored raw and counted in its UTC day', async () => {
  const db = fakeD1();
  await recordCheck(db, up(T0, 100));
  await recordCheck(db, up(T0 + 5 * 60_000, 300));
  await recordCheck(db, down(T0 + 10 * 60_000));
  const day = db.sqlite.prepare('SELECT * FROM days').get();
  assert.deepEqual({ ...day }, { date: '2026-11-02', total: 3, up: 2, ms_sum: 400, ms_n: 2 });
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM checks').get().n, 3);
});

test('a check just after midnight UTC starts a new day', async () => {
  const db = fakeD1();
  await recordCheck(db, up(Date.parse('2026-11-02T23:59:00Z')));
  await recordCheck(db, up(Date.parse('2026-11-03T00:01:00Z')));
  const dates = db.sqlite.prepare('SELECT date FROM days ORDER BY date').all().map((r) => r.date);
  assert.deepEqual(dates, ['2026-11-02', '2026-11-03']);
});

test('raw checks older than 48 hours are deleted; their day summary stays', async () => {
  const db = fakeD1();
  await recordCheck(db, up(T0 - 49 * HOUR));
  await recordCheck(db, up(T0));
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM checks').get().n, 1);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM days').get().n, 2);
});

test('day summaries older than 90 days are deleted', async () => {
  const db = fakeD1();
  await recordCheck(db, up(T0 - 90 * DAY));
  await recordCheck(db, up(T0 - 89 * DAY));
  await recordCheck(db, up(T0));
  const dates = db.sqlite.prepare('SELECT date FROM days ORDER BY date').all().map((r) => r.date);
  assert.deepEqual(dates, [dayOf(T0 - 89 * DAY), dayOf(T0)]);
});

test('24h uptime counts the checks that actually ran, not an expected 288', async () => {
  const db = fakeD1();
  // A 6-hour gap with no checks at all (scheduler outage), then 3 up and 1 down.
  for (const h of [-23, -22, -21]) await recordCheck(db, up(T0 + h * HOUR));
  await recordCheck(db, down(T0 - 1 * HOUR));
  const s = await buildSummary(db, T0);
  assert.equal(s.uptime['24h'], 75);
});

test('7d and 30d windows come from the daily rollup', async () => {
  const db = fakeD1();
  await recordCheck(db, down(T0 - 20 * DAY)); // inside 30d, outside 7d
  await recordCheck(db, up(T0 - 3 * DAY));
  await recordCheck(db, up(T0));
  const s = await buildSummary(db, T0);
  assert.equal(s.uptime['7d'], 100);
  assert.equal(s.uptime['30d'], 66.67);
});

test('summary with no data yet', async () => {
  const s = await buildSummary(fakeD1(), T0);
  assert.equal(s.latest, null);
  assert.equal(s.last_up, null);
  assert.deepEqual(s.uptime, { '24h': null, '7d': null, '30d': null });
  assert.deepEqual(s.days, []);
});

test('while down, the summary still reports when the server was last seen up', async () => {
  const db = fakeD1();
  await recordCheck(db, up(T0 - 10 * 60_000));
  await recordCheck(db, down(T0 - 5 * 60_000));
  await recordCheck(db, down(T0));
  const s = await buildSummary(db, T0);
  assert.equal(s.latest.up, false);
  assert.equal(s.latest.t, new Date(T0).toISOString());
  assert.equal(s.last_up.t, new Date(T0 - 10 * 60_000).toISOString());
  assert.equal(s.last_up.details.boot_time, DETAILS.boot_time);
});

test('after more than 48 hours down, the summary still knows when it was last up', async () => {
  const db = fakeD1();
  await recordCheck(db, up(T0 - 72 * HOUR));
  for (let h = 71; h >= 0; h--) await recordCheck(db, down(T0 - h * HOUR));
  const s = await buildSummary(db, T0);
  assert.equal(s.last_up.t, new Date(T0 - 72 * HOUR).toISOString());
  assert.equal(s.last_up.details.boot_time, DETAILS.boot_time);
  assert.equal(s.uptime['24h'], 0);
  // The kept "last up" row plus the 49 down checks inside the 48-hour window.
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM checks').get().n, 50);
});

test('pruning still deletes old rows when the server has never been up', async () => {
  const db = fakeD1();
  for (let h = 72; h >= 0; h--) await recordCheck(db, down(T0 - h * HOUR));
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM checks').get().n, 49);
});

test('days list covers the last 30 days, oldest first, with average response time', async () => {
  const db = fakeD1();
  await recordCheck(db, up(T0 - 40 * DAY)); // outside the bar
  await recordCheck(db, up(T0 - 1 * DAY, 200));
  await recordCheck(db, up(T0, 100));
  await recordCheck(db, down(T0 + 60_000));
  const s = await buildSummary(db, T0 + 60_000);
  assert.deepEqual(s.days, [
    { date: dayOf(T0 - DAY), up_pct: 100, avg_ms: 200 },
    { date: dayOf(T0), up_pct: 50, avg_ms: 100 },
  ]);
});

test('the summary round-trips through the database as one row', async () => {
  const db = fakeD1();
  await recordCheck(db, up(T0));
  const s = await buildSummary(db, T0);
  await saveSummary(db, s);
  await saveSummary(db, s); // overwrite, not a second row
  assert.deepEqual(await loadSummary(db), s);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM summary').get().n, 1);
});

test('loadSummary returns null before the first check', async () => {
  assert.equal(await loadSummary(fakeD1()), null);
});

// --- per-service uptime ---------------------------------------------------

const withServices = (t, services) => ({ t, up: true, ms: 100, code: 200, details: { ...DETAILS, services: { ...ALL_UP, ...services } } });

test('serviceUp needs the unit active AND the service answering', () => {
  assert.equal(serviceUp({ services: ALL_UP }, 'minecraft'), true);
  assert.equal(serviceUp({ services: { minecraft: { unit: 'active', responding: false } } }, 'minecraft'), false);
  assert.equal(serviceUp({ services: { minecraft: { unit: 'failed', responding: true } } }, 'minecraft'), false);
  assert.equal(serviceUp({ services: { minecraft: { unit: 'active', responding: null } } }, 'minecraft'), false);
  assert.equal(serviceUp(null, 'minecraft'), false);
});

test('each service gets its own current state and uptime', async () => {
  const db = fakeD1();
  await recordCheck(db, withServices(T0 - 10 * 60_000, {}));
  await recordCheck(db, withServices(T0 - 5 * 60_000, { minecraft: { unit: 'active', responding: false } }));
  await recordCheck(db, withServices(T0, { minecraft: { unit: 'active', responding: false } }));
  const s = await buildSummary(db, T0);
  assert.deepEqual(s.services.minecraft, { up: false, uptime: { '24h': 33.33, '7d': 33.33, '30d': 33.33 } });
  assert.deepEqual(s.services.nginx, { up: true, uptime: { '24h': 100, '7d': 100, '30d': 100 } });
  assert.deepEqual(Object.keys(s.services), ['email-pixel-tracker', 'nginx', 'minecraft']);
});

test('when the server itself is unreachable, every service counts as down', async () => {
  const db = fakeD1();
  await recordCheck(db, withServices(T0 - 5 * 60_000, {}));
  await recordCheck(db, down(T0));
  const s = await buildSummary(db, T0);
  for (const name of ['email-pixel-tracker', 'nginx', 'minecraft']) {
    assert.deepEqual(s.services[name], { up: false, uptime: { '24h': 50, '7d': 50, '30d': 50 } }, name);
  }
});

test('per-service history is pruned like the main history', async () => {
  const db = fakeD1();
  await recordCheck(db, withServices(T0 - 49 * HOUR, {}));
  await recordCheck(db, withServices(T0 - 91 * DAY, {}));
  await recordCheck(db, withServices(T0, {}));
  const raw = db.sqlite.prepare('SELECT COUNT(DISTINCT t) AS n FROM service_checks').get().n;
  const days = db.sqlite.prepare('SELECT COUNT(DISTINCT date) AS n FROM service_days').get().n;
  assert.equal(raw, 1);
  assert.equal(days, 2); // T0's day and the day 49 hours earlier; the 91-day-old one is gone
});

test('services with no checks yet are reported as unknown', async () => {
  const s = await buildSummary(fakeD1(), T0);
  assert.deepEqual(s.services.minecraft, { up: null, uptime: { '24h': null, '7d': null, '30d': null } });
});
