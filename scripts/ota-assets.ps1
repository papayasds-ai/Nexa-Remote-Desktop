# Installer hosting for REAL app updates (the app package, not only the web layer). Loaded by common.ps1.
#   Get-ReleaseHost        where the apps download installers from (release-host.txt = Cloudflare R2, otherwise the GitHub release 'ota')
#   Publish-OtaInstallers  uploads APK + Setup exe (or the Portable exe with -Portable) to the release 'ota' and VERIFIES them on GitHub
# The release and its tag are never deleted. Keep this file ASCII only (Windows PowerShell 5.1 reads it as ANSI).
$script:GhRepo = 'papayasds-ai/Nexa-Remote-Desktop'

function Get-ReleaseHost([string]$root) {
  $f = Join-Path $root 'release-host.txt'
  if (Test-Path $f) { $h = (Get-Content $f -Raw).Trim().TrimEnd('/'); if ($h) { return $h } }
  return "https://github.com/$($script:GhRepo)/releases/download/ota"
}

# Assets of the release 'ota' as @{ ok; assets } (name, size, state, digest when GitHub provides it).
function Get-OtaAssetList {
  if ((Invoke-Gh release view ota --repo $script:GhRepo --json assets) -ne 0) { return [pscustomobject]@{ ok = $false; assets = @() } }
  try { $j = ($script:ghOut -join "`n") | ConvertFrom-Json; return [pscustomobject]@{ ok = $true; assets = @($j.assets) } }
  catch { return [pscustomobject]@{ ok = $false; assets = @() } }
}

# Returns $true only when every wanted file is on GitHub with the right size. A file that is already there with the same
# checksum is skipped, so running it again continues where a failed run stopped. Old installers of the same kind are
# removed only after the new ones are verified. Retries each file 3 times (GitHub drops slow uploads with HTTP 408).
function Publish-OtaInstallers([string]$ver, [string]$outDir, [switch]$Portable, [switch]$ApkOnly) {
  $repo = $script:GhRepo
  $want = if ($Portable) { @("NexaDesk-Portable-$ver.exe") } elseif ($ApkOnly) { @("NexaDesk-$ver.apk") } else { @("NexaDesk-$ver.apk", "NexaDesk-Setup-$ver.exe") }
  $files = @($want | ForEach-Object { Join-Path $outDir $_ } | Where-Object { Test-Path $_ } | ForEach-Object { Get-Item $_ } | Sort-Object Length)
  if ($files.Count -eq 0) { Write-Host "No installer files for v$ver in output\ - nothing to upload." -ForegroundColor Yellow; return $false }
  if (-not (Get-Command gh.exe -ErrorAction SilentlyContinue)) { Write-Host "GitHub CLI is not installed. Run: winget install GitHub.cli   then: gh auth login" -ForegroundColor Red; return $false }
  if ((Invoke-Gh auth status) -ne 0) { Write-Host "Run 'gh auth login' once, then try again." -ForegroundColor Red; return $false }
  if ((Invoke-Gh release view ota --repo $repo) -ne 0) {
    if ((Invoke-Gh release create ota --repo $repo --target main --title "NexaDesk v$ver" --notes "NexaDesk v$ver") -ne 0) { Write-Host "GitHub release 'ota' could not be created:`n$($script:ghOut)" -ForegroundColor Red; return $false }
  }
  foreach ($f in $files) {
    $name = $f.Name
    $localHash = (Get-FileHash $f.FullName -Algorithm SHA256).Hash.ToLower()
    $cur = Get-OtaAssetList
    $have = $null
    if ($cur.ok) { $have = @($cur.assets | Where-Object { $_.name -eq $name }) | Select-Object -First 1 }
    if ($have -and ([long]$have.size -eq $f.Length) -and ((-not $have.state) -or $have.state -eq 'uploaded') -and ((-not $have.digest) -or $have.digest -eq "sha256:$localHash")) {
      Write-Host "  $name is already on the release (same checksum) - skipped" -ForegroundColor DarkGray; continue
    }
    Write-Host "  uploading $name ($([math]::Round($f.Length / 1MB, 1)) MB) ..." -ForegroundColor Cyan
    $code = 1
    for ($try = 1; $try -le 3 -and $code; $try++) {
      if ($try -gt 1) { Write-Host "  retry $try of 3 for $name ..." -ForegroundColor Yellow; Start-Sleep -Seconds 5 }
      $code = Send-GhAsset $f.FullName $repo
    }
    if ($code) { Write-Host "  upload of $name FAILED (exit $code). The release and its older files are untouched." -ForegroundColor Red; return $false }
  }
  $v = Get-OtaAssetList
  if (-not $v.ok) { Write-Host "Could not check the release on GitHub after the upload." -ForegroundColor Red; return $false }
  foreach ($f in $files) {
    $a = @($v.assets | Where-Object { $_.name -eq $f.Name }) | Select-Object -First 1
    if (-not $a -or [long]$a.size -ne $f.Length) { Write-Host "  $($f.Name) is not complete on GitHub." -ForegroundColor Red; return $false }
  }
  $keepNames = @($files | ForEach-Object { $_.Name })
  $rx = if ($Portable) { '^NexaDesk-Portable-.*\.exe$' } elseif ($ApkOnly) { '^NexaDesk-\d.*\.apk$' } else { '^NexaDesk-Setup-.*\.exe(\.blockmap)?$|^NexaDesk-\d.*\.apk$' }
  foreach ($s in @($v.assets | ForEach-Object { $_.name } | Where-Object { $_ -match $rx -and ($keepNames -notcontains $_) })) {
    if ((Invoke-Gh release delete-asset ota $s --repo $repo --yes) -eq 0) { Write-Host "  removed old asset $s" -ForegroundColor DarkGray } else { Write-Host "  could not remove old asset ${s}: $($script:ghOut)" -ForegroundColor Yellow }
  }
  if (-not $Portable) {
    $notes = "NexaDesk v$ver`n`nWindows: NexaDesk-Setup-$ver.exe (installer), NexaDesk-Portable-$ver.exe (no install needed)`nAndroid: NexaDesk-$ver.apk"
    [void](Invoke-Gh release edit ota --repo $repo --title "NexaDesk v$ver" --notes $notes)
  }
  Write-Host "  verified on GitHub: $($keepNames -join ', ')" -ForegroundColor Green
  return $true
}

. "$PSScriptRoot\cloud-windows.ps1"   # cloud build of the Windows installers (used while cloud-windows.txt exists)
