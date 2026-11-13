'use strict';
(() => {
const $ = s => document.querySelector(s);
const enc = new TextEncoder();
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const unhex = h => new Uint8Array(h.match(/../g).map(x => parseInt(x, 16)));
const rnd = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
function genSecret(n = 12) {
  let out = '';
  while (out.length < n) { const b = crypto.getRandomValues(new Uint8Array(1))[0]; if (b < 224) out += ALPH[b % ALPH.length]; } // 224 = 56*4, no modulo bias
  return out;
}
const S = {
  get(k, d) { try { const v = localStorage.getItem('nx_' + k); return v === null ? d : JSON.parse(v); } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem('nx_' + k, JSON.stringify(v)); return true; } catch (_) { return false; } }
};
const fmtId = id => id ? id.replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3') : '— — —';
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 3200); }

// ---------- crypto helpers (HMAC-SHA256 challenge/response, mutual authentication) ----------
async function hmacKey(secret) { return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
async function hmacHex(secret, msg) { return hex(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(msg))); }
async function hmacOk(secret, msg, macHex) {
  try { return await crypto.subtle.verify('HMAC', await hmacKey(secret), unhex(macHex), enc.encode(msg)); } catch (_) { return false; }
}
async function sas(pc) { // short code both sides can read aloud to verify the DTLS session
  const fp = d => ((d && d.sdp.match(/a=fingerprint:sha-256 ([0-9A-F:]+)/i)) || [])[1] || '';
  const arr = [fp(pc.localDescription), fp(pc.remoteDescription)].sort().join('|');
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(arr)));
  const n = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
  const s = String(n % 1e6).padStart(6, '0'); return s.slice(0, 3) + ' ' + s.slice(3);
}

// ---------- state ----------
const canHost = !!(window.nexa && window.nexa.canHost);
let deviceKey = S.get('devkey'); if (!deviceKey) { deviceKey = rnd(32); S.set('devkey', deviceKey); }
let myId = null, iceServers = [], ws = null, retry = null;
let pw = null; const invites = new Map();       // code -> expiry
const pendingAuth = new Map(), fails = new Map();
let host = null, view = null;
let closing = false;                              // the page is unloading (app closing or an update reload): no side effects such as locking the PC

function log(role, peer, ev) {
  const l = S.get('log', []); l.unshift({ ts: new Date().toISOString().replace('T', ' ').slice(0, 19), role, peer, ev }); S.set('log', l.slice(0, 200)); renderLog();
}
function renderLog() {
  const box = $('#log'); box.innerHTML = '';
  S.get('log', []).forEach(e => { const d = document.createElement('div'); d.textContent = `${e.ts}  [${e.role}]  ${fmtId(e.peer)}  ${e.ev}`; box.appendChild(d); });
}

// ---------- password / invites ----------
let permPwCache = '';
async function loadPermPw() {
  const sec = window.nexa && window.nexa.secret && window.nexa.secret.available ? window.nexa.secret : null;
  if (sec) {
    try { permPwCache = (await sec.get()) || ''; } catch (_) { permPwCache = ''; }
    const old = S.get('permpw', '');                                  // migrate an older plain-text copy
    if (old && !permPwCache) {
      permPwCache = old;                                                // keep the current session usable if secure migration fails
      try { if (await sec.set(old)) localStorage.removeItem('nx_permpw'); } catch (_) {}
    } else if (old) localStorage.removeItem('nx_permpw');
  } else permPwCache = S.get('permpw', '') || '';
}
function newPw() {
  const perm = permPwCache;
  pw = (S.get('unattended', false) && perm.length >= 12) ? perm : genSecret(12);
  $('#myPw').textContent = pw;
}
function validInvites() { const now = Date.now(); for (const [c, e] of invites) if (e < now) invites.delete(c); return [...invites.keys()]; }

// ---------- signaling ----------
const send = o => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
function setStatus(txt, cls) { const s = $('#status'); s.className = 'status ' + (cls || ''); s.querySelector('span').textContent = txt; }
function connectWS() {
  clearTimeout(retry);
  const url = S.get('server', window.NEXA_DEFAULT_SERVER || '');
  if (!url) { setStatus('No server set (Settings)', 'bad'); return; }
  try { if (ws) { ws.onclose = null; ws.close(); } } catch (_) {}
  setStatus('Connecting…');
  try { ws = new WebSocket(url); } catch (e) { setStatus('Bad server URL', 'bad'); return; }
  ws.onopen = () => send({ t: 'hello', key: deviceKey });
  ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch (_) { return; } onMsg(m).catch(err => console.error(err)); };
  ws.onclose = () => { setStatus('Offline – retrying…', 'bad'); retry = setTimeout(connectWS, 3000); };
}
function iceList() {
  let extra = []; try { extra = JSON.parse(S.get('extraIce', '') || '[]'); } catch (_) {}
  return iceServers.concat(Array.isArray(extra) ? extra : []);
}
const hasTurn = () => iceList().some(s => s && (s.username || s.credential));   // a relay (TURN) is what lets phones on mobile data connect
function relayInfo() { const el = $('#relayInfo'); if (el) el.textContent = hasTurn() ? 'Relay (TURN): available - connections also work from mobile data and strict networks.' : 'Relay (TURN): NOT set up on your server - connections from mobile data (5G/4G) and office networks usually fail. Run START-HERE.bat option T once.'; }
// relay credentials are issued once per server connection and expire after 12 h: a PC left on for days would lose the relay (phones on 5G could no longer connect), so ask for fresh ones regularly
setInterval(() => { if (ws && ws.readyState === 1 && myId) send({ t: 'ice' }); }, 20 * 60 * 1000);
// records what a connection attempt did (candidate types, ICE state) in the Connection log, so a failure can be understood afterwards
function watchIce(pc, role, peer) {
  const n = { host: 0, srflx: 0, relay: 0 };
  pc.addEventListener('icecandidate', e => { if (e.candidate && e.candidate.type in n) n[e.candidate.type]++; });
  pc.addEventListener('iceconnectionstatechange', () => { const s = pc.iceConnectionState; if (['connected', 'failed', 'disconnected'].includes(s)) log(role, peer, 'ICE ' + s + ' (own candidates: ' + n.host + ' host, ' + n.srflx + ' srflx, ' + n.relay + ' relay)'); });
}
async function onMsg(m) {
  switch (m.t) {
    case 'ota': checkOta(false, true); break;   // server says a new release was just published
    case 'welcome': myId = m.id; S.set('lastId', myId); iceServers = m.ice || []; relayInfo(); $('#myId').textContent = fmtId(myId); setStatus('Ready – secure connection', 'ok'); break;
    case 'ice': iceServers = m.ice || []; relayInfo(); break;   // fresh relay credentials (the old ones expire after 12 h)
    case 'idtaken': deviceKey = rnd(32); S.set('devkey', deviceKey); send({ t: 'hello', key: deviceKey }); break;
    case 'req': await onReq(m.from); break;
    case 'chal': await onChal(m.from, m.nonce); break;
    case 'auth': await onAuth(m.from, m.mac); break;
    case 'deny': if (view && view.to === m.from) { toast(m.reason || 'Connection refused'); log('viewer', m.from, 'refused: ' + (m.reason || '')); endView(false); } break;
    case 'sig': await onSig(m.from, m.data || {}); break;
    case 'bye': if (host && host.peer === m.from) endHost(false); if (view && view.to === m.from) { toast('Remote ended the session'); endView(false); } break;
  }
}

