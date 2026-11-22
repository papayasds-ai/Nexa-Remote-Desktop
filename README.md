# NexaDesk – secure remote access (TeamViewer-style)

Components
- `server/`      Signaling server (Node.js). Blind relay: never sees passwords or screen data. Issues TURN credentials.
- `app/www/`     Shared UI + WebRTC/crypto logic (used by both Windows and Android).
- `desktop/`     Electron wrapper -> Windows EXE (installer + portable). Host AND viewer.
- `android-app/` Capacitor wrapper -> signed APK. Viewer/controller (touch, on-screen keyboard).
- `scripts/`     PowerShell build scripts. **`NexaDesk.bat` is the only launcher**: double-click it for the menu, or run `NexaDesk.bat <command>` (see below).

## Quick start (Windows PC)
1. Install Node.js 22.12+ LTS (the build tools need it), Git for Windows, and (for the APK) JDK 17 + Android Studio SDK with `ANDROID_HOME` set.
2. Double-click `NexaDesk.bat` -> **1) FULL RELEASE**. First run it logs in to Cloudflare (browser), creates the server, builds
   `output\NexaDesk-Setup.exe` + `NexaDesk.apk`, pushes to GitHub (a sign-in window may appear once) and pings devices.
3. Install the EXE / APK. ID and password are there immediately - no server to run, nothing to type.
4. Later: **2) QUICK UPDATE** for UI/logic changes (no rebuild, all devices update instantly), **1)** when native parts change.

## Hosting the server on Cloudflare (no VPS needed)
`NexaDesk.bat server` (menu option 6; also runs automatically on the first release): it logs in, deploys `cloudflare/` as a Worker + Durable Object, creates the secret and prints your `wss://…workers.dev` URL. Do NOT upload `server/server.js` to Workers (it is Node-only). Optional Cloudflare TURN: `npx wrangler secret put TURN_KEY_ID` and `TURN_API_TOKEN`.

## Ways to connect across networks
| Method | How |
|---|---|
| ID + password | 9-digit ID + 12-char random password, rotated after every session |
| One-time invite code | Single use, 10-minute expiry (Security tab) |
| Unattended access | Permanent password (12+ chars), no prompt, optional |
| Direct P2P / LAN | WebRTC picks the fastest path automatically (shown in the session bar) |
| STUN hole-punching | Built in |
| TURN relay (TCP/TLS) | For symmetric NAT / corporate firewalls: set up coturn (`server/deploy/`) and put the secret in `server/config.json` |

## Security model
- Media + input travel over WebRTC (DTLS-SRTP, AES). The server and TURN only see ciphertext.
- Authentication is an HMAC-SHA256 challenge/response; the password is never sent. The SDP offer/answer is
  also HMAC-signed with the shared secret, so a malicious/compromised signaling server cannot MITM the session.
- Host approval prompt with per-session permissions (control, clipboard); red banner + Disconnect button always visible while shared.
- 5 failed attempts => 10-minute lockout per peer; server-side per-IP request limits and flood control.
- Electron: sandbox, context isolation, strict CSP, and only a whitelist of numeric input commands reaches the PowerShell input helper.
- Local connection log (Security tab). Session verification code shown on both ends for voice comparison.

## Build toolchain
No deprecated npm packages are used. Overrides in `desktop/package.json` and `android-app/package.json` pin the old
transitive packages to maintained versions. `android-app/vendor/tar-shim` is a small local wrapper that lets the Capacitor CLI
use the maintained `tar` package; delete it only together with the Capacitor upgrade.

## Keyboard shortcuts and Ctrl+Alt+Del
The phone's **Keys** button sends Task Manager, Alt+Tab, Windows key, Lock PC, Show desktop, Alt+F4, Esc and Print Screen.
Ctrl+Alt+Del is not available: Windows reserves it for the secure desktop, and no normal program can send it, whether it is typed
or injected. Supporting it requires a Windows service configured for software Secure Attention Sequence, which runs with
system privileges. That is a deliberate security decision, not something the app can enable quietly.

## Versions and update keys
- **Two keys, both built into every app:** a *daily key* that signs each release, and a *recovery key*. Either one is accepted.
  The daily key lives in your user profile (`%USERPROFILE%\.nexadesk\update-key.pem`), **not** in the project folder, so a new zip or
  a new project folder can never lose it or create a second one. Back it up once (password manager).
