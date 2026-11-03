import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeD1 } from './helpers/fake-d1.js';
import worker from '../worker/src/index.js';

const API_BODY = {
  status: 'up',
  boot_time: '2026-09-10T02:10:11.000Z',
  services: { 'email-pixel-tracker': 'active', nginx: 'active' },
  load: { '1m': 0.1, cpus: 16 },
  memory_used_percent: 39,
  disk_used_percent: 4,
};

function withFetch(impl, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => { globalThis.fetch = original; });
}

test('a scheduled run checks the API, records it, and publishes a summary', async () => {
  const env = { DB: fakeD1(), API_URL: 'https://api.plorbus.dev/' };
  let calledUrl;
  await withFetch(async (url) => { calledUrl = url; return Response.json(API_BODY); }, () =>
    worker.scheduled({ scheduledTime: Date.now(), cron: '*/5 * * * *' }, env, { waitUntil() {} }));
  assert.equal(calledUrl, 'https://api.plorbus.dev/');
  const res = await worker.fetch(new Request('https://status.plorbus.dev/api/status'), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.latest.up, true);
  assert.equal(body.uptime['24h'], 100);
});

test('/api/status before any check returns an empty summary, not an error', async () => {
  const res = await worker.fetch(new Request('https://status.plorbus.dev/api/status'), { DB: fakeD1() });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json');
  assert.equal(res.headers.get('cache-control'), 'public, max-age=60');
  assert.deepEqual(await res.json(), { latest: null });
});

test('/api/status rejects non-GET methods', async () => {
  const res = await worker.fetch(new Request('https://status.plorbus.dev/api/status', { method: 'POST' }), { DB: fakeD1() });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'GET, HEAD');
});

test('unknown paths that are not static files are 404', async () => {
  const res = await worker.fetch(new Request('https://status.plorbus.dev/api/other'), { DB: fakeD1() });
  assert.equal(res.status, 404);
});