// ---------- HOST side ----------
async function onReq(from) {
  if (!canHost) return send({ t: 'deny', to: from, reason: 'This device can only control others (viewer mode).' });
  const f = fails.get(from); if (f && f.until > Date.now()) return send({ t: 'deny', to: from, reason: 'Too many failed attempts. Try again later.' });
  if (host) return send({ t: 'deny', to: from, reason: 'Device is busy with another session.' });
  const nonce = rnd(16); pendingAuth.set(from, { nonce, ts: Date.now() });
  log('host', from, 'connection requested');
  send({ t: 'chal', to: from, nonce });
}
async function onAuth(from, mac) {
  const p = pendingAuth.get(from); pendingAuth.delete(from);
  if (!p || Date.now() - p.ts > 30000 || typeof mac !== 'string') return;
  const msg = 'auth:' + p.nonce + ':' + from + ':' + myId;
  let secret = null, kind = null;
  if (await hmacOk(pw, msg, mac)) { secret = pw; kind = 'password'; }
  else for (const c of validInvites()) if (await hmacOk(c, msg, mac)) { secret = c; kind = 'invite'; invites.delete(c); $('#inviteCode').textContent = '—'; break; }
  if (!secret) {
    const f = fails.get(from) || { n: 0, until: 0 }; f.n++; if (f.n >= 5) { f.until = Date.now() + 10 * 60000; f.n = 0; } fails.set(from, f);
    log('host', from, 'AUTH FAILED'); return send({ t: 'deny', to: from, reason: 'Authentication failed.' });
  }
  fails.delete(from);
  let perm;
  if (kind === 'password' && S.get('unattended', false)) perm = { control: S.get('defControl', true), clip: S.get('defClip', true) };
  else perm = await askConsent(from);
  if (!perm) { log('host', from, 'denied by user'); return send({ t: 'deny', to: from, reason: 'The user declined the request.' }); }
  try { await startHost(from, secret, perm); } catch (e) { console.error(e); toast('Could not start screen sharing'); send({ t: 'deny', to: from, reason: 'Host could not capture the screen.' }); endHost(false); }
}
function askConsent(from) {
  return new Promise(res => {
    $('#mdId').textContent = fmtId(from); $('#mdCtl').checked = S.get('defControl', true); $('#mdClip').checked = S.get('defClip', true);
    $('#modal').hidden = false; try { window.nexa && window.nexa.focus(); } catch (_) {}
    const done = v => { $('#modal').hidden = true; clearTimeout(t); res(v); };
    const t = setTimeout(() => done(null), 30000);
    $('#mdYes').onclick = () => done({ control: $('#mdCtl').checked, clip: $('#mdClip').checked });
    $('#mdNo').onclick = () => done(null);
  });
}
async function startHost(from, secret, perm) {
  try { if (perm.control && window.nexa && window.nexa.warm) window.nexa.warm(); } catch (_) {}   // start the input helper now, while the screen-share prompt is open
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 60, max: 60 } }, audio: false });
  const pc = new RTCPeerConnection({ iceServers: iceList() }); watchIce(pc, 'host', from);
  host = { peer: from, pc, stream, perm, secret, q: [], remoteSet: false, t0: Date.now() };
  try { if (window.nexa && window.nexa.hostSession) window.nexa.hostSession(from, !!perm.control); } catch (_) {}
  stream.getTracks().forEach(t => { try { t.contentHint = 'motion'; } catch (_) {} pc.addTrack(t, stream); });
  stream.getVideoTracks()[0].onended = () => endHost(true);
  const dc = pc.createDataChannel('ctl', { ordered: true }); host.dc = dc;
  dc.onmessage = e => onHostInput(e.data);
  dc.onclose = () => { if (host && host.pc === pc) { log('host', from, 'control channel closed'); endHost(true); } };
  pc.onicecandidate = e => e.candidate && send({ t: 'sig', to: from, data: { ice: e.candidate } });
  pc.onconnectionstatechange = () => {   // a network change (Wi-Fi <-> 5G) must not end the session at once: try an ICE restart first
    const s = pc.connectionState;
    if (s === 'closed') return endHost(true);
    if (!host || host.pc !== pc) return;
    if (s === 'connected') { clearTimeout(host.failT); return; }
    if (s === 'disconnected') setTimeout(() => { if (host && host.pc === pc && pc.connectionState === 'disconnected') hostRestart(); }, 4000);
    if (s === 'failed') { hostRestart(); clearTimeout(host.failT); host.failT = setTimeout(() => { if (host && host.pc === pc && pc.connectionState !== 'connected') endHost(true); }, 40000); }
  };
  const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
  const sdp = pc.localDescription.sdp;
  send({ t: 'sig', to: from, data: { type: 'offer', sdp, mac: await hmacHex(secret, 'offer:' + sdp) } });
  pc.getSenders().forEach(s => { if (s.track && s.track.kind === 'video') { const p = s.getParameters(); p.encodings = p.encodings && p.encodings.length ? p.encodings : [{}]; p.encodings[0].maxBitrate = 8e6; s.setParameters(p).catch(() => {}); } });
  $('#bnId').textContent = fmtId(from); $('#bnCtl').checked = perm.control; $('#banner').hidden = false;
  log('host', from, 'session started (control=' + perm.control + ')');
  const info = await sas(pc).catch(() => ''); if (info) toast('Session verification code: ' + info);
}
$('#bnCtl').onchange = e => { if (host) { host.perm.control = e.target.checked; try { window.nexa && window.nexa.hostSession && window.nexa.hostSession(host.peer, host.perm.control); } catch (_) {} } };
$('#bnStop').onclick = () => endHost(true);
// ---- stream quality presets (chosen by the viewer, applied by the host) ----
// 'motion' keeps the frame rate up (smooth cursor) and lets the resolution drop under load; 'detail' keeps text sharp but may lower the frame rate
const QUALITY = { auto: { br: 10e6, hint: 'motion', fps: 60 }, smooth: { br: 3e6, hint: 'motion', fps: 30 }, sharp: { br: 15e6, hint: 'detail', fps: 30 },
  // for a weak connection (phone on 5G, slow upload at the PC): half the width and height, so every pixel gets 4x the bits = readable text instead of mush
  lowdata: { br: 2e6, hint: 'detail', fps: 15, scale: 2 } };
function applyQuality(q) {
  const c = QUALITY[q]; if (!host || !c) return;
  host.pc.getSenders().forEach(s => {
    if (!s.track || s.track.kind !== 'video') return;
    try { s.track.contentHint = c.hint; } catch (_) {}
    const p = s.getParameters(); p.encodings = p.encodings && p.encodings.length ? p.encodings : [{}];
    p.encodings[0].maxBitrate = c.br; p.encodings[0].maxFramerate = c.fps; p.encodings[0].scaleResolutionDownBy = c.scale || 1; s.setParameters(p).catch(() => {});
  });
}
function endHost(notify) {
  if (!host) return; const h = host; host = null;
  if (notify) send({ t: 'bye', to: h.peer });
  clearTimeout(h.failT); clearInterval(h.clipTimer);
  try { h.dc && h.dc.close(); } catch (_) {} try { h.pc.close(); } catch (_) {}
  try { h.stream.getTracks().forEach(t => t.stop()); } catch (_) {}
  $('#banner').hidden = true; log('host', h.peer, 'session ended' + (h.t0 ? ' after ' + Math.round((Date.now() - h.t0) / 1000) + ' s' : '')); setTimeout(applyWhenIdle, 500);
  if (!S.get('unattended', false)) newPw();       // rotate one-time password after every session
  if (!closing && S.get('lockOnEnd', false) && h.perm && h.perm.control && h.t0 && Date.now() - h.t0 > 3000) lockThisPc();
  try { window.nexa && window.nexa.hostSession && window.nexa.hostSession(null, false); } catch (_) {}
}
function lockThisPc() {                            // same keys as the "Lock PC" button (Win+L), pressed locally
  const keys = COMBOS['win-l']; if (!keys || !window.nexa) return;
  keys.forEach(vk => window.nexa.input(`K ${vk} 1 ${EXT.has(vk) ? 1 : 0}`));
  [...keys].reverse().forEach(vk => window.nexa.input(`K ${vk} 0 ${EXT.has(vk) ? 1 : 0}`));
}
const nm = v => typeof v === 'number' && isFinite(v) && v >= 0 && v <= 1;
function onHostInput(raw) {
  if (!host) return; let m; try { m = JSON.parse(raw); } catch (_) { return; }
  const inp = c => window.nexa && window.nexa.input(c);
  if (m.k === 'clip') { if (host.perm.clip && typeof m.v === 'string' && m.v.length < CLIPMAX) { host.clipLast = m.v; navigator.clipboard.writeText(m.v).catch(() => {}); } return; }
  if (m.k === 'autoclip') {   // the viewer switched automatic clipboard sync on or off
    clearInterval(host.clipTimer); host.autoClip = !!m.v && !!host.perm.clip;
    if (host.autoClip) readLocalClip().then(v => { if (v !== null) host.clipLast = v; if (host && host.autoClip) host.clipTimer = setInterval(hostClipPoll, 1500); });
    return;
  }
  if (m.k === 'getclip') {
    if (!host.perm.clip) return host.dc.send(JSON.stringify({ k: 'clipdeny' }));
    navigator.clipboard.readText().then(v => host.dc && host.dc.send(JSON.stringify({ k: 'clipback', v: String(v).slice(0, 100000) }))).catch(() => {});
    return;
  }
  if (m.k === 'cap') {   // a new viewer asks for the fast mouse channel: unordered, no retransmits (a lost move is simply replaced by the next one)
    if (m.mv === 1 && !host.mv && host.pc) { host.mv = host.pc.createDataChannel('mv', { ordered: false, maxRetransmits: 0 }); host.mv.onmessage = e => onHostInput(e.data); }
    return;
  }
  if (m.k === 'q') { if (typeof m.v === 'string' && Object.prototype.hasOwnProperty.call(QUALITY, m.v)) applyQuality(m.v); return; }
  if (!host.perm.control) return;
  switch (m.k) {
    case 'm': if (nm(m.x) && nm(m.y)) inp(`M ${Math.round(m.x * 65535)} ${Math.round(m.y * 65535)}`); break;
    case 'd': case 'u': if ('lrm'.includes(m.b) && m.b.length === 1) inp(`${m.k === 'd' ? 'D' : 'U'} ${m.b}`); break;
    case 'w': if (typeof m.v === 'number') inp(`W ${Math.max(-1200, Math.min(1200, Math.round(m.v)))}`); break;
    case 'r': if (Number.isFinite(m.dx) && Number.isFinite(m.dy)) inp(`R ${Math.max(-1000, Math.min(1000, Math.round(m.dx)))} ${Math.max(-1000, Math.min(1000, Math.round(m.dy)))}`); break;
    case 'kd': case 'ku': if (Number.isInteger(m.vk) && m.vk > 0 && m.vk < 255) inp(`K ${m.vk} ${m.k === 'kd' ? 1 : 0} ${m.ext ? 1 : 0}`); break;
    case 't': if (typeof m.v === 'string') [...m.v.slice(0, 200)].forEach(ch => { const c = ch.codePointAt(0); if (c > 0 && c < 65536) inp(`T ${c}`); }); break;
  }
}

