'use strict';
const { app, BrowserWindow, session, desktopCapturer, shell, Menu, ipcMain, protocol, net, nativeImage, safeStorage, powerSaveBlocker, Tray, clipboard } = require('electron');
const path = require('path'), fs = require('fs'), crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const pipeNet = require('net');
const { pathToFileURL } = require('url');

// The UI is served from a stable origin (app://nexadesk) so localStorage (your ID key) survives OTA bundle swaps.
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
// startup log (%APPDATA%\NexaDesk\startup.log): shows whether the app started, loaded its page, or was closed/quit and why
const slog = m => { try { const f = path.join(app.getPath('userData'), 'startup.log'); try { if (fs.statSync(f).size > 200000) fs.unlinkSync(f); } catch (_) {} fs.appendFileSync(f, new Date().toISOString() + ' ' + m + '\n'); } catch (_) {} };
// "installed" = set up by the Setup (an uninstaller sits next to the exe). Portable builds (EXE or ZIP) never get installer updates.
const isInstalled = () => { if (process.env.PORTABLE_EXECUTABLE_FILE) return false; try { return fs.readdirSync(path.dirname(process.execPath)).some(n => /^Uninstall .*\.exe$/i.test(n)); } catch (_) { return false; } };
const T0 = (() => { try { return process.getCreationTime() || 0; } catch (_) { return 0; } })();   // when Windows created this process
const sinceT0 = () => (T0 ? ' +' + (Date.now() - T0) + 'ms since process creation' : '');
slog('start v' + app.getVersion() + sinceT0() + (isInstalled() ? '' : (process.env.PORTABLE_EXECUTABLE_FILE ? ' (portable EXE)' : ' (unpacked folder)')) + ' args=' + process.argv.slice(1).join(' '));
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { slog('another NexaDesk is already running (it holds the lock): this one quits'); app.exit(0); }
// keep the window at full speed when it is minimized/covered (a host must stay responsive), and skip Windows' occlusion tracking
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,MediaRouter,OptimizationHints,Translate,AutofillServerCommunication');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-default-apps');
app.commandLine.appendSwitch('no-first-run');

let win = null, helper = null, fellBack = false;
const RELEASE_PREFIX = (() => { try { const p = require(path.join(__dirname, 'build-config.json')).releasePrefix; return /^https:\/\/[a-z0-9.-]+\/$/i.test(p) ? p : ''; } catch (_) { return ''; } })();
const OTA_PREFIX = (() => { try { const p = require(path.join(__dirname, 'build-config.json')).otaPrefix; return /^https:\/\/[a-z0-9.-]+\/$/i.test(p) ? p : ''; } catch (_) { return ''; } })();
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const CMD = /^(M \d{1,5} \d{1,5}|[DU] [lrm]|W -?\d{1,4}|K \d{1,3} [01] [01]|T \d{1,5}|R -?\d{1,4} -?\d{1,4})$/;

