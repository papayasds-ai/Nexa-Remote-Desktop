'use strict';
const { app, BrowserWindow, session, desktopCapturer, shell, Menu, ipcMain, protocol, net, nativeImage, safeStorage, powerSaveBlocker, Tray } = require('electron');
const path = require('path'), fs = require('fs'), crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { pathToFileURL } = require('url');

// The UI is served from a stable origin (app://nexadesk) so localStorage (your ID key) survives OTA bundle swaps.
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
// startup log (%APPDATA%\NexaDesk\startup.log): shows whether the app started, loaded its page, or was closed/quit and why
const slog = m => { try { const f = path.join(app.getPath('userData'), 'startup.log'); try { if (fs.statSync(f).size > 200000) fs.unlinkSync(f); } catch (_) {} fs.appendFileSync(f, new Date().toISOString() + ' ' + m + '\n'); } catch (_) {} };
// "installed" = set up by the Setup (an uninstaller sits next to the exe). Portable builds (EXE or ZIP) never get installer updates.
const isInstalled = () => { if (process.env.PORTABLE_EXECUTABLE_FILE) return false; try { return fs.readdirSync(path.dirname(process.execPath)).some(n => /^Uninstall .*\.exe$/i.test(n)); } catch (_) { return false; } };
slog('start v' + app.getVersion() + (isInstalled() ? '' : ' (portable/unpacked)') + ' args=' + process.argv.slice(1).join(' '));
if (!app.requestSingleInstanceLock()) { slog('another NexaDesk is already running (it holds the lock): this one quits'); app.quit(); process.exit(0); }

let win = null, helper = null, fellBack = false, tray = null, keepTray = false, quitting = false;
const RELEASE_PREFIX = (() => { try { const p = require(path.join(__dirname, 'build-config.json')).releasePrefix; return /^https:\/\/[a-z0-9.-]+\/([\w.-]+\/)*$/i.test(p) ? p : ''; } catch (_) { return ''; } })();
// Backup download locations (GitHub copies of the same files). They are only used when they match these exact shapes, and every
// download must still match the sha256 from the signed update.json.
const MIRROR_WEB_RE = /^https:\/\/raw\.githubusercontent\.com\/[\w.-]+\/[\w.-]+\/HEAD\/ota\/www-\d+\.\d+\.\d+\.zip$/;
const MIRROR_APP_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/download\/ota\/NexaDesk-Setup-\d+\.\d+\.\d+\.exe$/;
// Download with live progress (sent to the window), a stall timeout, and a list of URLs tried in order. Returns a Buffer whose sha256 matches, or null.
async function downloadVerified(urls, sha256, sender, label, stallMs = 25000, maxBytes = 450 * 1024 * 1024) {
  const send = p => { try { if (sender && !sender.isDestroyed()) sender.send('nx-dl-progress', { label, ...p }); } catch (_) {} };
  for (const url of urls) {
    const host = (() => { try { return new URL(url).hostname; } catch (_) { return ''; } })();
    const ac = new AbortController(); let stall = null;
    const arm = () => { clearTimeout(stall); stall = setTimeout(() => ac.abort(), stallMs); };
    try {
      arm();
      const res = await net.fetch(url, { signal: ac.signal, cache: 'no-store' });
      if (!res.ok) { slog(label + ': ' + host + ' answered ' + res.status); clearTimeout(stall); continue; }
      const total = +res.headers.get('content-length') || 0, chunks = [], t0 = Date.now(); let got = 0, last = 0;
      if (total > maxBytes) { slog(label + ': ' + host + ' file too large'); clearTimeout(stall); continue; }
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        arm(); chunks.push(Buffer.from(value)); got += value.length;
        if (got > maxBytes) throw new Error('download larger than allowed');
        const now = Date.now();
        if (now - last > 250) { last = now; send({ host, got, total, speed: got / Math.max(0.001, (now - t0) / 1000) }); }
      }
      clearTimeout(stall);
      const buf = Buffer.concat(chunks);
      if (crypto.createHash('sha256').update(buf).digest('hex') === String(sha256).toLowerCase()) { send({ host, got, total: got, speed: 0, done: true }); return buf; }
      slog(label + ': checksum mismatch from ' + host);
    } catch (e) { slog(label + ': ' + host + ' failed (' + (e && e.message || e) + ')'); }
    clearTimeout(stall);
  }
  return null;
}
const OTA_PREFIX = (() => { try { const p = require(path.join(__dirname, 'build-config.json')).otaPrefix; return /^https:\/\/[a-z0-9.-]+\/([\w.-]+\/)*$/i.test(p) ? p : ''; } catch (_) { return ''; } })();
const CMD = /^(M \d{1,5} \d{1,5}|[DU] [lrm]|W -?\d{1,4}|K \d{1,3} [01] [01]|T \d{1,5}|R -?\d{1,4} -?\d{1,4})$/;

