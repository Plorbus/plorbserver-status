// One uptime check: is https://api.plorbus.dev/ answering, and how fast?
// "Up" means HTTP 200 *and* a JSON body that says {"status": "up"}. A
// tunnel error page, a 404 from the catch-all, a timeout, or a refused
// connection are all "down". This function never throws.

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const UNIT_STATE = /^[a-z]{3,12}$/;
const SERVICES = ['email-pixel-tracker', 'nginx'];

const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Copy only the fields the page shows, and only if they look right. The API
// is ours, but this stops a broken or compromised server from putting
// arbitrary text into the database.
export function pickDetails(body) {
  return {
    boot_time: typeof body?.boot_time === 'string' && ISO_TIME.test(body.boot_time) ? body.boot_time : null,
    services: Object.fromEntries(SERVICES.map((name) => {
      const state = body?.services?.[name];
      return [name, typeof state === 'string' && UNIT_STATE.test(state) ? state : 'unknown'];
    })),
    load_1m: finite(body?.load?.['1m']),
    cpus: finite(body?.load?.cpus),
    memory_used_percent: finite(body?.memory_used_percent),
    disk_used_percent: finite(body?.disk_used_percent),
  };
}

export async function checkOnce(url, { timeoutMs = 10_000, fetchImpl = fetch, clock = Date.now } = {}) {
  const t = clock();
  try {
    const res = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
      headers: { accept: 'application/json', 'user-agent': 'plorbserver-status-checker' },
    });
    const ms = clock() - t;
    let body = null;
    try { body = await res.json(); } catch { /* not JSON: counts as down */ }
    const up = res.status === 200 && body?.status === 'up';
    return { t, up, ms: up ? ms : null, code: res.status, details: up ? pickDetails(body) : null };
  } catch {
    return { t, up: false, ms: null, code: null, details: null };
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One retry after a short pause, so a single dropped packet doesn't paint
// a red mark on the history bar.
export async function checkWithRetry(url, { retryDelayMs = 10_000, sleep = wait, ...options } = {}) {
  const first = await checkOnce(url, options);
  if (first.up) return first;
  await sleep(retryDelayMs);
  return checkOnce(url, options);
}
