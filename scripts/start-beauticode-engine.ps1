#Requires -Version 5.1
<#
.SYNOPSIS
  One-click launcher for the beautiCode engine (system tray).

.DESCRIPTION
  Fast path:
  - Skip full npm build when dist is present and newer than its sources
  - Prefer a quick HTTP probe on :9335 (no Win32_Process scan on hot path)
  - Start tray immediately; session-host connects CDP in the background
  - If Codex is missing, launch it in parallel while the tray comes up
#>
param(
  [int]$Port = 9335,
  [switch]$ForceRestart,
  [switch]$NoLaunchCodex
)

$ErrorActionPreference = "Stop"
if ($Port -lt 0 -or $Port -gt 65535) {
  throw "Port must be 0 (auto) or an integer from 1 to 65535."
}
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$TrayScript = Join-Path $RepoRoot "apps\tray\start-tray.ps1"
$CodexAppUserModelId = "OpenAI.Codex_2p2nqsd0c76g0!App"
$LogPath = Join-Path $env:LOCALAPPDATA "beautiCode\engine-launcher.log"

function Write-BcLog([string]$Message) {
  try {
    $dir = Split-Path -Parent $LogPath
    if (-not (Test-Path -LiteralPath $dir)) {
      New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    $line = "[{0:u}] {1}" -f (Get-Date).ToUniversalTime(), $Message
    Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
  } catch {}
}

function Show-BcMessage {
  param(
    [string]$Text,
    [string]$Title = "beautiCode",
    [ValidateSet("Information","Error","Warning")]
    [string]$Icon = "Information"
  )
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
    $iconVal = [System.Windows.Forms.MessageBoxIcon]::Information
    if ($Icon -eq "Error") { $iconVal = [System.Windows.Forms.MessageBoxIcon]::Error }
    elseif ($Icon -eq "Warning") { $iconVal = [System.Windows.Forms.MessageBoxIcon]::Warning }
    [System.Windows.Forms.MessageBox]::Show(
      $Text,
      $Title,
      [System.Windows.Forms.MessageBoxButtons]::OK,
      $iconVal
    ) | Out-Null
  } catch {
    Write-Host $Text
  }
}

