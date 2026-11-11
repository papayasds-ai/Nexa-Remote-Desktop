# NexaDesk modernization change log

## 2026-11-11

- Added a genuine Electron Builder `portable` Windows target alongside NSIS; the standalone Portable EXE is now a required build output.
- Removed generation/distribution of the portable ZIP from the Windows build script.
- FULL release flow now requires JDK/Android build and all three native artifacts (Setup EXE, Portable EXE, signed APK) before publishing.
- Removed destructive deletion/recreation of the GitHub `ota` release. Publishing now looks up the existing release, preserves its ID/tag, uploads and verifies new versioned assets, updates release metadata, then deletes only obsolete NexaDesk versioned binaries individually through the GitHub API.
- QUICK OTA runs preserve existing native release assets.
- Publishing now uses a full Git clone, an exclusive lock, per-run staging, and persistent transcript logs.
- Local OTA and Cloudflare static asset cleanup is limited to obsolete versioned web bundles; unrelated files are retained.
- Android builds no longer delete the previous APK before a replacement has been successfully signed and verified.
- Added ExpressTURN UDP/TCP integration to both Cloudflare Worker and Node signaling server using server-side environment secrets. Added `scripts/setup-expressturn.ps1`.
- Updated relay messaging to avoid promising that TURN guarantees connectivity.

## Not yet implemented / not verified

- ICE restart and seamless network-change recovery are not implemented in this pass.
- TURN over TLS is not configured because the supplied provider details only establish UDP and TCP on port 3478; obtain the provider's exact TLS hostname/port before enabling it.
- File transfer, multi-monitor switching, additional clipboard workflow, and some requested device-management enhancements were not implemented in this pass.
- The project has not been built on Windows or Android in this Linux execution environment.
