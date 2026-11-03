import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkOnce, checkWithRetry, pickDetails } from '../worker/src/check.js';

const URL_ = 'https://api.plorbus.dev/';
const GOOD_BODY = {
  status: 'up',
  generated_at: '2026-11-02T20:00:00.000Z',
  boot_time: '2026-09-10T02:10:11.000Z',
  uptime_seconds: 4665857,
  services: { 'email-pixel-tracker': 'active', nginx: 'active' },
  load: { '1m': 0.14, '5m': 0.08, '15m': 0.01, cpus: 16 },
  memory_used_percent: 39,
  disk_used_percent: 4,
};

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

// A clock that advances 120 ms per read, so ms is deterministic.
const steppingClock = () => { let t = 1_700_000_000_000; return () => (t += 120); };

test('a 200 with status "up" is up, with response time and sanitized details', async () => {
  const r = await checkOnce(URL_, { fetchImpl: async () => jsonResponse(GOOD_BODY), clock: steppingClock() });
  assert.equal(r.up, true);
  assert.equal(r.code, 200);
  assert.equal(r.ms, 120);
  assert.equal(r.details.boot_time, '2026-09-10T02:10:11.000Z');
  assert.deepEqual(r.details.services, { 'email-pixel-tracker': 'active', nginx: 'active' });
});

for (const [name, fetchImpl, code] of [
  ['connection refused', async () => { throw new TypeError('fetch failed'); }, null],
  ['timeout', async () => { throw new DOMException('timed out', 'TimeoutError'); }, null],
  ['503 from the tunnel', async () => new Response('Bad gateway', { status: 503 }), 503],
  ['200 but status "down"', async () => jsonResponse({ ...GOOD_BODY, status: 'down' }), 200],
  ['200 with an HTML error page', async () => new Response('<html>oops</html>', { status: 200 }), 200],
  ['404 catch-all', async () => new Response('', { status: 404 }), 404],
]) {
  test(`${name} counts as down and never throws`, async () => {
    const r = await checkOnce(URL_, { fetchImpl, clock: steppingClock() });
    assert.equal(r.up, false);
    assert.equal(r.ms, null);
    assert.equal(r.code, code);
    assert.equal(r.details, null);
  });
}

test('checkOnce passes a timeout signal and does not follow redirects', async () => {
  let init;
  await checkOnce(URL_, { fetchImpl: async (_u, i) => { init = i; return jsonResponse(GOOD_BODY); } });
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(init.redirect, 'manual');
});

test('pickDetails drops anything malformed instead of storing it', () => {
  const d = pickDetails({
    boot_time: 'yesterday<script>',
    services: { 'email-pixel-tracker': 'ACTIVE; rm -rf', nginx: 'active', sshd: 'active' },
    load: { '1m': 'NaN', cpus: 16 },
    memory_used_percent: Infinity,
    disk_used_percent: 4,
    hostname: 'plorbserver',
  });
  assert.deepEqual(d, {
    boot_time: null,
    services: { 'email-pixel-tracker': 'unknown', nginx: 'active' },
    load_1m: null,
    cpus: 16,
    memory_used_percent: null,
    disk_used_percent: 4,
  });
});

test('checkWithRetry does not retry when the first check is up', async () => {
  let calls = 0;
  const r = await checkWithRetry(URL_, {
    fetchImpl: async () => { calls++; return jsonResponse(GOOD_BODY); },
    sleep: async () => assert.fail('should not sleep'),
  });
  assert.equal(r.up, true);
  assert.equal(calls, 1);
});

test('checkWithRetry retries once after a failure and keeps the second result', async () => {
  let calls = 0;
  let slept = 0;
  const r = await checkWithRetry(URL_, {
    retryDelayMs: 10_000,
    sleep: async (ms) => { slept = ms; },
    fetchImpl: async () => (++calls === 1 ? new Response('', { status: 502 }) : jsonResponse(GOOD_BODY)),
  });
  assert.equal(calls, 2);
  assert.equal(slept, 10_000);
  assert.equal(r.up, true);
});

test('checkWithRetry reports down when both attempts fail', async () => {
  const r = await checkWithRetry(URL_, {
    sleep: async () => {},
    fetchImpl: async () => { throw new TypeError('fetch failed'); },
  });
  assert.equal(r.up, false);
});