// Refuses a zip whose entries could be written outside the target folder (zip-slip) before anything is extracted.
function zipNamesSafe(buf) {
  try {
    let e = -1; for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; }
    if (e < 0) return false;
    let n = buf.readUInt16LE(e + 10), o = buf.readUInt32LE(e + 16);
    if (n > 5000) return false;
    while (n-- > 0) {
      if (buf.readUInt32LE(o) !== 0x02014b50) return false;
      const nl = buf.readUInt16LE(o + 28), xl = buf.readUInt16LE(o + 30), cl = buf.readUInt16LE(o + 32);
      const name = buf.toString('utf8', o + 46, o + 46 + nl);
      if (/(^|[\\/])\.\.([\\/]|$)|^[\\/]|:|\0/.test(name)) return false;
      o += 46 + nl + xl + cl;
    }
    return true;
  } catch (_) { return false; }
}
// ---------- OTA bundle management ----------
const otaDir = () => path.join(app.getPath('userData'), 'ota');
const statePath = () => path.join(app.getPath('userData'), 'ota-state.json');
const readState = () => { try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch (_) { return {}; } };
const bundledDir = () => path.join(__dirname, 'www');
const verOf = dir => { try { const m = fs.readFileSync(path.join(dir, 'config.js'), 'utf8').match(/NEXA_VERSION\s*=\s*"(\d+\.\d+\.\d+)"/); return m ? m[1] : '0.0.0'; } catch (_) { return '0.0.0'; } };
const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
function currentRoot() {
  const s = readState();
  // use the downloaded bundle only if it lives in our ota folder, is intact, and is newer than the one shipped inside the installer
  if (s.dir && path.dirname(s.dir) === otaDir() && fs.existsSync(path.join(s.dir, 'index.html')) && cmp(verOf(s.dir), verOf(bundledDir())) > 0) return s.dir;
  return bundledDir();
}

