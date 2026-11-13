# Starts NexaDesk the way a click would and reports what happens (for "the .exe does not open").
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\diagnose.ps1      -> also saves everything to diagnose-report.txt
$root = Split-Path $PSScriptRoot -Parent
Start-Transcript -Path (Join-Path $root 'diagnose-report.txt') -Force | Out-Null
$unpacked = Join-Path $root 'desktop\dist\win-unpacked\NexaDesk.exe'
$portable = @(Get-ChildItem (Join-Path $root 'output') -Filter 'NexaDesk-Portable-*.exe' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending) | Select-Object -First 1
$exe = if (Test-Path $unpacked) { $unpacked } elseif ($portable) { $portable.FullName } else { $null }
if (-not $exe) { Write-Host 'No NexaDesk.exe found (build it first).' -ForegroundColor Red; Stop-Transcript | Out-Null; return }
"Testing: $exe"
"Before: running copies = " + @(Get-Process NexaDesk -ErrorAction SilentlyContinue).Count
Get-Process NexaDesk -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep 2
$log = Join-Path $env:TEMP 'nx-electron.log'; Remove-Item $log -ErrorAction SilentlyContinue
$t0 = Get-Date
Start-Process $exe -ArgumentList '--enable-logging', "--log-file=$log"
Write-Host 'Started. Waiting 20 seconds - do not touch the app...'
Start-Sleep 20
'--- running now:'
Get-Process NexaDesk -ErrorAction SilentlyContinue | Select-Object Id, MainWindowTitle, @{n='HasWindow';e={$_.MainWindowHandle -ne 0}} | Format-Table -AutoSize | Out-String
'--- startup.log (what the app itself recorded):'
Get-Content (Join-Path $env:APPDATA 'NexaDesk\startup.log') -Tail 15 -ErrorAction SilentlyContinue
'--- icon-debug.log:'
Get-Content (Join-Path $env:APPDATA 'NexaDesk\icon-debug.log') -Tail 4 -ErrorAction SilentlyContinue
'--- Electron log (errors only):'
Get-Content $log -ErrorAction SilentlyContinue | Where-Object { $_ -match 'ERROR|FATAL|crash' } | Select-Object -Last 15
'--- crashes of NexaDesk since the start:'
Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = $t0 } -ErrorAction SilentlyContinue | Where-Object { $_.Message -match 'NexaDesk' } | Select-Object -First 3 | Format-List TimeCreated, Message
'--- app data:'
Get-Content (Join-Path $env:APPDATA 'NexaDesk\ota-state.json') -ErrorAction SilentlyContinue
Stop-Transcript | Out-Null
Write-Host "`nDone. Send me the file: $(Join-Path $root 'diagnose-report.txt')" -ForegroundColor Green
