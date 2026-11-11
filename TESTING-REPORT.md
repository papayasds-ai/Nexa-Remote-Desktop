# NexaDesk testing report

Date: 2026-11-11

## Checks actually performed

- Inspected the supplied project archive (82 entries; existing Electron, Android/Capacitor, WebRTC, Node signaling, Cloudflare Worker, OTA and PowerShell publishing components).
- `node --check app/www/app.js` — passed.
- `node --check cloudflare/src/index.js` — passed.
- `node --check server/server.js` — passed.
- Parsed `desktop/package.json` as JSON after adding the standalone portable target — passed.
- Confirmed no supplied ExpressTURN username or credential was copied into the updated project files.

## Not run / not claimed as passing

- PowerShell scripts could not be executed because PowerShell is not installed in this environment.
- Windows NSIS installer and Portable EXE builds were not run (Windows build host required).
- Android Gradle build, APK signing and `apksigner` verification were not run (Android SDK/JDK/Windows script environment required).
- GitHub authentication, repository push, release ID/tag preservation, GitHub asset upload/deletion and Cloudflare deployment were not run.
- ExpressTURN connectivity, UDP/TCP relay, cross-network WebRTC sessions, and provider TLS support were not tested.
- Touch gestures, mobile/tablet UI, multi-monitor, file transfer and network-change recovery were not tested.

## Release gate

Do not run a production FULL release until a Windows build machine has executed the FULL pipeline and verified the Setup EXE, standalone Portable EXE and signed APK. Confirm the existing GitHub `ota` release ID and tag before/after a controlled test publish. Validate ExpressTURN credentials after rotating them and verify a selected `relay` candidate in an actual session.
