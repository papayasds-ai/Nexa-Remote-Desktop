# Windows build troubleshooting (NexaDesk)

The supplied 1.0.30 build log shows Electron packaging completed and NSIS failed while creating `NexaDesk-Setup-1.0.30.exe` with `Can't open output file`. This is an output-file creation failure; the log alone does not identify whether the cause was a file lock, security software, permissions, or storage.

The patched `scripts/build-windows.ps1` directs electron-builder's transient output to a unique short directory under the current user's TEMP folder, restores `desktop/package.json`'s normal `dist` output setting after the build, checks for both required EXEs, and removes the temporary build directory. It also removes a duplicate installer copy operation that existed in the previous script.

If the same NSIS error remains:

1. Close any running NexaDesk installer or build process.
2. Check Windows Security Protection History and any third-party antivirus quarantine; allow the build only if you trust the source.
3. Ensure the TEMP folder and project `output` folder are writable and that the drive has sufficient free space.
4. Run `START-HERE.bat` again and select the Windows build option. Do not publish a FULL release unless both Windows EXEs and the Android APK exist.

The log also reports no code-signing certificate. That is a separate warning: the EXE can be generated unsigned, but Windows may display SmartScreen warnings. Obtain a legitimate code-signing certificate if signed distribution is required. Do not place a PFX password or private signing key in source control.

The npm `electron-winstaller` install-script warning did not cause the shown failure: npm completed installation and Electron packaging proceeded. Do not approve arbitrary install scripts merely to silence that warning.

This patch has not been executed on the user's Windows machine. Re-run the build there and share the new `logs/build-windows.log` if it still fails.
