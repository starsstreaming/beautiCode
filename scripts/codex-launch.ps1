# Shared Windows Codex discovery and loopback launch helpers.
# This file is dot-sourced by both the one-click launcher and the tray process.

$script:BeautiCodeKnownCodexAppUserModelId = "OpenAI.Codex_2p2nqsd0c76g0!App"

function Get-BcCodexMainProcesses {
  foreach ($process in @(Get-Process -Name "ChatGPT", "Codex" -ErrorAction SilentlyContinue)) {
    $path = $null
    try { $path = $process.Path } catch { }
    if (-not $path) { continue }
    $leaf = [System.IO.Path]::GetFileName($path)
    if ($leaf -notmatch "^(ChatGPT|Codex)\.exe$") { continue }
    if ($path -match "\\resources\\") { continue }
    [pscustomobject]@{
      Process = $process
      Path = $path
    }
  }
}

function Wait-BcCodexMainProcessesExit([int]$WaitSeconds = 8) {
  $deadline = [datetime]::UtcNow.AddSeconds([Math]::Max(1, $WaitSeconds))
  do {
    if (@(Get-BcCodexMainProcesses).Count -eq 0) { return $true }
    Start-Sleep -Milliseconds 250
  } while ([datetime]::UtcNow -lt $deadline)
  return (@(Get-BcCodexMainProcesses).Count -eq 0)
}

# Ask main windows to close first. Electron/Codex often ignores a single
# CloseMainWindow, so also fall back to Stop-Process (non-force) which still
# prefers a graceful close on Windows GUI apps.
function Stop-BcCodexGracefully([int]$WaitSeconds = 8) {
  $targets = @(Get-BcCodexMainProcesses)
  if ($targets.Count -eq 0) { return $true }

  foreach ($target in $targets) {
    try {
      $target.Process.Refresh()
      if ($target.Process.MainWindowHandle -ne [IntPtr]::Zero) {
        [void]$target.Process.CloseMainWindow()
      }
    } catch { }
  }

  if (Wait-BcCodexMainProcessesExit -WaitSeconds ([Math]::Min(3, [Math]::Max(1, $WaitSeconds)))) {
    return $true
  }

  foreach ($target in @(Get-BcCodexMainProcesses)) {
    try {
      Stop-Process -Id $target.Process.Id -ErrorAction Stop
    } catch { }
  }

  return (Wait-BcCodexMainProcessesExit -WaitSeconds $WaitSeconds)
}

# Last resort after the user already agreed to restart / force-close.
# Kills main ChatGPT/Codex.exe only (not helper processes under \resources\).
function Stop-BcCodexForcefully([int]$WaitSeconds = 3) {
  foreach ($target in @(Get-BcCodexMainProcesses)) {
    try {
      Stop-Process -Id $target.Process.Id -Force -ErrorAction Stop
    } catch { }
  }
  if (Wait-BcCodexMainProcessesExit -WaitSeconds $WaitSeconds) {
    return $true
  }

  # AppX / stubborn Electron trees sometimes leave the main image alive until
  # the process tree is torn down. taskkill /T is Windows-only and scoped by PID.
  foreach ($target in @(Get-BcCodexMainProcesses)) {
    try {
      $null = & taskkill.exe /PID $target.Process.Id /T /F 2>$null
    } catch { }
  }
  return (Wait-BcCodexMainProcessesExit -WaitSeconds $WaitSeconds)
}

function Get-BcCodexPackageLocations {
  $packages = @()
  try {
    $packages += @(Get-AppxPackage -Name "*OpenAI.Codex*" -ErrorAction SilentlyContinue)
  } catch { }
  if ($packages.Count -eq 0) {
    try {
      $packages += @(
        Get-AppxPackage -ErrorAction SilentlyContinue |
          Where-Object {
            $_.Name -match "OpenAI\.Codex|ChatGPT" -or
            $_.PackageFamilyName -match "OpenAI\.Codex|ChatGPT"
          }
      )
    } catch { }
  }
  $packages |
    Where-Object { $_.InstallLocation } |
    Sort-Object -Property Version -Descending |
    ForEach-Object { [string]$_.InstallLocation } |
    Select-Object -Unique
}

