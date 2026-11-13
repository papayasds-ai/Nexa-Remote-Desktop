'use strict';
/*
 * NexaDesk signaling server.
 * - Assigns stable 9-digit IDs derived from a device-held secret key (server stores nothing).
 * - Relays small JSON messages between peers. It never sees passwords or screen data:
 *   authentication is an HMAC challenge-response done end-to-end, and WebRTC media is DTLS-SRTP
 *   encrypted peer-to-peer (or via TURN, which only sees ciphertext).
 * - Issues short-lived TURN credentials so connections work behind strict NATs / firewalls.
 */
const fs = require('fs'), path = require('path'), http = require('http'), https = require('https'), crypto = require('crypto');
const { WebSocketServer } = require('ws');

const cfg = {
  port: 8080,
  stun: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'],
  turn: null,              // { urls: ["turn:host:3478?transport=udp","turns:host:443?transport=tcp"], secret: "..." }
  tlsCert: null, tlsKey: null,
  trustProxy: false,       // true when behind nginx/caddy (uses X-Forwarded-For)
  reqPerMinutePerIp: 20
};
try { Object.assign(cfg, JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'))); } catch (_) {}
if (process.env.PORT) cfg.port = +process.env.PORT;

const secretFile = path.join(__dirname, '.server-secret');
let SECRET;
try { SECRET = fs.readFileSync(secretFile, 'utf8').trim(); }
catch (_) { SECRET = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(secretFile, SECRET, { mode: 0o600 }); }

const idFor = key => String(crypto.createHmac('sha256', SECRET).update(key).digest().readUInt32BE(0) % 1e9).padStart(9, '0');

function iceServers(id) {
  const list = [{ urls: cfg.stun }];
  if (cfg.turn && cfg.turn.urls && cfg.turn.secret) {
    const user = (Math.floor(Date.now() / 1000) + 12 * 3600) + ':' + id;
    const cred = crypto.createHmac('sha1', cfg.turn.secret).update(user).digest('base64');
    list.push({ urls: cfg.turn.urls, username: user, credential: cred });
  }
  return list;
}

const handler = (req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true,"online":' + clients.size + '}'); }
  res.writeHead(404); res.end();
};
const server = (cfg.tlsCert && cfg.tlsKey)
  ? https.createServer({ cert: fs.readFileSync(cfg.tlsCert), key: fs.readFileSync(cfg.tlsKey), minVersion: 'TLSv1.2' }, handler)
  : http.createServer(handler);
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

const clients = new Map();   // id -> ws
const ipReq = new Map();     // ip -> [timestamps]
const ROUTED = new Set(['req', 'chal', 'auth', 'deny', 'sig', 'bye']);
const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);

function ipOf(req) {
  if (cfg.trustProxy && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
  return req.socket.remoteAddress;
}
function send(ws, o) { if (ws.readyState === 1) ws.send(JSON.stringify(o)); }

wss.on('connection', (ws, req) => {
  const ip = ipOf(req);
  ws.alive = true; ws.id = null; ws.bucket = 200; ws.bucketTs = Date.now();
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', raw => {
    // flood protection (token bucket ~ 20 msg/s with burst 200 for ICE candidates)
    const now = Date.now();
    ws.bucket = Math.min(200, ws.bucket + (now - ws.bucketTs) / 50); ws.bucketTs = now;
    if (--ws.bucket < 0) return ws.close(1008, 'rate limit');

    let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'hello') {
      if (typeof m.key !== 'string' || !/^[0-9a-f]{64}$/.test(m.key)) return ws.close(1008, 'bad key');
      const id = idFor(m.key);
      const old = clients.get(id);
      if (old && old !== ws && old.readyState === 1) {
        if (old.key !== m.key) return send(ws, { t: 'idtaken' });
        old.close(1000, 'replaced');           // same device reconnecting
      }
      ws.id = id; ws.key = m.key; clients.set(id, ws);
      return send(ws, { t: 'welcome', id, ice: iceServers(id) });
    }
    if (!ws.id) return;

    if (m.t === 'ice') return send(ws, { t: 'ice', ice: iceServers(ws.id) });

    if (!ROUTED.has(m.t) || typeof m.to !== 'string' || !/^\d{9}$/.test(m.to)) return;
    if (m.t === 'req') {
      const arr = (ipReq.get(ip) || []).filter(ts => now - ts < 60000);
      arr.push(now); ipReq.set(ip, arr);
      if (arr.length > cfg.reqPerMinutePerIp) return send(ws, { t: 'deny', from: m.to, reason: 'Too many requests. Slow down.' });
    }
    const target = clients.get(m.to);
    if (!target) return m.t === 'req' ? send(ws, { t: 'deny', from: m.to, reason: 'Partner is offline.' }) : undefined;
    // forward only whitelisted fields; the sender ID is always stamped by the server (cannot be spoofed)
    send(target, { t: m.t, from: ws.id, nonce: clip(m.nonce, 64), mac: clip(m.mac, 128), reason: clip(m.reason, 200),
                   data: m.data && typeof m.data === 'object' ? m.data : undefined });
  });
  ws.on('close', () => { if (ws.id && clients.get(ws.id) === ws) clients.delete(ws.id); });
  ws.on('error', () => {});
});

setInterval(() => {
  wss.clients.forEach(ws => { if (!ws.alive) return ws.terminate(); ws.alive = false; ws.ping(); });
  const now = Date.now();
  for (const [ip, a] of ipReq) { const f = a.filter(t => now - t < 60000); f.length ? ipReq.set(ip, f) : ipReq.delete(ip); }
}, 30000);

server.listen(cfg.port, () => console.log(`NexaDesk signaling server on ${(cfg.tlsCert ? 'wss' : 'ws')}://0.0.0.0:${cfg.port}  (TURN: ${cfg.turn ? 'enabled' : 'not configured'})`));