// streaming download with progress events to the UI (bytes received / total / phase)
function sendProg(o) { try { if (win && !win.isDestroyed()) win.webContents.send('nx-progress', o); } catch (_) {} }
async function download(url, kind, opts) {
  const res = await net.fetch(url, opts || {}); if (!res.ok) throw new Error('HTTP ' + res.status);
  const total = Number(res.headers.get('content-length')) || 0, chunks = []; let got = 0, last = 0;
  const rd = res.body.getReader();
  for (;;) {
    const { done, value } = await rd.read(); if (done) break;
    chunks.push(value); got += value.length;
    const now = Date.now(); if (now - last > 120) { last = now; sendProg({ kind, phase: 'download', received: got, total }); }
  }
  sendProg({ kind, phase: 'download', received: got, total: total || got });
  return Buffer.concat(chunks);
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
    if (!OTA_PREFIX || typeof url !== 'string' || !url.startsWith(OTA_PREFIX) || !/^www-\d+\.\d+\.\d+\.zip$/.test(url.slice(OTA_PREFIX.length))) return { ok: false };
    if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[0-9a-f]{64}$/i.test(sha256 || '')) return { ok: false };
    const buf = await download(url, 'ota', { cache: 'no-store' });
    sendProg({ kind: 'ota', phase: 'verify' });
    if (crypto.createHash('sha256').update(buf).digest('hex') !== sha256.toLowerCase()) { sendProg({ kind: 'ota', phase: 'error' }); return { ok: false }; }
    sendProg({ kind: 'ota', phase: 'install' });
    const base = otaDir(); fs.mkdirSync(base, { recursive: true });
    const zip = path.join(base, `www-${version}.zip`), dir = path.join(base, `www-${version}`);
    fs.rmSync(dir, { recursive: true, force: true }); fs.writeFileSync(zip, buf);
    fs.mkdirSync(dir, { recursive: true });
    await new Promise((ok, bad) => execFile('tar.exe', ['-xf', zip, '-C', dir], { windowsHide: true }, err => (err ? bad(err) : ok())))
      .catch(() => new Promise((ok, bad) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', 'Expand-Archive -LiteralPath $env:NX_ZIP -DestinationPath $env:NX_DIR -Force'],
        { windowsHide: true, env: { ...process.env, NX_ZIP: zip, NX_DIR: dir } }, err => (err ? bad(err) : ok()))));
    if (!fs.existsSync(path.join(dir, 'index.html')) || verOf(dir) !== version) { fs.rmSync(dir, { recursive: true, force: true }); return { ok: false }; }
    fs.writeFileSync(statePath(), JSON.stringify({ version, dir })); sendProg({ kind: 'ota', phase: 'done' });
    for (const n of fs.readdirSync(base)) if (n !== `www-${version}`) fs.rmSync(path.join(base, n), { recursive: true, force: true });   // erase old packages
    return { ok: true };
  } catch (_) { sendProg({ kind: 'ota', phase: 'error' }); return { ok: false }; }
});
// app update: the installer is downloaded + checked in the background as soon as it is announced (nx-native-stage),
// so when the update is applied it only has to start it (no waiting for a 100 MB download at the last second)
let nativeStaged = null, stagingP = null;
function nativeOk(e, o) {
  if (!fromOurWindow(e) || !o || typeof o.url !== 'string' || !/^[a-f0-9]{64}$/.test(o.sha256 || '') || !/^\d+\.\d+\.\d+$/.test(o.version || '')) return 'bad request';
  const file = o.url.split('/').pop();
  if (!RELEASE_PREFIX || !o.url.startsWith(RELEASE_PREFIX) || file !== 'NexaDesk-Setup-' + o.version + '.exe') return 'untrusted source';
  return '';
}
function stageNative(o) {
  const target = path.join(app.getPath('temp'), o.url.split('/').pop());
  if (nativeStaged && nativeStaged.sha === o.sha256 && fs.existsSync(target)) return Promise.resolve(target);
  if (stagingP && stagingP.sha === o.sha256) return stagingP.p;
  const p = (async () => {
    const buf = await download(o.url, 'native');
    sendProg({ kind: 'native', phase: 'verify' });
    if (crypto.createHash('sha256').update(buf).digest('hex') !== o.sha256) { sendProg({ kind: 'native', phase: 'error' }); throw new Error('checksum mismatch'); }
    fs.writeFileSync(target, buf); nativeStaged = { sha: o.sha256 };
    sendProg({ kind: 'native', phase: 'done' });
    return target;
  })();
  stagingP = { sha: o.sha256, p }; p.then(() => { stagingP = null; }, () => { stagingP = null; });
  return p;
}
ipcMain.handle('nx-native-stage', async (e, o) => {
  const bad = nativeOk(e, o); if (bad) return { ok: false, why: bad };
  try { await stageNative(o); return { ok: true }; } catch (er) { sendProg({ kind: 'native', phase: 'error' }); return { ok: false, why: er.message || 'failed' }; }
});
ipcMain.handle('nx-native-install', async (e, o) => {
  const bad = nativeOk(e, o); if (bad) return { ok: false, why: bad };
  try {
    let target; try { target = await stageNative(o); } catch (er) { sendProg({ kind: 'native', phase: 'error' }); return { ok: false, why: 'download failed (' + er.message + ')' }; }
    sendProg({ kind: 'native', phase: 'install' });
    // run after this app has exited, so the installer can replace the files (it restarts the app by itself)
    const child = spawn('cmd.exe', ['/c', 'ping -n 2 127.0.0.1 >nul & "' + target + '" --updated /S --force-run'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    slog('app update v' + o.version + ': installer started, quitting (the installer restarts the app)');
    setTimeout(() => app.quit(), 300);
    return { ok: true };
  } catch (_) { return { ok: false, why: 'failed' }; }
});
// the Portable build must not install the Setup behind your back: it reports no package version, so the app never offers it an installer update
ipcMain.handle('nx-native-version', e => (fromOurWindow(e) && isInstalled() ? app.getVersion() : ''));
// permanent password: encrypted with the Windows account key (DPAPI). Only our own window may use it.
const secretFile = () => path.join(app.getPath('userData'), 'secret.bin');
const fromOurWindow = e => !!win && e.sender === win.webContents;
ipcMain.handle('nx-clip-read', e => (fromOurWindow(e) ? String(clipboard.readText() || '').slice(0, 100000) : ''));   // auto clipboard sync: works while the window is unfocused
ipcMain.handle('nx-secret-get', e => {
  if (!fromOurWindow(e) || !safeStorage.isEncryptionAvailable()) return '';
  try { return safeStorage.decryptString(fs.readFileSync(secretFile())); } catch (_) { return ''; }
});
ipcMain.handle('nx-secret-set', (e, v) => {
  if (!fromOurWindow(e) || !safeStorage.isEncryptionAvailable() || typeof v !== 'string' || v.length > 256) return false;
  try { fs.writeFileSync(secretFile(), safeStorage.encryptString(v)); return true; } catch (_) { return false; }
});
ipcMain.handle('nx-manage-admins', async e => {
  if (!fromOurWindow(e) || process.platform !== 'win32') return { ok: false, why: 'Windows Setup is required.' };
  const broker = inputBrokerPath();
  if (!broker || !fs.existsSync(broker)) return { ok: false, why: 'The elevated input service is not included in this build.' };
  const command = "$p=Start-Process -FilePath $env:NEXA_BROKER -ArgumentList @('--manage-admins') -Verb RunAs -PassThru -Wait; exit $p.ExitCode";
  return await new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true, env: { ...process.env, NEXA_BROKER: broker }
  }, err => resolve(err ? { ok: false, why: 'Windows administrator approval was canceled or the settings window failed.' } : { ok: true })));
});
// system tray (optional, Settings > This PC): closing the window hides it instead of quitting, so this PC stays reachable
let tray = null, trayOn = false, quitting = false;
function showWin() { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } }
function setTray(on) {
  trayOn = !!on;
  if (trayOn && !tray) {
    let img = nativeImage.createFromPath(iconPath()); if (!img.isEmpty()) img = img.resize({ width: 16, height: 16 });
    tray = new Tray(img); tray.setToolTip('NexaDesk');
    tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Open NexaDesk', click: showWin }, { type: 'separator' }, { label: 'Quit NexaDesk', click: () => { quitting = true; app.quit(); } }]));
    tray.on('click', showWin);
  } else if (!trayOn && tray) { tray.destroy(); tray = null; showWin(); }
}
// host comfort (Windows): keep the PC from sleeping while NexaDesk runs, and optionally start with Windows (minimized)
let awakeId = null;
ipcMain.handle('nx-power', (e, o) => {
  if (!fromOurWindow(e) || !o || process.platform !== 'win32') return { ok: false };
  try {
    if (typeof o.keepAwake === 'boolean') {
      if (o.keepAwake && awakeId === null) awakeId = powerSaveBlocker.start('prevent-app-suspension');
      if (!o.keepAwake && awakeId !== null) { powerSaveBlocker.stop(awakeId); awakeId = null; }
    }
    if (typeof o.tray === 'boolean') setTray(o.tray);
    if (typeof o.autostart === 'boolean') {
      if (!app.isPackaged) return { ok: false };
      app.setLoginItemSettings({ openAtLogin: o.autostart, args: ['--autostart'] });
    }
    return { ok: true, keepAwake: awakeId !== null, autostart: app.isPackaged ? !!app.getLoginItemSettings().openAtLogin : false, tray: trayOn };
  } catch (_) { return { ok: false }; }
});
ipcMain.on('nx-ota-apply', e => { if (win && e.sender === win.webContents) win.loadURL('app://nexadesk/index.html'); });

