# plorbserver-status

A public uptime page for my home server: **https://status.plorbus.dev**

`plorbserver` is a spare PC in my house running Ubuntu Server. It hosts a few
small projects (an email open tracker, a static website, a Minecraft server).
This repo is how the outside world can see whether it's up, without opening
anything on my home network.

```
                      every 5 min
 ┌──────────────────────────────┐        ┌───────────────────────────────────────────┐
 │ Cloudflare Worker (cron)     │ ─────▶ │ https://api.plorbus.dev                   │
 │  stores results in D1        │        │   Cloudflare edge                         │
 │  serves status.plorbus.dev   │        │     │  (tunnel: the server dialed out)    │
 └──────────────────────────────┘        │     ▼                                     │
            ▲                            │  plorbserver                              │
            │ page + /api/status         │   cloudflared ──▶ 127.0.0.1:8090          │
        visitors                         │                   status service (Node)   │
                                         └───────────────────────────────────────────┘
```

## How it works

1. **Status service** (`server/`). A small Node service on the server
   that answers `GET /` with coarse health JSON: up, boot time, uptime,
   load average, memory % and disk %, and for each hosted service (email
   tracker, website, Minecraft) whether it's running **and** whether it
   actually answered a test request on `127.0.0.1`. It binds `127.0.0.1` only, runs as its own non-root system user
   under a systemd sandbox, and caches its answer for 5 seconds so it can't
   be hammered. It has no npm dependencies.
2. **Cloudflare Tunnel.** `cloudflared` on the server opens an *outbound*
   connection to Cloudflare. Requests for `api.plorbus.dev` ride back down
   that connection to `127.0.0.1:8090`. No port is opened on the router or
   the firewall for any of this.
3. **Checker + page** (`worker/`, `site/`). A Cloudflare Worker runs every 5
   minutes, calls the API with a 10-second timeout (one retry), and records
   up/down and response time in D1 (Cloudflare's SQLite), for the server
   and for each service. The same Worker serves the page and a small
   `/api/status` JSON summary.

## Design decisions

**The checker doesn't run on the server.** A server can't report its own
downtime: if it's off, so is anything running on it. The check runs on
Cloudflare's network and reaches the server the same way a visitor would,
so "down" means "down for the world", whether that's the box, the power,
the home internet, or the tunnel.

**No inbound ports.** The tunnel is dialed *out* from the server, so the
status API and the tracker's pixel need no port forward and no firewall
rule. `cloudflared` only routes the hostnames it's configured for, ending
with a catch-all `404`. `api.plorbus.dev` goes to the status service. On the
tracker's hostname only `/pixel/...` is routed, so its admin pages are not
reachable through the tunnel at all.

**The public API says as little as possible.** No IP addresses, hostnames,
usernames, or process lists. Numbers are rounded (memory and disk as whole
percentages). Nothing from the request (path, query, headers) reaches any
file read, port, or command: the one command it runs is `systemctl
is-active` for three unit names from a hardcoded list, through `execFile` (no shell). A test
fails if a snapshot taken on the test machine contains that machine's
hostname or username, or anything shaped like an IP address.

**Uptime math counts real checks.** If a scheduled run is skipped, that
time is unknown, not up and not down. So percentages are `up checks /
checks that ran`, never `/ expected checks`. Raw checks are kept 48 hours.
Each check also increments a per-day row (UTC), and those daily rows are
kept 90 days. That *is* the rollup, so nothing ever needs a batch job to
summarize old data. After every check the Worker rebuilds the page's
summary and stores it as a single row, so a page view costs one database
read.

**Photos are checked, not trusted.** A test walks the bytes of every JPEG
under `site/` and fails on any metadata segment (Exif, where GPS lives;
XMP; IPTC; comments). Deploys go through `npm run deploy`, which refuses if
`site/` contains anything that isn't committed.

**Plain on purpose.** The page is unstyled HTML with no framework.
`<meta name="color-scheme" content="light dark">` gives it the browser's
own dark mode.

## Honest limits

- **Same-provider blind spot.** The checker, the page, and the tunnel are
  all on Cloudflare. If Cloudflare itself is down, this page is too and
  can't say so. The failures a home server actually has (power, ISP, the
  box, `cloudflared`) are all caught.
- **5-minute resolution.** An outage shorter than that can fall between
  checks.
- **Services are checked from inside the server.** The Minecraft check
  proves the game answers, but not that the router's port forward works.
  See `docs/DESIGN.md` section 5.

## Running the tests

```
npm test
```

Node 22.13+ (for the built-in `node:sqlite`), with no dependencies for the tests themselves. The Worker's SQL
runs against Node's built-in SQLite through a small D1 stand-in
(`test/helpers/fake-d1.js`), using the real migration file.

## Layout

```
server/status.js, collect.js       status service (runs on the server)
server/*.service                   systemd units (status service, cloudflared)
server/cloudflared/                tunnel ingress template
worker/src/                        Cloudflare Worker: check, store, routes
worker/migrations/                 D1 schema
site/                              the page (plain HTML + JS)
test/                              node:test suites
```

Design decisions and trade-offs: [`docs/DESIGN.md`](docs/DESIGN.md). Server setup: [`docs/DEPLOY.md`](docs/DEPLOY.md).

## License

MIT
