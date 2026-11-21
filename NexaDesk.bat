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
echo   1) Full release    server + EXE + APK + GitHub + instant update
echo   2) Update          quick if only the UI changed, full build if the app changed
echo   3) Security check  installs packages and applies the safe fixes
echo   0) Exit
echo.
echo   New PC? Run  NexaDesk.bat setup  first: it lists what is missing.
echo.
set "c="
set /p "c=Choose: "
set "CMD="
if "%c%"=="1" set "CMD=release"
if "%c%"=="2" set "CMD=update"
if "%c%"=="3" set "CMD=security-fix"
if "%c%"=="0" exit /b 0
if not defined CMD goto menu
set "ARGS="
call :dispatch
echo.
pause
goto menu

:dispatch
if /i "%CMD%"=="release"      call :ps release-all.ps1      & goto :eof
if /i "%CMD%"=="update"       call :ps update-auto.ps1      & goto :eof
if /i "%CMD%"=="quick"        call :ps publish-ota.ps1      & goto :eof
if /i "%CMD%"=="force"        set "ARGS= -Force%ARGS%" & call :ps update-auto.ps1 & goto :eof
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
if /i "%CMD%"=="setup"        call :ps setup-check.ps1      & goto :eof
if /i "%CMD%"=="help"         goto usage
echo Unknown command: %CMD%
:usage
echo.
echo Usage: NexaDesk.bat ^<command^> [flags]     (no command = menu)
echo   release / update / quick / force / windows / android / server / security / check / diagnose / auto-on / auto-off / migrate / setup
echo   examples:  NexaDesk.bat update -Force      NexaDesk.bat security -Fix      NexaDesk.bat migrate -From "C:\old\NexaDesk"
goto :eof

:ps
%PS% "scripts\%~1"%ARGS%
goto :eof