// ---------- VIEWER side ----------
function connectTo(id, secret) {
  id = (id || '').replace(/\D/g, '');
  if (id.length !== 9) return toast('Enter a valid 9-digit ID');
  if (!secret) return toast('Enter the password or invite code');
  if (!ws || ws.readyState !== 1 || !myId) return toast('Not connected to the server');
  if (id === myId) return toast('That is your own ID');
  if (view) endView(true);
  view = { to: id, secret, st: 'auth', q: [], remoteSet: false };
  view.timer = setTimeout(() => { if (view && view.st !== 'live') { toast(hasTurn() ? 'No response from partner' : 'No connection: direct link blocked and no relay (TURN) set up on your server - run START-HERE option T'); endView(false); } }, 60000);
  toast('Contacting partner…'); log('viewer', id, 'connecting'); pushRecent(id);
  send({ t: 'req', to: id });
}
async function onChal(from, nonce) {
  if (!view || view.to !== from || view.st !== 'auth' || typeof nonce !== 'string') return;
  view.st = 'wait';
  const pc = new RTCPeerConnection({ iceServers: iceList() }); view.pc = pc; watchIce(pc, 'viewer', from);
  pc.onicecandidate = e => e.candidate && send({ t: 'sig', to: from, data: { ice: e.candidate } });
  pc.ontrack = e => { $('#vid').srcObject = e.streams[0]; try { e.receiver.playoutDelayHint = 0; } catch (_) {} try { e.receiver.jitterBufferTarget = 0; } catch (_) {} };   // show frames as soon as they arrive
  pc.ondatachannel = e => {
    if (e.channel.label === 'mv') { view.mv = e.channel; return; }
    view.dc = e.channel; e.channel.onmessage = ev => onPcMsg(ev.data);
    const sendQ = () => { dcs({ k: 'q', v: S.get('quality', 'auto') }); dcs({ k: 'cap', mv: 1 }); };
    e.channel.onopen = sendQ; if (e.channel.readyState === 'open') sendQ();
  };
  pc.onconnectionstatechange = async () => {
    if (!view) return;
    if (pc.connectionState === 'connected' && view.st !== 'live') { view.st = 'live'; showSession(); }
    if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
      if (view.st === 'live' && pc.connectionState !== 'closed') viewerRecover(pc, from);   // network change on a live session: ask the PC for an ICE restart
      else if (pc.connectionState !== 'disconnected') { toast(hasTurn() ? 'Connection lost' : 'Could not connect: direct connection blocked and no relay (TURN) set up on your server - run START-HERE option T'); endView(false); }
    }
  };
  send({ t: 'auth', to: from, mac: await hmacHex(view.secret, 'auth:' + nonce + ':' + myId + ':' + from) });
}
async function onSig(from, d) {
  if (view && view.to === from && view.pc) {
    if (d.sdp && d.type === 'offer') {
      if (!(await hmacOk(view.secret, 'offer:' + d.sdp, d.mac || ''))) { toast('Host failed authentication – aborting (possible tampering)'); log('viewer', from, 'OFFER MAC INVALID'); return endView(true); }
      view.remoteSet = false; await view.pc.setRemoteDescription({ type: 'offer', sdp: d.sdp }); view.remoteSet = true;
      for (const c of view.q) await view.pc.addIceCandidate(c).catch(() => {}); view.q = [];
      const ans = await view.pc.createAnswer(); await view.pc.setLocalDescription(ans);
      const sdp = view.pc.localDescription.sdp;
      send({ t: 'sig', to: from, data: { type: 'answer', sdp, mac: await hmacHex(view.secret, 'answer:' + sdp) } });
    } else if (d.ice) { view.remoteSet ? await view.pc.addIceCandidate(d.ice).catch(() => {}) : view.q.push(d.ice); }
  } else if (host && host.peer === from) {
    if (d.sdp && d.type === 'answer') {
      if (!(await hmacOk(host.secret, 'answer:' + d.sdp, d.mac || ''))) { log('host', from, 'ANSWER MAC INVALID'); return endHost(true); }
      await host.pc.setRemoteDescription({ type: 'answer', sdp: d.sdp }); host.remoteSet = true;
      for (const c of host.q) await host.pc.addIceCandidate(c).catch(() => {}); host.q = [];
    } else if (d.ice) { host.remoteSet ? await host.pc.addIceCandidate(d.ice).catch(() => {}) : host.q.push(d.ice); }
    else if (d.restart) hostRestart();   // the viewer lost the connection and asks for an ICE restart
  }
}
async function showSession() {
  clearTimeout(view.timer); $('#session').hidden = false; log('viewer', view.to, 'session live'); view.t0 = Date.now();
  zReset(); setTb(!matchMedia('(pointer: coarse)').matches && innerWidth >= 900);   // phones/tablets start with the controls hidden
  const code = await sas(view.pc).catch(() => '');
  const upd = async () => {
    if (!view) return; let kind = '?', rtt = '', fps = '';
    try { const st = await view.pc.getStats(); const loc = {}; st.forEach(r => { if (r.type === 'local-candidate') loc[r.id] = r; if (r.type === 'inbound-rtp' && r.kind === 'video' && r.framesPerSecond) fps = Math.round(r.framesPerSecond); });
      st.forEach(r => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') { const l = loc[r.localCandidateId]; kind = l ? (l.candidateType === 'relay' ? 'Relay (TURN)' : l.candidateType === 'host' ? 'Direct (LAN)' : 'Direct (P2P)') : '?'; if (r.currentRoundTripTime) rtt = Math.round(r.currentRoundTripTime * 1000) + ' ms'; } }); } catch (_) {}
    $('#sesInfo').textContent = `${fmtId(view.to)} · ${kind} ${rtt}${fps ? ' · ' + fps + ' fps' : ''} · verify code ${code}`;
  };
  upd(); view.statTimer = setInterval(upd, 3000);
  view.adaptTimer = setInterval(adaptTick, 3000); clipAutoStart();
}
function endView(notify) {
  if (!view) return; tpReset(); const v = view; view = null;
  clearTimeout(v.timer); clearInterval(v.statTimer); clearInterval(v.adaptTimer); clearInterval(v.recov); clearInterval(clip.timer);
  if (notify) send({ t: 'bye', to: v.to });
  try { v.pc && v.pc.close(); } catch (_) {}
  $('#vid').srcObject = null; $('#session').hidden = true; if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  log('viewer', v.to, 'session ended' + (v.t0 ? ' after ' + Math.round((Date.now() - v.t0) / 1000) + ' s' : '')); setTimeout(applyWhenIdle, 500);
}
// input capture
const vid = $('#vid');
// ----- collapsible floating toolbar: one toggle button; the bars are hidden until it is tapped -----
const sessEl = $('#session');
function setTb(open) { sessEl.classList.toggle('tbclosed', !open); const b = $('#tbToggle'); b.textContent = open ? '✕' : '☰'; b.setAttribute('aria-expanded', String(!!open)); }
$('#tbToggle').onclick = () => setTb(sessEl.classList.contains('tbclosed'));
// ----- pinch-to-zoom and two-finger pan of the remote picture (view only: the cursor mapping is corrected in norm()) -----
const Z = { s: 1, tx: 0, ty: 0, as: 1, atx: 0, aty: 0 };   // wanted / applied scale and translation (origin = top-left of the video box)
const stageEl = document.querySelector('.stage');
const zc = s => Math.min(6, Math.max(1, s));
function zApply() {
  Z.as = Z.s; Z.atx = Z.tx; Z.aty = Z.ty;
  vid.style.transform = Z.s === 1 ? '' : `translate(${Z.tx}px,${Z.ty}px) scale(${Z.s})`;
  const b = $('#btnZoom'); if (b) b.textContent = Math.round(Z.s * 100) + '%';
}
function zBase() { const r = vid.getBoundingClientRect(); return { l: r.left - Z.atx, t: r.top - Z.aty, w: r.width / Z.as, h: r.height / Z.as }; }
function zSet(s, tx, ty) {
  Z.s = zc(s); Z.tx = tx; Z.ty = ty;
  if (Z.s <= 1.001) { Z.s = 1; Z.tx = 0; Z.ty = 0; zApply(); return; }
  const S = stageEl.getBoundingClientRect(), b = zBase(), bw = b.w * Z.s, bh = b.h * Z.s;   // keep the picture from leaving the screen
  const rng = (sl, sr, bl, sz) => { const a = sl - bl, c = sr - bl - sz; return [Math.min(a, c), Math.max(a, c)]; };
  const [x0, x1] = rng(S.left, S.right, b.l, bw), [y0, y1] = rng(S.top, S.bottom, b.t, bh);
  Z.tx = Math.min(x1, Math.max(x0, Z.tx)); Z.ty = Math.min(y1, Math.max(y0, Z.ty));
  zApply();
}
function zReset() { Z.s = 1; Z.tx = 0; Z.ty = 0; zApply(); }
$('#btnZoom').onclick = zReset;
// two fingers: pinch = zoom (+ pan with the midpoint); once zoomed in, dragging = pan; at 100% dragging = remote scroll (as before)
function twoMove() {
  const pts = [...tp.ptrs.values()]; if (pts.length < 2) return null;
  const [a, b] = pts, d = Math.hypot(a.x - b.x, a.y - b.y) || 1, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  let t = tp.two;
  if (!t) { const bb = zBase(); tp.two = { d0: d, mx0: mx, my0: my, s0: Z.s, tx0: Z.tx, ty0: Z.ty, bl: bb.l, bt: bb.t, mode: null }; return null; }
  if (!t.mode) {
    if (Math.abs(d - t.d0) > 14) t.mode = 'zoom';
    else if (Math.hypot(mx - t.mx0, my - t.my0) > 12) t.mode = Z.s > 1.01 ? 'pan' : 'scroll';
    else return null;
  }
  if (t.mode === 'scroll') return 'scroll';
  const s = t.mode === 'zoom' ? zc(t.s0 * d / t.d0) : t.s0;
  const cx = (t.mx0 - t.bl - t.tx0) / t.s0, cy = (t.my0 - t.bt - t.ty0) / t.s0;   // picture point that was under the fingers' midpoint
  zSet(s, mx - cx * s - t.bl, my - cy * s - t.bt);
  return t.mode;
}
function onPcMsg(raw) {
  let m; try { m = JSON.parse(raw); } catch (_) { return; }
  if (m.k === 'clipback' && typeof m.v === 'string') navigator.clipboard.writeText(m.v).then(() => toast('PC clipboard copied to this device')).catch(() => toast('Could not copy the PC clipboard'));
  if (m.k === 'clipdeny') toast('The PC does not allow clipboard sharing');
  if (m.k === 'clipsync' && typeof m.v === 'string' && m.v.length <= CLIPMAX && S.get('autoClip', false)) { clip.last = m.v; navigator.clipboard.writeText(m.v).catch(() => {}); }   // automatic sync: the PC's clipboard changed
}
$('#btnSwitch').onclick = () => {
  const cur = view && view.to;
  const next = S.get('savedPcs', []).find(p => p.id !== cur);
  endView(true);
  document.querySelector('[data-tab="home"]').click();
  if (next) { $('#remId').value = next.id; if (next.pw) { $('#remPw').value = next.pw; toast('Press Connect for ' + fmtId(next.id)); } else { $('#remPw').focus(); toast('Enter the password for ' + fmtId(next.id)); } }
  else toast('Save another PC first (Remote Control tab)');
};
$('#btnPcClip').onclick = () => { dcs({ k: 'getclip' }); toast('Requesting the PC clipboard…'); };
const dcs = o => { if (view && view.dc && view.dc.readyState === 'open') view.dc.send(JSON.stringify(o)); };
const dcm = o => { const c = view && view.mv && view.mv.readyState === 'open' ? view.mv : null; if (c) c.send(JSON.stringify(o)); else dcs(o); };   // mouse moves: fast channel when the host has one
function norm(e) {   // pointer -> 0..1 position in the remote picture; works while zoomed (the CSS transform scale k is divided out)
  const r = vid.getBoundingClientRect(), vw = vid.videoWidth, vh = vid.videoHeight; if (!vw) return null;
  const k = Z.as || 1, rw = r.width / k, rh = r.height / k;
  let w, h, ox, oy;
  if (vid.classList.contains('actual')) { w = vw; h = vh; ox = (rw - w) / 2; oy = (rh - h) / 2; }
  else { const s = Math.min(rw / vw, rh / vh); w = vw * s; h = vh * s; ox = (rw - w) / 2; oy = (rh - h) / 2; }
  return { x: Math.min(1, Math.max(0, ((e.clientX - r.left) / k - ox) / w)), y: Math.min(1, Math.max(0, ((e.clientY - r.top) / k - oy) / h)) };
}
let moveQ = null;
const btnOf = e => (e.button === 2 ? 'r' : e.button === 1 ? 'm' : 'l');
const isTouchPtr = e => e.pointerType === 'touch' || e.pointerType === 'pen';
// ----- mouse on a desktop viewer: absolute positioning, as before -----
vid.addEventListener('pointermove', e => { if (isTouchPtr(e)) return; const p = norm(e); if (!p) return; if (!moveQ) requestAnimationFrame(() => { dcm({ k: 'm', ...moveQ }); moveQ = null; }); moveQ = p; });
vid.addEventListener('pointerdown', e => { if (isTouchPtr(e)) return; vid.setPointerCapture(e.pointerId); vid.focus(); e.preventDefault(); const p = norm(e); if (p) dcs({ k: 'm', ...p }); dcs({ k: 'd', b: btnOf(e) }); });
vid.addEventListener('pointerup', e => { if (isTouchPtr(e)) return; dcs({ k: 'u', b: btnOf(e) }); e.preventDefault(); });
// touch / pen: anywhere on the session screen (not on buttons, sliders or the keyboard field)
const sess = $('#session');
sess.addEventListener('pointerdown', e => {
  if (!isTouchPtr(e) || e.target.closest('button, input, label, select, .bar, .padbar')) return;
  sess.setPointerCapture(e.pointerId); e.preventDefault(); tpDown(e);
});
sess.addEventListener('pointermove', e => { if (isTouchPtr(e)) tpMove(e); });
sess.addEventListener('pointerup', e => { if (isTouchPtr(e)) tpUp(e); });
sess.addEventListener('pointercancel', e => { if (isTouchPtr(e)) tpUp(e); });
vid.addEventListener('contextmenu', e => e.preventDefault());
vid.addEventListener('wheel', e => {
  if (e.ctrlKey) {   // trackpad pinch / Ctrl+wheel on a PC = zoom the picture around the pointer
    const b = zBase(), s = zc(Z.s * (e.deltaY < 0 ? 1.1 : 1 / 1.1)), cx = (e.clientX - b.l - Z.tx) / Z.s, cy = (e.clientY - b.t - Z.ty) / Z.s;
    zSet(s, e.clientX - cx * s - b.l, e.clientY - cy * s - b.t); e.preventDefault(); return;
  }
  dcs({ k: 'w', v: -e.deltaY }); e.preventDefault();
}, { passive: false });

// ----- touch / pen on a phone or tablet: trackpad style, the cursor never jumps to the finger -----
//   drag            = move cursor (relative to finger movement)
//   tap             = left click
//   tap, then tap and hold = drag (release to drop)
//   two-finger tap  = right click
//   two-finger drag = scroll
//   press and hold  = right click
//   Left / Hold / Right buttons below the screen do the same without gestures
const tp = { ptrs: new Map(), gesture: 'idle', dragging: false, hold: false, lastTapEnd: 0, longT: null, maxN: 0, moved: false, accX: 0, accY: 0, accW: 0 };
const sensOf = () => Math.min(6, Math.max(1, +S.get('sens', 2.5) || 2.5));
function tpSend(dx, dy) {
  tp.accX += dx; tp.accY += dy;
  const ix = Math.trunc(tp.accX), iy = Math.trunc(tp.accY);
  if (!ix && !iy) return;
  tp.accX -= ix; tp.accY -= iy;
  dcs({ k: 'r', dx: ix, dy: iy });
}
const clickBtn = b => { dcs({ k: 'd', b }); dcs({ k: 'u', b }); };
function tpDown(e) {
  const now = performance.now();
  if (tp.ptrs.size === 0) { tp.maxN = 0; tp.moved = false; tp.gesture = 'point'; }
  tp.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: now, moved: false });
  tp.maxN = Math.max(tp.maxN, tp.ptrs.size);
  clearTimeout(tp.longT);
  if (tp.ptrs.size === 1) {
    if (now - tp.lastTapEnd < 300 && !tp.hold) { tp.dragging = true; dcs({ k: 'd', b: 'l' }); }   // second tap = press and drag
    else tp.longT = setTimeout(() => { if (tp.gesture === 'point' && !tp.moved && !tp.dragging) { clickBtn('r'); tp.gesture = 'done'; } }, 600);
  } else {                                  // second finger: two-finger gesture (cancels any drag)
    if (tp.dragging) { tp.dragging = false; dcs({ k: 'u', b: 'l' }); }
    tp.gesture = 'two'; tp.two = null;
  }
}
function tpMove(e) {
  const p = tp.ptrs.get(e.pointerId); if (!p) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
  if (!p.moved && Math.hypot(e.clientX - p.sx, e.clientY - p.sy) > 10) { p.moved = true; tp.moved = true; clearTimeout(tp.longT); }
  if (tp.gesture === 'point' && tp.ptrs.size === 1) tpSend(dx * sensOf() / Z.s, dy * sensOf() / Z.s);   // zoomed in = finer cursor control
  else if (tp.gesture === 'two') { if (twoMove() === 'scroll') { tp.accW += dy * 1.5; const w = Math.trunc(tp.accW); if (w) { tp.accW -= w; dcs({ k: 'w', v: w }); } } }
}
function tpUp(e) {
  const p = tp.ptrs.get(e.pointerId); if (!p) return;
  tp.ptrs.delete(e.pointerId);
  if (tp.ptrs.size > 0) return;             // wait until every finger is up
  const now = performance.now(), dur = now - p.t;
  clearTimeout(tp.longT);
  let leftTap = false;
  if (tp.dragging) { tp.dragging = false; dcs({ k: 'u', b: 'l' }); }
  else if (tp.gesture === 'point' && !tp.moved && dur < 250) { clickBtn('l'); leftTap = true; }
  else if (tp.gesture === 'two' && !tp.moved && tp.maxN >= 2 && dur < 400) clickBtn('r');
  tp.lastTapEnd = leftTap ? now : 0;
  tp.gesture = 'idle'; tp.moved = false; tp.maxN = 0; tp.accW = 0; tp.two = null;
}
function tpReset() {
  clearTimeout(tp.longT);
  if (tp.hold || tp.dragging) dcs({ k: 'u', b: 'l' });
  tp.ptrs.clear(); tp.dragging = false; tp.hold = false; tp.gesture = 'idle'; tp.lastTapEnd = 0; tp.accX = tp.accY = tp.accW = 0; tp.two = null; zReset(); modsClear();
  $('#tpHold').classList.remove('on');
}
$('#tpLeft').onclick = () => clickBtn('l');
$('#tpRight').onclick = () => clickBtn('r');
// keyboard shortcuts: Windows does not let any normal program send Ctrl+Alt+Del (see README), the others work
const COMBOS = { 'ctrl-c': [17, 67], 'ctrl-v': [17, 86], 'ctrl-x': [17, 88], 'ctrl-z': [17, 90], 'ctrl-a': [17, 65], 'win-shift-s': [91, 16, 83], 'ctrl-shift-esc': [17, 16, 27], 'alt-tab': [18, 9], 'win': [91], 'win-l': [91, 76], 'win-d': [91, 68], 'alt-f4': [18, 115], 'esc': [27], 'printscreen': [44] };
function sendCombo(name) {
  const keys = COMBOS[name]; if (!keys) return;
  keys.forEach(vk => dcs({ k: 'kd', vk, ext: EXT.has(vk) }));
  [...keys].reverse().forEach(vk => dcs({ k: 'ku', vk, ext: EXT.has(vk) }));
}
document.querySelectorAll('#keysBar button').forEach(b => b.onclick = () => sendCombo(b.dataset.combo));
$('#tpKeys').onclick = () => { $('#keysBar').hidden = !$('#keysBar').hidden; };
const QUICK = { 'ctrl-c': 'Copy', 'ctrl-v': 'Paste', 'ctrl-x': 'Cut', 'ctrl-z': 'Undo', 'ctrl-a': 'Select all', 'win-shift-s': 'Snipping', 'ctrl-shift-esc': 'Task Manager', 'alt-tab': 'Alt+Tab', 'win-l': 'Lock PC', 'printscreen': 'Print Screen' };
const quickKeys = () => S.get('quickKeys', ['ctrl-c', 'ctrl-v', 'ctrl-z']);
function renderQuick() {
  const bar = $('#quickBar'); bar.innerHTML = '';
  quickKeys().forEach(k => { if (!QUICK[k]) return; const b = document.createElement('button'); b.textContent = QUICK[k]; b.onclick = () => sendCombo(k); bar.appendChild(b); });
  const cfg = $('#quickCfg'); cfg.innerHTML = '';
  Object.keys(QUICK).forEach(k => {
    const l = document.createElement('label'); l.className = 'chk';
    const c = document.createElement('input'); c.type = 'checkbox'; c.checked = quickKeys().includes(k);
    c.onchange = () => { const cur = quickKeys().filter(x => x !== k); if (c.checked) cur.push(k); S.set('quickKeys', cur); renderQuick(); };
    l.append(c, ' ' + QUICK[k]); cfg.appendChild(l);
  });
}
renderQuick();
$('#tpHold').onclick = () => { tp.hold = !tp.hold; $('#tpHold').classList.toggle('on', tp.hold); dcs({ k: tp.hold ? 'd' : 'u', b: 'l' }); };
$('#sens').value = sensOf();
$('#sens').oninput = e => S.set('sens', +e.target.value);
$('#quality').value = S.get('quality', 'auto');
$('#quality').onchange = e => { S.set('quality', e.target.value); if (view) view.ad = null; dcs({ k: 'q', v: e.target.value }); toast('Quality: ' + e.target.options[e.target.selectedIndex].text); };
$('#padBar').hidden = !matchMedia('(pointer: coarse)').matches;
const VK = { Enter: 13, Backspace: 8, Tab: 9, Escape: 27, Space: 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46, Insert: 45, Home: 36, End: 35, PageUp: 33, PageDown: 34,
  ShiftLeft: 16, ShiftRight: 16, ControlLeft: 17, ControlRight: 17, AltLeft: 18, AltRight: 18, MetaLeft: 91, MetaRight: 92, CapsLock: 20,
  Minus: 189, Equal: 187, BracketLeft: 219, BracketRight: 221, Semicolon: 186, Quote: 222, Comma: 188, Period: 190, Slash: 191, Backquote: 192, Backslash: 220 };
