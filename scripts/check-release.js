// Checks what the update server publishes right now, the way an app sees it (read-only, changes nothing):
// update.json is valid, the web bundle downloads and matches its sha256, and the installer links (if any) answer.
//   node scripts\check-release.js            (uses server-url.txt)
//   node scripts\check-release.js <origin>   (for testing)
// Exit code 1 = devices could not install this update.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const urlFile = path.join(path.resolve(__dirname, '..'), 'server-url.txt');
const origin = (process.argv[2] || (fs.existsSync(urlFile) ? fs.readFileSync(urlFile, 'utf8').trim() : ''))
  .replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/$/, '');
const row = (label, v) => console.log(label.padEnd(30) + v);
const keysFile = path.join(path.resolve(__dirname, '..'), 'app', 'www', 'update-keys.js');
let bad = false;
const fail = msg => { bad = true; console.log('PROBLEM: ' + msg); };

(async () => {
  if (!origin) { fail('no server address (server-url.txt is missing)'); return; }
  const q = '?t=' + Date.now();
  let m, text;
  try {
    const r = await fetch(origin + '/update.json' + q, { cache: 'no-store' });
    if (!r.ok) { fail('update.json answered HTTP ' + r.status + '. Run a quick update (option 2) once.'); return; }
    text = await r.text(); m = JSON.parse(text);
  } catch (e) { fail('cannot read ' + origin + '/update.json: ' + e.message); return; }
  row('published version:', String(m.version));
  if (!/^\d+\.\d+\.\d+$/.test(m.version || '') || !/^www-\d+\.\d+\.\d+\.zip$/.test(m.bundle || '') || !/^[0-9a-f]{64}$/i.test(m.sha256 || '')) { fail('update.json has missing or malformed fields'); return; }
  try {                                   // signature: update.sig2 must verify with a key the apps trust (from app\www\update-keys.js)
    const keys = JSON.parse(fs.readFileSync(keysFile, 'utf8').match(/=\s*(\[[^\]]*\])/)[1]);
    if (!keys.length) row('signature:', '(no keys in app\\www\\update-keys.js - not checked)');
    else {
      const sr = await fetch(origin + '/update.sig2' + q, { cache: 'no-store' });
      const sig = Buffer.from(sr.ok ? (await sr.text()).trim() : '', 'base64');
      const good = sr.ok && keys.some(k => { try { return crypto.verify('sha256', Buffer.from(text), crypto.createPublicKey({ key: Buffer.from(k, 'base64'), format: 'der', type: 'spki' }), sig); } catch (_) { return false; } });
      row('signed with a trusted key:', good ? 'YES' : 'NO');
      if (!good) fail('update.sig2 is missing or not signed with a key the apps trust');
    }
  } catch (e) { row('signature:', 'could not check (' + e.message + ')'); }
  try {
    const r = await fetch(origin + '/' + m.bundle + q, { cache: 'no-store' });
    if (!r.ok) fail(m.bundle + ' answered HTTP ' + r.status);
    else {
      const h = crypto.createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex');
      row('web bundle matches its hash:', h === String(m.sha256).toLowerCase() ? 'YES' : 'NO');
      if (h !== String(m.sha256).toLowerCase()) fail(m.bundle + ' on the server does not match the sha256 in update.json');
    }
  } catch (e) { fail('cannot download ' + m.bundle + ': ' + e.message); }
  if (m.native) {
    row('app installers (version):', String(m.native.version));
    for (const k of ['windows', 'android']) {
      if (!m.native[k]) continue;
      try { const r = await fetch(m.native[k].url, { method: 'HEAD' }); row('  ' + k + ' installer link:', r.ok ? 'reachable' : 'HTTP ' + r.status); if (!r.ok) console.log('WARNING: the ' + k + ' installer link does not answer; in-app app updates will fail.'); }
      catch (e) { row('  ' + k + ' installer link:', 'unreachable (' + e.message + ')'); }
    }
  } else row('app installers:', '(none listed)');
  if (!bad) console.log('\nAll good: devices can install v' + m.version + '.');
})().then(() => process.exit(bad ? 1 : 0));
