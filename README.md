# NexaDesk – secure remote access (TeamViewer-style)

## Download NexaDesk

Open the [stable OTA release](https://github.com/papayasds-ai/Nexa-Remote-Desktop/releases/tag/ota) and download the latest version for your device:

- **Windows installer:** `NexaDesk-Setup-<version>.exe`
- **Windows portable:** `NexaDesk-Portable-<version>.exe`
- **Android:** `NexaDesk-<version>.apk`

The stable `ota` release is updated in place, so the link stays the same. The public repository root keeps a copy of each signed web update for download and verification; installed apps retrieve updates from the Cloudflare Worker. Forced updates are announced to connected devices only after the signature and bundle checks pass.

The root `www-<version>.zip`, `update.json`, and `update.sig2` files are the signed web-layer update. The release assets contain the Windows and Android downloads. Never upload signing keys, keystore passwords, server secrets, or notification tokens to this public repository.

Components
- `server/`      Signaling server (Node.js). Blind relay: never sees passwords or screen data. Issues TURN credentials.
- `app/www/`     Shared UI + WebRTC/crypto logic (used by both Windows and Android).
- `desktop/`     Electron wrapper -> Windows EXE (installer + portable). Host AND viewer.
- `android-app/` Capacitor wrapper -> signed APK. Viewer/controller (touch, on-screen keyboard).
- `scripts/`     PowerShell build scripts. `START-HERE.bat` is the only launcher: one menu with every function.

## Quick start (Windows PC)
1. Install Node.js 22.12+ LTS (the build tools need it), Git for Windows, and (for the APK) JDK 17 + Android Studio SDK with `ANDROID_HOME` set.
2. Double-click `START-HERE.bat` -> **2) AUTO full**. First run it logs in to Cloudflare (browser), creates the server, builds
   `output\NexaDesk-Setup.exe` + `NexaDesk.apk`, pushes to GitHub (a sign-in window may appear once) and pings devices.
3. Run the Windows Setup with an account that can elevate to install the machine-wide input service; whether Windows shows a UAC prompt follows that PC's local policy. Portable does not install the service. Install the APK on Android. ID and password are ready immediately.
4. Later: **1) AUTO quick** for UI/logic changes (no rebuild, all devices update in seconds), **2) AUTO full** when native parts change, **3) MANUAL** to choose the version number yourself.

## Hosting the server on Cloudflare (no VPS needed)
`START-HERE.bat` (menu option 8; also runs automatically on the first release): it logs in, deploys `cloudflare/` as a Worker + Durable Object, creates the secret and prints your `wss://…workers.dev` URL. Do NOT upload `server/server.js` to Workers (it is Node-only). Optional Cloudflare TURN: `npx wrangler secret put TURN_KEY_ID` and `TURN_API_TOKEN`.

## Ways to connect across networks
| Method | How |
|---|---|
| ID + password | 9-digit ID + 12-char random password, rotated after every session |
| One-time invite code | Single use, 10-minute expiry (Security tab) |
| Unattended access | Permanent password (12+ chars), no prompt, optional |
| Direct P2P / LAN | WebRTC picks the fastest path automatically (shown in the session bar) |
| STUN hole-punching | Built in |
| TURN relay | **Needed for phones on 5G/4G and most office/hotel networks**, which block direct connections. START-HERE option **T** sets up Cloudflare Realtime TURN once (you copy a key from the Cloudflare dashboard). Self-hosted alternative: coturn (`server/deploy/`) with the Node server. Settings > Server shows whether a relay is active. |

## Security model
- Media + input travel over WebRTC (DTLS-SRTP, AES). The server and TURN only see ciphertext.
- Authentication is an HMAC-SHA256 challenge/response; the password is never sent. The SDP offer/answer is
  also HMAC-signed with the shared secret, so a malicious/compromised signaling server cannot MITM the session.
- Host approval prompt with per-session permissions (control, clipboard); red banner + Disconnect button always visible while shared.
- 5 failed attempts => 10-minute lockout per peer; server-side per-IP request limits and flood control.
- Electron: sandbox, context isolation, strict CSP, and only a whitelist of numeric input commands reaches the local input backends.
- Elevated Windows app control uses a machine-installed input service. Only controller IDs added to the machine-protected allowlist by a Windows administrator can use it; host control consent still applies. Other controllers stay at the normal user integrity level. The service does not grant Windows account administrator rights or interact with Windows' secure desktop.
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
  from the PC.** If the daily key is ever lost: `START-HERE.bat` option 4 (enter that file) publishes one release signed with it, creates a
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
  For a specific old key: `scripts\publish-ota.ps1 -AppKey <key id the device shows>`; `-AppKey none` stops it. Devices whose old key you no
  longer have need one new Setup / APK, once.