const EXT = new Set([37, 38, 39, 40, 45, 46, 36, 35, 33, 34, 92, 91]);
function vkOf(code) {
  if (VK[code]) return VK[code]; let m;
  if ((m = code.match(/^Key([A-Z])$/))) return m[1].charCodeAt(0);
  if ((m = code.match(/^Digit(\d)$/))) return 48 + +m[1];
  if ((m = code.match(/^F(\d{1,2})$/)) && +m[1] >= 1 && +m[1] <= 12) return 111 + +m[1];
  return 0;
}
function keyEv(e, down) {
  if (!view || view.st !== 'live' || $('#session').hidden || document.activeElement === $('#kbd')) return;
  const vk = vkOf(e.code); if (!vk) return;
  dcs({ k: down ? 'kd' : 'ku', vk, ext: EXT.has(vk) }); e.preventDefault();
}
document.addEventListener('keydown', e => keyEv(e, true)); document.addEventListener('keyup', e => keyEv(e, false));
// ----- sticky modifier keys (Ctrl / Alt / Shift / Win) + extra keys for phones and tablets -----
const mods = new Set();
function modsUi() { document.querySelectorAll('#modBar [data-mod]').forEach(b => b.classList.toggle('on', mods.has(+b.dataset.mod))); }
function modsClear() { mods.clear(); modsUi(); }
function sendKey(vk) {   // a key press with the latched modifiers; they are released afterwards
  const ms = [...mods];
  ms.forEach(m => dcs({ k: 'kd', vk: m, ext: EXT.has(m) }));
  dcs({ k: 'kd', vk, ext: EXT.has(vk) }); dcs({ k: 'ku', vk, ext: EXT.has(vk) });
  ms.reverse().forEach(m => dcs({ k: 'ku', vk: m, ext: EXT.has(m) }));
  if (ms.length) modsClear();
}
function sendModText(ch) {   // a letter or digit typed while a modifier is latched (Ctrl, then C)
  const c = ch.length === 1 ? ch.toUpperCase() : '';
  if (!/^[A-Z0-9]$/.test(c)) return false;
  sendKey(c.charCodeAt(0)); return true;
}
document.querySelectorAll('#modBar [data-mod]').forEach(b => b.onclick = () => { const vk = +b.dataset.mod; mods.has(vk) ? mods.delete(vk) : mods.add(vk); modsUi(); });
const KEYROW = [['Esc', 27], ['Tab', 9], ['←', 37], ['↑', 38], ['↓', 40], ['→', 39], ['Home', 36], ['End', 35], ['PgUp', 33], ['PgDn', 34], ['Del', 46], ['Ins', 45]];
const addKeys = (el, list) => list.forEach(([t, vk]) => { const b = document.createElement('button'); b.textContent = t; b.onclick = () => sendKey(vk); el.appendChild(b); });
addKeys($('#keyRow'), KEYROW);
addKeys($('#fnRow'), Array.from({ length: 12 }, (_, i) => ['F' + (i + 1), 112 + i]));
$('#fnToggle').onclick = () => { $('#fnRow').hidden = !$('#fnRow').hidden; };
['#modBar', '#keyRow', '#fnRow'].forEach(s => $(s).addEventListener('mousedown', ev => ev.preventDefault()));   // keep the on-screen keyboard open while tapping these
// ----- automatic clipboard sync (opt-in per session: text only, up to 100 000 characters, both directions) -----
const CLIPMAX = 100000;
const clip = { last: '', timer: null };
async function readLocalClip() {   // the Windows app reads the clipboard natively (works while its window is in the background); otherwise the browser API
  try { if (window.nexa && window.nexa.clipRead) return String((await window.nexa.clipRead()) || ''); return String(await navigator.clipboard.readText()); } catch (_) { return null; }
}
async function clipPoll() {
  if (!view || view.st !== 'live' || !S.get('autoClip', false)) return;
  const v = await readLocalClip(); if (v === null || !v || v === clip.last || v.length > CLIPMAX) return;
  clip.last = v; dcs({ k: 'clip', v });
}
async function hostClipPoll() {
  if (!host || !host.autoClip || !host.dc || host.dc.readyState !== 'open') return;
  const v = await readLocalClip(); if (v === null || !v || v === host.clipLast || v.length > CLIPMAX) return;
  host.clipLast = v; host.dc.send(JSON.stringify({ k: 'clipsync', v }));
}
function clipAutoStart() {
  clearInterval(clip.timer); const on = S.get('autoClip', false);
  $('#btnAutoClip').textContent = 'Auto clipboard: ' + (on ? 'on' : 'off'); $('#btnAutoClip').classList.toggle('on', on);
  if (!view) return;
  dcs({ k: 'autoclip', v: on ? 1 : 0 });
  if (on) readLocalClip().then(v => { if (v !== null) clip.last = v; if (view && S.get('autoClip', false)) clip.timer = setInterval(clipPoll, 1500); });   // what is in the clipboard now is NOT sent
}
$('#btnAutoClip').onclick = () => { const on = !S.get('autoClip', false); S.set('autoClip', on); if (on) toast('Auto clipboard ON: copied text (also passwords) is shared both ways during this session'); clipAutoStart(); };
window.addEventListener('focus', () => { clipPoll(); });
clipAutoStart();
// ----- network-change resilience: ICE restart instead of dropping the session -----
async function hostRestart() {
  if (!host || host.restarting || Date.now() - (host.lastRestart || 0) < 3000) return;
  host.restarting = true; host.lastRestart = Date.now(); const h = host;
  try {
    h.pc.restartIce(); h.remoteSet = false;
    const offer = await h.pc.createOffer({ iceRestart: true }); await h.pc.setLocalDescription(offer);
    const sdp = h.pc.localDescription.sdp;
    send({ t: 'sig', to: h.peer, data: { type: 'offer', sdp, mac: await hmacHex(h.secret, 'offer:' + sdp) } });
  } catch (_) {} finally { h.restarting = false; }
}
function viewerRecover(pc, from) {
  if (!view || view.recov) return; let n = 0; toast('Connection interrupted - reconnecting...');
  const stop = () => { clearInterval(view.recov); view.recov = null; };
  view.recov = setInterval(() => {
    if (!view || view.pc !== pc) return;
    if (pc.connectionState === 'connected') { stop(); toast('Reconnected'); return; }
    if (++n > 8) { stop(); toast('Connection lost'); endView(true); return; }
    send({ t: 'sig', to: from, data: { restart: 1 } });
  }, 4000);
}
// ----- adaptive quality (only while Quality = Auto): step down on loss/delay, step back up when the link is good for ~15 s -----
const AQ = ['auto', 'smooth', 'lowdata'], AQN = ['Auto', 'Smooth', 'Low data'];
async function adaptTick() {
  if (!view || view.st !== 'live' || !view.pc) return;
  if (S.get('quality', 'auto') !== 'auto') { view.ad = null; return; }
  let lost = 0, recv = 0, rtt = 0;
  try { const st = await view.pc.getStats(); st.forEach(r => { if (r.type === 'inbound-rtp' && r.kind === 'video') { lost = r.packetsLost || 0; recv = r.packetsReceived || 0; } if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') rtt = (r.currentRoundTripTime || 0) * 1000; }); } catch (_) { return; }
  const a = view.ad || (view.ad = { lost, recv, bad: 0, good: 0, lvl: 0 });
  const dl = lost - a.lost, dr = recv - a.recv; a.lost = lost; a.recv = recv;
  const loss = dl + dr > 0 ? 100 * Math.max(0, dl) / (dl + dr) : 0;
  if (loss > 4 || rtt > 400) { a.bad++; a.good = 0; } else if (loss < 1 && rtt < 150) { a.good++; a.bad = 0; } else { a.bad = 0; a.good = 0; }
  let lvl = a.lvl;
  if (a.bad >= 2 && lvl < 2) { lvl++; a.bad = 0; } else if (a.good >= 5 && lvl > 0) { lvl--; a.good = 0; }
  if (lvl !== a.lvl) { a.lvl = lvl; dcs({ k: 'q', v: AQ[lvl] }); toast('Auto quality: ' + AQN[lvl] + (lvl ? ' (weak connection)' : ' (connection recovered)')); }
}
const kbd = $('#kbd');
kbd.addEventListener('beforeinput', e => {
  if (e.inputType === 'insertText' && e.data) { if (!(mods.size && sendModText(e.data))) dcs({ k: 't', v: e.data }); }
  else if (e.inputType === 'deleteContentBackward') sendKey(8);
  else if (e.inputType === 'insertLineBreak') sendKey(13);
  e.preventDefault();
});
$('#btnKbd').onclick = () => { kbd.value = ''; kbd.focus(); };
$('#btnClip').onclick = async () => { try { dcs({ k: 'clip', v: await navigator.clipboard.readText() }); toast('Clipboard sent'); } catch (_) { toast('Clipboard not available'); } };
$('#btnFit').onclick = () => { vid.classList.toggle('actual'); zReset(); };
$('#btnFs').onclick = () => { document.fullscreenElement ? document.exitFullscreen() : $('#session').requestFullscreen().catch(() => {}); };
$('#btnEnd').onclick = () => endView(true);

// ---------- UI wiring ----------
document.querySelectorAll('nav button').forEach(b => b.onclick = () => {
  document.querySelectorAll('nav button').forEach(x => x.classList.toggle('on', x === b));
  ['home', 'sec', 'set'].forEach(t => $('#tab-' + t).hidden = t !== b.dataset.tab);
  if (wantInstall && !inSettings()) { wantInstall = false; applyWhenIdle(true); }
});
const copy = async (txt, ok) => { try { await navigator.clipboard.writeText(txt); toast(ok); } catch (_) { toast('Copy failed'); } };
$('#copyId').onclick = () => myId && copy(myId, 'ID copied');
$('#copyPw').onclick = () => pw && copy(pw, 'Password copied');
$('#regenPw').onclick = () => { if (S.get('unattended', false)) toast('Permanent password is active (Security tab)'); else newPw(); };
const adminControllerCard = $('#adminControllerCard');
if (adminControllerCard && window.nexa && window.nexa.manageAdmins) {
  Promise.resolve(window.nexa.nativeVersion ? window.nexa.nativeVersion() : '').then(version => { if (version) adminControllerCard.hidden = false; }).catch(() => {});
  $('#manageAdminControllers').onclick = async () => {
    try {
      const result = await window.nexa.manageAdmins();
      if (!result || !result.ok) toast((result && result.why) || 'Admin controller settings could not be opened');
    } catch (_) { toast('Admin controller settings could not be opened'); }
  };
}
$('#remId').addEventListener('input', e => { const d = e.target.value.replace(/\D/g, '').slice(0, 9); e.target.value = d.replace(/(\d{3})(?=\d)/g, '$1 '); });
function renderSaved() {
  const box = $('#savedPcs'); box.innerHTML = '';
  const list = S.get('savedPcs', []);
  if (!list.length) { box.textContent = 'No saved PCs yet.'; return; }
  list.forEach((p, i) => {
    const row = document.createElement('div');
    const go = document.createElement('button'); go.textContent = (p.label || 'PC') + '  ·  ' + fmtId(p.id) + (p.pw ? '  🔑' : '');
    go.onclick = () => { $('#remId').value = fmtId(p.id); if (p.pw) { $('#remPw').value = p.pw; $('#connectBtn').click(); } else $('#remPw').focus(); };   // saved password = one tap to connect
    const ed = document.createElement('button'); ed.textContent = '✎'; ed.title = 'Rename';
    ed.onclick = () => {                                  // inline rename (window.prompt does not exist in the Windows app)
      const inp = document.createElement('input'); inp.value = p.label || ''; inp.maxLength = 24; inp.placeholder = 'Name, e.g. Office PC';
      let done = false;
      const save = () => { if (done) return; done = true; const l = S.get('savedPcs', []); if (l[i] && l[i].id === p.id) { l[i].label = inp.value.trim() || 'PC ' + fmtId(p.id); S.set('savedPcs', l); } renderSaved(); };
      inp.onkeydown = e => { if (e.key === 'Enter') save(); else if (e.key === 'Escape') { done = true; renderSaved(); } };
      inp.onblur = save;
      row.replaceChild(inp, go); inp.focus(); inp.select();
    };
    const x = document.createElement('button'); x.textContent = '✕'; x.title = 'Remove';
    x.onclick = () => { const l = S.get('savedPcs', []); l.splice(i, 1); S.set('savedPcs', l); renderSaved(); };
    row.append(go, ed, x); box.appendChild(row);
  });
}
function pushRecent(id) {
  const l = [id, ...S.get('recentPcs', []).filter(x => x !== id)].slice(0, 5); S.set('recentPcs', l); renderRecent();
}
function renderRecent() {
  const box = $('#recentPcs'); if (!box) return; box.innerHTML = '';
  const l = S.get('recentPcs', []);
  if (!l.length) { box.textContent = 'Nothing yet.'; return; }
  const saved = S.get('savedPcs', []);
  const row = document.createElement('div'); row.style.flexWrap = 'wrap';
  l.forEach(id => {
    const s = saved.find(p => p.id === id);
    const b = document.createElement('button'); b.textContent = (s && s.label ? s.label + ' · ' : '') + fmtId(id);
    b.onclick = () => { $('#remId').value = fmtId(id); if (s && s.pw) { $('#remPw').value = s.pw; $('#connectBtn').click(); } else $('#remPw').focus(); };
    row.appendChild(b);
  });
  box.appendChild(row);
}
$('#savePc').onclick = () => {
  const id = $('#remId').value.replace(/\D/g, '');
  if (id.length !== 9) return toast('Enter the full 9-digit partner ID');
  const old = S.get('savedPcs', []).find(p => p.id === id);
  const l = S.get('savedPcs', []).filter(p => p.id !== id);
  const pw = $('#remPw').value.trim();                 // full credentials: the password typed in the box is saved with the ID (on this device only)
  l.unshift({ id, label: (old && old.label) || 'PC ' + fmtId(id), pw: pw || (old && old.pw) || '' });
  if (!S.set('savedPcs', l.slice(0, 50))) return toast('Could not save on this device (storage is unavailable)');
  renderSaved(); toast(pw ? 'Saved with password' : 'Saved');
};
renderSaved(); renderRecent();
$('#connectBtn').onclick = () => { connectTo($('#remId').value, $('#remPw').value.trim()); };
$('#remPw').addEventListener('keydown', e => e.key === 'Enter' && $('#connectBtn').click());
$('#newInvite').onclick = () => { const c = genSecret(12); invites.clear(); invites.set(c, Date.now() + 10 * 60000); $('#inviteCode').textContent = c; };
$('#copyInvite').onclick = () => validInvites().length && copy([...invites.keys()][0], 'Invite copied');
$('#optUnattended').checked = S.get('unattended', false);
$('#optControl').checked = S.get('defControl', true); $('#optClip').checked = S.get('defClip', true);
$('#optUnattended').onchange = e => { const on = e.target.checked; if (on && permPwCache.length < 12) { e.target.checked = false; return toast('Set a permanent password (12+ chars) first'); } S.set('unattended', on); newPw(); };
$('#optControl').onchange = e => S.set('defControl', e.target.checked); $('#optClip').onchange = e => S.set('defClip', e.target.checked);
$('#rowLockEnd').hidden = !canHost;
$('#optLockEnd').checked = S.get('lockOnEnd', false);
$('#optLockEnd').onchange = e => { S.set('lockOnEnd', e.target.checked); toast(e.target.checked ? 'This PC will lock when a remote session ends' : 'Lock after session: off'); };
// this PC (Windows app, needs app package 1.0.15+; hidden when the installed app is older)
if (canHost && window.nexa.power) {
  $('#pcCard').hidden = false;
  const aw = $('#optAwake'), au = $('#optAutostart');
  aw.checked = S.get('keepAwake', false);
  window.nexa.power({ keepAwake: aw.checked }).then(r => { if (r && r.ok) au.checked = !!r.autostart; }).catch(() => {});
  aw.onchange = async e => { S.set('keepAwake', e.target.checked); const r = await window.nexa.power({ keepAwake: e.target.checked }); toast(r && r.ok ? (e.target.checked ? 'This PC will not go to sleep while NexaDesk runs' : 'Sleep is allowed again') : 'Could not change this'); };
  au.onchange = async e => { const r = await window.nexa.power({ autostart: e.target.checked }); if (!r || !r.ok) { e.target.checked = !e.target.checked; return toast('Could not change this (install the app first)'); } toast(e.target.checked ? 'NexaDesk will start when you sign in' : 'Autostart: off'); };
  const tr = $('#optTray'); tr.checked = S.get('trayOn', false);
  window.nexa.power({ tray: tr.checked }).catch(() => {});
  tr.onchange = async e => { S.set('trayOn', e.target.checked); const r = await window.nexa.power({ tray: e.target.checked }); toast(r && r.ok ? (e.target.checked ? 'Closing the window now keeps NexaDesk running in the tray' : 'Closing the window quits NexaDesk again') : 'Could not change this'); };
}
$('#savePerm').onclick = async () => {
  const v = $('#permPw').value; if (v.length < 12) return toast('Use at least 12 characters');
  const sec = window.nexa && window.nexa.secret && window.nexa.secret.available ? window.nexa.secret : null;
  try {
    if (sec) { if (!(await sec.set(v))) return toast('Could not store the password securely'); localStorage.removeItem('nx_permpw'); }
    else if (!S.set('permpw', v)) return toast('Could not save on this device (storage is unavailable)');
  } catch (_) { return toast('Could not save the permanent password securely'); }
  permPwCache = v; $('#permPw').value = ''; toast('Saved'); if (S.get('unattended', false)) newPw();
};
loadPermPw().then(newPw);
$('#clearLog').onclick = () => { S.set('log', []); renderLog(); };
$('#srvUrl').value = S.get('server', window.NEXA_DEFAULT_SERVER || ''); $('#extraIce').value = S.get('extraIce', '');
$('#saveSet').onclick = () => { const u = $('#srvUrl').value.trim(); if (!/^wss?:\/\//.test(u)) return toast('URL must start with wss:// or ws://'); S.set('server', u); S.set('srvManual', true); S.set('extraIce', $('#extraIce').value); connectWS(); toast('Saved'); };
if (!canHost) { $('#myPw').textContent = 'Viewer mode'; $('#hostHint').textContent = 'This device controls other computers. Install the Windows app on a computer you want to access.'; $('#copyPw').hidden = $('#regenPw').hidden = true; }
else newPw();
window.addEventListener('beforeunload', () => { closing = true; endHost(true); endView(true); });
// ---------- OTA (web-layer) updates: update.json + www-<version>.zip, pushed instantly by the server.
// Safety checks: update.json must be signed (update.sig2) with the daily or recovery key built into this app, HTTPS from the configured
// server only, version must be newer, bundle must match the sha256 in update.json. ----------
const VER = window.NEXA_VERSION || '0.0.0';
const otaBase = () => (S.get('server', window.NEXA_DEFAULT_SERVER || '') || '').replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/$/, '');
const cmpv = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
$('#verInfo').textContent = 'v' + VER;
setTimeout(() => { const box = $('#updLogBox'); if (box) box.textContent = S.get('updLog', []).join('\n'); }, 0);
setTimeout(async () => {                         // what is actually running on this device (after the bridge is defined)
  const parts = [];
  if (CU()) { try { const c = await CU().current(); const id = c && c.bundle && c.bundle.id; parts.push(id && id !== 'builtin' ? 'downloaded update (' + id.slice(0, 8) + ')' : 'built-in package, no update applied'); } catch (_) {} }
  if (window.nexa && window.nexa.nativeVersion) { try { parts.push('app package v' + (await window.nexa.nativeVersion())); } catch (_) {} }
  $('#bundleInfo').textContent = 'Running: ' + (parts.join(' · ') || 'built-in package');
}, 0);
const CU = () => window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorUpdater;
if (CU()) CU().notifyAppReady().catch(() => {});          // confirms this bundle booted (otherwise Android rolls back automatically)
let pend = null, otaBusy = false;
function adoptServer(m) {                                  // server address is delivered by update.json - no manual setup needed
  if (m && /^wss?:\/\//.test(m.server || '') && !S.get('srvManual', false) && S.get('server', '') !== m.server) {
    S.set('server', m.server); $('#srvUrl').value = m.server; connectWS();
  }
}
const autoUpd = () => S.get('autoUpdate', false) === true;   // default: ask with a pop-up; silent install only if the user ticked the box
function ulog(msg) {                                         // visible record of the update process
  const l = S.get('updLog', []); l.push(new Date().toLocaleTimeString() + '  ' + msg);
  S.set('updLog', l.slice(-40)); const box = document.querySelector('#updLogBox'); if (box) box.textContent = S.get('updLog', []).join('\n');
}
const inSettings = () => !$('#tab-set').hidden || !$('#tab-sec').hidden;
let wantInstall = false;                                    // the user pressed Install while in Settings
function applyWhenIdle(force, now) {                         // never interrupt a live session; never reload while in Settings
  if (!pend || host || view) return;
  if (!force && !autoUpd()) return;                          // manual mode: wait for the Install button
  if (!now && inSettings()) return;                          // a reload would send the user back to the home tab
  const la = S.get('lastApply', null);
  if (la && la.version === pend.version && Date.now() - la.t < 600000) {
    // applied a moment ago and the app still reports the old version: do not loop, tell the user
    pend = null; $('#updBox').textContent = 'Update v' + la.version + ' was downloaded but did not take effect. Reinstall the app once (see README).';
    return;
  }
  const p = pend; pend = null; S.set('lastApply', { version: p.version, t: Date.now() }); toast('Updating to v' + p.version + '…');
  ulog('applying v' + p.version + (p.id ? ' (android bundle ' + p.id.slice(0, 8) + ')' : ' (windows)'));
  setTimeout(() => {
    if (p.id && CU()) CU().set({ id: p.id }).catch(e => ulog('android activation failed: ' + (e && e.message || e)));
    else if (window.nexa) window.nexa.otaApply();
  }, 700);
}
const b64 = s => Uint8Array.from(atob(s.trim()), c => c.charCodeAt(0));
const trustKeys = () => (Array.isArray(window.NEXA_UPDATE_KEYS) ? window.NEXA_UPDATE_KEYS : []);
async function keyIdOf(k) { const d = new Uint8Array(await crypto.subtle.digest('SHA-256', b64(k))); return [...d].slice(0, 8).map(x => x.toString(16).padStart(2, '0')).join(''); }
async function verifyManifest(text, sigB64) {                // accepted when ANY of the trusted keys (daily, recovery) verifies it
  for (const k of trustKeys()) {
    try {
      const key = await crypto.subtle.importKey('spki', b64(k), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
      if (await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64(sigB64), new TextEncoder().encode(text))) return true;
    } catch (_) {}
  }
  return false;
}
// ---------- update progress bar (percent, size, speed, time left) ----------
const fmtB = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
let progT0 = 0, progLast = null;
function showProg(o) {
  const box = $('#updProg'); if (!box) return;
  const ph = o.phase, fill = $('#progFill'), now = Date.now();
  box.hidden = false; fill.className = '';
  if (ph === 'download') {
    if (!progT0 || o.received < (progLast ? progLast.r : 0)) { progT0 = now; }
    progLast = { r: o.received };
    const el = Math.max(0.3, (now - progT0) / 1000), sp = o.received / el, pct = o.total ? Math.min(100, o.received / o.total * 100) : null;
    $('#progLbl').textContent = (o.kind === 'native' ? 'Downloading app update' : 'Downloading update') + (o.version ? ' v' + o.version : '');
    $('#progPct').textContent = pct === null ? '' : Math.floor(pct) + '%';
    if (pct === null) fill.className = 'ind'; else fill.style.width = pct + '%';
    if (o.pctOnly) { $('#progSize').textContent = ''; $('#progSpeed').textContent = ''; return; }
    $('#progSize').textContent = fmtB(o.received) + (o.total ? ' / ' + fmtB(o.total) : '');
    const left = o.total && sp > 0 ? Math.ceil((o.total - o.received) / sp) : 0;
    $('#progSpeed').textContent = (o.received ? fmtB(sp) + '/s' : '') + (left ? ' · ' + (left >= 60 ? Math.floor(left / 60) + 'm ' + (left % 60) + 's' : left + 's') + ' left' : '');
  } else if (ph === 'verify' || ph === 'install') {
    progT0 = 0; fill.style.width = '100%';
    $('#progLbl').textContent = ph === 'verify' ? 'Verifying download…' : 'Installing update…'; $('#progPct').textContent = ''; $('#progSize').textContent = ''; $('#progSpeed').textContent = '';
  } else if (ph === 'done') {
    progT0 = 0; fill.style.width = '100%'; $('#progLbl').textContent = 'Update downloaded and verified ✓'; $('#progPct').textContent = '100%';
    setTimeout(() => { if (!progT0) box.hidden = true; }, 6000);
  } else if (ph === 'error') {
    progT0 = 0; fill.className = 'err'; $('#progLbl').textContent = 'Update failed'; $('#progPct').textContent = '';
  }
}
if (window.nexa && window.nexa.onProgress) window.nexa.onProgress(showProg);
async function stageUpdate(m) {                              // download + verify the bundle; does not apply it
  const url = otaBase() + '/' + m.bundle, cu = CU();
  toast('Downloading update v' + m.version + '…');
  if (window.nexa && window.nexa.otaInstall) {
    const res = await window.nexa.otaInstall({ url, version: m.version, sha256: m.sha256 });
    if (!res || !res.ok) { ulog('download v' + m.version + ' failed: ' + JSON.stringify(res || {})); throw new Error('install'); }
    pend = { version: m.version }; ulog('downloaded v' + m.version + ' (windows)');
  } else if (cu) {
    try { const l = await cu.list(), c = await cu.current(); for (const b of (l.bundles || [])) if (b.id !== c.bundle.id && b.id !== 'builtin') await cu.delete({ id: b.id }).catch(() => {}); } catch (_) {}
    let lis = null; try { lis = await cu.addListener('download', e => showProg({ phase: 'download', version: m.version, received: Math.round((e.percent || 0)), total: 100, pctOnly: true })); } catch (_) {}
    let b; try { b = await cu.download({ url, version: m.version, checksum: m.sha256 }); } catch (e) { ulog('download v' + m.version + ' failed: ' + (e && e.message || e)); try { lis && lis.remove(); } catch (_) {} showProg({ phase: 'error' }); throw e; }
    try { lis && lis.remove(); } catch (_) {} showProg({ phase: 'done' });
    pend = { id: b.id, version: m.version }; ulog('downloaded v' + m.version + ' (android)');
  } else throw new Error('install');
}
function showReady(v) {                                      // manual mode: tell the user, they decide when
  $('#updBox').textContent = 'Update v' + v + ' is ready. It installs when you press Install (never during a session).';
  $('#installUpd').hidden = false; toast('Update v' + v + ' is ready - press Install in Settings');
}
function updMsg(text) { $('#updBox').textContent = text; const m = $('#updMsg'); if (m) { m.textContent = text; $('#updProg').hidden = false; } }
let forceTimer = null;
function forceNow(v) {                                       // mandatory update: 30 s warning, then installs
  if (forceTimer) return;
  let n = (host || view) ? 30 : 5;
  const show = () => updMsg('Mandatory update v' + v + ' installs in ' + n + ' s. Active sessions will be disconnected.');
  show(); toast('Mandatory update v' + v + ' is installing');
  forceTimer = setInterval(() => {
    n--;
    if (n > 0) return show();
    clearInterval(forceTimer); forceTimer = null;
    if (host) endHost(true);
    if (view) endView(true);
    applyWhenIdle(true, true);
  }, 1000);
}
function withCountdown(label, fn) {
  let n = (host || view) ? 30 : 5;
  const show = () => updMsg(label + ' installs in ' + n + ' s. Active sessions will be disconnected.');
  show();
  const t = setInterval(() => { n--; if (n > 0) return show(); clearInterval(t); if (host) endHost(true); if (view) endView(true); fn(); }, 1000);
}
const askedUpd = new Set();                       // one pop-up per version per app start (a re-check every minute must not nag)
function askUpdate(key, title, go) {
  if (askedUpd.has(key) || host || view || document.getElementById('updAsk')) return;
  askedUpd.add(key);
  const wrap = document.createElement('div'); wrap.id = 'updAsk';
  wrap.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:16px';
  const box = document.createElement('div');
  box.style.cssText = 'background:#121a2b;color:#e8ecf4;border:1px solid #2a3550;border-radius:14px;padding:20px;max-width:360px;width:100%;font:15px system-ui,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.5)';
  const h = document.createElement('div'); h.textContent = title; h.style.cssText = 'font-weight:700;font-size:17px;margin-bottom:8px';
  const t = document.createElement('div'); t.textContent = 'A new version is available. Install it now?'; t.style.cssText = 'opacity:.8;margin-bottom:16px';
  const row = document.createElement('div'); row.style.cssText = 'display:flex;gap:10px;justify-content:flex-end';
  const later = document.createElement('button'); later.textContent = 'Later'; later.onclick = () => wrap.remove();
  const yes = document.createElement('button'); yes.textContent = 'Install now'; yes.className = 'primary'; yes.onclick = () => { wrap.remove(); go(); };
  row.append(later, yes); box.append(h, t, row); wrap.appendChild(box); document.body.appendChild(wrap);
}
function whenIdle(fn) { const t = setInterval(() => { if (!host && !view) { clearInterval(t); fn(); } }, 2000); }
let nativePend = false, nativeStagedV = '';                                    // an app-package install is already scheduled or running
async function installNativeNow(nat) {
  const winVer = nat.windows.version || nat.version;
  toast('Installing app update v' + winVer + '…');
  const r = await window.nexa.nativeInstall({ url: nat.windows.url, sha256: nat.windows.sha256, version: winVer });
  ulog('app installer v' + winVer + ': ' + (r && r.ok ? 'started' : 'failed (' + ((r && r.why) || 'unknown') + ')'));
  if (!r || !r.ok) { nativePend = false; toast('App update failed: ' + ((r && r.why) || 'unknown')); }
}
async function handleNative(m, forceN) {
  const nat = m.native; if (!nat) return;
  if (nat.windows && window.nexa && window.nexa.nativeInstall && window.nexa.nativeVersion) {
    const cur = await window.nexa.nativeVersion();
    const winVer = nat.windows.version || nat.version;
    if (cur && cmpv(winVer, cur) > 0) {
      if (nativeStagedV !== winVer && window.nexa.nativeStage) { nativeStagedV = winVer; window.nexa.nativeStage({ url: nat.windows.url, sha256: nat.windows.sha256, version: winVer }).then(r => { if (!r || !r.ok) nativeStagedV = ''; }).catch(() => { nativeStagedV = ''; }); }
      if (nativePend) return;
      if (forceN) { nativePend = true; return withCountdown('App update v' + winVer, () => installNativeNow(nat)); }
      if (autoUpd()) { nativePend = true; return whenIdle(() => installNativeNow(nat)); }
      $('#nativeBox').textContent = 'App update v' + winVer + ' is ready. Install it when you are not in a session.';
      $('#installNative').hidden = false;
      $('#installNative').onclick = () => { if (host || view) return toast('Finish the current session first'); installNativeNow(nat); };
      askUpdate('n' + winVer, 'App update v' + winVer, () => installNativeNow(nat));
    }
  }
  if (nat.android && window.Capacitor && window.Capacitor.getPlatform && window.Capacitor.getPlatform() === 'android') {
    let curA = ''; try { curA = (await CU().current()).native || ''; } catch (_) {}
    const link = $('#apkLink');
    const androidVer = nat.android.version || nat.version;
    if (!curA || cmpv(androidVer, curA) > 0) { link.href = nat.android.url; link.textContent = 'Download the latest app (APK, v' + androidVer + ')'; link.hidden = false;
      askUpdate('a' + androidVer, 'App update v' + androidVer, () => { const a = document.createElement('a'); a.href = nat.android.url; a.target = '_blank'; a.rel = 'noopener'; a.click(); });
      if (forceN) { const b = $('#updApk'); b.href = nat.android.url; b.hidden = false; updMsg('Mandatory app update v' + androidVer + ': tap the button to download and install it.'); } }
    else link.hidden = true;
  }
}
function installNow() {
  if (!pend) return toast('No update is ready');
  if (host || view) return toast('Finish the current session first');
  wantInstall = true;
  if (inSettings()) return toast('The update installs when you leave Settings');
  wantInstall = false; applyWhenIdle(true);
}
// checkOta(manual): user pressed "Check"   push: server announced a new release   neither: automatic check
async function checkOta(manual, push) {
  if (otaBusy) return;
  otaBusy = true; checkOta.last = Date.now();
  try {
    const q = '?t=' + Date.now();
    const [rt, rs] = await Promise.all([fetch(otaBase() + '/update.json' + q, { cache: 'no-store' }), fetch(otaBase() + '/update.sig2' + q, { cache: 'no-store' })]);
    if (!rt.ok || !rs.ok) { ulog('update server has no release files (' + rt.status + '/' + rs.status + ')'); throw new Error('manifest'); }
    const text = await rt.text();
    if (!(await verifyManifest(text, await rs.text()))) throw new Error('signature');
    const m = JSON.parse(text);
    adoptServer(m);
    const ok = /^\d+\.\d+\.\d+$/.test(m.version) && /^www-\d+\.\d+\.\d+\.zip$/.test(m.bundle || '') && /^[0-9a-f]{64}$/i.test(m.sha256 || '');
    ulog('server has v' + m.version + ', this device runs v' + VER + (m.force === true ? ' (forced)' : ''));
    if (typeof m.notes === 'string' && m.notes) $('#notesBox').textContent = "What's new in v" + m.version + ': ' + m.notes.slice(0, 300);
    if (ok && cmpv(m.version, VER) > 0) {
      if (!pend || pend.version !== m.version) await stageUpdate(m);
      if (m.force === true) forceNow(m.version); else if (autoUpd()) applyWhenIdle(); else { showReady(m.version); askUpdate('w' + m.version, 'Update v' + m.version, installNow); }
    } else if (manual && !m.native) toast('You are on the latest version (v' + VER + ')');
    // the installed package (EXE / APK) is checked on every check: a page reload after a web update would otherwise cancel it forever
    await handleNative(m, m.force === true);
    if (manual && !(ok && cmpv(m.version, VER) > 0) && m.native && !nativePend && $('#installNative').hidden && $('#apkLink').hidden) toast('You are on the latest version (v' + VER + ')');
  } catch (e) {
    ulog('check failed: ' + (e && e.message || e));
    if (e.message === 'signature') {
      const mine = await Promise.all(trustKeys().map(keyIdOf));
      $('#updBox').textContent = 'Update rejected: it is not signed with a key this app trusts (app trusts ' + (mine.join(', ') || 'none') + '). Publish with your daily or recovery key, or install the newest app once.';
      if (manual) toast('Update rejected - details in Settings > Version');
    } else if (manual) toast('Could not check for updates');
  } finally { otaBusy = false; }
}
$('#chkUpd').onclick = () => checkOta(true);
$('#installUpd').onclick = installNow;
const modeHint = () => { $('#updModeHint').textContent = autoUpd() ? 'Automatic: a new version installs by itself when you are not in a session or in Settings.' : 'Manual: a new version is downloaded and then waits until you press "Install update".'; };
$('#autoUpd').checked = autoUpd(); modeHint();
$('#autoUpd').onchange = e => {
  S.set('autoUpdate', e.target.checked); modeHint();
  toast(e.target.checked ? 'Automatic updates: on' : 'Automatic updates: off - you install updates yourself');
  if (e.target.checked) checkOta();
};
setInterval(() => checkOta(), 60000);
window.addEventListener('focus', () => { if (Date.now() - (checkOta.last || 0) > 30000) checkOta(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - (checkOta.last || 0) > 30000) checkOta(); });
setTimeout(() => checkOta(), 6000);
{ const c = S.get('lastId', ''); if (c) $('#myId').textContent = fmtId(c); }   // show the last known ID instantly
renderLog(); connectWS();
})();