// ---------- input injection (Windows) ----------
let activeControlPeer = '', controlAllowed = false, brokerSocket = null, brokerMode = 'standard';
let brokerRetry = null, brokerEpoch = 0, brokerLastNotice = '';
const heldKeys = new Map(), heldButtons = new Set();
function helperPath() { return app.isPackaged ? path.join(process.resourcesPath, 'inputhelper.ps1') : path.join(__dirname, 'inputhelper.ps1'); }
function inputBrokerPath() {
  if (process.platform !== 'win32') return '';
  let name = '';
  try { name = require(path.join(__dirname, 'build-config.json')).inputBrokerName || ''; } catch (_) {}
  if (!/^NexaDeskInputBroker-\d+\.\d+\.\d+\.exe$/.test(name)) return '';
  return app.isPackaged ? path.join(process.resourcesPath, 'inputbroker', name) : path.join(__dirname, 'inputbroker', 'dist', name);
}
function closeBrokerPipe() {
  if (brokerRetry) { clearTimeout(brokerRetry); brokerRetry = null; }
  const socket = brokerSocket; brokerSocket = null; brokerMode = 'standard';
  if (socket) { socket.nexaIntentional = true; try { socket.destroy(); } catch (_) {} }
}
function scheduleBrokerRetry(epoch, delay = 15000) {
  if (brokerRetry) clearTimeout(brokerRetry);
  brokerRetry = setTimeout(() => {
    brokerRetry = null;
    if (epoch === brokerEpoch && controlAllowed && activeControlPeer) connectBroker(epoch, activeControlPeer);
  }, delay);
}
function connectBroker(epoch, peer) {
  const broker = inputBrokerPath();
  if (!broker || !fs.existsSync(broker) || process.platform !== 'win32') return;
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Diagnostics.Process]::GetCurrentProcess().SessionId'], { windowsHide: true }, (err, stdout) => {
    if (epoch !== brokerEpoch || !controlAllowed || peer !== activeControlPeer) return;
    const sessionId = Number(String(stdout || '').trim());
    if (err || !Number.isInteger(sessionId) || sessionId <= 0) { scheduleBrokerRetry(epoch); return; }
    const socket = pipeNet.createConnection({ path: `\\\\.\\pipe\\NexaDesk.Input.${sessionId}` });
    brokerSocket = socket; brokerMode = 'pending';
    let buffer = '', gotReply = false;
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      if (epoch !== brokerEpoch || !controlAllowed || peer !== activeControlPeer) { socket.nexaIntentional = true; socket.destroy(); return; }
      socket.write(`C ${peer}\n`);
    });
    socket.on('data', data => {
      buffer += data;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
        if (!gotReply) {
          gotReply = true;
          if (epoch !== brokerEpoch || !controlAllowed || peer !== activeControlPeer) { socket.nexaIntentional = true; socket.destroy(); return; }
          if (line === 'ADMIN') {
            brokerMode = 'admin'; brokerLastNotice = '';
            slog('elevated input enabled for allowlisted controller ' + peer);
          } else {
            brokerMode = 'standard';
            if (brokerLastNotice !== peer + ':standard') slog('controller ' + peer + ' is not on the elevated input allowlist; using standard input');
            brokerLastNotice = peer + ':standard';
            socket.nexaIntentional = true; socket.destroy(); scheduleBrokerRetry(epoch);
          }
        } else if (line === 'REVOKED') {
          brokerMode = 'standard'; brokerLastNotice = peer + ':revoked';
          slog('elevated input revoked for controller ' + peer);
          socket.nexaIntentional = true; socket.destroy(); scheduleBrokerRetry(epoch);
          return;
        }
      }
    });
    socket.on('error', () => {
      if (brokerSocket === socket) { brokerSocket = null; brokerMode = 'standard'; }
      if (!socket.nexaIntentional && epoch === brokerEpoch && controlAllowed && activeControlPeer) {
        if (brokerLastNotice !== 'unavailable') slog('elevated input service unavailable; standard input remains active');
        brokerLastNotice = 'unavailable'; scheduleBrokerRetry(epoch);
      }
    });
    socket.on('close', () => {
      if (brokerSocket === socket) { brokerSocket = null; brokerMode = 'standard'; }
      if (!socket.nexaIntentional && epoch === brokerEpoch && controlAllowed && activeControlPeer) scheduleBrokerRetry(epoch);
    });
  });
}
function setHostControl(peer, allowed) {
  releaseHeldInput();
  brokerEpoch++;
  closeBrokerPipe();
  activeControlPeer = peer || ''; controlAllowed = !!allowed;
  brokerLastNotice = '';
  if (controlAllowed && activeControlPeer) {
    ensureHelper();                         // immediate normal input while the service pipe connects
    connectBroker(brokerEpoch, activeControlPeer);
  } else {
    if (pendTimer) { clearTimeout(pendTimer); pendTimer = null; }
    pendMove = null;
  }
}
ipcMain.on('nx-host-session', (e, peer, allowed) => {
  if (!fromOurWindow(e) || process.platform !== 'win32' || typeof allowed !== 'boolean') return;
  if (peer === null && !allowed) return setHostControl('', false);
  if (typeof peer !== 'string' || !/^\d{9}$/.test(peer)) return;
  setHostControl(peer, allowed);
});
function ensureHelper() {
  if (helper || process.platform !== 'win32') return;
  helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath()], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  helper.on('exit', () => { helper = null; });
  helper.stdin.on('error', () => {});
  helper.stderr.setEncoding('utf8');
  let inputErr = '';
  helper.stderr.on('data', chunk => {
    inputErr += chunk;
    const lines = inputErr.split(/\r?\n/); inputErr = lines.pop() || '';
    for (const line of lines) if (/^NX_INPUT_(REJECTED|ERROR)\|/.test(line)) slog('input helper: ' + line.slice(0, 160));
  });
}
// Mouse moves are absolute, so only the newest one matters: the first goes out at once, and a burst (for example after a network hiccup)
// collapses into one jump at most every 8 ms instead of being replayed slowly. Clicks and keys flush the pending move first (order kept).
let lastMove = 0, pendMove = null, pendTimer = null;
function writeInput(c) {
  if (!controlAllowed || !activeControlPeer) return;
  if (brokerMode === 'admin' && brokerSocket && !brokerSocket.destroyed) brokerSocket.write(c + '\n');
  else if (helper) helper.stdin.write(c + '\n');
  const p = c.split(' ');
  if (p[0] === 'D') heldButtons.add(p[1]);
  else if (p[0] === 'U') heldButtons.delete(p[1]);
  else if (p[0] === 'K') {
    const id = p[1] + ' ' + p[3];
    if (p[2] === '1') heldKeys.set(id, `K ${p[1]} 0 ${p[3]}`); else heldKeys.delete(id);
  }
}
function releaseHeldInput() {
  for (const keyUp of [...heldKeys.values()]) writeInput(keyUp);
  heldKeys.clear();
  for (const button of [...heldButtons]) writeInput(`U ${button}`);
  heldButtons.clear();
}
function writeMove(c) { lastMove = Date.now(); writeInput(c); }
function flushMove() { if (pendTimer) { clearTimeout(pendTimer); pendTimer = null; } if (pendMove) { writeMove(pendMove); pendMove = null; } }
ipcMain.on('nx-input', (e, cmd) => {
  if (!win || e.sender !== win.webContents) return;
  if (typeof cmd !== 'string' || !CMD.test(cmd)) return;        // strict whitelist: nothing else reaches PowerShell
  if (!controlAllowed || !activeControlPeer) return;
  ensureHelper();
  if (cmd.charCodeAt(0) !== 77) { flushMove(); writeInput(cmd); return; }   // not a move
  const dt = Date.now() - lastMove;
  if (dt >= 8 && !pendTimer) return writeMove(cmd);
  pendMove = cmd;
  if (!pendTimer) pendTimer = setTimeout(() => { pendTimer = null; if (pendMove) { writeMove(pendMove); pendMove = null; } }, Math.max(1, 8 - dt));
});
ipcMain.on('nx-warm', e => { if (win && e.sender === win.webContents) ensureHelper(); });   // start the input helper before the first mouse move
ipcMain.on('nx-focus', e => { if (win && e.sender === win.webContents) { win.show(); win.focus(); win.flashFrame(true); } });

