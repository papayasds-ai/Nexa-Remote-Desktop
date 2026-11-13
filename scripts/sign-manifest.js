// NexaDesk release signing. Apps trust TWO public keys (built into app\www\update-keys.js):
//   daily key     ~\.nexadesk\update-key.pem           signs every release; lives in your user profile, NOT in the project folder,
//                                                       so a new zip / new project folder can never lose it or create a second one
//   recovery key  ~\.nexadesk\RECOVERY-MOVE-OFFLINE.pem  created once; move it to a password manager / USB stick and delete it from disk.
//                                                       Only its public half (recovery-public.pem) stays here.
// Either key is accepted by the apps. If the daily key is ever lost, publish once with the recovery key
// (START-HERE.bat option 4): a new daily key is created and every app picks up the new trust list by itself.
//
//   node sign-manifest.js ensure [liveTrustIds] [recoveryPem]   makes sure keys exist, writes app\www\update-keys.js, prints KEYID= and TRUST=
//   node sign-manifest.js sign2 <file> [recoveryPem]            writes update.sig2 (signature the new apps verify)
//   (legacy bridge for apps installed before signing was removed: legacy-id / sign / keyid, see below)
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const home = path.join(os.homedir(), '.nexadesk');
const dailyFile = path.join(home, 'update-key.pem'), recPubFile = path.join(home, 'recovery-public.pem'), recPrivFile = path.join(home, 'RECOVERY-MOVE-OFFLINE.pem');
const keysJs = path.join(root, 'app', 'www', 'update-keys.js');
const fail = m => { console.error('ERROR: ' + m); process.exit(1); };
const spkiOf = pemOrKey => crypto.createPublicKey(pemOrKey).export({ type: 'spki', format: 'der' });
const idOfDer = der => crypto.createHash('sha256').update(der).digest('hex').slice(0, 16);
const idOfPem = file => idOfDer(spkiOf(fs.readFileSync(file)));
const newPair = () => crypto.generateKeyPairSync('rsa', { modulusLength: 3072, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });

function ensure(liveCsv, recArg) {
  const live = (liveCsv || '').split(',').filter(x => /^[0-9a-f]{16}$/.test(x));
  fs.mkdirSync(home, { recursive: true });
  const makeDaily = () => { fs.writeFileSync(dailyFile, newPair().privateKey, { mode: 0o600 }); console.log('Created your daily update key: ' + dailyFile); };
  const makeRecovery = () => {
    const k = newPair(); fs.writeFileSync(recPrivFile, k.privateKey, { mode: 0o600 }); fs.writeFileSync(recPubFile, k.publicKey);
    fs.writeFileSync(path.join(home, 'READ-ME.txt'), 'NexaDesk update keys\r\n\r\nupdate-key.pem is the key that signs your releases. Keep it (back it up in a password manager).\r\nRECOVERY-MOVE-OFFLINE.pem is the spare: move it to a password manager or USB stick and delete it from this PC.\r\nIf update-key.pem is ever lost: START-HERE.bat option 4 (path to the recovery file) (no reinstall needed).\r\n');
    console.log('\n*** RECOVERY KEY CREATED: ' + recPrivFile);
    console.log('*** Move this file to a password manager or USB stick NOW and delete it from this PC. Without it a lost daily key means reinstalling the apps.\n');
  };
  if (!fs.existsSync(dailyFile)) {
    if (recArg) {
      if (!fs.existsSync(recArg)) fail('recovery key file not found: ' + recArg);
      const rid = idOfPem(recArg);
      if (fs.existsSync(recPubFile) && idOfPem(recPubFile) !== rid) fail('that file is not the recovery key this PC knows (' + idOfPem(recPubFile) + ').');
      if (live.length && !live.includes(rid)) fail('the devices do not trust that key (they trust ' + live.join(', ') + ').');
      fs.writeFileSync(recPubFile, crypto.createPublicKey(fs.readFileSync(recArg)).export({ type: 'spki', format: 'pem' }));
      makeDaily();
    } else if (live.length) {
      fail('your daily update key (' + dailyFile + ') is missing, but the devices already trust ' + live.join(', ') + '. Restore that file from your backup, or publish once with the recovery key: START-HERE.bat option 4 (path to RECOVERY-MOVE-OFFLINE.pem)');
    } else { makeDaily(); if (!fs.existsSync(recPubFile)) makeRecovery(); }
  }
  if (!fs.existsSync(recPubFile)) makeRecovery();
  const dailyId = idOfPem(dailyFile), recId = idOfPem(recPubFile);
  if (live.length && !live.includes(dailyId) && !(recArg && live.includes(idOfPem(recArg)))) {
    fail('your daily key is ' + dailyId + ' but the devices trust ' + live.join(', ') + '. Restore the right ~\\.nexadesk\\update-key.pem, or publish once with the recovery key: START-HERE.bat option 4');
  }
  const keys = [spkiOf(fs.readFileSync(dailyFile)), spkiOf(fs.readFileSync(recPubFile))].map(d => d.toString('base64'));
  fs.writeFileSync(keysJs, 'window.NEXA_UPDATE_KEYS = ' + JSON.stringify(keys) + ';   // public keys the app trusts, written by scripts/sign-manifest.js\n');
  console.log('Update keys: daily ' + dailyId + ' + recovery ' + recId);
  console.log('KEYID=' + dailyId); console.log('TRUST=' + dailyId + ',' + recId);
}