function Test-BcCdpFast([int]$CdpPort) {
  if ($CdpPort -le 0) { return $false }
  try {
    # TcpClient is much cheaper than Invoke-WebRequest for a liveness poke.
    $client = New-Object System.Net.Sockets.TcpClient
    $iar = $client.BeginConnect("127.0.0.1", $CdpPort, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne(120, $false)
    if (-not $ok) {
      try { $client.Close() } catch {}
      return $false
    }
    try { $client.EndConnect($iar) } catch {
      try { $client.Close() } catch {}
      return $false
    }
    try { $client.Close() } catch {}
  } catch {
    return $false
  }
  # Confirm it really speaks CDP JSON (still short timeout).
  try {
    $r = Invoke-WebRequest -Uri ("http://127.0.0.1:{0}/json/version" -f $CdpPort) -UseBasicParsing -TimeoutSec 1
    return ($r.StatusCode -eq 200)
  } catch {
    return $false
  }
}

function Find-BcCdpPortFast([int]$Preferred = 9335) {
  # Hot path: only the common ports, preferred first. Full scan is session-host's job.
  $candidates = @($Preferred, 9335, 9222, 9223) | Select-Object -Unique
  foreach ($p in $candidates) {
    if (Test-BcCdpFast -CdpPort $p) { return [int]$p }
  }
  return 0
}

function Get-BcTrayPids {
  # Narrow Get-CimInstance filter is still heavy; use process name + command line
  # only when ForceRestart needs it.
  $pids = New-Object System.Collections.ArrayList
  try {
    Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe' OR Name = 'pwsh.exe' OR Name = 'node.exe'" -ErrorAction SilentlyContinue |
      Where-Object {
        $_.CommandLine -and (
          $_.CommandLine -match 'start-tray\.ps1' -or
          $_.CommandLine -match 'session-host\.mjs'
        )
      } |
      ForEach-Object { [void]$pids.Add([int]$_.ProcessId) }
  } catch {}
  return @($pids)
}

function Get-CodexMainExeFast {
  # Avoid scanning all processes on every launch. Prefer AppX path, then known installs.
  try {
    $pkg = Get-AppxPackage -Name "OpenAI.Codex" -ErrorAction SilentlyContinue |
      Sort-Object -Property Version -Descending |
      Select-Object -First 1
    if ($pkg -and $pkg.InstallLocation) {
      $candidate = Join-Path $pkg.InstallLocation "app\ChatGPT.exe"
      if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
  } catch {}

  foreach ($p in @(
      (Join-Path $env:LOCALAPPDATA "Programs\chatgpt\ChatGPT.exe"),
      (Join-Path $env:LOCALAPPDATA "Programs\Codex\Codex.exe")
    )) {
    if ($p -and (Test-Path -LiteralPath $p)) { return $p }
  }
  return $null
}

function Start-CodexWithCdpFast([int]$CdpPort) {
  if ($CdpPort -le 0 -or $CdpPort -gt 65535) { $CdpPort = 9335 }
  $exe = Get-CodexMainExeFast
  $args = ("--remote-debugging-address=127.0.0.1 --remote-debugging-port={0}" -f $CdpPort)
  if ($exe) {
    try {
      $psi = New-Object System.Diagnostics.ProcessStartInfo
      $psi.FileName = $exe
      $psi.Arguments = $args
      $psi.UseShellExecute = $true
      [void][System.Diagnostics.Process]::Start($psi)
      Write-BcLog ("started Codex exe={0} port={1}" -f $exe, $CdpPort)
      return $true
    } catch {
      Write-BcLog ("direct Codex start failed: {0}" -f $_.Exception.Message)
    }
  }
  try {
    Start-Process -FilePath "explorer.exe" -ArgumentList ("shell:AppsFolder\{0}" -f $CodexAppUserModelId) | Out-Null
    Write-BcLog "launched Codex via AppsFolder"
    return $true
  } catch {
    Write-BcLog ("AppsFolder launch failed: {0}" -f $_.Exception.Message)
    return $false
  }
}

function Start-BcTray([int]$CdpPort) {
  $argList = New-Object System.Collections.ArrayList
  [void]$argList.Add("-NoProfile")
  [void]$argList.Add("-ExecutionPolicy")
  [void]$argList.Add("Bypass")
  [void]$argList.Add("-File")
  [void]$argList.Add(('{0}' -f $TrayScript))
  if ($CdpPort -gt 0) {
    [void]$argList.Add("-Port")
    [void]$argList.Add("$CdpPort")
  }
  # The tray owns the source-vs-dist freshness check and rebuilds stale dist.
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "powershell.exe"
  # Quote the -File path; join the rest as separate args via ProcessStartInfo is
  # awkward in PS 5.1 — keep a single argument string with proper quoting.
  $quoted = @()
  foreach ($a in $argList) {
    if ($a -match '[\s"]') {
      $quoted += ('"{0}"' -f ($a -replace '"', '\"'))
    } else {
      $quoted += $a
    }
  }
  $psi.Arguments = ($quoted -join " ")
  $psi.WorkingDirectory = $RepoRoot
  $psi.UseShellExecute = $true
  $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  [void][System.Diagnostics.Process]::Start($psi)
  Write-BcLog ("started tray Port={0} FreshnessCheck=True" -f $CdpPort)
}

try {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  Write-BcLog ("launcher start Port={0} ForceRestart={1}" -f $Port, [bool]$ForceRestart)

  if (-not (Test-Path -LiteralPath $TrayScript)) {
    throw "Missing tray script: $TrayScript"
  }

  if ($ForceRestart) {
    foreach ($procId in @(Get-BcTrayPids)) {
      try { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue } catch {}
    }
    Start-Sleep -Milliseconds 400
  } else {
    # Cheap duplicate check: if session-host already listening via our prior
    # run, avoid Win32_Process scan when possible by looking for node+tray only
    # when ForceRestart is off and user double-clicks.
    $existing = @(Get-BcTrayPids)
    if ($existing.Count -gt 0) {
      Write-BcLog ("engine already running count={0}" -f $existing.Count)
      # No modal dialog — tray icon is already the signal. Exit quietly.
      exit 0
    }
  }

  # 1) Fast CDP probe (preferred port only, ~100–300ms worst case miss).
  $cdpPort = Find-BcCdpPortFast -Preferred $Port

  # 2) If no CDP, kick Codex launch WITHOUT waiting for it — tray starts now.
  #    session-host deferHostConnect + watch loop will attach when CDP appears.
  #    Tray "应用或重新应用" can also force launch/restart later.
  if ($cdpPort -le 0 -and -not $NoLaunchCodex) {
    Write-BcLog "no CDP yet - launching Codex in parallel with tray"
    [void](Start-CodexWithCdpFast -CdpPort $Port)
    # Tiny second chance (~0.6s) in case Codex CDP is already warm from a
    # previous partial start; do NOT block for a full minute.
    $deadline = (Get-Date).AddMilliseconds(600)
    while ((Get-Date) -lt $deadline) {
      $cdpPort = Find-BcCdpPortFast -Preferred $Port
      if ($cdpPort -gt 0) { break }
      Start-Sleep -Milliseconds 120
    }
  }

  # 3) Start tray. Port 0 → session-host auto-discovers in background.
  # Preserve an explicitly requested port while Codex is still starting.
  $trayPort = if ($cdpPort -gt 0) {
    $cdpPort
  } elseif ($Port -gt 0) {
    $Port
  } else {
    0
  }
  Start-BcTray -CdpPort $trayPort
  $sw.Stop()
  Write-BcLog ("launcher done in {0}ms cdp={1}" -f $sw.ElapsedMilliseconds, $cdpPort)
  exit 0
}
catch {
  Write-BcLog ("launcher failed: {0}" -f $_.Exception.Message)
  Show-BcMessage -Icon "Error" -Text ("beautiCode engine failed to start:`n{0}`n`nLog: {1}" -f $_.Exception.Message, $LogPath)
  exit 1
}
