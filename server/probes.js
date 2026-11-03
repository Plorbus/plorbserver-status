// "Is it actually answering?" checks for the services on this box.
//
// systemd saying a unit is "active" only means the process exists. These
// probes connect to each service on 127.0.0.1 and see whether it answers.
// Ports are fixed in collect.js; nothing from a request reaches here.

import http from 'node:http';
import net from 'node:net';

// Any HTTP answer below 500 counts: a 404 or 401 still proves the app is
// alive. The email tracker is probed at "/" (Express answers 404 there and
// logs nothing) rather than /pixel/, which would log a fake open each time.
export function httpProbe(port, { host = '127.0.0.1', path = '/', timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(ok);
    };
    const req = http.request(
      { host, port, path, method: 'GET', headers: { 'user-agent': 'plorbserver-status-probe' } },
      (res) => { res.resume(); finish(res.statusCode < 500); },
    );
    const timer = setTimeout(() => finish(false), timeoutMs);
    req.on('error', () => finish(false));
    req.end();
  });
}

// --- Minecraft "Server List Ping" -------------------------------------
// The same request the game's multiplayer menu sends: a handshake saying
// "I want status", then a status request. The server answers with a JSON
// blob (version, MOTD, player counts). We only care that a valid answer
// comes back; nothing from it is passed on.

export function varInt(value) {
  const bytes = [];
  let v = value >>> 0; // negative numbers as 32-bit two's complement, like Java
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (v !== 0);
  return Buffer.from(bytes);
}

// Returns { value, size }, or null if the buffer ends mid-number.
export function readVarInt(buf, offset = 0) {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (offset + i >= buf.length) return null;
    const byte = buf[offset + i];
    value |= (byte & 0x7f) << (7 * i);
    if ((byte & 0x80) === 0) return { value, size: i + 1 };
  }
  throw new Error('VarInt too long');
}

const mcString = (s) => {
  const bytes = Buffer.from(s, 'utf8');
  return Buffer.concat([varInt(bytes.length), bytes]);
};

function packet(id, ...fields) {
  const body = Buffer.concat([varInt(id), ...fields]);
  return Buffer.concat([varInt(body.length), body]);
}

const MAX_REPLY_BYTES = 256 * 1024; // a status reply is a few KB, even with a server icon

export function minecraftProbe(port, { host = '127.0.0.1', timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let buf = Buffer.alloc(0);
    const socket = net.connect({ host, port });
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);

    socket.on('connect', () => {
      const port16 = Buffer.alloc(2);
      port16.writeUInt16BE(port);
      socket.write(Buffer.concat([
        // Handshake: protocol version -1 ("just asking"), address, port, next state 1 = status.
        packet(0x00, varInt(-1), mcString(host), port16, varInt(1)),
        // Status request: an empty packet 0x00.
        packet(0x00),
      ]));
    });

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        const length = readVarInt(buf);
        if (!length) return; // wait for more bytes
        if (length.value > MAX_REPLY_BYTES || buf.length > MAX_REPLY_BYTES) return finish(false);
        if (buf.length < length.size + length.value) return; // wait for the rest
        let offset = length.size;
        const id = readVarInt(buf, offset);
        if (!id || id.value !== 0x00) return finish(false);
        offset += id.size;
        const strLen = readVarInt(buf, offset);
        if (!strLen) return finish(false);
        offset += strLen.size;
        const status = JSON.parse(buf.toString('utf8', offset, offset + strLen.value));
        finish(typeof status === 'object' && status !== null && typeof status.version === 'object');
      } catch {
        finish(false);
      }
    });

    socket.on('error', () => finish(false));
    socket.on('end', () => finish(false));
    socket.on('close', () => finish(false));
  });
}
