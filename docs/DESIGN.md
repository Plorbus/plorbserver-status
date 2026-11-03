# Design decisions

Why each piece of plorbserver-status is built the way it is, and what was
considered instead. For how to deploy it, see [DEPLOY.md](DEPLOY.md).

## The shape of it

```
Cloudflare Worker ──every 5 min──▶ https://api.plorbus.dev ──tunnel──▶ status service (on the server)
      │
      ├─ stores each result in D1
      └─ serves https://status.plorbus.dev (page + /api/status)
```

Three parts: a tiny status service on the server, a Cloudflare Tunnel that
makes it reachable, and a Worker that checks it from outside and shows the
results.

## 1. The checker runs outside the server

A server can't report its own downtime: when it's off, so is any page it
serves. So the check runs on Cloudflare's network and reaches the server
the same way a visitor does (DNS → Cloudflare → tunnel → server). "Down"
then means down for the world, whatever the cause: the box, the power, the
home internet, or the tunnel software.

## 2. Cloudflare Worker + D1, not GitHub Actions + Pages

The first plan was a GitHub Actions job every 15 minutes, committing results
to the repo, with the page on GitHub Pages. It was dropped for a Worker with
a cron trigger, storing results in D1 (Cloudflare's SQLite):

| | GitHub Actions + Pages | Worker + D1 (chosen) |
|---|---|---|
| Check timing | "about" every 15 min; GitHub's scheduler is often late, especially on the hour | every 5 min, on time |
| Where data lives | commits (≈35,000 bot commits a year) | a database, so the repo only has code |
| Long-term risk | scheduled workflows auto-disable after 60 days of repo inactivity | none |
| HTTPS for the page | DNS-only record + waiting on GitHub's certificate | automatic |
| Blind spot | independent of Cloudflare | **shares a provider with the tunnel** |

That last row is the real cost. If Cloudflare itself is down, the page goes
down with everything else and can't say so. Accepted, because a home
server's real failure modes (power, ISP, the machine, `cloudflared`) are
all caught.

Also considered: batching results and committing weekly. It doesn't work.
CI runners are wiped after every run, so there's nowhere to hold a week of
results except by committing them, and the page would be up to a week stale.

## 3. No inbound ports

`cloudflared` on the server makes outbound connections to Cloudflare, and
requests come back down those. Nothing new listens on the internet, no
router port forward, no firewall rule. Its config ends with a catch-all
`404`, so only named hostnames go anywhere:

- `api.plorbus.dev` → the status service on `127.0.0.1:8090`.
- `t.plorbus.dev` → the email tracker, but **only paths starting `/pixel/`**.
  Mail servers only ever need the pixel, so the tracker's admin pages aren't
  routed at all.
- Anything else, including the bare `plorbus.dev`, → 404.

Choices around `cloudflared`:

- **One tunnel for the whole box**, not one per site. Future sites become two
  more lines of config.
- **A hand-written systemd unit running as a dedicated `cloudflared` user.**
  `cloudflared service install` runs as root, and also installs a timer that
  replaces the binary itself, which would fight with the package manager.
- **The credentials file is readable by the `cloudflared` user only (mode
  0400)**, and exists only on the server. The login certificate from setup
  (which can create and delete tunnels and DNS for the whole account) was
  deleted once the tunnel existed.
- **Updated automatically, and restarted after updates.** The service runs
  with `--no-autoupdate` so the package manager is the only thing that
  changes the binary. `unattended-upgrades` is allowed to install it from
  Cloudflare's repo. The package doesn't restart the service itself, so a
  systemd path unit watches `/usr/bin/cloudflared` and restarts the tunnel
  when an upgrade replaces it. (Tested: it fires once per replacement, and
  not at boot.)

## 4. The status service

- **Node's built-in `http` module, no npm packages.** Python's built-in
  `http.server` was the other obvious choice, but its own docs say it's not
  for production. With no dependencies there's nothing to install and
  nothing third-party to audit.
- **Listens on `127.0.0.1` only.** Only `cloudflared` on the same machine
  can reach it.
- **Says as little as possible:** up, boot time, uptime, whether two named
  services are active, load average, memory % and disk % (rounded). No IPs,
  hostnames, usernames or process lists.
- **Request data never reaches a command or a file.** The handler only looks
  at the method and whether the path is `/`. The one command it runs is
  `systemctl is-active` for two names from a hardcoded list, through
  `execFile` (no shell), with a 2-second timeout. If systemd hangs, that
  service shows `unknown` and the request still answers.
- **Cached for 5 seconds**, and simultaneous requests share one in-flight
  read, so it can't be hammered into doing work.
- **Its own non-root system user, plus a strict systemd sandbox**
  (read-only filesystem, no home directories, no other tenants' files, no
  privileges, loopback-only networking). `systemd-analyze security` scores
  it 1.4, where lower is safer.
- **Why not `DynamicUser`:** it was the first choice, because it creates a
  throwaway user at start with no account to manage. On this server, a
  dynamic user couldn't talk to systemd over D-Bus, so every service read
  `unknown`. Found by testing the sandbox settings one at a time: only
  `DynamicUser` broke it. A normal system user under the identical sandbox
  works.

## 5. What counts as "up"

- Up means **HTTP 200 and a JSON body saying `"status": "up"`**. A tunnel
  error page, the 404 catch-all, a timeout (10 s), or no answer at all are
  all "down". Redirects aren't followed.
- **One retry after 10 seconds** before recording "down", so a single
  dropped packet doesn't paint a red day.
- Before anything from the API is stored, it's re-checked field by field
  (timestamps must look like timestamps, states must be short words, numbers
  must be numbers). A broken or compromised server can't put arbitrary text
  in the database.

## 6. Storing history without it growing forever

- **Raw checks are kept for 48 hours**, enough for the 24-hour figure.
- **Every check also adds to a one-row-per-day total (UTC)**, kept 90 days.
  That's the rollup: it's built as checks happen, so there's no batch job
  and old raw rows can simply be deleted.
- **Uptime % counts the checks that actually ran**, never "expected
  checks". If Cloudflare skips a run, that time is unknown, not up and not
  down.
- **The newest "up" check is never deleted**, so after a long outage the page
  can still say when the server was last seen up.
- After every check the Worker rebuilds the page's summary and stores it as
  one row, so a page view costs a single database read.

## 7. The page

- **Deliberately plain HTML, no framework, no stylesheet** (one rule stops
  photos overflowing on phones). Styling comes later.
  `<meta name="color-scheme" content="light dark">` gives the browser's own
  dark mode for free.
- **Honest states:** "unknown, because no check has been recorded yet"
  rather than a promise. A warning when no check has arrived for 30 minutes.
  While down, it says when the server was last seen up.
- Data is inserted with `textContent` only, never as HTML.

## 8. Photos

- Originals never enter git (`.gitignore`), and cleaned copies are made
  outside the repo first.
- Cleaning: apply the camera's rotation, *then* drop all metadata (so
  portrait shots stay upright), resize to at most 1200 px.
- **Checked, not trusted:** a test reads the bytes of every JPEG the site
  can serve and fails on any metadata segment (Exif, which is where GPS
  lives; XMP; IPTC; comments).
- `npm run deploy` refuses if `site/` contains anything not committed,
  because the deploy tool uploads whatever is in the folder.

## 9. Tests

`npm test`, built-in Node test runner, no dependencies. The Worker's SQL
runs against Node's built-in SQLite through a small stand-in for D1 that
loads the real migration file, so the queries tested are the ones deployed.

## 10. Open questions

- **The email tracker still answers on its old Tailscale Funnel address**
  (whole app, including admin) so that emails already sent keep working.
  Retiring it, and logging the visitor's real IP from Cloudflare's
  `CF-Connecting-IP` header, are left to the tracker's own project. The trap
  to avoid: Funnel and the tunnel both connect from `127.0.0.1`, so that
  header must only be trusted on a listener that only the tunnel uses.
