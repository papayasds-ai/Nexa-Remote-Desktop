@echo off
setlocal
cd /d "%~dp0"
:menu
cls
echo ==========================================
echo   NexaDesk - secure remote access builder
echo ==========================================
echo  1) FULL RELEASE  (server + EXE + APK + GitHub + instant update)
echo  2) QUICK UPDATE  (UI/logic only: no rebuild, devices update instantly)
echo  3) Build Windows EXE only
echo  4) Build Android APK only
echo  5) Repair / create the server (Cloudflare)
echo  6) Exit
echo.
set /p c=Choose 1-6: 
if "%c%"=="1" powershell -NoProfile -ExecutionPolicy Bypass -File scripts\release-all.ps1 & pause & goto menu
if "%c%"=="2" powershell -NoProfile -ExecutionPolicy Bypass -File scripts\publish-ota.ps1 & pause & goto menu
if "%c%"=="3" powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-windows.ps1 & pause & goto menu
if "%c%"=="4" powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-android.ps1 & pause & goto menu
if "%c%"=="5" powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy-cloudflare.ps1 & pause & goto menu
if "%c%"=="6" exit /b
goto menu
