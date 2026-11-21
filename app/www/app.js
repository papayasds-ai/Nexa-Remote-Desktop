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
  set(k, v) { try { localStorage.setItem('nx_' + k, JSON.stringify(v)); } catch (_) {} }
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
let myId = null, iceServers = [], ws = null, retry = null, icePing = null;
let pw = null; const invites = new Map();       // code -> expiry
const pendingAuth = new Map(), fails = new Map(), gfail = { n: 0, t0: 0, until: 0 };
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
    permPwCache = (await sec.get()) || '';
    const old = S.get('permpw', '');                                  // migrate an older plain-text copy
    if (old && !permPwCache) { permPwCache = old; await sec.set(old); }
    if (old) localStorage.removeItem('nx_permpw');
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
async function onMsg(m) {
  switch (m.t) {
    case 'ota': checkOta(false, true); break;   // server says a new release was just published
    case 'ice': iceServers = m.ice || iceServers; if (icePing) { icePing(); icePing = null; } break;   // fresh TURN credentials
    case 'welcome': myId = m.id; S.set('lastId', myId); iceServers = m.ice || []; $('#myId').textContent = fmtId(myId); setStatus('Ready – secure connection', 'ok'); break;
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
  if (gfail.until > Date.now()) return send({ t: 'deny', to: from, reason: 'Too many failed attempts. Try again later.' });
  for (const [k, v] of pendingAuth) if (Date.now() - v.ts > 30000) pendingAuth.delete(k);
  if (pendingAuth.size >= 20) return send({ t: 'deny', to: from, reason: 'Device is busy. Try again in a moment.' });
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
  if (pw && await hmacOk(pw, msg, mac)) { secret = pw; kind = 'password'; }
  else for (const c of validInvites()) if (await hmacOk(c, msg, mac)) { secret = c; kind = 'invite'; invites.delete(c); $('#inviteCode').textContent = '—'; break; }
  if (!secret) {
    const f = fails.get(from) || { n: 0, until: 0 }; f.n++; if (f.n >= 5) { f.until = Date.now() + 10 * 60000; f.n = 0; } fails.set(from, f);
    if (Date.now() - gfail.t0 > 10 * 60000) { gfail.n = 0; gfail.t0 = Date.now(); }
    if (++gfail.n >= 25) { gfail.until = Date.now() + 5 * 60000; gfail.n = 0; }   // many different IDs guessing: pause everyone
    log('host', from, 'AUTH FAILED'); return send({ t: 'deny', to: from, reason: 'Authentication failed.' });
  }
  fails.delete(from);
  let perm;
  if (kind === 'password' && S.get('unattended', false)) perm = { control: S.get('defControl', true), clip: S.get('defClip', true), files: S.get('defFiles', true) };
  else perm = await askConsent(from);
  if (!perm) { log('host', from, 'denied by user'); return send({ t: 'deny', to: from, reason: 'The user declined the request.' }); }
  try { await startHost(from, secret, perm); } catch (e) { console.error(e); toast('Could not start screen sharing: ' + ((e && (e.name + ' ' + e.message)) || e)); try { window.nexa && window.nexa.log && window.nexa.log('startHost failed: ' + (e && (e.name + ' ' + e.message))); } catch (_) {} send({ t: 'deny', to: from, reason: 'Host could not capture the screen.' }); endHost(false); }
}
function askConsent(from) {
  return new Promise(res => {
    $('#mdId').textContent = fmtId(from); $('#mdCtl').checked = S.get('defControl', true); $('#mdClip').checked = S.get('defClip', true); $('#mdFiles').checked = S.get('defFiles', true);
    $('#modal').hidden = false; try { window.nexa && window.nexa.focus(); } catch (_) {}
    const done = v => { $('#modal').hidden = true; clearTimeout(t); res(v); };
    const t = setTimeout(() => done(null), 30000);
    $('#mdYes').onclick = () => done({ control: $('#mdCtl').checked, clip: $('#mdClip').checked, files: $('#mdFiles').checked });
    $('#mdNo').onclick = () => done(null);
  });
}
async function startHost(from, secret, perm) {
  const wantSound = S.get('shareAudio', false); let stream;
  try { stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: wantSound }); }
  catch (e) { if (!wantSound) throw e; stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false }); }   // no sound capture available: share the picture only
  const pc = new RTCPeerConnection({ iceServers: iceList() });
  host = { peer: from, pc, stream, perm, secret, q: [], remoteSet: false, t0: Date.now() };
  stream.getTracks().forEach(t => { if (t.kind === 'video') { try { t.contentHint = 'detail'; } catch (_) {} } pc.addTrack(t, stream); });
  preferCodec(pc, S.get('codec', 'auto'));
  stream.getVideoTracks()[0].onended = () => endHost(true);
  const dc = pc.createDataChannel('ctl', { ordered: true }); host.dc = dc;
  dc.onmessage = e => onHostInput(e.data);
  const fdc = pc.createDataChannel('file', { ordered: true }); fdc.binaryType = 'arraybuffer'; host.fdc = fdc;   // files from the viewer
  fdc.onmessage = e => onHostFile(e.data);
  pc.onicecandidate = e => e.candidate && send({ t: 'sig', to: from, data: { ice: e.candidate } });
  pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState)) endHost(true); };
  const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
  const sdp = pc.localDescription.sdp;
  send({ t: 'sig', to: from, data: { type: 'offer', sdp, mac: await hmacHex(secret, 'offer:' + sdp) } });
  applyQuality('auto');
  $('#bnId').textContent = fmtId(from); $('#bnCtl').checked = perm.control; $('#banner').hidden = false;
  log('host', from, 'session started (control=' + perm.control + ')');
  const info = await sas(pc).catch(() => ''); if (info) toast('Session verification code: ' + info);
}
$('#bnCtl').onchange = e => { if (host) host.perm.control = e.target.checked; };
$('#bnStop').onclick = () => endHost(true);
// ---- stream quality presets (chosen by the viewer, applied by the host) ----
// br = bitrate cap, fps = frame-rate cap, hint = what the encoder protects (detail/text = sharpness, motion = smoothness), max = capture size cap
const QUALITY = {
  auto:   { br: 8e6,  fps: 30, hint: 'detail', max: [1920, 1080] },
  smooth: { br: 2.5e6, fps: 30, hint: 'motion', max: [1280, 720] },
  sharp:  { br: 15e6, fps: 30, hint: 'detail', max: null },
  text:   { br: 12e6, fps: 12, hint: 'text',   max: null }       // reading / office work: full resolution, fewer frames, crisp letters
};
function preferCodec(pc, name) {                    // optional: put one video codec first (the viewer must support it; otherwise the next one is used)
  if (!name || name === 'auto') return;
  try {
    const caps = RTCRtpSender.getCapabilities('video').codecs, want = caps.filter(c => c.mimeType.toLowerCase() === 'video/' + name.toLowerCase());
    if (!want.length) return;
    pc.getTransceivers().forEach(t => { if (t.sender && t.sender.track && t.sender.track.kind === 'video' && t.setCodecPreferences) t.setCodecPreferences([...want, ...caps.filter(c => !want.includes(c))]); });
  } catch (_) {}
}
function applyQuality(q) {
  const c = QUALITY[q]; if (!host || !c) return;
  host.pc.getSenders().forEach(s => {
    if (!s.track || s.track.kind !== 'video') return;
    try { s.track.contentHint = c.hint; } catch (_) {}
    const p = s.getParameters(); p.encodings = p.encodings && p.encodings.length ? p.encodings : [{}];
    p.encodings[0].maxBitrate = c.br; p.encodings[0].maxFramerate = c.fps;
    if (c.hint !== 'motion') p.encodings[0].scaleResolutionDownBy = 1;     // never shrink the picture to save bitrate (that is what makes text mushy)
    s.setParameters(p).catch(() => {});
    const m = c.max || [7680, 4320];                                         // capture size: Smooth/Auto cap a 4K screen, Sharp/Text use it all
    s.track.applyConstraints({ width: { max: m[0] }, height: { max: m[1] }, frameRate: { max: c.fps } }).catch(() => {});
  });
}
function endHost(notify) {
  if (!host) return; const h = host; host = null;
  if (notify) send({ t: 'bye', to: h.peer });
  try { h.dc && h.dc.close(); } catch (_) {} try { h.pc.close(); } catch (_) {}
  try { h.stream.getTracks().forEach(t => t.stop()); } catch (_) {}
  abortRx(); $('#banner').hidden = true; log('host', h.peer, 'session ended' + (h.t0 ? ' after ' + Math.round((Date.now() - h.t0) / 1000) + ' s' : '')); setTimeout(applyWhenIdle, 500);
  if (!S.get('unattended', false)) newPw();       // rotate one-time password after every session
  if (!closing && S.get('lockOnEnd', false) && h.perm && h.perm.control && h.t0 && Date.now() - h.t0 > 3000) lockThisPc();
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
  if (m.k === 'clip') { if (host.perm.clip && typeof m.v === 'string' && m.v.length < 100000) navigator.clipboard.writeText(m.v).catch(() => {}); return; }
  if (m.k === 'getclip') {
    if (!host.perm.clip) return host.dc.send(JSON.stringify({ k: 'clipdeny' }));
    navigator.clipboard.readText().then(v => host.dc && host.dc.send(JSON.stringify({ k: 'clipback', v: String(v).slice(0, 100000) }))).catch(() => {});
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

// ---- files sent by the viewer (only when the host allowed file transfer for this session) ----
let rx = null;                                   // the file that is arriving right now: { id, got, size, name, q }
const fsend = o => { try { host && host.fdc && host.fdc.readyState === 'open' && host.fdc.send(JSON.stringify(o)); } catch (_) {} };
function abortRx() { if (rx) { const r = rx; rx = null; if (window.nexa && window.nexa.fileClose) window.nexa.fileClose(r.id, false).catch(() => {}); } }
async function onHostFile(d) {
  if (!host) return;
  if (!host.perm.files || !window.nexa || !window.nexa.fileOpen) { if (typeof d === 'string') fsend({ k: 'no', why: 'this PC does not allow file transfer' }); return; }
  if (typeof d === 'string') {
    let m; try { m = JSON.parse(d); } catch (_) { return; }
    if (m.k === 'fs') {
      if (rx) return fsend({ k: 'no', why: 'another file is still arriving' });
      const size = Number(m.size); if (!(size >= 0)) return fsend({ k: 'no', why: 'bad file size' });
      const r = await window.nexa.fileOpen({ name: String(m.name || 'file').slice(0, 200), size });
      if (!r || !r.ok) return fsend({ k: 'no', why: (r && r.why) || 'refused' });
      rx = { id: r.id, got: 0, size, name: r.name, q: Promise.resolve() };
      log('host', host.peer, 'receiving file ' + r.name + ' (' + size + ' bytes)'); fsend({ k: 'ok' });
    } else if (m.k === 'fe' && rx) {
      const r = rx; rx = null; await r.q;
      const res = await window.nexa.fileClose(r.id, r.got === r.size);
      if (res && res.ok) { fsend({ k: 'done', name: r.name }); toast('File received: ' + r.name + ' (Downloads\\NexaDesk Received)'); log('host', host.peer, 'file received: ' + r.name); }
      else fsend({ k: 'no', why: 'file was incomplete' });
    } else if (m.k === 'fa') abortRx();
  } else if (rx) {
    const r = rx; r.got += d.byteLength;
    if (r.got > r.size) { abortRx(); return fsend({ k: 'no', why: 'more data than announced' }); }
    r.q = r.q.then(() => window.nexa.fileWrite(r.id, new Uint8Array(d))).then(ok => { if (!ok && rx === r) { abortRx(); fsend({ k: 'no', why: 'could not write the file' }); } });
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
  view.timer = setTimeout(() => { if (view && view.st !== 'live') { toast('No response from partner'); endView(false); } }, 60000);
  toast('Contacting partner…'); log('viewer', id, 'connecting'); pushRecent(id);
  send({ t: 'req', to: id });
}
async function onChal(from, nonce) {
  if (!view || view.to !== from || view.st !== 'auth' || typeof nonce !== 'string') return;
  view.st = 'wait';
  const pc = new RTCPeerConnection({ iceServers: iceList() }); view.pc = pc;
  pc.onicecandidate = e => e.candidate && send({ t: 'sig', to: from, data: { ice: e.candidate } });
  pc.ontrack = e => { $('#vid').srcObject = e.streams[0]; if (e.track.kind === 'audio') $('#btnSound').hidden = false; };
  pc.ondatachannel = e => {
    if (e.channel.label === 'file') {            // replies of the PC to the files we send
      view.fdc = e.channel; e.channel.binaryType = 'arraybuffer';
      e.channel.onmessage = ev => { try { const m = JSON.parse(ev.data); if (view && view.fWait) { const w = view.fWait; view.fWait = null; w(m); } } catch (_) {} };
      return;
    }
    view.dc = e.channel; e.channel.onmessage = ev => onPcMsg(ev.data);
    const sendQ = () => dcs({ k: 'q', v: S.get('quality', 'auto') });
    e.channel.onopen = sendQ; if (e.channel.readyState === 'open') sendQ();
  };
  pc.onconnectionstatechange = async () => {
    if (!view) return;
    if (pc.connectionState === 'connected') { view.st = 'live'; showSession(); }
    const cs = pc.connectionState;
    if (cs === 'connected') { clearTimeout(view.dcT); netNote(false); }
    if (cs === 'disconnected') { netNote(true); clearTimeout(view.dcT); view.dcT = setTimeout(() => { if (view && view.pc === pc && pc.connectionState !== 'connected') { toast('Connection lost'); endView(false); } }, 30000); }
    if (cs === 'failed' || cs === 'closed') { toast('Connection lost'); endView(false); }
  };
  send({ t: 'auth', to: from, mac: await hmacHex(view.secret, 'auth:' + nonce + ':' + myId + ':' + from) });
}
async function onSig(from, d) {
  if (view && view.to === from && view.pc) {
    if (d.sdp && d.type === 'offer') {
      if (!(await hmacOk(view.secret, 'offer:' + d.sdp, d.mac || ''))) { toast('Host failed authentication – aborting (possible tampering)'); log('viewer', from, 'OFFER MAC INVALID'); return endView(true); }
      await view.pc.setRemoteDescription({ type: 'offer', sdp: d.sdp }); view.remoteSet = true;
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
  }
}
async function showSession() {
  clearTimeout(view.timer); $('#session').hidden = false; log('viewer', view.to, 'session live'); view.t0 = Date.now();
  const code = await sas(view.pc).catch(() => '');
  const upd = async () => {
    if (!view) return; let kind = '?', rtt = '', fps = '';
    try { const st = await view.pc.getStats(); const loc = {}; st.forEach(r => { if (r.type === 'local-candidate') loc[r.id] = r; if (r.type === 'inbound-rtp' && r.kind === 'video' && r.framesPerSecond) fps = Math.round(r.framesPerSecond); });
      st.forEach(r => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') { const l = loc[r.localCandidateId]; kind = l ? (l.candidateType === 'relay' ? 'Relay (TURN)' : l.candidateType === 'host' ? 'Direct (LAN)' : 'Direct (P2P)') : '?'; if (r.currentRoundTripTime) rtt = Math.round(r.currentRoundTripTime * 1000) + ' ms'; } }); } catch (_) {}
    const el = Math.round((Date.now() - view.t0) / 1000), clock = String(Math.floor(el / 60)).padStart(2, '0') + ':' + String(el % 60).padStart(2, '0');
    $('#sesInfo').textContent = `${fmtId(view.to)} · ${kind} ${rtt}${fps ? ' · ' + fps + ' fps' : ''} · ${clock} · verify code ${code}`;
  };
  upd(); view.statTimer = setInterval(upd, 3000);
  try { if (navigator.wakeLock) view.wake = await navigator.wakeLock.request('screen'); } catch (_) {}   // phone screen stays on during a session
}
function endView(notify) {
  if (!view) return; tpReset(); const v = view; view = null;
  clearTimeout(v.timer); clearTimeout(v.dcT); clearInterval(v.statTimer); zoomReset(); netNote(false); $('#session').classList.remove('immersive'); try { v.wake && v.wake.release(); } catch (_) {}
  try { if (v.fdc && v.fdc.readyState === 'open') v.fdc.send(JSON.stringify({ k: 'fa' })); } catch (_) {}
  $('#btnSound').hidden = true; $('#vid').muted = true; $('#btnSound').textContent = 'Sound off'; $('#xferInfo').textContent = '';
  if (notify) send({ t: 'bye', to: v.to });
  try { v.pc && v.pc.close(); } catch (_) {}
  $('#vid').srcObject = null; $('#session').hidden = true; if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  log('viewer', v.to, 'session ended' + (v.t0 ? ' after ' + Math.round((Date.now() - v.t0) / 1000) + ' s' : '')); setTimeout(applyWhenIdle, 500);
}
// input capture
const vid = $('#vid');
function onPcMsg(raw) {
  let m; try { m = JSON.parse(raw); } catch (_) { return; }
  if (m.k === 'clipback' && typeof m.v === 'string') navigator.clipboard.writeText(m.v).then(() => toast('PC clipboard copied to this device')).catch(() => toast('Could not copy the PC clipboard'));
  if (m.k === 'clipdeny') toast('The PC does not allow clipboard sharing');
}
$('#btnSwitch').onclick = () => {
  const cur = view && view.to;
  const next = S.get('savedPcs', []).find(p => p.id !== cur);
  endView(true);
  document.querySelector('[data-tab="home"]').click();
  if (next) { $('#remId').value = next.id; $('#remPw').focus(); toast('Enter the password for ' + fmtId(next.id)); }
  else toast('Save another PC first (Remote Control tab)');
};
$('#btnPcClip').onclick = () => { dcs({ k: 'getclip' }); toast('Requesting the PC clipboard…'); };
const dcs = o => { if (view && view.dc && view.dc.readyState === 'open') view.dc.send(JSON.stringify(o)); };
function norm(e) {
  const r = vid.getBoundingClientRect(), vw = vid.videoWidth, vh = vid.videoHeight; if (!vw) return null;
  let w, h, ox, oy;
  if (vid.classList.contains('actual')) { w = vw * Z.s; h = vh * Z.s; ox = (r.width - w) / 2; oy = (r.height - h) / 2; }
  else { const s = Math.min(r.width / vw, r.height / vh); w = vw * s; h = vh * s; ox = (r.width - w) / 2; oy = (r.height - h) / 2; }
  return { x: Math.min(1, Math.max(0, (e.clientX - r.left - ox) / w)), y: Math.min(1, Math.max(0, (e.clientY - r.top - oy) / h)) };
}

// ----- zoom (pinch with two fingers, Ctrl+wheel / trackpad pinch on a computer, 100% button): the remote picture is scaled and panned -----
const Z = { s: 1, x: 0, y: 0 };
function zoomApply() {
  const st = vid.parentElement, W = vid.offsetWidth, H = vid.offsetHeight;
  Z.s = Math.min(6, Math.max(1, Z.s));
  const mx = (Z.s - 1) * W / 2, my = (Z.s - 1) * H / 2;
  Z.x = Math.min(mx, Math.max(-mx, Z.x)); Z.y = Math.min(my, Math.max(-my, Z.y));
  if (Z.s === 1) { Z.x = Z.y = 0; vid.style.transform = ''; st.style.overflow = ''; }
  else { vid.style.transformOrigin = 'center'; vid.style.transform = `translate(${Z.x}px, ${Z.y}px) scale(${Z.s})`; st.style.overflow = 'hidden'; }
  const b = $('#btnZoom'); if (b) b.textContent = Z.s === 1 ? 'Zoom' : Math.round(Z.s * 100) + '%';
}
// factor around the screen point (cx, cy); (dx, dy) = movement of the pinch centre = pan
function zoomBy(f, cx, cy, dx, dy) {
  const r = vid.parentElement.getBoundingClientRect(), ox = r.left + r.width / 2, oy = r.top + r.height / 2;
  const s0 = Z.s, s1 = Math.min(6, Math.max(1, s0 * f)), k = s1 / s0;
  Z.x = (cx - ox) - ((cx - ox) - Z.x) * k + (dx || 0); Z.y = (cy - oy) - ((cy - oy) - Z.y) * k + (dy || 0); Z.s = s1;
  zoomApply();
}
function zoomReset() { Z.s = 1; Z.x = Z.y = 0; try { zoomApply(); } catch (_) {} }
function netNote(on) { const n = $('#netNote'); if (n) n.hidden = !on; }
let moveQ = null;
const btnOf = e => (e.button === 2 ? 'r' : e.button === 1 ? 'm' : 'l');
const isTouchPtr = e => e.pointerType === 'touch' || e.pointerType === 'pen';
// ----- mouse on a desktop viewer: absolute positioning, as before -----
vid.addEventListener('pointermove', e => { if (isTouchPtr(e)) return; const p = norm(e); if (!p) return; if (!moveQ) requestAnimationFrame(() => { dcs({ k: 'm', ...moveQ }); moveQ = null; }); moveQ = p; });
vid.addEventListener('pointerdown', e => { if (isTouchPtr(e)) return; vid.setPointerCapture(e.pointerId); vid.focus(); e.preventDefault(); const p = norm(e); if (p) dcs({ k: 'm', ...p }); dcs({ k: 'd', b: btnOf(e) }); });
vid.addEventListener('pointerup', e => { if (isTouchPtr(e)) return; dcs({ k: 'u', b: btnOf(e) }); e.preventDefault(); });
// touch / pen: anywhere on the session screen (not on buttons, sliders or the keyboard field)
const sess = $('#session');
sess.addEventListener('pointerdown', e => {
  if (!isTouchPtr(e) || e.target.closest('button, input, label')) return;
  sess.setPointerCapture(e.pointerId); e.preventDefault(); tpDown(e);
});
sess.addEventListener('pointermove', e => { if (isTouchPtr(e)) tpMove(e); });
sess.addEventListener('pointerup', e => { if (isTouchPtr(e)) tpUp(e); });
sess.addEventListener('pointercancel', e => { if (isTouchPtr(e)) tpUp(e); });
vid.addEventListener('contextmenu', e => e.preventDefault());
vid.addEventListener('wheel', e => { if (e.ctrlKey) zoomBy(Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY, 0, 0); else dcs({ k: 'w', v: -e.deltaY }); e.preventDefault(); }, { passive: false });

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
const clickBtn = b => { dcs({ k: 'd', b }); dcs({ k: 'u', b }); try { navigator.vibrate && navigator.vibrate(b === 'r' ? 25 : 12); } catch (_) {} };
function tpDown(e) {
  const now = performance.now();
  if (tp.ptrs.size === 0) { tp.maxN = 0; tp.moved = false; tp.gesture = 'point'; }
  tp.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: now, moved: false });
  tp.maxN = Math.max(tp.maxN, tp.ptrs.size); tp.pinch = false; tp.d0 = 0;
  clearTimeout(tp.longT);
  if (tp.ptrs.size === 1) {
    if (now - tp.lastTapEnd < 300 && !tp.hold) { tp.dragging = true; dcs({ k: 'd', b: 'l' }); }   // second tap = press and drag
    else tp.longT = setTimeout(() => { if (tp.gesture === 'point' && !tp.moved && !tp.dragging) { clickBtn('r'); tp.gesture = 'done'; } }, 600);
  } else {                                  // second finger: two-finger gesture (cancels any drag)
    if (tp.dragging) { tp.dragging = false; dcs({ k: 'u', b: 'l' }); }
    tp.gesture = 'two';
  }
}
function tpMove(e) {
  const p = tp.ptrs.get(e.pointerId); if (!p) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
  if (!p.moved && Math.hypot(e.clientX - p.sx, e.clientY - p.sy) > 10) { p.moved = true; tp.moved = true; clearTimeout(tp.longT); }
  if (tp.gesture === 'point' && tp.ptrs.size === 1) tpSend(dx * sensOf(), dy * sensOf());
  else if (tp.gesture === 'two' && tp.ptrs.size === 2) {
    const [p1, p2] = [...tp.ptrs.values()], d = Math.hypot(p1.x - p2.x, p1.y - p2.y), cx = (p1.x + p2.x) / 2, cy = (p1.y + p2.y) / 2;
    if (!tp.d0) { tp.d0 = d; tp.pd = d; tp.pcx = cx; tp.pcy = cy; }
    if (!tp.pinch && (Math.abs(d - tp.d0) > 28 || (Z.s > 1 && Math.hypot(cx - tp.pcx, cy - tp.pcy) > 28 && Math.abs(d - tp.d0) > 8))) { tp.pinch = true; tp.moved = true; tp.accW = 0; }
    if (tp.pinch) { zoomBy(d / tp.pd, cx, cy, cx - tp.pcx, cy - tp.pcy); tp.pd = d; tp.pcx = cx; tp.pcy = cy; return; }
    tp.accW += dy * 1.5; const w = Math.trunc(tp.accW); if (w) { tp.accW -= w; dcs({ k: 'w', v: w }); } }
  else if (tp.gesture === 'two' && !tp.pinch) { tp.accW += dy * 1.5; const w = Math.trunc(tp.accW); if (w) { tp.accW -= w; dcs({ k: 'w', v: w }); } }
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
  tp.gesture = 'idle'; tp.moved = false; tp.maxN = 0; tp.accW = 0;
}
function tpReset() {
  clearTimeout(tp.longT);
  if (tp.hold || tp.dragging) dcs({ k: 'u', b: 'l' });
  tp.ptrs.clear(); tp.dragging = false; tp.hold = false; tp.gesture = 'idle'; tp.lastTapEnd = 0; tp.accX = tp.accY = tp.accW = 0;
  $('#tpHold').classList.remove('on');
}
$('#tpLeft').onclick = () => clickBtn('l');
$('#tpRight').onclick = () => clickBtn('r');
// keyboard shortcuts: Windows does not let any normal program send Ctrl+Alt+Del (see README), the others work
const COMBOS = { 'ctrl-c': [17, 67], 'ctrl-v': [17, 86], 'ctrl-x': [17, 88], 'ctrl-z': [17, 90], 'ctrl-a': [17, 65], 'win-shift-s': [91, 16, 83], 'ctrl-shift-esc': [17, 16, 27], 'alt-tab': [18, 9], 'win': [91], 'win-l': [91, 76], 'win-d': [91, 68], 'alt-f4': [18, 115], 'esc': [27], 'printscreen': [44], 'ctrl-s': [17, 83], 'ctrl-f': [17, 70], 'ctrl-w': [17, 87], 'ctrl-t': [17, 84], 'ctrl-y': [17, 89], 'win-r': [91, 82], 'win-e': [91, 69], 'f5': [116], 'f11': [122], 'enter': [13], 'tab': [9] };
for (let i = 1; i <= 12; i++) COMBOS['f' + i] = [111 + i];
function sendCombo(name) {
  const keys = COMBOS[name]; if (!keys) return;
  keys.forEach(vk => dcs({ k: 'kd', vk, ext: EXT.has(vk) }));
  [...keys].reverse().forEach(vk => dcs({ k: 'ku', vk, ext: EXT.has(vk) }));
}
{ const fb = $('#fKeys'); for (let i = 1; i <= 12; i++) { const b = document.createElement('button'); b.textContent = 'F' + i; b.dataset.combo = 'f' + i; fb.appendChild(b); } }
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
$('#quality').onchange = e => { S.set('quality', e.target.value); dcs({ k: 'q', v: e.target.value }); toast('Quality: ' + e.target.options[e.target.selectedIndex].text); };
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
const kbd = $('#kbd');
kbd.addEventListener('beforeinput', e => {
  if (e.inputType === 'insertText' && e.data) dcs({ k: 't', v: e.data });
  else if (e.inputType === 'deleteContentBackward') { dcs({ k: 'kd', vk: 8 }); dcs({ k: 'ku', vk: 8 }); }
  else if (e.inputType === 'insertLineBreak') { dcs({ k: 'kd', vk: 13 }); dcs({ k: 'ku', vk: 13 }); }
  e.preventDefault();
});
$('#btnKbd').onclick = () => { kbd.value = ''; kbd.focus(); };
$('#btnClip').onclick = async () => { try { dcs({ k: 'clip', v: await navigator.clipboard.readText() }); toast('Clipboard sent'); } catch (_) { toast('Clipboard not available'); } };
$('#btnSound').onclick = () => { vid.muted = !vid.muted; $('#btnSound').textContent = vid.muted ? 'Sound off' : 'Sound on'; if (!vid.muted) vid.play().catch(() => {}); };
// send file(s) to the PC: the PC must have allowed file transfer for this session
const askPc = (o, ms = 15000) => new Promise(res => {
  const ch = view && view.fdc; if (!ch || ch.readyState !== 'open') return res({ k: 'no', why: 'file channel is not ready' });
  view.fWait = res; ch.send(JSON.stringify(o));
  setTimeout(() => { if (view && view.fWait === res) { view.fWait = null; res({ k: 'no', why: 'no answer from the PC' }); } }, ms);
});
async function sendFile(f) {
  const info = $('#xferInfo'), ch = view && view.fdc;
  const r = await askPc({ k: 'fs', name: f.name, size: f.size }); if (r.k !== 'ok') return toast('Not sent: ' + (r.why || 'refused'));
  const CH = 32768; let last = 0; ch.bufferedAmountLowThreshold = 1 << 20;
  for (let off = 0; off < f.size; off += CH) {
    if (!view || view.fdc !== ch || ch.readyState !== 'open') { info.textContent = ''; return toast('File transfer interrupted'); }
    if (ch.bufferedAmount > (4 << 20)) await new Promise(res => { ch.onbufferedamountlow = () => { ch.onbufferedamountlow = null; res(); }; });
    ch.send(await f.slice(off, off + CH).arrayBuffer());
    const now = Date.now(); if (now - last > 250) { last = now; info.textContent = f.name.slice(0, 24) + ' ' + Math.round(off * 100 / f.size) + '%'; }
  }
  const d = await askPc({ k: 'fe' }, 60000); info.textContent = '';
  toast(d.k === 'done' ? 'Sent: ' + f.name : 'Not completed: ' + (d.why || 'unknown'));
}
$('#btnFile').onclick = () => { $('#fileIn').value = ''; $('#fileIn').click(); };
$('#fileIn').onchange = async e => { for (const f of [...e.target.files]) { if (!view) break; await sendFile(f); } e.target.value = ''; };
$('#btnFit').onclick = () => { zoomReset(); vid.classList.toggle('actual'); };
$('#btnZoom').onclick = () => { if (Z.s === 1) { const r = vid.parentElement.getBoundingClientRect(); zoomBy(2, r.left + r.width / 2, r.top + r.height / 2, 0, 0); } else zoomReset(); };
$('#btnShot').onclick = () => {
  try {
    if (!vid.videoWidth) return toast('No picture yet');
    const c = document.createElement('canvas'); c.width = vid.videoWidth; c.height = vid.videoHeight; c.getContext('2d').drawImage(vid, 0, 0);
    c.toBlob(b => { if (!b) return toast('Screenshot failed'); const u = URL.createObjectURL(b), l = document.createElement('a'); l.href = u; l.download = 'NexaDesk-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.png'; document.body.appendChild(l); l.click(); l.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000); toast('Screenshot saved'); }, 'image/png');
  } catch (_) { toast('Screenshot failed'); }
};
$('#fab').onclick = () => $('#session').classList.toggle('immersive');
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
$('#remId').addEventListener('input', e => { const d = e.target.value.replace(/\D/g, '').slice(0, 9); e.target.value = d.replace(/(\d{3})(?=\d)/g, '$1 '); });
// Saved passwords: Windows app = encrypted with the Windows account key (DPAPI); Android/browser = AES-GCM with a non-extractable key kept in IndexedDB.
const Vault = (() => {
  const win = window.nexa && window.nexa.vault;
  const idb = () => new Promise((ok, bad) => { const r = indexedDB.open('nx-vault', 1); r.onupgradeneeded = () => r.result.createObjectStore('k'); r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error); });
  const idbGet = async () => { const db = await idb(); return new Promise((ok, bad) => { const q = db.transaction('k').objectStore('k').get('key'); q.onsuccess = () => ok(q.result); q.onerror = () => bad(q.error); }); };
  const idbPut = async k => { const db = await idb(); return new Promise((ok, bad) => { const t = db.transaction('k', 'readwrite'); t.objectStore('k').put(k, 'key'); t.oncomplete = () => ok(); t.onerror = () => bad(t.error); }); };
  const key = async () => { let k = await idbGet(); if (!k) { k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); await idbPut(k); } return k; };
  return {
    async load() {
      try {
        if (win) return JSON.parse((await win.get()) || '{}');
        const raw = localStorage.getItem('nx_vault'); if (!raw) return {};
        const b = Uint8Array.from(atob(raw), c => c.charCodeAt(0));
        return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b.slice(0, 12) }, await key(), b.slice(12))));
      } catch (_) { return {}; }
    },
    async save(o) {
      try {
        const txt = JSON.stringify(o);
        if (win) return !!(await win.set(txt));
        const iv = crypto.getRandomValues(new Uint8Array(12)), ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(), enc.encode(txt)));
        const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
        localStorage.setItem('nx_vault', btoa(String.fromCharCode(...out))); return true;
      } catch (_) { return false; }
    }
  };
})();
let vaultData = {};                                    // { partnerId: password }
Vault.load().then(v => { vaultData = v || {}; renderSaved(); });
async function rememberPc(id, pass) {                  // save the PC (and its password) for one-tap connect
  const l = S.get('savedPcs', []); if (!l.some(p => p.id === id)) { l.unshift({ id, label: 'PC ' + fmtId(id) }); S.set('savedPcs', l.slice(0, 50)); }
  if (pass) { vaultData[id] = pass; if (!(await Vault.save(vaultData))) { delete vaultData[id]; toast('Could not store the password securely'); } }
  renderSaved();
}
function renderSaved() {
  const box = $('#savedPcs'); box.innerHTML = '';
  const list = S.get('savedPcs', []);
  if (!list.length) { box.textContent = 'No saved PCs yet.'; return; }
  list.forEach((p, i) => {
    const row = document.createElement('div');
    const has = !!vaultData[p.id];
    const go = document.createElement('button'); go.textContent = (has ? '🔑 ' : '') + (p.label || 'PC') + '  ·  ' + fmtId(p.id);
    go.onclick = () => {
      $('#remId').value = fmtId(p.id);
      if (has) { toast('Connecting to ' + (p.label || fmtId(p.id)) + '…'); connectTo(p.id, vaultData[p.id]); }   // saved password: connect at once
      else $('#remPw').focus();
    };
    const ed = document.createElement('button'); ed.textContent = '✎'; ed.title = 'Rename';
    ed.onclick = () => {                                  // inline rename (window.prompt does not exist in the Windows app)
      const inp = document.createElement('input'); inp.value = p.label || ''; inp.maxLength = 24; inp.placeholder = 'Name, e.g. Office PC';
      let done = false;
      const save = () => { if (done) return; done = true; const l = S.get('savedPcs', []); if (l[i] && l[i].id === p.id) { l[i].label = inp.value.trim() || 'PC ' + fmtId(p.id); S.set('savedPcs', l); } renderSaved(); };
      inp.onkeydown = e => { if (e.key === 'Enter') save(); else if (e.key === 'Escape') { done = true; renderSaved(); } };
      inp.onblur = save;
      row.replaceChild(inp, go); inp.focus(); inp.select();
    };
    const x = document.createElement('button'); x.textContent = '✕'; x.title = 'Remove (and forget its password)';
    x.onclick = async () => { const l = S.get('savedPcs', []); l.splice(i, 1); S.set('savedPcs', l); if (vaultData[p.id]) { delete vaultData[p.id]; await Vault.save(vaultData); } renderSaved(); };
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
    b.onclick = () => { $('#remId').value = fmtId(id); $('#remPw').focus(); };
    row.appendChild(b);
  });
  box.appendChild(row);
}
$('#savePc').onclick = () => {
  const id = $('#remId').value.replace(/\D/g, '');
  if (id.length < 6) return toast('Enter the partner ID first');
  const old = S.get('savedPcs', []).find(p => p.id === id), pass = $('#remSave').checked ? $('#remPw').value.trim() : '';
  if ($('#remSave').checked && !pass && !vaultData[id]) toast('Type the password first to remember it');
  const l = S.get('savedPcs', []).filter(p => p.id !== id); l.unshift({ id, label: old && old.label ? old.label : 'PC ' + fmtId(id) }); S.set('savedPcs', l.slice(0, 50));
  rememberPc(id, pass).then(() => toast(pass ? 'Saved with password' : 'Saved'));
};
renderRecent();
$('#connectBtn').onclick = () => {
  const id = $('#remId').value.replace(/\D/g, ''), pass = $('#remPw').value.trim();
  if ($('#remSave').checked && id.length === 9 && pass) rememberPc(id, pass);      // tick Remember = this PC and its password are kept for one-tap connect
  connectTo($('#remId').value, pass || vaultData[id] || ''); $('#remPw').value = '';
};
$('#remPw').addEventListener('keydown', e => e.key === 'Enter' && $('#connectBtn').click());
$('#newInvite').onclick = () => { const c = genSecret(12); invites.clear(); invites.set(c, Date.now() + 10 * 60000); $('#inviteCode').textContent = c; };
$('#copyInvite').onclick = () => validInvites().length && copy([...invites.keys()][0], 'Invite copied');
$('#optUnattended').checked = S.get('unattended', false);
$('#optControl').checked = S.get('defControl', true); $('#optClip').checked = S.get('defClip', true);
$('#optUnattended').onchange = e => { const on = e.target.checked; if (on && permPwCache.length < 12) { e.target.checked = false; return toast('Set a permanent password (12+ chars) first'); } S.set('unattended', on); newPw(); };
$('#optControl').onchange = e => S.set('defControl', e.target.checked); $('#optClip').onchange = e => S.set('defClip', e.target.checked);
document.querySelectorAll('.hostonly').forEach(e => { e.hidden = !canHost; });
$('#optFiles').checked = S.get('defFiles', true); $('#optFiles').onchange = e => S.set('defFiles', e.target.checked);
$('#optSound').checked = S.get('shareAudio', false); $('#optSound').onchange = e => { S.set('shareAudio', e.target.checked); toast(e.target.checked ? 'This PC will share its sound (from the next session)' : 'Sound sharing: off'); };
$('#optCodec').value = S.get('codec', 'auto'); $('#optCodec').onchange = e => { S.set('codec', e.target.value); toast('Video codec applies from the next session'); };
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
  const tr = $('#optTray'); tr.checked = S.get('tray', false);
  window.nexa.power({ tray: tr.checked }).catch(() => {});
  tr.onchange = async e => { S.set('tray', e.target.checked); const r = await window.nexa.power({ tray: e.target.checked }); toast(r && r.ok ? (e.target.checked ? 'Closing the window now keeps NexaDesk running in the tray' : 'Closing the window quits NexaDesk') : 'Could not change this'); };
  au.onchange = async e => { const r = await window.nexa.power({ autostart: e.target.checked }); if (!r || !r.ok) { e.target.checked = !e.target.checked; return toast('Could not change this (install the app first)'); } toast(e.target.checked ? 'NexaDesk will start when you sign in' : 'Autostart: off'); };
}
// administrator mode: input into elevated windows (Task Manager, installers, other admin tools) only works when NexaDesk itself runs elevated
if (canHost && window.nexa.admin) {
  const refreshAdmin = async () => {
    const r = await window.nexa.admin({}); if (!r || !r.ok) return;
    $('#pcCard').hidden = false; $('#adminCard').hidden = false;
    $('#adminState').textContent = r.elevated ? 'Running as administrator: the remote mouse and keyboard also work in Task Manager and other admin windows. (The Windows sign-in / UAC secure screen cannot be controlled by any normal program.)'
      : 'Running normally: Windows ignores the remote mouse and keyboard in admin windows such as Task Manager. Restart as administrator to control them.';
    $('#btnElevate').hidden = r.elevated; $('#rowAdminAuto').hidden = !(r.elevated && r.packaged); $('#optAdminAuto').checked = !!r.task;
  };
  $('#btnElevate').onclick = async () => { toast('Windows will ask for permission…'); const r = await window.nexa.admin({ relaunch: true }); if (!r || !r.ok) toast('Cancelled: NexaDesk keeps running normally'); };
  $('#optAdminAuto').onchange = async e => {
    const r = await window.nexa.admin({ autostart: e.target.checked });
    if (!r || !r.ok) { e.target.checked = !e.target.checked; return toast('Could not change this' + (r && r.why ? ' (' + r.why + ')' : '')); }
    if (e.target.checked && $('#optAutostart')) $('#optAutostart').checked = false;
    toast(e.target.checked ? 'NexaDesk will start as administrator when you sign in' : 'Administrator autostart: off');
  };
  refreshAdmin();
}
$('#savePerm').onclick = async () => {
  const v = $('#permPw').value; if (v.length < 12) return toast('Use at least 12 characters');
  const sec = window.nexa && window.nexa.secret && window.nexa.secret.available ? window.nexa.secret : null;
  if (sec) { if (!(await sec.set(v))) return toast('Could not store the password securely'); localStorage.removeItem('nx_permpw'); }
  else S.set('permpw', v);
  permPwCache = v; $('#permPw').value = ''; toast('Saved'); if (S.get('unattended', false)) newPw();
};
loadPermPw().then(newPw);
$('#clearLog').onclick = () => { S.set('log', []); renderLog(); };
$('#srvUrl').value = S.get('server', window.NEXA_DEFAULT_SERVER || ''); $('#extraIce').value = S.get('extraIce', '');
$('#addTurn').onclick = () => {
  const host = $('#turnHost').value.trim().replace(/^turns?:/i, ''), user = $('#turnUser').value.trim(), pass = $('#turnPass').value;
  if (!/^[\w.-]+(:\d{2,5})?$/.test(host) || !user || !pass) return toast('Enter host:port, username and password');
  let list = []; try { list = JSON.parse($('#extraIce').value || '[]'); if (!Array.isArray(list)) list = []; } catch (_) { return toast('The ICE list is not valid JSON; fix or clear it first'); }
  const h = host.includes(':') ? host : host + ':3478';
  list = list.filter(x => !(x && JSON.stringify(x.urls || '').includes(h)));
  list.push({ urls: ['turn:' + h + '?transport=udp', 'turn:' + h + '?transport=tcp'], username: user, credential: pass });
  $('#extraIce').value = JSON.stringify(list); $('#turnPass').value = ''; toast('Added - press Save & reconnect, then Test connection');
};
// what can this network do? Gathers the same candidates a real session would use and reports host / STUN / TURN results and TURN errors
$('#testConn').onclick = async () => {
  const box = $('#testBox'), lines = []; const say = t => { lines.push(t); box.textContent = lines.join('\n'); };
  $('#testConn').disabled = true;
  try {
    say(ws && ws.readyState === 1 && myId ? 'Signaling server: connected (your ID ' + fmtId(myId) + ')' : 'Signaling server: NOT connected: check the server URL');
    if (ws && ws.readyState === 1 && myId) { const t = performance.now(); await new Promise(res => { icePing = res; send({ t: 'ice' }); setTimeout(res, 5000); }); say('  answer time: ' + Math.round(performance.now() - t) + ' ms'); }
    const servers = iceList(), withTurn = servers.some(sv => sv.username);
    say(servers.length + ' ICE server entries (' + (withTurn ? 'with TURN' : 'no TURN') + ')');
    const seen = { host: 0, srflx: 0, relay: 0 }, errs = []; let relayMs = null; const t0 = performance.now();
    const pc = new RTCPeerConnection({ iceServers: servers }); pc.createDataChannel('t');
    pc.onicecandidate = e => { const m = e.candidate && / typ (host|srflx|relay)/.exec(e.candidate.candidate); if (m) { seen[m[1]]++; if (m[1] === 'relay' && relayMs === null) relayMs = Math.round(performance.now() - t0); } };
    pc.onicecandidateerror = e => { if (e.errorCode !== 701 || !/^stun/.test(e.url || '')) errs.push((e.url || '?') + ' → ' + e.errorCode + ' ' + (e.errorText || '')); };
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise(res => { const t = setTimeout(res, 9000); pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } }; });
    pc.close();
    say('Local (LAN) addresses: ' + seen.host + '   Public address via STUN: ' + seen.srflx + '   TURN relay: ' + seen.relay + (relayMs !== null ? ' (first in ' + relayMs + ' ms)' : ''));
    errs.slice(0, 4).forEach(x => say('  problem: ' + x + (/401|403/.test(x) ? '  (username/password rejected)' : /701/.test(x) ? '  (server unreachable, check host:port / firewall)' : '')));
    say(seen.relay ? '✔ Relay works: connections over mobile data and strict networks are possible.'
      : withTurn ? '✘ TURN is configured but gave no relay address. Check host, port, username and password above.'
      : '✘ No TURN server: over mobile data (5G) or strict networks a connection can fail. Add one above (Metered / ExpressTURN free plans work).');
    if (!seen.srflx && !seen.relay) say('⚠ Nothing reachable from outside: UDP may be blocked on this network.');
  } catch (e) { say('Test failed: ' + (e && e.message || e)); }
  $('#testConn').disabled = false;
};
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
const autoUpd = () => S.get('autoUpdate', true) !== false;   // default: install updates automatically
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
const fmtMB = n => (n / 1048576).toFixed(1);
function showDl(p) {                                         // live download progress (percent, size, speed, which host)
  const pct = p.pct != null ? Math.round(p.pct) : p.total ? Math.min(100, Math.round(p.got * 100 / p.total)) : null;
  let t = p.label + ' - ' + (pct === null ? 'downloading' : pct + '%');
  if (p.got) t += ' · ' + fmtMB(p.got) + (p.total ? '/' + fmtMB(p.total) : '') + ' MB';
  if (p.speed) t += ' · ' + fmtMB(p.speed) + ' MB/s';
  if (p.host) t += ' · ' + p.host;
  $('#updBox').textContent = t;
  const bar = $('#dlBar'); bar.hidden = false; bar.firstElementChild.style.width = (pct === null ? 8 : pct) + '%';
  if (p.done || pct === 100) setTimeout(() => { bar.hidden = true; }, 900);
}
if (window.nexa && window.nexa.onDownload) window.nexa.onDownload(showDl);
const MIRROR_PREFIX_RE = /^https:\/\/(raw\.githubusercontent\.com\/[\w.-]+\/[\w.-]+\/HEAD\/ota\/|github\.com\/[\w.-]+\/[\w.-]+\/releases\/download\/ota\/)$/;
let dlListening = false;
async function stageUpdate(m) {                              // download + verify the bundle; does not apply it
  const url = otaBase() + '/' + m.bundle, cu = CU();
  const mw = m.mirrors && MIRROR_PREFIX_RE.test(m.mirrors.web || '') && /raw\.githubusercontent/.test(m.mirrors.web) ? [m.mirrors.web + m.bundle] : [];   // backup copy on GitHub
  toast('Downloading update v' + m.version + '…');
  if (window.nexa && window.nexa.otaInstall) {
    const res = await window.nexa.otaInstall({ url, urls: mw, version: m.version, sha256: m.sha256 });
    if (!res || !res.ok) { ulog('download v' + m.version + ' failed: ' + JSON.stringify(res || {})); throw new Error('install'); }
    pend = { version: m.version }; ulog('downloaded v' + m.version + ' (windows)');
  } else if (cu) {
    try { const l = await cu.list(), c = await cu.current(); for (const b of (l.bundles || [])) if (b.id !== c.bundle.id && b.id !== 'builtin') await cu.delete({ id: b.id }).catch(() => {}); } catch (_) {}
    if (!dlListening) { dlListening = true; try { cu.addListener('download', ev => showDl({ label: 'Update v' + m.version, pct: ev && ev.percent })); } catch (_) {} }
    let b, lastErr;
    for (const u of [url, ...mw]) {                           // own server first, then the GitHub copy
      try { b = await cu.download({ url: u, version: m.version, checksum: m.sha256 }); break; } catch (e) { lastErr = e; ulog('download v' + m.version + ' from ' + u.split('/')[2] + ' failed: ' + (e && e.message || e)); }
    }
    if (!b) throw lastErr || new Error('download');
    pend = { id: b.id, version: m.version }; ulog('downloaded v' + m.version + ' (android)');
  } else throw new Error('install');
}
function showReady(v) {                                      // manual mode: tell the user, they decide when
  $('#updBox').textContent = 'Update v' + v + ' is ready. It installs when you press Install (never during a session).';
  $('#installUpd').hidden = false; toast('Update v' + v + ' is ready - press Install in Settings');
}
let forceTimer = null;
function forceNow(v) {                                       // mandatory update: 30 s warning, then installs
  if (forceTimer) return;
  let n = 30;
  const show = () => { $('#updBox').textContent = 'Mandatory update v' + v + ' installs in ' + n + ' s. Active sessions will be disconnected.'; };
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
  let n = 30;
  const show = () => { $('#updBox').textContent = label + ' installs in ' + n + ' s. Active sessions will be disconnected.'; };
  show();
  const t = setInterval(() => { n--; if (n > 0) return show(); clearInterval(t); if (host) endHost(true); if (view) endView(true); fn(); }, 1000);
}
function whenIdle(fn) { const t = setInterval(() => { if (!host && !view) { clearInterval(t); fn(); } }, 2000); }
let nativePend = false;                                    // an app-package install is already scheduled or running
async function installNativeNow(nat) {
  toast('Installing app update v' + nat.version + '…');
  const r = await window.nexa.nativeInstall({ url: nat.windows.url, urls: nat.windows.mirror ? [nat.windows.mirror] : [], sha256: nat.windows.sha256, version: nat.version });
  ulog('app installer v' + nat.version + ': ' + (r && r.ok ? 'started' : 'failed (' + ((r && r.why) || 'unknown') + ')'));
  if (!r || !r.ok) { nativePend = false; toast('App update failed: ' + ((r && r.why) || 'unknown')); }
}
async function handleNative(m, forceN) {
  const nat = m.native; if (!nat) return;
  if (nat.windows && window.nexa && window.nexa.nativeInstall && window.nexa.nativeVersion) {
    const cur = await window.nexa.nativeVersion();
    if (cur && cmpv(nat.version, cur) > 0) {
      if (nativePend) return;
      if (forceN) { nativePend = true; return withCountdown('App update v' + nat.version, () => installNativeNow(nat)); }
      if (autoUpd()) { nativePend = true; return whenIdle(() => installNativeNow(nat)); }
      $('#nativeBox').textContent = 'App update v' + nat.version + ' is ready. Install it when you are not in a session.';
      $('#installNative').hidden = false;
      $('#installNative').onclick = () => { if (host || view) return toast('Finish the current session first'); installNativeNow(nat); };
    }
  }
  if (nat.android && window.Capacitor && window.Capacitor.getPlatform && window.Capacitor.getPlatform() === 'android') {
    let curA = ''; try { curA = (await CU().current()).native || ''; } catch (_) {}
    const link = $('#apkLink');
    if (!curA || cmpv(nat.version, curA) > 0) { link.href = nat.android.url; link.textContent = 'Download the latest app (APK, v' + nat.version + ')'; link.hidden = false; }
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
  otaBusy = true;
  try {
    const q = '?t=' + Date.now();
    const [rt, rs] = await Promise.all([fetch(otaBase() + '/update.json' + q, { cache: 'no-store' }), fetch(otaBase() + '/update.sig2' + q, { cache: 'no-store' })]);
    if (!rt.ok || !rs.ok) { ulog('update server has no release files (' + rt.status + '/' + rs.status + ')'); throw new Error('manifest'); }
    const text = await rt.text();
    if (!(await verifyManifest(text, await rs.text()))) throw new Error('signature');
    const m = JSON.parse(text);
    if (m.native && m.native.windows && m.mirrors && MIRROR_PREFIX_RE.test(m.mirrors.app || '') && /github\.com/.test(m.mirrors.app)) m.native.windows.mirror = m.mirrors.app + 'NexaDesk-Setup-' + m.native.version + '.exe';
    adoptServer(m);
    const ok = /^\d+\.\d+\.\d+$/.test(m.version) && /^www-\d+\.\d+\.\d+\.zip$/.test(m.bundle || '') && /^[0-9a-f]{64}$/i.test(m.sha256 || '');
    ulog('server has v' + m.version + ', this device runs v' + VER + (m.force === true ? ' (forced)' : ''));
    if (ok && cmpv(m.version, VER) > 0) {
      if (!pend || pend.version !== m.version) await stageUpdate(m);
      if (m.force === true) forceNow(m.version); else if (autoUpd()) applyWhenIdle(); else showReady(m.version);
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
$('#autoUpd').checked = autoUpd();
$('#autoUpd').onchange = e => {
  S.set('autoUpdate', e.target.checked);
  toast(e.target.checked ? 'Automatic updates: on' : 'Automatic updates: off - you install updates yourself');
  if (e.target.checked) checkOta();
};
setInterval(() => checkOta(), 60000);
window.addEventListener('focus', () => checkOta());
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkOta(); });
setTimeout(() => checkOta(), 1500);
{ const c = S.get('lastId', ''); if (c) $('#myId').textContent = fmtId(c); }   // show the last known ID instantly
setInterval(() => { if (ws && ws.readyState === 1 && myId && !host && !view) send({ t: 'ice' }); }, 5 * 3600 * 1000);   // TURN credentials expire after 12 h
renderLog(); connectWS();
})();
