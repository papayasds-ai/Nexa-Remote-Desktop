@echo off
rem ============================================================================================================
rem  NexaDesk - the ONLY launcher. Double-click for the menu, or run it with a command:
rem    NexaDesk.bat release, update, force, windows, android, server, security, check, diagnose,
rem                 auto-on, auto-off, migrate, help          (extra flags are passed on, e.g.  NexaDesk.bat update -Force)
rem  No parenthesised blocks are used on purpose: folders such as "NexaDesk(1)" would break them.
rem ============================================================================================================
setlocal
cd /d "%~dp0"
title NexaDesk
rem old launchers from earlier versions are removed: this file is the only one
for %%F in (START-HERE.bat run-android.bat run-cloudflare.bat run-release.bat run-security.bat run-update.bat run-windows.bat) do if exist "%%F" del /q "%%F" >nul 2>&1
set "PS=powershell -NoProfile -ExecutionPolicy Bypass -File"
set "CMD=%~1"
if "%CMD%"=="" goto menu
shift
set "ARGS="
:collect2
if "%~1"=="" goto direct
set "ARGS=%ARGS% %1"
shift
goto collect2

:direct
call :dispatch
exit /b %ERRORLEVEL%

:menu
cls
echo ==============================================
echo   NexaDesk - secure remote access builder
echo ==============================================
echo   1) FULL RELEASE   server + EXE + APK + GitHub + instant update
echo   2) QUICK UPDATE   UI/logic only, no rebuild, devices update instantly
echo   3) FORCED UPDATE  like 2, but every device installs it (30 s warning)
echo   4) Build Windows EXE only
echo   5) Build Android APK only
echo   6) Repair / create the server (Cloudflare)
echo   7) Security check   (type 8 to also allow safe fixes)
echo   8) Security check + apply safe fixes
echo   9) Check what the server publishes (self-test)
echo   D) Diagnose "the app does not open"
echo   A) Automatic releases ON      Z) Automatic releases OFF
echo   M) Import settings from an older NexaDesk folder
echo   0) Exit
echo.
set "c="
set /p "c=Choose: "
set "CMD="
if "%c%"=="1" set "CMD=release"
if "%c%"=="2" set "CMD=update"
if "%c%"=="3" set "CMD=force"
if "%c%"=="4" set "CMD=windows"
if "%c%"=="5" set "CMD=android"
if "%c%"=="6" set "CMD=server"
if "%c%"=="7" set "CMD=security"
if "%c%"=="8" set "CMD=security-fix"
if "%c%"=="9" set "CMD=check"
if /i "%c%"=="d" set "CMD=diagnose"
if /i "%c%"=="a" set "CMD=auto-on"
if /i "%c%"=="z" set "CMD=auto-off"
if /i "%c%"=="m" set "CMD=migrate"
if "%c%"=="0" exit /b 0
if not defined CMD goto menu
set "ARGS="
call :dispatch
echo.
pause
goto menu

:dispatch
if /i "%CMD%"=="release"      call :ps release-all.ps1      & goto :eof
if /i "%CMD%"=="update"       call :ps publish-ota.ps1      & goto :eof
if /i "%CMD%"=="force"        set "ARGS= -Force%ARGS%" & call :ps publish-ota.ps1 & goto :eof
if /i "%CMD%"=="windows"      call :ps build-windows.ps1    & goto :eof
if /i "%CMD%"=="android"      call :ps build-android.ps1    & goto :eof
if /i "%CMD%"=="server"       call :ps deploy-cloudflare.ps1 & goto :eof
if /i "%CMD%"=="cloudflare"   call :ps deploy-cloudflare.ps1 & goto :eof
if /i "%CMD%"=="security"     call :ps security-check.ps1   & goto :eof
if /i "%CMD%"=="security-fix" set "ARGS= -Fix%ARGS%" & call :ps security-check.ps1 & goto :eof
if /i "%CMD%"=="check"        node scripts\check-release.js%ARGS% & goto :eof
if /i "%CMD%"=="diagnose"     call :ps diagnose.ps1         & goto :eof
if /i "%CMD%"=="auto-on"      call :ps install-auto-release.ps1 & goto :eof
if /i "%CMD%"=="auto-off"     set "ARGS= -Remove%ARGS%" & call :ps install-auto-release.ps1 & goto :eof
if /i "%CMD%"=="migrate"      call :ps migrate.ps1          & goto :eof
if /i "%CMD%"=="help"         goto usage
echo Unknown command: %CMD%
:usage
echo.
echo Usage: NexaDesk.bat ^<command^> [flags]
echo   release      full release (add -AllowInsecure only for LAN tests)
echo   update       quick web-layer update   flags: -Force  -NoBump  -WithPortable  -RetryUpload  -RecoveryKey ^<file^>  -AppKey ^<id^|none^>
echo   force        quick update that every device must install
echo   windows      build the Windows EXE        android   build the Android APK
echo   server       create / repair the Cloudflare server
echo   security     check packages   flags: -Fix  -Force
echo   check        test what the server publishes
echo   diagnose     start the EXE and report what happens
echo   auto-on / auto-off   automatic releases every 10 minutes
echo   migrate      import server-url, tokens and keystore from an older folder   flag: -From ^<folder^>
goto :eof

:ps
%PS% "scripts\%~1"%ARGS%
goto :eof
