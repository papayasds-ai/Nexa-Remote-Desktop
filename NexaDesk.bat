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
echo   1) FULL FORCED RELEASE   server + EXE + APK + require update on devices
echo   2) QUICK WEB UPDATE   UI/logic only; does not rebuild the Android APK
echo   3) FORCED UPDATE      force web update and start Android APK update when supported
echo   4) Build Windows EXE only
echo   5) Build Android APK only
echo   6) Repair / create the server (Cloudflare)
echo   7) Security check   (type 8 to also allow safe fixes)
echo   8) Security check + apply safe fixes
echo   9) Check what the server publishes (self-test)
echo   R) Android release   build APK + publish the update
echo   F) Forced Android release   build APK + require the update
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
if /i "%c%"=="r" set "CMD=android-release"
if /i "%c%"=="f" set "CMD=android-release"
if /i "%c%"=="d" set "CMD=diagnose"
if /i "%c%"=="a" set "CMD=auto-on"
if /i "%c%"=="z" set "CMD=auto-off"
if /i "%c%"=="m" set "CMD=migrate"
if "%c%"=="0" exit /b 0
if not defined CMD goto menu
set "ARGS="
if /i "%c%"=="f" set "ARGS= -Force"
call :dispatch
echo.
pause
goto menu

:dispatch
if /i "%CMD%"=="release"      goto dispatch_release
if /i "%CMD%"=="update"       goto dispatch_update
if /i "%CMD%"=="force"        goto dispatch_force
if /i "%CMD%"=="android-release" goto dispatch_android_release
if /i "%CMD%"=="windows"      goto dispatch_windows
if /i "%CMD%"=="android"      goto dispatch_android
if /i "%CMD%"=="server"       goto dispatch_server
if /i "%CMD%"=="cloudflare"   goto dispatch_server
if /i "%CMD%"=="security"     goto dispatch_security
if /i "%CMD%"=="security-fix" goto dispatch_security_fix
if /i "%CMD%"=="check"        goto dispatch_check
if /i "%CMD%"=="diagnose"     goto dispatch_diagnose
if /i "%CMD%"=="auto-on"      goto dispatch_auto_on
if /i "%CMD%"=="auto-off"     goto dispatch_auto_off
if /i "%CMD%"=="migrate"      goto dispatch_migrate
if /i "%CMD%"=="help"         goto usage
echo Unknown command: %CMD%
goto :eof

:dispatch_release
set "ARGS= -Force%ARGS%"
call :ps release-all.ps1
goto :eof
:dispatch_update
call :ps publish-ota.ps1
goto :eof
:dispatch_force
set "ARGS= -Force%ARGS%"
call :ps publish-ota.ps1
goto :eof
:dispatch_android_release
call :ps release-android.ps1%ARGS%
goto :eof
:dispatch_windows
call :ps build-windows.ps1
goto :eof
:dispatch_android
call :ps build-android.ps1
goto :eof
:dispatch_server
call :ps deploy-cloudflare.ps1
goto :eof
:dispatch_security
call :ps security-check.ps1
goto :eof
:dispatch_security_fix
set "ARGS= -Fix%ARGS%"
call :ps security-check.ps1
goto :eof
:dispatch_check
node scripts\check-release.js%ARGS%
goto :eof
:dispatch_diagnose
call :ps diagnose.ps1
goto :eof
:dispatch_auto_on
call :ps install-auto-release.ps1
goto :eof
:dispatch_auto_off
set "ARGS= -Remove%ARGS%"
call :ps install-auto-release.ps1
goto :eof
:dispatch_migrate
call :ps migrate.ps1
goto :eof
:usage
echo.
echo Usage: NexaDesk.bat ^<command^> [flags]
echo   release      full forced release: server + EXE + APK + require update on devices
echo   update       quick web-only update   flags: -Force  -NoBump  -RecoveryKey ^<file^>  -AppKey ^<id^|none^>
echo   android-release  build Android APK and publish a signed update (Cloudflare token required)
echo   android-release -Force  publish a mandatory Android update (Android may still show its system confirmation)
echo   force        quick mandatory update; Android starts its APK installer when supported
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
