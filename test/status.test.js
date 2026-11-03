import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createStatusServer } from '../server/status.js';

const SAMPLE = { status: 'up', boot_time: '2026-09-10T02:10:11.000Z' };
let server;
let base;
let failNext = false;

before(async () => {
  server = createStatusServer({
    getStatus: async () => {
      if (failNext) { failNext = false; throw new Error('proc unreadable'); }
      return SAMPLE;
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

test('GET / returns the status JSON with safe headers', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(await res.json(), SAMPLE);
});

test('query strings are ignored, not interpreted', async () => {
  const res = await fetch(`${base}/?unit=ssh;id&x=$(reboot)`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), SAMPLE);
});

test('any other path is 404', async () => {
  for (const path of ['/status', '/etc/passwd', '/..%2f..%2fetc/passwd', '//']) {
    const res = await fetch(`${base}${path}`);
    assert.equal(res.status, 404, path);
    await res.body?.cancel();
  }
});

test('non-GET methods get 405 with an Allow header', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    const res = await fetch(`${base}/`, { method });
    assert.equal(res.status, 405, method);
    assert.equal(res.headers.get('allow'), 'GET, HEAD');
    await res.body?.cancel();
  }
});

test('HEAD returns headers and no body', async () => {
  const res = await fetch(`${base}/`, { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '');
});

test('a failing snapshot returns a generic 500 without the error message', async () => {
  failNext = true;
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.ok(!text.includes('proc unreadable'));
});
