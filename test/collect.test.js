import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import {
  UNITS, parseBootTime, parseUptimeSeconds, parseMemoryPercent, diskPercent,
  unitState, snapshot, cached,
} from '../server/collect.js';

// Real text captured from plorbserver on 2026-11-02.
const PROC_STAT = 'cpu  11983832 22552 1568485 7444601156 3991024 0 75754 0 0 0\nbtime 1789006211\n';
const PROC_UPTIME = '4665857.73 74446011.60\n';
const PROC_MEMINFO = [
  'MemTotal:       31734128 kB',
  'MemFree:         2118344 kB',
  'MemAvailable:   19305596 kB',
  'Buffers:          827672 kB',
].join('\n');

test('parseBootTime reads the btime line', () => {
  assert.equal(parseBootTime(PROC_STAT).toISOString(), '2026-09-10T02:10:11.000Z');
});

test('parseBootTime throws on text without btime', () => {
  assert.throws(() => parseBootTime('cpu 1 2 3\n'), /btime/);
});

test('parseUptimeSeconds floors the first field', () => {
  assert.equal(parseUptimeSeconds(PROC_UPTIME), 4665857);
});

test('parseMemoryPercent uses MemAvailable, not MemFree', () => {
  // (31734128 - 19305596) / 31734128 = 39.16%
  assert.equal(parseMemoryPercent(PROC_MEMINFO), 39);
});

test('diskPercent matches df: used / (used + available to users), rounded up', () => {
  // 1000 blocks, 600 free, 550 available to non-root: used 400 / (400 + 550) = 42.1%
  assert.equal(diskPercent({ blocks: 1000, bfree: 600, bavail: 550 }), 43);
  // plorbserver on 2026-11-03: 29G of 2.7T. df says 2%, not 1%.
  assert.equal(diskPercent({ blocks: 1000, bfree: 989, bavail: 989 }), 2);
});

test('unitState returns the state systemctl prints, even on non-zero exit', async () => {
  const exec = (cmd, args, opts, cb) => cb(new Error('exit 3'), 'inactive\n');
  assert.equal(await unitState('nginx', { exec }), 'inactive');
});

test('unitState calls systemctl with a fixed argument list', async () => {
  let seen;
  const exec = (cmd, args, opts, cb) => { seen = [cmd, ...args]; cb(null, 'active\n'); };
  await unitState('email-pixel-tracker', { exec });
  assert.deepEqual(seen, ['systemctl', 'is-active', '--', 'email-pixel-tracker.service']);
});

test('unitState maps unexpected output to "unknown"', async () => {
  const exec = (cmd, args, opts, cb) => cb(null, 'something weird\n');
  assert.equal(await unitState('nginx', { exec }), 'unknown');
});

test('unitState gives up with "unknown" when systemctl hangs', async () => {
  const exec = () => {}; // never calls back
  const started = Date.now();
  assert.equal(await unitState('nginx', { exec, timeoutMs: 50 }), 'unknown');
  assert.ok(Date.now() - started < 1000);
});

test('unitState refuses names outside the allowlist before running anything', () => {
  let ran = false;
  const exec = () => { ran = true; };
  assert.throws(() => unitState('ssh; rm -rf /', { exec }), /not allowed/);
  assert.equal(ran, false);
});

const fakeDeps = {
  now: () => new Date('2026-11-02T20:00:00Z'),
  read: async (path) => ({ '/proc/stat': PROC_STAT, '/proc/uptime': PROC_UPTIME, '/proc/meminfo': PROC_MEMINFO })[path],
  fsStats: async () => ({ blocks: 1000, bfree: 600, bavail: 550 }),
  state: async () => 'active',
  loadavg: () => [0.14159, 0.08, 0.012],
  cpus: () => 16,
};

test('snapshot has exactly the public fields, rounded', async () => {
  const s = await snapshot(fakeDeps);
  assert.deepEqual(s, {
    status: 'up',
    generated_at: '2026-11-02T20:00:00.000Z',
    boot_time: '2026-09-10T02:10:11.000Z',
    uptime_seconds: 4665857,
    services: { 'email-pixel-tracker': 'active', nginx: 'active' },
    load: { '1m': 0.14, '5m': 0.08, '15m': 0.01, cpus: 16 },
    memory_used_percent: 39,
    disk_used_percent: 43,
  });
  assert.deepEqual(Object.keys(s.services), [...UNITS]);
});

test('the real snapshot leaks no hostname, username, or IP address', async () => {
  const text = JSON.stringify(await snapshot({ ...fakeDeps, read: undefined, fsStats: undefined, loadavg: undefined, cpus: undefined }));
  assert.ok(!text.includes(os.hostname()), 'hostname leaked');
  assert.ok(!text.includes(os.userInfo().username), 'username leaked');
  // ISO timestamps contain "hh:mm:ss", which looks like IPv6 to a regex; drop them first.
  const withoutTimes = text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '');
  assert.doesNotMatch(withoutTimes, /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, 'IPv4 leaked');
  assert.doesNotMatch(withoutTimes, /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/i, 'IPv6 leaked');
});

test('cached runs fn once within the TTL and again after it', async () => {
  let now = 0;
  let calls = 0;
  const get = cached(async () => ++calls, 5000, () => now);
  assert.equal(await get(), 1);
  now = 4999;
  assert.equal(await get(), 1);
  now = 5000;
  assert.equal(await get(), 2);
});

test('cached shares one in-flight call between concurrent callers', async () => {
  let calls = 0;
  let release;
  const get = cached(() => { calls++; return new Promise((r) => { release = r; }); }, 5000);
  const both = Promise.all([get(), get(), get()]);
  release('x');
  assert.deepEqual(await both, ['x', 'x', 'x']);
  assert.equal(calls, 1);
});

test('cached does not cache failures', async () => {
  let calls = 0;
  const get = cached(async () => { calls++; if (calls === 1) throw new Error('boom'); return 'ok'; }, 5000);
  await assert.rejects(get(), /boom/);
  assert.equal(await get(), 'ok');
});
