// NexaDesk signaling server for Cloudflare Workers + Durable Objects.
// Same protocol as server/server.js, so the Windows/Android apps work unchanged.
// Secrets/vars: SERVER_SECRET (required), TURN_KEY_ID + TURN_API_TOKEN (optional, Cloudflare Realtime TURN).

const ROUTED = new Set(['req', 'chal', 'auth', 'deny', 'sig', 'bye']);
const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);

// Optional fixed TURN servers (secret TURN_STATIC = JSON array, e.g. ExpressTURN/Metered/own coturn with static credentials). Never stored in the repo.
function staticTurn(env) {
  try { const a = JSON.parse(env.TURN_STATIC || '[]'); return (Array.isArray(a) ? a : []).filter(s => s && s.urls && s.username && s.credential).slice(0, 6); } catch (_) { return []; }
}
function safeEq(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    // update files (manifest, signature, bundle): static assets, served with CORS so the apps can fetch them
    if (req.method === 'GET' && (url.pathname === '/update.json' || url.pathname === '/update.sig' || url.pathname === '/update.sig2' || /^\/www-\d+\.\d+\.\d+\.zip$/.test(url.pathname))) {
      const r = await env.ASSETS.fetch(req);
      const h = new Headers(r.headers);
      h.set('Access-Control-Allow-Origin', '*');
      h.set('Cache-Control', 'no-store');
      return new Response(r.body, { status: r.status, headers: h });
    }
    if (url.pathname === '/notify' && req.method === 'POST') {          // called by publish-ota.ps1 right after a release
      const got = req.headers.get('Authorization') || '';
      if (!env.OTA_NOTIFY_TOKEN || !safeEq(got, 'Bearer ' + env.OTA_NOTIFY_TOKEN)) return new Response('forbidden', { status: 403 });
      return env.HUB.get(env.HUB.idFromName('hub')).fetch(new Request('https://hub/broadcast', { method: 'POST', body: (await req.text()).slice(0, 2000) }));
    }
    if (url.pathname === '/health') return new Response(JSON.stringify({ ok: true, turn: !!(env.TURN_KEY_ID && env.TURN_API_TOKEN) || staticTurn(env).length > 0 }), { headers: { 'content-type': 'application/json' } });   // turn: is a relay configured?
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('NexaDesk signaling server', { status: 200 });
    return env.HUB.get(env.HUB.idFromName('hub')).fetch(req);
  }
};

export class Hub {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.ipReq = new Map(); this.ipMsg = new Map(); }

  async fetch(req) {
    if (req.headers.get('Upgrade') !== 'websocket') {                    // internal broadcast: tell every online device to update now
      let v = ''; try { v = String(JSON.parse(await req.text()).version || '').slice(0, 20); } catch (_) {}
      let n = 0; for (const s of this.ctx.getWebSockets()) { try { s.send(JSON.stringify({ t: 'ota', version: v })); n++; } catch (_) {} }
      return Response.json({ notified: n });
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id: null, key: null, ip: req.headers.get('cf-connecting-ip') || '' });
    return new Response(null, { status: 101, webSocket: client });
  }

  find(id) { return this.ctx.getWebSockets().find(w => { const a = w.deserializeAttachment(); return a && a.id === id; }); }

  async idFor(key) {
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(this.env.SERVER_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const d = new DataView(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(key)));
    return String(d.getUint32(0) % 1e9).padStart(9, '0');
  }

  async iceServers() {
    const list = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
    const { TURN_KEY_ID: id, TURN_API_TOKEN: tok } = this.env;
    if (id && tok) {
      try {
        const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${id}/credentials/generate-ice-servers`, {
          method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify({ ttl: 43200 })
        });
        if (r.ok) { const j = await r.json(); (j.iceServers || []).forEach(s => { if (s.username) list.push(s); }); }
      } catch (_) {}
    }
    staticTurn(this.env).forEach(s => list.push(s));   // fallback / extra relays
    return list;
  }

  async webSocketMessage(ws, raw) {
    const att = ws.deserializeAttachment() || {};
    const now = Date.now();
    if (typeof raw !== 'string' || raw.length > 65536) return ws.close(1009, 'too big');
    // flood control: max 400 messages / 10 s per IP
    const mk = att.ip, c = (this.ipMsg.get(mk) || []).filter(t => now - t < 10000); c.push(now); this.ipMsg.set(mk, c);
    if (c.length > 400) return ws.close(1008, 'rate limit');

    let m; try { m = JSON.parse(raw); } catch (_) { return; }
    if (!m || typeof m.t !== 'string') return;
    const send = (w, o) => { try { w.send(JSON.stringify(o)); } catch (_) {} };

    if (m.t === 'hello') {
      if (!this.env.SERVER_SECRET) return send(ws, { t: 'deny', from: '000000000', reason: 'Server misconfigured: SERVER_SECRET not set.' });
      if (typeof m.key !== 'string' || !/^[0-9a-f]{64}$/.test(m.key)) return ws.close(1008, 'bad key');
      const id = await this.idFor(m.key);
      const old = this.find(id);
      if (old && old !== ws) {
        if (old.deserializeAttachment().key !== m.key) return send(ws, { t: 'idtaken' });
        try { old.close(1000, 'replaced'); } catch (_) {}
      }
      ws.serializeAttachment({ id, key: m.key, ip: att.ip });
      return send(ws, { t: 'welcome', id, ice: await this.iceServers() });
    }
    if (!att.id) return;
    if (m.t === 'ice') return send(ws, { t: 'ice', ice: await this.iceServers() });
    if (!ROUTED.has(m.t) || typeof m.to !== 'string' || !/^\d{9}$/.test(m.to)) return;

    if (m.t === 'req') {
      const a = (this.ipReq.get(att.ip) || []).filter(t => now - t < 60000); a.push(now); this.ipReq.set(att.ip, a);
      if (a.length > 20) return send(ws, { t: 'deny', from: m.to, reason: 'Too many requests. Slow down.' });
    }
    const target = this.find(m.to);
    if (!target) return m.t === 'req' ? send(ws, { t: 'deny', from: m.to, reason: 'Partner is offline.' }) : undefined;
    send(target, { t: m.t, from: att.id, nonce: clip(m.nonce, 64), mac: clip(m.mac, 128), reason: clip(m.reason, 200),
                   data: m.data && typeof m.data === 'object' ? m.data : undefined });
  }

  async webSocketClose(ws, code) { try { ws.close(code && code !== 1005 ? code : 1000); } catch (_) {} }
  async webSocketError() {}
}
