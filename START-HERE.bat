@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"
if /i "%~1"=="speedup" goto speedup
set PS=powershell -NoProfile -ExecutionPolicy Bypass -File
:menu
cls
echo ==========================================
echo   NexaDesk - secure remote access builder
echo ==========================================
echo  UPDATE ALL DEVICES  (Windows + Android)
echo   1) AUTO    quick  - next version number, UI/logic only (no rebuild, seconds)
echo   2) AUTO    full   - next version number, rebuilds EXE + APK
echo   3) MANUAL         - YOU type the version number; quick or full; forced or normal
echo   4) Hands-free auto-release: turn ON  (checks every 10 minutes)
echo   5) Hands-free auto-release: turn OFF
echo  BUILD ONLY  (nothing is published)
echo   6) Windows EXE      7) Android APK
echo  TOOLS
echo   8) Repair / create the server      9) Speed up THIS PC (Defender, asks for admin)
echo   T) Set up the TURN relay (needed for phones on 5G/4G and strict networks)
echo   R) Emergency: publish with the RECOVERY key (daily key lost)
echo   0) Exit
echo.
set c=
set /p c=Choose: 
if "%c%"=="1" (%PS% scripts\update.ps1 -Mode auto -Scope quick & pause & goto menu)
if "%c%"=="2" (%PS% scripts\update.ps1 -Mode auto -Scope full & pause & goto menu)
if "%c%"=="3" (%PS% scripts\update.ps1 -Mode manual & pause & goto menu)
if "%c%"=="4" (%PS% scripts\install-auto-release.ps1 & pause & goto menu)
if "%c%"=="5" (%PS% scripts\install-auto-release.ps1 -Remove & pause & goto menu)
if "%c%"=="6" (%PS% scripts\build-windows.ps1 & pause & goto menu)
if "%c%"=="7" (%PS% scripts\build-android.ps1 & pause & goto menu)
if "%c%"=="8" (%PS% scripts\deploy-cloudflare.ps1 & pause & goto menu)
if "%c%"=="9" goto elevate
if /i "%c%"=="t" (%PS% scripts\setup-turn.ps1 & pause & goto menu)
if /i "%c%"=="r" goto recovery
if "%c%"=="0" exit /b
goto menu

:recovery
set k=
set /p k=Path to RECOVERY-MOVE-OFFLINE.pem: 
if "!k!"=="" goto menu
%PS% scripts\publish-ota.ps1 -RecoveryKey "!k!"
pause
goto menu

:elevate
net session >nul 2>&1 && goto speedup
powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList 'speedup' -Verb RunAs"
goto menu

:speedup
:: one-time: stops Windows Defender from re-scanning NexaDesk on every launch (main cause of slow Electron startup)
powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-MpPreference -ExclusionProcess 'NexaDesk.exe'; Add-MpPreference -ExclusionPath \"$env:LOCALAPPDATA\Programs\NexaDesk\"; Add-MpPreference -ExclusionPath \"$env:APPDATA\NexaDesk\"; Write-Host 'Done. NexaDesk will now start fast.' -ForegroundColor Green"
pause
if /i "%~1"=="speedup" exit /b
goto menu