ipcMain.handle('nx-ota-install', async (e, o) => {
  try {
    if (!win || e.sender !== win.webContents || process.platform !== 'win32') return { ok: false };
    const { url, version, sha256 } = o || {};
    const list = [url, ...(Array.isArray(o.urls) ? o.urls : [])].filter((u, i, a) => typeof u === 'string' && a.indexOf(u) === i).slice(0, 3);
    const okUrl = u => (OTA_PREFIX && u.startsWith(OTA_PREFIX) && /^www-\d+\.\d+\.\d+\.zip$/.test(u.slice(OTA_PREFIX.length))) || MIRROR_WEB_RE.test(u);
    if (!list.length || !list.every(okUrl)) return { ok: false };
    if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[0-9a-f]{64}$/i.test(sha256 || '')) return { ok: false };
    if (!list.every(u => u.split('/').pop() === `www-${version}.zip`)) return { ok: false };
    const buf = await downloadVerified(list, sha256.toLowerCase(), e.sender, 'Update v' + version, 25000, 60 * 1024 * 1024);
    if (!buf) return { ok: false };
    const base = otaDir(); fs.mkdirSync(base, { recursive: true });
    const zip = path.join(base, `www-${version}.zip`), dir = path.join(base, `www-${version}`);
    if (!zipNamesSafe(buf)) { slog('update zip rejected: unsafe entry names'); return { ok: false }; }
    fs.rmSync(dir, { recursive: true, force: true }); fs.writeFileSync(zip, buf);
    await new Promise((ok, bad) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', 'Expand-Archive -LiteralPath $env:NX_ZIP -DestinationPath $env:NX_DIR -Force'],
      { windowsHide: true, env: { ...process.env, NX_ZIP: zip, NX_DIR: dir } }, err => (err ? bad(err) : ok())));
    if (!fs.existsSync(path.join(dir, 'index.html')) || verOf(dir) !== version) { fs.rmSync(dir, { recursive: true, force: true }); return { ok: false }; }
    fs.writeFileSync(statePath(), JSON.stringify({ version, dir }));
    for (const n of fs.readdirSync(base)) if (n !== `www-${version}`) fs.rmSync(path.join(base, n), { recursive: true, force: true });   // erase old packages
    return { ok: true };
  } catch (_) { return { ok: false }; }
});
// app update: download the installer, check it against the checksum in update.json, run it silently
ipcMain.handle('nx-native-install', async (e, o) => {
  if (!fromOurWindow(e) || !o || typeof o.url !== 'string' || !/^[a-f0-9]{64}$/.test(o.sha256 || '') || !/^\d+\.\d+\.\d+$/.test(o.version || '')) return { ok: false, why: 'bad request' };
  const file = o.url.split('/').pop();
  const list = [o.url, ...(Array.isArray(o.urls) ? o.urls : [])].filter((u, i, a) => typeof u === 'string' && a.indexOf(u) === i).slice(0, 3);
  const okUrl = u => u.split('/').pop() === 'NexaDesk-Setup-' + o.version + '.exe' && ((RELEASE_PREFIX && u.startsWith(RELEASE_PREFIX)) || MIRROR_APP_RE.test(u));
  if (!list.every(okUrl) || !RELEASE_PREFIX || !o.url.startsWith(RELEASE_PREFIX)) return { ok: false, why: 'untrusted source' };
  try {
    const buf = await downloadVerified(list, o.sha256, e.sender, 'App update v' + o.version);
    if (!buf) return { ok: false, why: 'download failed or checksum mismatch' };
    const stage = path.join(app.getPath('userData'), 'updates'); fs.rmSync(stage, { recursive: true, force: true }); fs.mkdirSync(stage, { recursive: true });   // private folder, not the shared temp folder
    const target = path.join(stage, file);
    fs.writeFileSync(target, buf);
    if (crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') !== o.sha256) return { ok: false, why: 'checksum mismatch after saving' };
    // run after this app has exited, so the installer can replace the files
    const child = require('child_process').spawn('cmd.exe', ['/c', 'ping -n 4 127.0.0.1 >nul & "' + target + '" --updated /S --force-run'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    slog('app update v' + o.version + ': installer started, quitting (the installer restarts the app)');
    setTimeout(() => app.quit(), 800);
    return { ok: true };
  } catch (_) { return { ok: false, why: 'failed' }; }
});
// the Portable build must not install the Setup behind your back: it reports no package version, so the app never offers it an installer update
ipcMain.handle('nx-native-version', e => (fromOurWindow(e) && isInstalled() ? app.getVersion() : ''));
// permanent password: encrypted with the Windows account key (DPAPI). Only our own window may use it.
const secretFile = () => path.join(app.getPath('userData'), 'secret.bin');
const vaultFile = () => path.join(app.getPath('userData'), 'vault.bin');
const fromOurWindow = e => !!win && e.sender === win.webContents;
// saved-PC passwords (one JSON text, encrypted with DPAPI)
ipcMain.handle('nx-vault-get', e => {
  if (!fromOurWindow(e) || !safeStorage.isEncryptionAvailable()) return '';
  try { return safeStorage.decryptString(fs.readFileSync(vaultFile())); } catch (_) { return ''; }
});
ipcMain.handle('nx-vault-set', (e, v) => {
  if (!fromOurWindow(e) || !safeStorage.isEncryptionAvailable() || typeof v !== 'string' || v.length > 100000) return false;
  try { fs.writeFileSync(vaultFile(), safeStorage.encryptString(v)); return true; } catch (_) { return false; }
});
ipcMain.handle('nx-secret-get', e => {
  if (!fromOurWindow(e) || !safeStorage.isEncryptionAvailable()) return '';
  try { return safeStorage.decryptString(fs.readFileSync(secretFile())); } catch (_) { return ''; }
});
ipcMain.handle('nx-secret-set', (e, v) => {
  if (!fromOurWindow(e) || !safeStorage.isEncryptionAvailable() || typeof v !== 'string' || v.length > 256) return false;
  try { fs.writeFileSync(secretFile(), safeStorage.encryptString(v)); return true; } catch (_) { return false; }
});
// host comfort (Windows): keep the PC from sleeping while NexaDesk runs, and optionally start with Windows (minimized)
let awakeId = null;
ipcMain.handle('nx-power', (e, o) => {
  if (!fromOurWindow(e) || !o || process.platform !== 'win32') return { ok: false };
  try {
    if (typeof o.keepAwake === 'boolean') {
      if (o.keepAwake && awakeId === null) awakeId = powerSaveBlocker.start('prevent-app-suspension');
      if (!o.keepAwake && awakeId !== null) { powerSaveBlocker.stop(awakeId); awakeId = null; }
    }
    if (typeof o.autostart === 'boolean') {
      if (!app.isPackaged) return { ok: false };
      app.setLoginItemSettings({ openAtLogin: o.autostart, args: ['--autostart'] });
      if (o.autostart) execFile('schtasks.exe', ['/Delete', '/TN', ADMIN_TASK, '/F'], { windowsHide: true }, () => {});   // only one way of starting at sign-in
    }
    if (typeof o.tray === 'boolean') setTray(o.tray);
    return { ok: true, keepAwake: awakeId !== null, autostart: app.isPackaged ? !!app.getLoginItemSettings().openAtLogin : false };
  } catch (_) { return { ok: false }; }
});
// ---- tray: keep hosting after the window is closed ----
function showWin() { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
function setTray(on) {
  keepTray = !!on;
  if (on && !tray) {
    try {
      const img = nativeImage.createFromPath(iconPath()); tray = new Tray(img.isEmpty() ? nativeImage.createFromPath(resPath('icon.ico')) : img.resize({ width: 16, height: 16 }));
      tray.setToolTip('NexaDesk - running in the background');
      tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Open NexaDesk', click: showWin }, { type: 'separator' }, { label: 'Quit NexaDesk', click: () => { quitting = true; app.quit(); } }]));
      tray.on('click', showWin);
    } catch (e) { slog('tray error: ' + e.message); tray = null; keepTray = false; }
  }
  if (!on && tray) { try { tray.destroy(); } catch (_) {} tray = null; }
}
// ---- administrator: Windows blocks input into elevated windows from a normal program (UIPI). Running elevated removes that limit ----
const ADMIN_TASK = 'NexaDesk Autostart';
const elevatedP = process.platform === 'win32' ? new Promise(ok => execFile('fltmc.exe', [], { windowsHide: true }, err => ok(!err))) : Promise.resolve(false);
elevatedP.then(v => slog('administrator rights: ' + v));
const runOk = (file, args, opt) => new Promise(ok => execFile(file, args, { windowsHide: true, ...(opt || {}) }, err => ok(!err)));
ipcMain.on('nx-log', (e, m) => { if (fromOurWindow(e)) slog('ui: ' + m); });
ipcMain.handle('nx-admin', async (e, o) => {
  if (!fromOurWindow(e) || process.platform !== 'win32') return { ok: false };
  o = o || {}; const elevated = await elevatedP;
  if (o.relaunch === true) {
    if (elevated) return { ok: true, elevated: true };
    const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    app.releaseSingleInstanceLock();                     // the elevated copy must be allowed to start
    const ok = await runOk('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', 'try { Start-Process -FilePath $env:NX_EXE -Verb RunAs -ArgumentList "--elevated" -ErrorAction Stop; exit 0 } catch { exit 1 }'], { env: { ...process.env, NX_EXE: exe } });
    if (ok) { slog('restarting with administrator rights'); setTimeout(() => { quitting = true; app.quit(); }, 700); return { ok: true, restarting: true }; }
    app.requestSingleInstanceLock(); return { ok: false, why: 'cancelled' };
  }
  if (typeof o.autostart === 'boolean') {
    if (!elevated || !app.isPackaged) return { ok: false, why: 'needs administrator rights' };
    if (o.autostart) {
      const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
      const ok = await runOk('schtasks.exe', ['/Create', '/TN', ADMIN_TASK, '/TR', '"' + exe + '" --autostart', '/SC', 'ONLOGON', '/RL', 'HIGHEST', '/F']);
      if (!ok) return { ok: false, why: 'task not created' };
      app.setLoginItemSettings({ openAtLogin: false });   // the task replaces the normal autostart entry
    } else await runOk('schtasks.exe', ['/Delete', '/TN', ADMIN_TASK, '/F']);
  }
  const task = await runOk('schtasks.exe', ['/Query', '/TN', ADMIN_TASK]);
  return { ok: true, elevated, task, packaged: app.isPackaged };
});
// ---- file transfer to this PC: the page asks, this side validates the name and size and writes into Downloads\NexaDesk Received ----
const rxFiles = new Map(); let rxSeq = 0;
const closeRx = (id, keep) => { const f = rxFiles.get(id); if (!f) return null; rxFiles.delete(id); try { fs.closeSync(f.fd); } catch (_) {} if (!keep) { try { fs.unlinkSync(f.target); } catch (_) {} return null; } return f; };
ipcMain.handle('nx-file-open', (e, o) => {
  if (!fromOurWindow(e) || !o) return { ok: false, why: 'refused' };
  const size = Number(o.size);
  if (!(size >= 0) || size > 4 * 1024 ** 3) return { ok: false, why: 'file too large (4 GB limit)' };
  if (rxFiles.size) return { ok: false, why: 'another file is still arriving' };
  let name = path.basename(String(o.name || 'file')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 120) || 'file';
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name)) name = '_' + name;
  try {
    const dir = path.join(app.getPath('downloads'), 'NexaDesk Received'); fs.mkdirSync(dir, { recursive: true });
    const ext = path.extname(name), base = path.basename(name, ext); let target = path.join(dir, name), n = 1;
    while (fs.existsSync(target)) target = path.join(dir, base + ' (' + (n++) + ')' + ext);
    const id = ++rxSeq; rxFiles.set(id, { fd: fs.openSync(target, 'wx'), target, got: 0, size });
    return { ok: true, id, name: path.basename(target) };
  } catch (_) { return { ok: false, why: 'cannot write to Downloads' }; }
});
ipcMain.handle('nx-file-write', (e, id, bytes) => {
  const f = rxFiles.get(id); if (!fromOurWindow(e) || !f || !(bytes instanceof Uint8Array || Buffer.isBuffer(bytes))) return false;
  if (f.got + bytes.length > f.size) { closeRx(id, false); return false; }
  try { fs.writeSync(f.fd, bytes); f.got += bytes.length; return true; } catch (_) { closeRx(id, false); return false; }
});
ipcMain.handle('nx-file-close', (e, id, ok) => {
  if (!fromOurWindow(e)) return { ok: false };
  const f = rxFiles.get(id); const complete = !!f && !!ok && f.got === f.size; const kept = closeRx(id, complete);
  if (kept) { slog('file received: ' + kept.target + ' (' + kept.size + ' bytes)'); return { ok: true, path: kept.target }; }
  return { ok: false };
});
ipcMain.on('nx-ota-apply', e => { if (win && e.sender === win.webContents) win.loadURL('app://nexadesk/index.html'); });

// ---------- input injection (Windows) ----------
function helperPath() { return app.isPackaged ? path.join(process.resourcesPath, 'inputhelper.ps1') : path.join(__dirname, 'inputhelper.ps1'); }
function ensureHelper() {
  if (helper || process.platform !== 'win32') return;
  helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath()], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  helper.on('exit', () => { helper = null; });
  helper.stdin.on('error', () => {});
}
// ---- admin input: the app stays a NORMAL process (screen capture fails in an elevated Electron on some PCs), only a tiny PowerShell helper runs
// elevated through a scheduled task (created once with one UAC prompt) and receives the same whitelisted commands over a localhost socket. ----
const INPUT_TASK = 'NexaDesk Input', PD_HELPER = () => path.join(process.env.ProgramData || 'C:\\ProgramData', 'NexaDesk', 'inputhelper.ps1');
let adminSrv = null, adminSock = null, adminToken = '', adminLaunchAt = 0, adminOn = false;
function adminStartServer() {
  if (adminSrv) return;
  adminToken = crypto.randomBytes(24).toString('hex');
  adminSrv = require('net').createServer(sock => {
    let buf = '', ok = false;
    sock.setNoDelay(true); sock.on('error', () => {});
    sock.on('data', d => { if (ok) return; buf += d.toString('utf8'); if (buf.length > 200) return sock.destroy(); const nl = buf.indexOf('\n'); if (nl < 0) return;
      if (buf.slice(0, nl).trim() === adminToken && !adminSock) { ok = true; adminSock = sock; slog('admin input helper connected'); } else sock.destroy(); });
    sock.on('close', () => { if (adminSock === sock) { adminSock = null; slog('admin input helper disconnected'); } });
  });
  adminSrv.on('error', () => { adminSrv = null; });
  adminSrv.listen(0, '127.0.0.1', () => {
    try { const dir = app.getPath('userData'); fs.writeFileSync(path.join(dir, 'helper.port'), String(adminSrv.address().port)); fs.writeFileSync(path.join(dir, 'helper.token'), adminToken); } catch (_) {}
  });
}
function adminLaunch() {
  if (!adminOn || adminSock || Date.now() - adminLaunchAt < 8000) return;
  adminLaunchAt = Date.now(); adminStartServer();
  setTimeout(() => execFile('schtasks.exe', ['/Run', '/TN', INPUT_TASK], { windowsHide: true }, err => { if (err) slog('admin input helper could not be started'); }), 300);
}
if (process.platform === 'win32') execFile('schtasks.exe', ['/Query', '/TN', INPUT_TASK], { windowsHide: true }, err => { adminOn = !err; if (adminOn) { slog('admin input task found'); adminStartServer(); adminLaunch(); } });
ipcMain.handle('nx-admin-input', async (e, o) => {
  if (!fromOurWindow(e) || process.platform !== 'win32') return { ok: false };
  o = o || {};
  if (o.enable === true) {
    const user = (process.env.USERDOMAIN ? process.env.USERDOMAIN + '\\' : '') + (process.env.USERNAME || '');
    if (!/^[\w .\\-]{1,80}$/.test(user)) return { ok: false, why: 'unusual user name' };
    const q = s => String(s).replace(/'/g, "''");
    const script = [
      "$ErrorActionPreference='Stop'",
      "$d=Join-Path $env:ProgramData 'NexaDesk'; New-Item -ItemType Directory -Force $d | Out-Null",
      "Copy-Item -LiteralPath '" + q(helperPath()) + "' -Destination (Join-Path $d 'inputhelper.ps1') -Force",
      "& icacls.exe $d /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' | Out-Null",
      "$a=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"'+(Join-Path $d 'inputhelper.ps1')+'\" -Dir \"" + q(app.getPath('userData')) + "\"')",
      "$p=New-ScheduledTaskPrincipal -UserId '" + q(user) + "' -LogonType Interactive -RunLevel Highest",
      "$s=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)",
      "Register-ScheduledTask -TaskName '" + INPUT_TASK + "' -Action $a -Principal $p -Settings $s -Force | Out-Null"
    ].join('\r\n');
    const b64 = Buffer.from(script, 'utf16le').toString('base64');
    const ok = await runOk('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      "try { Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','" + b64 + "' -ErrorAction Stop; exit 0 } catch { exit 1 }"]);
    const has = await runOk('schtasks.exe', ['/Query', '/TN', INPUT_TASK]);
    if (!ok || !has) return { ok: false, why: 'cancelled or failed' };
    adminOn = true; adminStartServer(); adminLaunchAt = 0; adminLaunch(); slog('admin input enabled');
  } else if (o.enable === false) {
    const ok = await runOk('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      "try { Start-Process -FilePath schtasks.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '/Delete','/TN','" + INPUT_TASK + "','/F' -ErrorAction Stop; exit 0 } catch { exit 1 }"]);
    if (ok) { adminOn = false; try { adminSock && adminSock.destroy(); } catch (_) {} slog('admin input disabled'); }
  }
  const task = await runOk('schtasks.exe', ['/Query', '/TN', INPUT_TASK]);
  return { ok: true, task, connected: !!adminSock, elevated: await elevatedP };
});
ipcMain.on('nx-input', (e, cmd) => {
  if (!win || e.sender !== win.webContents) return;
  if (typeof cmd !== 'string' || !CMD.test(cmd)) return;        // strict whitelist: nothing else reaches PowerShell
  if (adminOn) { adminLaunch(); if (adminSock) { try { adminSock.write(cmd + '\n'); return; } catch (_) {} } }   // elevated helper when it is connected
  ensureHelper(); if (helper) helper.stdin.write(cmd + '\n');
});
ipcMain.on('nx-focus', e => { if (win && e.sender === win.webContents) { win.show(); win.focus(); win.flashFrame(true); } });

function resPath(f) { return app.isPackaged ? path.join(process.resourcesPath, f) : path.join(__dirname, f); }
// PNG for the window (taskbar, title bar, Alt+Tab): loads reliably; icon.ico is used for the .exe itself
function iconPath() { return resPath('icon-256.png'); }
// the taskbar and title bar show the window icon; set it explicitly and record whether the icon file loaded
function applyWindowIcon() {
  let p = iconPath(); let img = nativeImage.createFromPath(p);
  if (img.isEmpty()) { p = resPath('icon.ico'); img = nativeImage.createFromPath(p); }
  if (win && !img.isEmpty()) win.setIcon(img);
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'icon-debug.log'), `${new Date().toISOString()} icon=${p} exists=${fs.existsSync(p)} loaded=${!img.isEmpty()} size=${JSON.stringify(img.getSize())}\n`); } catch (_) {}
}
function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 720, minWidth: 760, minHeight: 520, backgroundColor: '#0b0f17', title: 'NexaDesk', autoHideMenuBar: true, icon: iconPath(),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false }
  });
  Menu.setApplicationMenu(null);
  if (process.argv.includes('--autostart')) win.minimize();   // started by "Start with Windows": stay out of the way
  slog('window created');
  win.once('ready-to-show', () => {
    slog('ready-to-show'); applyWindowIcon(); setTimeout(applyWindowIcon, 1500);
    try {   // make sure the window is really on screen and in front (Windows can leave a new window behind others or minimized)
      if (!process.argv.includes('--autostart')) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); win.setAlwaysOnTop(true); setTimeout(() => { if (win && !win.isDestroyed()) win.setAlwaysOnTop(false); }, 800); }
    } catch (e) { slog('show error: ' + e.message); }
    setTimeout(() => { try { slog('window state: visible=' + win.isVisible() + ' minimized=' + win.isMinimized() + ' focused=' + win.isFocused() + ' bounds=' + JSON.stringify(win.getBounds())); } catch (_) {} }, 2000);
  });
  win.webContents.on('did-finish-load', () => slog('page loaded'));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => slog('page FAILED to load: ' + code + ' ' + desc + ' ' + url));
  win.webContents.on('render-process-gone', (_e, d) => slog('renderer gone: ' + (d && d.reason)));
  win.on('close', e => { if (keepTray && !quitting && process.platform === 'win32') { e.preventDefault(); win.hide(); slog('window hidden to the tray'); } });
  win.on('closed', () => slog('window closed'));
  win.loadURL('app://nexadesk/index.html');
  // safety net: if a downloaded bundle fails to load, drop it and fall back to the bundle shipped in the installer
  win.webContents.on('did-fail-load', (e, code, desc, url, isMain) => {
    if (isMain && !fellBack && currentRoot() !== bundledDir()) { fellBack = true; try { fs.unlinkSync(statePath()); } catch (_) {} win.loadURL('app://nexadesk/index.html'); }
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.on('will-attach-webview', e => e.preventDefault());
  win.on('closed', () => { win = null; });
}

if (process.platform === 'win32') app.setAppUserModelId('com.nexadesk.desktop');   // taskbar groups and icons by this ID
app.whenReady().then(() => {
  protocol.handle('app', async req => {
    let p = decodeURIComponent(new URL(req.url).pathname); if (p === '/' || p === '') p = '/index.html';
    const root = currentRoot(), file = path.normalize(path.join(root, p));
    if (!file.startsWith(root + path.sep)) return new Response('forbidden', { status: 403 });
    const r = await net.fetch(pathToFileURL(file).toString());
    const h = new Headers(r.headers); h.set('Cache-Control', 'no-store');   // never serve a stale UI file after an update
    return new Response(r.body, { status: r.status, headers: h });
  });
  const ses = session.defaultSession;
  ses.setDisplayMediaRequestHandler(async (req, cb) => {
    try { const s = await desktopCapturer.getSources({ types: ['screen'] }); cb(req.audioRequested ? { video: s[0], audio: 'loopback' } : { video: s[0] }); } catch (e) { slog('screen capture failed: ' + (e && e.message || e) + (process.argv.includes('--elevated') ? ' (elevated)' : '')); cb({}); }   // 'loopback' = the sound this PC plays
  });
  ses.setPermissionCheckHandler((wc, perm, origin) => !!origin && origin.startsWith('app://nexadesk') && ['media', 'display-capture', 'clipboard-sanitized-write', 'clipboard-read'].includes(perm));
  ses.setPermissionRequestHandler((wc, perm, cb) => cb(wc.getURL().startsWith('app://nexadesk/') && ['media', 'display-capture', 'clipboard-sanitized-write', 'clipboard-read'].includes(perm)));
  createWindow();
  applyWindowIcon();
});
app.on('second-instance', () => showWin());
app.on('before-quit', () => { quitting = true; slog('quit'); });
app.on('will-quit', () => { if (helper) helper.kill(); try { adminSock && adminSock.destroy(); adminSrv && adminSrv.close(); } catch (_) {} });
app.on('window-all-closed', () => { if (helper) helper.kill(); app.quit(); });
