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
  [int]$Port = 0,
  [switch]$ForceRestart,
  [switch]$NoLaunchCodex
)

$ErrorActionPreference = "Stop"
if ($Port -lt 0 -or $Port -gt 65535) {
  throw "端口必须为 0（自动）或 1 到 65535 之间的整数。"
}
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $RepoRoot "scripts\bc-tray-singleton.ps1")
$TrayScript = Join-Path $RepoRoot "apps\tray\start-tray.ps1"
$CodexLaunchScript = Join-Path $RepoRoot "scripts\codex-launch.ps1"
$ReleaseManifest = Join-Path $RepoRoot "release-manifest.json"
$LogRoot = if ($env:LOCALAPPDATA) {
  Join-Path $env:LOCALAPPDATA "beautiCode\logs"
} else {
  Join-Path ([System.IO.Path]::GetTempPath()) "beautiCode\logs"
}
$LogPath = Join-Path $LogRoot "engine-launcher.log"
$TrayMutexName = Get-BcTrayMutexName
$TrayPanelEventName = Get-BcTrayPanelEventName
$LauncherMutexName = "Local\beautiCode.Engine.Launcher.v1"
$script:launcherMutex = $null
$script:launcherMutexOwned = $false

if (-not (Test-Path -LiteralPath $CodexLaunchScript -PathType Leaf)) {
  throw "缺少 Codex 启动脚本：$CodexLaunchScript"
}
. $CodexLaunchScript

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

function Wait-BcCdpReady {
  param(
    [int]$Preferred = 0,
    [int]$WaitSeconds = 15
  )
  $deadline = [datetime]::UtcNow.AddSeconds([Math]::Max(1, $WaitSeconds))
  do {
    $hit = Find-BcCdpPortFast -Preferred $Preferred
    if ($hit -gt 0) { return [int]$hit }
    Start-Sleep -Milliseconds 250
  } while ([datetime]::UtcNow -lt $deadline)
  return 0
}

function Request-BcTrayPanel([int]$WaitMilliseconds = 0) {
  $deadline = [datetime]::UtcNow.AddMilliseconds([Math]::Max(0, $WaitMilliseconds))
  do {
    $showEvent = $null
    try {
      $showEvent = [System.Threading.EventWaitHandle]::OpenExisting($TrayPanelEventName)
      [void]$showEvent.Set()
      Write-BcLog "tray panel requested"
      return $true
    } catch [System.Threading.WaitHandleCannotBeOpenedException] {
      # The tray creates this event immediately after taking its instance mutex.
    } finally {
      if ($null -ne $showEvent) {
        try { $showEvent.Dispose() } catch {}
      }
    }
    if ([datetime]::UtcNow -ge $deadline) { break }
    Start-Sleep -Milliseconds 100
  } while ($true)
  Write-BcLog "tray panel request timed out"
  return $false
}

function Test-BcTrayRunningFast {
  return (Test-BcTrayReady)
}

function Get-BcTrayPids {
  # Win32_Process command-line inspection is intentionally ForceRestart-only.
  $pids = New-Object System.Collections.ArrayList
  try {
    Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe' OR Name = 'pwsh.exe' OR Name = 'node.exe'" -ErrorAction SilentlyContinue |
      Where-Object {
        $_.CommandLine -and (
          (Test-BcTrayCommandLine -CommandLine $_.CommandLine) -or
          $_.CommandLine -match 'session-host\.mjs'
        )
      } |
      ForEach-Object { [void]$pids.Add([int]$_.ProcessId) }
  } catch {}
  return @($pids)
}

function Get-CodexMainExeFast {
  return Find-BcCodexExecutable
}

function Confirm-BcCodexAction {
  param([string]$Text)
  $owner = $null
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
    $owner = New-Object System.Windows.Forms.Form
    $owner.ShowInTaskbar = $false
    $owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
    $owner.Size = New-Object System.Drawing.Size(1, 1)
    $owner.Opacity = 0
    $owner.TopMost = $true
    $owner.Show()
    $owner.Activate()
    $result = [System.Windows.Forms.MessageBox]::Show(
      $owner,
      $Text,
      "beautiCode",
      [System.Windows.Forms.MessageBoxButtons]::YesNo,
      [System.Windows.Forms.MessageBoxIcon]::Warning,
      [System.Windows.Forms.MessageBoxDefaultButton]::Button2
    )
    return $result -eq [System.Windows.Forms.DialogResult]::Yes
  } catch {
    return $false
  } finally {
    if ($null -ne $owner) {
      try { $owner.Close() } catch {}
      try { $owner.Dispose() } catch {}
    }
  }
}

