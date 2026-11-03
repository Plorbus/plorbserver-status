import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { httpProbe, minecraftProbe, varInt, readVarInt } from '../server/probes.js';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(resolve));

// A port with nothing listening: bind, read the port, close.
async function closedPort() {
  const s = net.createServer();
  const port = await listen(s);
  await close(s);
  return port;
}

test('varInt matches the Minecraft protocol examples', () => {
  assert.deepEqual([...varInt(0)], [0x00]);
  assert.deepEqual([...varInt(1)], [0x01]);
  assert.deepEqual([...varInt(127)], [0x7f]);
  assert.deepEqual([...varInt(128)], [0x80, 0x01]);
  assert.deepEqual([...varInt(25565)], [0xdd, 0xc7, 0x01]);
  assert.deepEqual([...varInt(-1)], [0xff, 0xff, 0xff, 0xff, 0x0f]);
});

test('readVarInt decodes, reports incomplete input, and rejects over-long values', () => {
  assert.deepEqual(readVarInt(Buffer.from([0xdd, 0xc7, 0x01])), { value: 25565, size: 3 });
  assert.equal(readVarInt(Buffer.from([0xdd, 0xc7])), null);
  assert.throws(() => readVarInt(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0x01])), /too long/);
});

for (const [status, expected] of [[200, true], [401, true], [404, true], [503, false]]) {
  test(`httpProbe: HTTP ${status} -> ${expected}`, async () => {
    const server = http.createServer((req, res) => { res.statusCode = status; res.end(); });
    const port = await listen(server);
    try { assert.equal(await httpProbe(port), expected); } finally { await close(server); }
  });
}

test('httpProbe: nothing listening -> false', async () => {
  assert.equal(await httpProbe(await closedPort()), false);
});

test('httpProbe: a server that never answers -> false within the timeout', async () => {
  const server = net.createServer(() => {}); // accepts, says nothing
  const port = await listen(server);
  const started = Date.now();
  try {
    assert.equal(await httpProbe(port, { timeoutMs: 200 }), false);
    assert.ok(Date.now() - started < 1500);
  } finally { server.close(); }
});

// A fake Minecraft server that checks the handshake it receives, then
// answers the status request the way a real server does.
function fakeMinecraft({ reply }) {
  const seen = {};
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      // Packet 1: handshake. Packet 2: status request (length 1, id 0).
      const len1 = readVarInt(buf);
      if (!len1 || buf.length < len1.size + len1.value + 2) return;
      let o = len1.size;
      const id = readVarInt(buf, o); o += id.size;
      const proto = readVarInt(buf, o); o += proto.size;
      const hostLen = readVarInt(buf, o); o += hostLen.size;
      seen.host = buf.toString('utf8', o, o + hostLen.value); o += hostLen.value;
      seen.port = buf.readUInt16BE(o); o += 2;
      seen.nextState = readVarInt(buf, o).value;
      seen.handshakeId = id.value;
      seen.statusRequest = [...buf.subarray(len1.size + len1.value)];
      reply(socket);
    });
    socket.on('error', () => {});
  });
  return { server, seen };
}

function statusPacket(json) {
  const body = Buffer.from(json, 'utf8');
  const payload = Buffer.concat([varInt(0x00), varInt(body.length), body]);
  return Buffer.concat([varInt(payload.length), payload]);
}

test('minecraftProbe: sends a status handshake and accepts a real-looking reply', async () => {
  const json = JSON.stringify({ version: { name: '26.2', protocol: 999 }, players: { max: 20, online: 1 }, description: { text: 'hi' } });
  const { server, seen } = fakeMinecraft({ reply: (s) => s.write(statusPacket(json)) });
  const port = await listen(server);
  try {
    assert.equal(await minecraftProbe(port), true);
    assert.equal(seen.handshakeId, 0x00);
    assert.equal(seen.host, '127.0.0.1');
    assert.equal(seen.port, port);
    assert.equal(seen.nextState, 1);
    assert.deepEqual(seen.statusRequest, [0x01, 0x00]);
  } finally { await close(server); }
});

test('minecraftProbe: a reply split across several TCP chunks still works', async () => {
  const packet = statusPacket(JSON.stringify({ version: { name: 'x', protocol: 1 }, description: 'y' }));
  const { server } = fakeMinecraft({
    reply: (s) => { s.write(packet.subarray(0, 3)); setTimeout(() => s.write(packet.subarray(3)), 20); },
  });
  const port = await listen(server);
  try { assert.equal(await minecraftProbe(port), true); } finally { await close(server); }
});

for (const [name, reply] of [
  ['garbage bytes', (s) => s.end(Buffer.from('HTTP/1.1 400 Bad Request\r\n\r\n'))],
  ['valid framing but not JSON', (s) => s.end(statusPacket('not json'))],
  ['JSON without a version', (s) => s.end(statusPacket('{"hello":"world"}'))],
  ['connection closed with no reply', (s) => s.end()],
]) {
  test(`minecraftProbe: ${name} -> false`, async () => {
    const { server } = fakeMinecraft({ reply });
    const port = await listen(server);
    try { assert.equal(await minecraftProbe(port, { timeoutMs: 1000 }), false); } finally { await close(server); }
  });
}

test('minecraftProbe: nothing listening -> false', async () => {
  assert.equal(await minecraftProbe(await closedPort()), false);
});

test('minecraftProbe: a server that never answers -> false within the timeout', async () => {
  const server = net.createServer(() => {});
  const port = await listen(server);
  const started = Date.now();
  try {
    assert.equal(await minecraftProbe(port, { timeoutMs: 200 }), false);
    assert.ok(Date.now() - started < 1500);
  } finally { server.close(); }
});

test('minecraftProbe: refuses an absurdly large reply', async () => {
  const { server } = fakeMinecraft({ reply: (s) => s.write(Buffer.concat([varInt(5_000_000), Buffer.alloc(300_000)])) });
  const port = await listen(server);
  try { assert.equal(await minecraftProbe(port, { timeoutMs: 1000 }), false); } finally { server.close(); }
});
