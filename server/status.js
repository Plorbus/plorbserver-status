// Read-only status endpoint for plorbserver.
//
// Listens on 127.0.0.1 only. The public reaches it through the Cloudflare
// Tunnel as https://api.plorbus.dev/, and nothing else can. One route,
// GET / (and HEAD), returns a cached snapshot. Everything else is 404/405.

import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { snapshot, cached } from './collect.js';

const CACHE_TTL_MS = 5000;

const BASE_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
});

function send(res, status, body, extraHeaders = {}, includeBody = true) {
  res.writeHead(status, { ...BASE_HEADERS, ...extraHeaders });
  res.end(includeBody ? JSON.stringify(body) : undefined);
}

export function createStatusServer({ getStatus }) {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, { error: 'method not allowed' }, { allow: 'GET, HEAD' });
    }
    // Only the path matters, and only to compare it with "/". The query
    // string is dropped unread.
    const path = req.url.split('?', 1)[0];
    if (path !== '/') return send(res, 404, { error: 'not found' });
    try {
      return send(res, 200, await getStatus(), {}, req.method === 'GET');
    } catch (err) {
      console.error(`snapshot failed: ${err.message}`);
      return send(res, 500, { error: 'internal error' });
    }
  });
  // A slow or idle client can't hold a connection open for long.
  server.headersTimeout = 5000;
  server.requestTimeout = 10000;
  return server;
}

function main() {
  const host = process.env.HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? 8090);
  const server = createStatusServer({ getStatus: cached(() => snapshot(), CACHE_TTL_MS) });
  server.listen(port, host, () => console.log(`plorbserver-status listening on http://${host}:${port}`));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
