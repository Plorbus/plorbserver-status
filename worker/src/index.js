// Cloudflare Worker for status.plorbus.dev.
//
// scheduled(): runs on the cron in wrangler.jsonc. Checks the API from
//   Cloudflare's network (not from the server, which can't report its own
//   downtime), stores the result, and rebuilds the page summary.
// fetch(): serves /api/status. The page itself (site/) is static assets,
//   served by Cloudflare before this code ever runs.

import { checkWithRetry } from './check.js';
import { recordCheck, recordServices, buildSummary, saveSummary, loadSummary } from './store.js';

const JSON_HEADERS = {
  'content-type': 'application/json',
  'cache-control': 'public, max-age=60',
  'x-content-type-options': 'nosniff',
};

export default {
  async scheduled(_controller, env) {
    const check = await checkWithRetry(env.API_URL);
    await recordCheck(env.DB, check);
    try {
      await recordServices(env.DB, check);
    } catch (err) {
      // Logged loudly, but the core uptime record above is already safe.
      console.error(`recording per-service results failed: ${err.message}`);
    }
    await saveSummary(env.DB, await buildSummary(env.DB, Date.now()));
    console.log(JSON.stringify({ up: check.up, ms: check.ms, code: check.code }));
  },

  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname !== '/api/status') return new Response('Not found\n', { status: 404 });
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed\n', { status: 405, headers: { allow: 'GET, HEAD' } });
    }
    const summary = (await loadSummary(env.DB)) ?? { latest: null };
    return new Response(JSON.stringify(summary), { headers: JSON_HEADERS });
  },
};