## Features (selection)
- **Quality presets** in the session bar (Auto / Smooth / Sharp): Smooth lowers the bitrate for slow connections, Sharp raises it for text.
- **Saved PCs can be renamed** (the pencil button) and the **Recent** list shows your last connections.
- **Lock this PC when a remote session ends** (Security tab, off by default): presses Win+L on the host after a session in which control was allowed.
- **Keep this PC awake**, **Start with Windows (minimized)** and **Keep running in the system tray** (Settings > This PC, Windows app only).
- **Smooth remote control**: 60 fps capture that favours frame rate, an unordered fast channel for mouse moves, newest-move-wins on the host, and a pre-started input helper.
- **Release notes**: whatever you type as notes when publishing is shown to users under Settings > Version.

## Updating the app - two procedures
Everything is published from **START-HERE.bat**. Every update is described by three independent choices:

| Choice | Options | Meaning |
|---|---|---|
| Version number | **AUTO** or **MANUAL** | AUTO (menu 1, 2): the next number above the highest of this folder's `VERSION` and the live version. If `VERSION` is already ahead of what is live, that number is used as it is. MANUAL (menu 3): you type the number; it must be higher than the live one (devices never install a lower or equal version). |
| Scope | **QUICK** or **FULL** | QUICK: UI/logic only (`app\www`), no rebuild, devices update in seconds. FULL: also rebuilds the EXE + APK, needed after changes in `desktop\` or the Android plugins. |
| Delivery | **FORCED** or **NORMAL** | FORCED (default): every device installs it after a short warning, whatever its setting. NORMAL (manual mode answers "n"): each device follows its own setting. |

- **Hands-free auto-release** (menu 4 on / 5 off): every 10 minutes the PC checks the project. `app\www` changed -> quick update; `desktop\` changed -> full update. Version number automatic, forced. Log: `build\auto-release.log`.
- **R) Recovery key**: quick update signed with the offline recovery key, only if the daily key is lost.
- **Why "three modes"?** They are not three update systems but what a device can do: **Forced** (the release is marked forced), **Automatic** (Settings > Version > *Install updates automatically*, on by default: installs when idle) and **Manual** (that setting off: the update is downloaded and waits for the *Install update* button). Forced always wins; nothing ever interrupts a live session except a forced update after its warning.
- **Native packages:** the Windows app downloads the new Setup from your release host and checks its SHA-256 before starting it. Setup requires administrator-level elevation because it installs the machine-wide input service. Windows shows a UAC prompt according to local policy. Android cannot install an APK silently, so the app shows a download link.
- **Elevated input service:** Setup installs the LocalSystem input broker under Program Files and registers it as an automatic Windows service. Opening the controller allowlist editor and updating the native Windows package also require administrator-level elevation; UAC prompts follow Windows policy. After installation, allowlisted remote input does not prompt for UAC; ordinary controllers cannot use the elevated pipe. Portable builds do not install the service.
- Setup builds use `compression: store` and keep only the English locale, so Portable starts faster; Portable still unpacks to `%TEMP%\NexaDeskPortable` on every launch (exclude that folder in Defender, or use the Setup / unpacked ZIP).

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
- **Saved PCs:** stores only the ID and a label. Passwords are never saved.
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
- Windows is the only controllable host. Android and other OSes are viewers. Elevated application windows can be controlled only by allowlisted NexaDesk controller IDs while the host permits control. Windows secure-desktop UAC prompts, Ctrl+Alt+Del, and the lock screen stay protected by Windows.
- No file transfer, multi-monitor picker, audio, or Ctrl+Alt+Del yet.
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
- Changes to native parts (Electron main/preload, input helper, Android plugins) need a new EXE/APK: use option 2.
  UI/logic changes: option 1 is enough.
- Integrity and authenticity: `update.json` is signed (RSA-3072) with your daily or recovery key; the apps reject anything else, so a
  hacked Cloudflare or GitHub account cannot push code to your devices. The bundle and installers must also match the SHA-256 in the
  signed manifest. Keep the keys in your profile / password manager, never on a public repo.
## Repo visibility
Keep the repo private. Source code is not secret from the apps (they can be decompiled), but it does show the protocol and
the build process. Updates no longer depend on GitHub, so a private repo works. GitHub holds the source and the installer
downloads (release `ota`), which only people you give access to can open.

## Pushing this project to GitHub
`.gitignore` already excludes the `signing\` folder (Android keystore, old keys) and server secrets. NEVER upload them to a public repo.