- The first run creates `RECOVERY-MOVE-OFFLINE.pem` in the same folder: **move it to a password manager or USB stick and delete it
  from the PC.** If the daily key is ever lost: `NexaDesk.bat update -RecoveryKey <that file>` publishes one release signed with it, creates a
  new daily key, and every app picks up the new key list by itself - no reinstall.
- Builds and publishes refuse to run when your key does not match what the devices trust (the message says how to fix it), so a
  release that devices would reject is never published.
- Versions go up automatically: **every** build or publish (all menu options and the automatic release) is one patch above the newest
  version the server publishes, so the number never stays behind.
- After every publish a self-test (`scripts\check-release.js`) downloads what the server serves and checks signature, bundle hash and
  installer links like an app would. Devices are only pinged when it passes. Run it any time: `node scripts\check-release.js`.
- Quick updates keep the installer information of the last full release in `update.json`, and apps look at it on every check.
- Apps installed **before** this scheme still demand a signature made with the key they were built with (`update.sig`). If that key
  file is in `signing\` (`update-private.pem` or `retired-*.pem`), publishing signs for those apps too, so they can take the update.
  For a specific old key: `NexaDesk.bat update -AppKey <key id the device shows>`; `-AppKey none` stops it. Devices whose old key you no
  longer have need one new Setup / APK, once.

## Package security
- Every build installs packages with `scripts\npm-secure.js`: exact versions from `package-lock.json` (created on the first run - keep these files),
  `npm audit` on every install with automatic safe fixes, a list of deprecated packages, and a **hard stop** when a high/critical advisory is left in
  something that ships to users (Electron and the other desktop packages, the Android runtime packages, the self-hosted server).
- `NexaDesk.bat security` checks all package folders any time; `NexaDesk.bat security -Fix` also updates packages within their allowed versions.
- **What blocks a build:** only advisories in what really ships to users. For the Windows app that is Electron itself (and any runtime `dependencies`);
  `electron-builder` and its helpers (app-builder-lib, builder-util, dmg-builder, ...) only run on your PC to create the installer, so their advisories are
  listed as information but never stop a build. (Before, they did, and `npm audit fix --force` could only answer by *downgrading* electron-builder.)
- `NexaDesk.bat security -Force` (major upgrades) now refuses any change that would downgrade a package, undoes it, and a package.json that an older forced fix had
  downgraded is restored automatically on the next run.
- "Deprecated" notices that remain come from inside the build tools (not your code) and go away when those tools update; they are listed, not hidden.
- Each package folder has an `.npmrc` that forces the official https registry, keeps the audit on and pins exact versions.

## GitHub and installer hosting
- The GitHub repository is `github-repo.txt` (owner/name), otherwise `papayasds-ai/Nexa-Remote-Desktop`, `papayasds-ai/NexaDesk` or `<your login>/NexaDesk` if one exists, otherwise
  `<your login>/NexaDesk` is created (private). The scripts run `gh auth setup-git` so git can use your GitHub CLI login.
- In-app installer updates need the installers to be downloadable without a login: either `release-host.txt` (public R2 URL; copy it from
  your other PC) or a **public** repository (installers come from its `ota` release). With neither, devices still get instant screen updates
  and you install new Setup / APK files by hand. Make the repo public with: `gh repo edit <owner/name> --visibility public --accept-visibility-change-consequences`.

## Commands (NexaDesk.bat)
| Command | What it does |
|---|---|
| `release` | full release: server + EXE + APK + GitHub + instant update |
| `update [-Force] [-NoBump] [-WithPortable] [-RetryUpload] [-RecoveryKey f] [-AppKey id]` | quick web-layer update |
| `force` | quick update every device must install |
| `windows` / `android` | build the EXE / APK only |
| `server` | create or repair the Cloudflare server |
| `security [-Fix] [-Force]` | package audit |
| `check` | download what the server publishes and verify it like an app would |
| `diagnose` | start the EXE and report what happens |
| `auto-on` / `auto-off` | automatic releases every 10 minutes |
| `migrate [-From folder]` | copy server-url, tokens, keystore (`signing\`) from an older NexaDesk folder into this one |

## New in this version (1.0.17)
- **One launcher:** START-HERE.bat and the six run-*.bat files are replaced by `NexaDesk.bat`. After unzipping a new version run `NexaDesk.bat migrate` once.
- **Security check no longer loops:** see *Package security*.
- **GitHub release is updated in place** (your `ota` release and tag are kept, old files are removed, uploads retry per file, `-RetryUpload` re-sends). The 75 MB
  Portable EXE is no longer uploaded (the in-app updater never used it); add `-WithPortable` if you want it on the release page.
- **Administrator mode (Windows):** Settings > This PC > *Restart as administrator*. Windows ignores injected mouse/keyboard input into admin windows (Task Manager,
  installers) from a normal program; an elevated NexaDesk is not subject to that. Optional: *Start as administrator when I sign in* (a scheduled task, no prompt each time).
  The Windows sign-in / UAC secure screen still cannot be controlled by any normal program.
- **Saved PCs with passwords:** tick *Remember this PC and its password*; tap a PC with a key to connect at once. Stored encrypted (Windows: account key; Android: AES-GCM key
  that cannot be exported). Do not remember one-time invite codes. Removing a saved PC removes its password.
- **Sharper picture:** presets Auto / Smooth / Sharp / **Text**. The picture is never shrunk to save bitrate, frame-rate caps per preset, large screens are capped in
  Smooth/Auto, optional codec choice (VP9 gives the crispest text; H.264 is lightest on the CPU).
- **File transfer to the PC:** *Send file* in the session bar (phone or PC). The PC allows it per session (checkbox in the approval prompt, default in Security tab). Files land in
  `Downloads\NexaDesk Received`, names are sanitized, 4 GB limit, never executed.
- **Sound:** optional *Share this PC's sound*; the viewer gets a Sound on/off button.
- **Keep running in the tray** when the window is closed (Settings > This PC).
- **Connection test + TURN helper** (Settings > Server): checks the signaling server, STUN and TURN like a real session, shows rejected-credential / unreachable-relay errors,
  and *Add* builds the TURN entry from host:port + username + password.
- **TURN credentials refresh** (they expired after 12 h in a long-running app), phone screen stays awake during a session, session timer in the bar.

- **Quality presets** in the session bar (Auto / Smooth / Sharp): Smooth lowers the bitrate for slow connections, Sharp raises it for text.
- **Saved PCs can be renamed** (the pencil button) and the **Recent** list shows your last connections.
- **Lock this PC when a remote session ends** (Security tab, off by default): presses Win+L on the host after a session in which control was allowed.
- **Keep this PC awake** and **Start with Windows (minimized)** (Settings tab, Windows app only; needs app package 1.0.15 or newer).
- App-package updates (EXE) are now offered on every check, not only when the web layer changed.

## Automatic and forced updates
- **Automatic releases (web layer):** run `scripts\install-auto-release.ps1` once. Every 10 minutes the PC checks `app\www`;
  if it changed, the script checks the syntax and publishes a new version. Turn it off with `install-auto-release.ps1 -Remove`.
  Log: `build\auto-release.log`. Anything saved in `app\www` reaches devices within about 10 minutes, so keep it working.
- **Forced updates:** `NexaDesk.bat force` (or `update -Force`) publishes a release that every device installs, even with **Install updates
  automatically** turned off. Devices show a 30-second warning, then disconnect active sessions and install.
- **Automatic checks:** devices check every minute. Without the forced flag, manual mode still waits for the Install button.
- **Native updates:** the Windows app downloads the new Setup from your release host, checks its SHA-256 and installs it silently
  when idle. Android does not allow silent APK installs, so the app shows a download link for the new APK.

## Security review (what was checked)
- Electron runtime upgraded from 31.7.7 (end of support, high-severity advisory) to 45.2.3. The shipped runtime audits clean.
- Window isolation: context isolation on, Node access off, sandbox on, navigation blocked, web security on.
- The Windows helper only accepts fixed command patterns from the page, and the web layer's security policy only allows
  connections to the server origin.
- Updates: signed with a key kept on your PC; the apps reject anything unsigned, tampered or signed by another key.
- Not hidden: the app shows a banner and asks for consent while it is controlling a PC. This is deliberate.
- Open items: the EXE and APK are not signed by a trusted certificate authority (Windows SmartScreen and Play Protect will warn);
  the permanent password is kept in the app's local storage (encrypting it with the OS keystore is the next step);
  unattended mode lets anyone with the permanent password control the PC without a prompt, so keep it off unless needed;
  the build tools still have moderate advisories (build-time only, never shipped).

## New features and the setup they need
- **App updates (Windows, silent):** the installer is uploaded to a public Cloudflare R2 bucket and listed in the signed
  manifest. The app downloads it, checks the checksum from update.json, then runs it with `/S` after closing.
  One-time setup: create the R2 bucket `nexadesk-releases` in the Cloudflare dashboard, enable public access, and write its
  public address (for example `https://pub-xxxx.r2.dev`) into `release-host.txt`. Installers are about 75 MB, which is why R2 is
  used (static assets are limited to 25 MB per file). Test this on a Windows PC before relying on it.
