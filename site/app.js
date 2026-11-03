import { formatDuration, formatPercent, dailyUptime, isStale, serviceLines } from './format.js';

const $ = (id) => document.getElementById(id);
const when = (iso) => new Date(iso).toLocaleString();
const ago = (iso, now) => `${formatDuration((now - Date.parse(iso)) / 1000)} ago`;

function listItem(text) {
  const li = document.createElement('li');
  li.textContent = text;
  return li;
}

function render(data, now) {
  const { latest, last_up: lastUp } = data;
  if (!latest) {
    // Don't promise a time here: if the schedule is broken this would
    // otherwise sit on the page forever looking normal.
    $('status').textContent = 'unknown, because no check has been recorded yet';
    return;
  }

  $('status').textContent = latest.up ? 'Up' : 'Down';
  $('last-check').textContent = `${when(latest.t)} (${ago(latest.t, now)})`;
  $('stale').hidden = !isStale(latest.t, now);

  const boot = lastUp?.details?.boot_time;
  if (latest.up && boot) {
    $('uptime').textContent = `${formatDuration((now - Date.parse(boot)) / 1000)} (since it booted on ${when(boot)})`;
  } else if (lastUp) {
    $('uptime-line').textContent = `Last seen up: ${when(lastUp.t)} (${ago(lastUp.t, now)})`;
  } else {
    $('uptime-line').textContent = 'Has not been seen up yet.';
  }

  $('up-24h').textContent = formatPercent(data.uptime['24h']);
  $('up-7d').textContent = formatPercent(data.uptime['7d']);
  $('up-30d').textContent = formatPercent(data.uptime['30d']);

  const services = serviceLines(data.services);
  $('services').replaceChildren(...(services.length ? services : ['no data yet']).map(listItem));

  const daily = dailyUptime(data.days);
  $('daily').replaceChildren(...(daily.length ? daily : ['no checks yet']).map(listItem));

  const d = lastUp?.details;
  const items = [];
  if (latest.up && latest.ms != null) items.push(`Response time: ${latest.ms} ms (Cloudflare to the server and back)`);
  if (d) {
    if (d.load_1m != null) items.push(`CPU load (1 min average): ${d.load_1m} across ${d.cpus} CPUs`);
    if (d.memory_used_percent != null) items.push(`Memory used: ${d.memory_used_percent}%`);
    if (d.disk_used_percent != null) items.push(`Disk used: ${d.disk_used_percent}%`);
    if (!latest.up) items.unshift(`These are from the last time it was up, ${when(lastUp.t)}.`);
  }
  $('details').replaceChildren(...(items.length ? items : ['nothing yet']).map(listItem));
}

async function load() {
  try {
    const res = await fetch('/api/status', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    render(await res.json(), Date.now());
  } catch {
    $('status').textContent = "couldn't load the status data, try refreshing";
  }
}

load();
setInterval(load, 60_000);