function resPath(f) { return app.isPackaged ? path.join(process.resourcesPath, f) : path.join(__dirname, f); }
// PNG for the window (taskbar, title bar, Alt+Tab): loads reliably; icon.ico is used for the .exe itself
function iconPath() { return resPath('icon-256.png'); }
// the taskbar and title bar show the window icon; set it explicitly and record whether the icon file loaded
function applyWindowIcon() {
  let p = iconPath(); let img = nativeImage.createFromPath(p);
  if (img.isEmpty()) { p = resPath('icon.ico'); img = nativeImage.createFromPath(p); }
  if (win && !img.isEmpty()) win.setIcon(img);
}
function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 720, minWidth: 760, minHeight: 520, backgroundColor: '#0b0f17', title: 'NexaDesk', autoHideMenuBar: true, icon: iconPath(),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false, backgroundThrottling: false }
  });
  Menu.setApplicationMenu(null);
  if (process.argv.includes('--autostart')) win.minimize();   // started by "Start with Windows": stay out of the way
  slog('window created');
  win.once('ready-to-show', () => {
    slog('ready-to-show' + sinceT0()); applyWindowIcon(); setTimeout(applyWindowIcon, 1500);
    try {   // make sure the window is really on screen and in front (Windows can leave a new window behind others or minimized)
      if (!process.argv.includes('--autostart')) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); win.setAlwaysOnTop(true); setTimeout(() => { if (win && !win.isDestroyed()) win.setAlwaysOnTop(false); }, 800); }
    } catch (e) { slog('show error: ' + e.message); }
    setTimeout(() => { try { slog('window state: visible=' + win.isVisible() + ' minimized=' + win.isMinimized() + ' focused=' + win.isFocused() + ' bounds=' + JSON.stringify(win.getBounds())); } catch (_) {} }, 2000);
  });
  win.webContents.on('did-finish-load', () => slog('page loaded'));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => slog('page FAILED to load: ' + code + ' ' + desc + ' ' + url));
  win.webContents.on('render-process-gone', (_e, d) => { slog('renderer gone: ' + (d && d.reason)); setHostControl('', false); });
  win.on('close', e => { if (trayOn && !quitting) { e.preventDefault(); win.hide(); } });   // tray mode: closing the window only hides it
  win.on('session-end', () => { quitting = true; });
  win.loadURL('app://nexadesk/index.html');
  // safety net: if a downloaded bundle fails to load, drop it and fall back to the bundle shipped in the installer
  win.webContents.on('did-fail-load', (e, code, desc, url, isMain) => {
    if (isMain && !fellBack && currentRoot() !== bundledDir()) { fellBack = true; try { fs.unlinkSync(statePath()); } catch (_) {} win.loadURL('app://nexadesk/index.html'); }
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.on('closed', () => { setHostControl('', false); slog('window closed'); win = null; });
}

if (process.platform === 'win32') app.setAppUserModelId('com.nexadesk.desktop');   // taskbar groups and icons by this ID
app.whenReady().then(() => {
  if (!gotLock) return;
  protocol.handle('app', async req => {
    let p = decodeURIComponent(new URL(req.url).pathname); if (p === '/' || p === '') p = '/index.html';
    const root = currentRoot(), file = path.normalize(path.join(root, p));
    if (!file.startsWith(root + path.sep)) return new Response('forbidden', { status: 403 });
    try {
      const buf = await fs.promises.readFile(file);
      return new Response(buf, { status: 200, headers: { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' } });
    } catch (_) { return new Response('not found', { status: 404 }); }
  });
  const ses = session.defaultSession;
  ses.setDisplayMediaRequestHandler(async (req, cb) => {
    try { const s = await desktopCapturer.getSources({ types: ['screen'] }); cb({ video: s[0] }); } catch (_) { cb({}); }
  });
  ses.setPermissionRequestHandler((wc, perm, cb) => cb(['media', 'display-capture', 'clipboard-sanitized-write', 'clipboard-read'].includes(perm)));
  createWindow();
});
app.on('second-instance', showWin);
app.on('before-quit', () => { quitting = true; setHostControl('', false); if (helper && helper.stdin) helper.stdin.end(); slog('quit'); });
app.on('window-all-closed', () => { setHostControl('', false); if (helper && helper.stdin) helper.stdin.end(); app.quit(); });