function Find-BcCodexExecutable {
  $candidates = New-Object System.Collections.ArrayList

  foreach ($running in @(Get-BcCodexMainProcesses)) {
    [void]$candidates.Add($running.Path)
  }

  foreach ($installLocation in @(Get-BcCodexPackageLocations)) {
    foreach ($relative in @(
        "app\ChatGPT.exe",
        "app\Codex.exe",
        "ChatGPT.exe",
        "Codex.exe"
      )) {
      [void]$candidates.Add((Join-Path $installLocation $relative))
    }
  }

  foreach ($root in @($env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if (-not $root) { continue }
    foreach ($relative in @(
        "Programs\ChatGPT\ChatGPT.exe",
        "Programs\chatgpt\ChatGPT.exe",
        "Programs\Codex\Codex.exe",
        "Programs\codex\Codex.exe",
        "OpenAI\ChatGPT\ChatGPT.exe",
        "OpenAI\Codex\Codex.exe"
      )) {
      [void]$candidates.Add((Join-Path $root $relative))
    }
  }

  foreach ($candidate in @($candidates)) {
    if (-not $candidate) { continue }
    try {
      if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        return (Resolve-Path -LiteralPath $candidate).Path
      }
    } catch { }
  }
  return $null
}

function Find-BcCodexAppUserModelId {
  try {
    $startApps = @(
      Get-StartApps -ErrorAction SilentlyContinue |
        Where-Object {
          $_.AppID -and ($_.Name -match "Codex|ChatGPT|OpenAI")
        }
    )
    if ($startApps.Count -gt 0) {
      return [string]$startApps[0].AppID
    }
  } catch { }
  return $script:BeautiCodeKnownCodexAppUserModelId
}

function Test-BcLoopbackPortAvailable([int]$Port) {
  if ($Port -lt 1 -or $Port -gt 65535) { return $false }
  $listener = $null
  try {
    $listener = New-Object System.Net.Sockets.TcpListener(
      [System.Net.IPAddress]::Loopback,
      $Port
    )
    $listener.Start()
    return $true
  } catch {
    return $false
  } finally {
    if ($null -ne $listener) {
      try { $listener.Stop() } catch { }
    }
  }
}

function Get-BcLoopbackCdpPort([int]$Preferred = 9335) {
  if (Test-BcLoopbackPortAvailable -Port $Preferred) {
    return $Preferred
  }
  $listener = $null
  try {
    $listener = New-Object System.Net.Sockets.TcpListener(
      [System.Net.IPAddress]::Loopback,
      0
    )
    $listener.Start()
    return [int]$listener.LocalEndpoint.Port
  } finally {
    if ($null -ne $listener) {
      try { $listener.Stop() } catch { }
    }
  }
}

function Start-BcCodexWithCdp([int]$CdpPort = 9335) {
  if ($CdpPort -le 0 -or $CdpPort -gt 65535) {
    $CdpPort = Get-BcLoopbackCdpPort
  }
  $executable = Find-BcCodexExecutable
  if ($executable) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $executable
    $psi.Arguments = "--remote-debugging-address=127.0.0.1 --remote-debugging-port=$CdpPort"
    $psi.WorkingDirectory = Split-Path -Parent $executable
    $psi.UseShellExecute = $true
    [void][System.Diagnostics.Process]::Start($psi)
    return [pscustomobject]@{
      Method = "executable"
      Executable = $executable
      AppUserModelId = $null
      Port = $CdpPort
    }
  }

  $appUserModelId = Find-BcCodexAppUserModelId
  if ($appUserModelId) {
    Start-Process -FilePath "explorer.exe" `
      -ArgumentList ("shell:AppsFolder\{0}" -f $appUserModelId) `
      -ErrorAction Stop | Out-Null
    return [pscustomobject]@{
      Method = "appx"
      Executable = $null
      AppUserModelId = $appUserModelId
      Port = $CdpPort
    }
  }

  throw "找不到已安装的 Codex/ChatGPT Desktop 应用，请先安装 Codex Desktop。"
}
