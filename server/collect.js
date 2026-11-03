// Reads coarse, non-sensitive health numbers from the local machine.
//
// Nothing in this file ever sees request data. The HTTP layer calls
// snapshot() with no arguments, so no part of a URL, header, or body can
// reach a file path or a command line. The only command run is
// `systemctl is-active` for unit names from the fixed UNITS list, and it
// runs through execFile, which never starts a shell.

import { execFile } from 'node:child_process';
import { readFile, statfs } from 'node:fs/promises';
import os from 'node:os';

export const UNITS = Object.freeze(['email-pixel-tracker', 'nginx']);

const KNOWN_STATES = new Set([
  'active', 'inactive', 'failed', 'activating', 'deactivating', 'reloading', 'maintenance',
]);

export function parseBootTime(procStat) {
  const match = /^btime\s+(\d+)$/m.exec(procStat);
  if (!match) throw new Error('btime not found in /proc/stat');
  return new Date(Number(match[1]) * 1000);
}

export function parseUptimeSeconds(procUptime) {
  const seconds = Number.parseFloat(procUptime);
  if (!Number.isFinite(seconds)) throw new Error('unreadable /proc/uptime');
  return Math.floor(seconds);
}

// "Used" the way `free` means it: memory not available to new programs.
// MemFree alone would count the page cache as used and read ~90% on a
// healthy Linux box.
export function parseMemoryPercent(meminfo) {
  const kb = (key) => {
    const match = new RegExp(`^${key}:\\s+(\\d+) kB$`, 'm').exec(meminfo);
    if (!match) throw new Error(`${key} not found in /proc/meminfo`);
    return Number(match[1]);
  };
  const total = kb('MemTotal');
  return Math.round(((total - kb('MemAvailable')) / total) * 100);
}

// Same formula as df's Use%: blocks reserved for root count as neither
// used nor available.
export function diskPercent({ blocks, bfree, bavail }) {
  const used = blocks - bfree;
  return Math.round((used / (used + bavail)) * 100);
}

export function unitState(name, { timeoutMs = 2000, exec = execFile } = {}) {
  if (!UNITS.includes(name)) throw new Error(`unit not allowed: ${name}`);
  return new Promise((resolve) => {
    // Belt and braces: execFile's own timeout kills the child, and this
    // timer guarantees an answer even if the callback never fires.
    const timer = setTimeout(() => resolve('unknown'), timeoutMs);
    exec('systemctl', ['is-active', '--', `${name}.service`], { timeout: timeoutMs }, (_err, stdout) => {
      clearTimeout(timer);
      // is-active exits non-zero for inactive/failed units but still prints
      // the state, so stdout is the answer and the error is expected.
      const state = String(stdout ?? '').trim();
      resolve(KNOWN_STATES.has(state) ? state : 'unknown');
    });
  });
}

const round2 = (n) => Math.round(n * 100) / 100;

export async function snapshot({
  now = () => new Date(),
  read = (path) => readFile(path, 'utf8'),
  fsStats = () => statfs('/'),
  state = (name) => unitState(name),
  loadavg = () => os.loadavg(),
  cpus = () => os.availableParallelism(),
} = {}) {
  const [procStat, procUptime, meminfo, disk, ...states] = await Promise.all([
    read('/proc/stat'),
    read('/proc/uptime'),
    read('/proc/meminfo'),
    fsStats(),
    ...UNITS.map((name) => state(name)),
  ]);
  const [one, five, fifteen] = loadavg();
  return {
    status: 'up',
    generated_at: now().toISOString(),
    boot_time: parseBootTime(procStat).toISOString(),
    uptime_seconds: parseUptimeSeconds(procUptime),
    services: Object.fromEntries(UNITS.map((name, i) => [name, states[i]])),
    load: { '1m': round2(one), '5m': round2(five), '15m': round2(fifteen), cpus: cpus() },
    memory_used_percent: parseMemoryPercent(meminfo),
    disk_used_percent: diskPercent(disk),
  };
}

// Wraps an async function so it runs at most once per ttlMs. Concurrent
// callers share the one in-flight call, and failures are not cached, so
// the next request simply tries again.
export function cached(fn, ttlMs, clock = Date.now) {
  let value;
  let expires = -Infinity;
  let inflight = null;
  return () => {
    if (clock() < expires) return Promise.resolve(value);
    inflight ??= fn()
      .then((result) => {
        value = result;
        expires = clock() + ttlMs;
        return result;
      })
      .finally(() => { inflight = null; });
    return inflight;
  };
}