const dir = path.join(root, 'signing');   // legacy keys only
const memo = path.join(dir, 'legacy-key-id.txt');
const [, , cmd, arg, arg2] = process.argv;

function keyFiles() {
  let names = []; try { names = fs.readdirSync(dir).filter(n => /\.pem$/i.test(n)); } catch (_) {}
  const out = [];
  for (const n of names) { try { out.push({ file: path.join(dir, n), id: idOfPem(path.join(dir, n)), name: n }); } catch (_) {} }
  return out;
}
function pick(want) {
  const all = keyFiles();
  if (want) return all.find(k => k.id === want) || null;
  return all.find(k => k.name === 'update-private.pem') || null;
}

if (cmd === 'ensure') {
  ensure(arg, arg2 === '-' ? '' : arg2);
} else if (cmd === 'sign2' && arg) {
  const keyFile = arg2 || dailyFile;
  if (!fs.existsSync(keyFile)) fail('key file not found: ' + keyFile);
  fs.writeFileSync(path.join(path.dirname(arg), 'update.sig2'), crypto.sign('sha256', fs.readFileSync(arg), fs.readFileSync(keyFile)).toString('base64'));
  console.log('Signed ' + path.basename(arg) + ' with key ' + idOfPem(keyFile));
} else if (cmd === 'legacy-id') {
  let want = (arg && arg !== 'none') ? arg.trim() : '';
  if (arg === 'none') { try { fs.unlinkSync(memo); } catch (_) {} want = ''; }
  else if (want) { if (!/^[0-9a-f]{16}$/.test(want)) { console.error('ERROR: a key id has 16 hex characters'); process.exit(1); } fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(memo, want); }
  else { try { want = fs.readFileSync(memo, 'utf8').trim(); } catch (_) {} }
  if (arg === 'none') { console.log(''); process.exit(0); }
  const k = pick(want);
  if (!k && want) console.error('NOTE: no key file for ' + want + ' in signing\\ - devices that trust it need one new installer.');
  console.log(k ? k.id : '');
} else if (cmd === 'sign' && arg && arg2) {
  const k = pick(arg2);
  if (!k) { console.error('ERROR: no key file for ' + arg2); process.exit(1); }
  fs.writeFileSync(path.join(path.dirname(arg), 'update.sig'), crypto.sign('sha256', fs.readFileSync(arg), fs.readFileSync(k.file)).toString('base64'));
  console.log('Signed ' + path.basename(arg) + ' for apps that trust key ' + k.id + ' (legacy bridge)');
} else if (cmd === 'keyid' && arg) {
  try { console.log(idOfPem(arg)); } catch (_) { process.exit(1); }
} else {
  console.error('usage: sign-manifest.js ensure [liveTrustIds] [recoveryPem] | sign2 <file> [recoveryPem] | legacy-id [keyId|none] | sign <file> <keyId> | keyid <pem>');
  process.exit(2);
}