function Start-CodexWithCdpFast([int]$CdpPort) {
  if ($CdpPort -le 0 -or $CdpPort -gt 65535) {
    $CdpPort = Get-BcLoopbackCdpPort
  }
  try {
    $result = Start-BcCodexWithCdp -CdpPort $CdpPort
    if ($result.Method -eq "executable") {
      Write-BcLog ("started Codex exe={0} port={1}" -f $result.Executable, $result.Port)
    } else {
      Write-BcLog ("launched Codex via AppsFolder appId={0}; custom CDP args may be ignored" -f $result.AppUserModelId)
    }
    return $true
  } catch {
    Write-BcLog ("Codex 启动失败：{0}" -f $_.Exception.Message)
    return $false
  }
}

function Start-BcTray([int]$CdpPort) {
  [void](Start-BcTrayProcess `
    -InstallRoot $RepoRoot `
    -TargetHost codex `
    -Port $CdpPort `
    -SkipBuild:(Test-Path -LiteralPath $ReleaseManifest -PathType Leaf))
  Write-BcLog ("started tray Port={0} FreshnessCheck=True" -f $CdpPort)
}

try {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  Write-BcLog ("launcher start Port={0} ForceRestart={1}" -f $Port, [bool]$ForceRestart)

  $launcherCreated = $false
  $script:launcherMutex = [System.Threading.Mutex]::new(
    $true,
    $LauncherMutexName,
    [ref]$launcherCreated
  )
  if (-not $launcherCreated) {
    Write-BcLog "launcher already active mutex=True"
    if (-not $NoLaunchCodex) {
      [void](Request-BcTrayPanel -WaitMilliseconds 5000)
    }
    exit 0
  }
  $script:launcherMutexOwned = $true

  if (-not (Test-Path -LiteralPath $TrayScript)) {
    throw "缺少托盘脚本：$TrayScript"
  }

  $trayAlreadyRunning = $false
  if ($ForceRestart) {
    foreach ($procId in @(Get-BcTrayPids)) {
      try { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue } catch {}
    }
    Start-Sleep -Milliseconds 400
  } else {
    # The tray owns this process-lifetime mutex. Checking it avoids the
    # 0.3-1.0s Win32_Process scan on every normal launch.
    $trayAlreadyRunning = Test-BcTrayRunningFast
    if ($trayAlreadyRunning -and $NoLaunchCodex) {
      Write-BcLog "engine already running mutex=True NoLaunchCodex=True"
      # Windows logon startup stays silent and never opens/restarts Codex.
      exit 0
    }
  }

  # 1) Fast CDP probe (preferred port only, ~100–300ms worst case miss).
  $cdpPort = Find-BcCdpPortFast -Preferred $Port

  $codexExecutable = Get-CodexMainExeFast
  $codexAlreadyRunning = (@(Get-BcCodexMainProcesses).Count -gt 0)
  $launchPort = if ($cdpPort -gt 0) {
    $cdpPort
  } elseif ($Port -gt 0) {
    $Port
  } elseif ($codexExecutable) {
    Get-BcLoopbackCdpPort
  } else {
    0
  }

  # 2) Spawn the tray before AppX lookup / Codex cold start. The session-host
  #    connects in the background, so neither task needs to block tray startup.
  #    Port 0 → session-host auto-discovers in background.
  # Preserve an explicitly requested port while Codex is still starting.
  $trayPort = if ($cdpPort -gt 0) {
    $cdpPort
  } elseif ($Port -gt 0) {
    $Port
  } elseif ($launchPort -gt 0) {
    $launchPort
  } else {
    0
  }
  if ($trayAlreadyRunning) {
    Write-BcLog "engine already running mutex=True - checking Codex match"
  } else {
    Start-BcTray -CdpPort $trayPort
    Write-BcLog ("tray spawned in {0}ms" -f $sw.ElapsedMilliseconds)
  }
  if (-not $NoLaunchCodex) {
    [void](Request-BcTrayPanel -WaitMilliseconds 5000)
  }

  # 3) If no CDP, kick Codex launch after the tray process is already running.
  #    The session-host watch loop attaches when CDP appears.
  if ($cdpPort -le 0 -and -not $NoLaunchCodex) {
    if ($codexAlreadyRunning) {
      # A normal Codex launch may not expose CDP. Never kill it silently:
      # ask once, close gracefully, then relaunch with loopback CDP so the
      # session-host watcher can import the active background immediately.
      $accepted = Confirm-BcCodexAction -Text "ChatGPT/Codex 已在运行，但未发现可用的 CDP 端点。`n`n若要让 beautiCode 连接此窗口并恢复当前背景，必须安全重启 ChatGPT/Codex。未保存的内容可能会丢失。现在重启吗？"
      if ($accepted) {
        Write-BcLog "no CDP and Codex already running - user accepted restart"
        $stopped = $false
        try {
          $stopped = Stop-BcCodexGracefully
        } catch {
          Write-BcLog ("Codex graceful stop failed: {0}" -f $_.Exception.Message)
          $stopped = $false
        }
        if (-not $stopped) {
          Write-BcLog "Codex did not exit gracefully - asking to force close"
          $forceAccepted = Confirm-BcCodexAction -Text "ChatGPT/Codex 未能在超时时间内安全退出。`n`n是否强制结束剩余进程并重新打开？未保存的内容可能会丢失。"
          if ($forceAccepted) {
            Write-BcLog "user accepted force close"
            try {
              $stopped = Stop-BcCodexForcefully
            } catch {
              Write-BcLog ("Codex force stop failed: {0}" -f $_.Exception.Message)
              $stopped = $false
            }
          } else {
            Write-BcLog "user declined force close"
          }
        }
        if ($stopped) {
          if (Start-CodexWithCdpFast -CdpPort $launchPort) {
            $readyPort = Wait-BcCdpReady -Preferred $launchPort -WaitSeconds 15
            if ($readyPort -gt 0) {
              $cdpPort = $readyPort
              Write-BcLog ("Codex CDP ready port={0}" -f $readyPort)
              [void](Request-BcTrayPanel)
            } else {
              Write-BcLog ("Codex CDP readiness timed out preferredPort={0}" -f $launchPort)
              Show-BcMessage -Icon "Warning" -Text "ChatGPT/Codex 已重新打开，但 CDP 尚未就绪。beautiCode 会继续在后台连接；若稍后仍未恢复，请从托盘重试。"
            }
          } else {
            Show-BcMessage -Icon "Error" -Text "无法通过本机 CDP 端点重新打开 ChatGPT/Codex。请查看 beautiCode 启动日志后重试。"
          }
        } else {
          Write-BcLog "Codex restart aborted: process still running"
          Show-BcMessage -Icon "Warning" -Text "Codex 仍在运行，重启已取消。请手动关闭 ChatGPT/Codex 后，使用托盘中的“应用或重新应用”重试。"
        }
      } else {
        Write-BcLog "no CDP and Codex already running - user declined restart"
      }
    } else {
      $accepted = Confirm-BcCodexAction -Text "ChatGPT/Codex 当前未运行。`n`n是否通过本机 CDP 端点打开它，以便 beautiCode 连接窗口并恢复当前背景？"
      if ($accepted) {
        Write-BcLog "no CDP and Codex not running - user accepted launch"
        if (Start-CodexWithCdpFast -CdpPort $launchPort) {
          $readyPort = Wait-BcCdpReady -Preferred $launchPort -WaitSeconds 15
          if ($readyPort -gt 0) {
            $cdpPort = $readyPort
            Write-BcLog ("Codex CDP ready port={0}" -f $readyPort)
            [void](Request-BcTrayPanel)
          } else {
            Write-BcLog ("Codex CDP readiness timed out preferredPort={0}" -f $launchPort)
            Show-BcMessage -Icon "Warning" -Text "ChatGPT/Codex 已打开，但 CDP 尚未就绪。beautiCode 会继续在后台连接；若稍后仍未恢复，请从托盘重试。"
          }
        } else {
          Show-BcMessage -Icon "Error" -Text "无法通过本机 CDP 端点打开 ChatGPT/Codex。请查看 beautiCode 启动日志后重试。"
        }
      } else {
        Write-BcLog "no CDP and Codex not running - user declined launch"
      }
    }
  }

  $sw.Stop()
  Write-BcLog ("launcher done in {0}ms cdp={1}" -f $sw.ElapsedMilliseconds, $cdpPort)
  exit 0
}
catch {
  Write-BcLog ("启动器失败：{0}" -f $_.Exception.Message)
  Show-BcMessage -Icon "Error" -Text ("beautiCode 引擎启动失败：`n{0}`n`n日志：{1}" -f $_.Exception.Message, $LogPath)
  exit 1
}
finally {
  if ($null -ne $script:launcherMutex) {
    if ($script:launcherMutexOwned) {
      try { $script:launcherMutex.ReleaseMutex() } catch {}
      $script:launcherMutexOwned = $false
    }
    try { $script:launcherMutex.Dispose() } catch {}
    $script:launcherMutex = $null
  }
}