- **Android app updates:** Android does not allow silent APK installs, so the app shows a download link. Installing the APK
  is still one tap.
- **Code signing (Windows):** put your certificate at `signing\codesign.pfx` and its password in `signing\codesign-password.txt`.
  Without them the EXE stays unsigned and Windows will warn people.
- **Automatic native builds:** `install-auto-release.ps1` now also runs the full release when files in `desktop\` or the
  Android project's `package.json` change.
- **Quick keys:** choose which shortcut buttons appear under the screen (Security tab).
- **Get PC clipboard:** copies the PC's clipboard to the phone on request. The PC must allow clipboard sharing.
- **Switch PC:** ends the current session and fills in the next saved PC.
- **Session details:** frame rate and connection type are shown during a session, and the log records session length.
- **Permanent password (Windows):** encrypted with the Windows account key. Android keeps it in local storage for now.

## Not included
- **Ctrl+Alt+Del:** Windows allows only a privileged Windows service to send it. That service would run with system rights, so
  it needs your explicit approval and testing on your PC before it is built.
- **Several PCs at once:** the app controls one PC at a time. Use Switch PC to move between them.
- **Continuous clipboard sync:** the clipboard is shared on request only, so copied passwords are not sent automatically.

## Honest limitations (v1)
- Windows is the only controllable host. Android and other OSes are viewers. Elevated/UAC windows and the lock screen can't be controlled unless the app runs as administrator.
- No multi-monitor picker, no file download FROM the PC, no Ctrl+Alt+Del yet.
- Not independently security-audited. EXE/APK are unsigned by a trusted CA: Windows SmartScreen will warn until you sign with a code-signing certificate.
- Passwords are stored in the app's local storage; use OS disk encryption.

## Updates (OTA) - how it works
- Update files (`update.json`, `www-<version>.zip`) are served by your Cloudflare Worker from `cloudflare/public/`.
  Every release replaces them; the Worker is redeployed with each release. Apps fetch them from the server's own https address.
- `update.json` also carries the server address, so apps configure themselves (no manual setup, no local server).
- After publishing, the server pings every online device over its live connection: they download, verify (SHA-256) and apply
  the new UI/logic immediately - never in the middle of a remote session. Devices also re-check every minute and whenever you open the app.
- Android: the bundle is applied by the Capgo updater with automatic rollback if the new bundle fails to boot. Windows: bundle unpacked
  to the user profile, falls back to the installer's bundle if it fails to load.
- Changes to native parts (Electron main/preload, input helper, Android plugins) need a new EXE/APK: use option 1.
  UI/logic changes: option 2 is enough.
- Integrity and authenticity: `update.json` is signed (RSA-3072) with your daily or recovery key; the apps reject anything else, so a
  hacked Cloudflare or GitHub account cannot push code to your devices. The bundle and installers must also match the SHA-256 in the
  signed manifest. Keep the keys in your profile / password manager, never on a public repo.
- Automatic vs manual: Settings -> Version has **Install updates automatically**. On (default): updates are downloaded and applied
  when the app is idle. Off: the app still downloads a pushed release and shows **Install update**, which you press yourself.
  Manual **Check for updates** always works. Updates never interrupt a live session.

## Repo visibility
Keep the repo private. Source code is not secret from the apps (they can be decompiled), but it does show the protocol and
the build process. Updates no longer depend on GitHub, so a private repo works. GitHub holds the source and the installer
downloads (release `ota`), which only people you give access to can open.

## Pushing this project to GitHub
`.gitignore` already excludes the `signing\` folder (Android keystore, old keys) and server secrets. NEVER upload them to a public repo.

## New in 1.0.94+
- **Pinch to zoom** on the phone (two fingers; keep moving them to pan), Zoom button, Ctrl+wheel / trackpad pinch on a computer.
- Screenshot button (saves the remote picture as PNG), F1-F12 and more shortcut keys, a menu button that hides all controls, haptic feedback, and a "connection unstable" notice with a 30 s recovery window.
- Security: installer staged in a private folder and re-checked, download size limits, zip path check, tighter permissions, login-guess limits on the PC and the server, server memory/size limits, release version can no longer go backwards.
- **Cloud build:** option 1 builds the large Windows installers on GitHub (scripts\cloud-windows.ps1 + .github\workflows\build-windows.yml), so nothing big is uploaded from your PC. Needs a PUBLIC repo and no release-host.txt; delete cloud-windows.txt to build locally. If the cloud build fails it falls back to the local build.
