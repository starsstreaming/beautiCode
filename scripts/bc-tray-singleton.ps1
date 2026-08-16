#Requires -Version 5.1
# Shared tray singleton: v2 mutex names, abandoned-lock takeover, and a
# strict live-process check. Launchers must not treat "mutex exists" or a
# command line that merely mentions start-tray.ps1 as a running tray.

$script:BcTrayMutexName = "Local\beautiCode.Engine.Tray.v2"
$script:BcTrayPanelEventName = "Local\beautiCode.Engine.ShowPanel.v2"
$script:BcTrayShutdownEventName = "Local\beautiCode.Engine.Shutdown.v2"

function Get-BcTrayMutexName { $script:BcTrayMutexName }
function Get-BcTrayPanelEventName { $script:BcTrayPanelEventName }
function Get-BcTrayShutdownEventName { $script:BcTrayShutdownEventName }
function Get-BcHostMutexName {
  param([ValidateSet("codex", "dsh")][string]$TargetHost)
  return ("Local\beautiCode.Engine.Host.{0}.v2" -f $TargetHost)
}

function Test-BcTrayCommandLine {
  param([string]$CommandLine)
  if (-not $CommandLine) { return $false }
  return [bool]($CommandLine -match '(?i)(?:^|\s)-File\s+(?:"[^"]*\\|)?(?:[^\s"]*\\)?start-tray\.ps1(?:["\s]|$)')
}

function Get-BcLiveTrayProcesses {
  $matches = New-Object System.Collections.ArrayList
  try {
    Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe' OR Name = 'pwsh.exe'" -ErrorAction SilentlyContinue |
      Where-Object { Test-BcTrayCommandLine -CommandLine $_.CommandLine } |
      ForEach-Object { [void]$matches.Add($_) }
  } catch {}
  return @($matches)
}

function Test-BcTrayProcessAlive {
  return [bool](Get-BcLiveTrayProcesses | Select-Object -First 1)
}

function Test-BcTrayLockPresent {
  $mutex = $null
  try {
    $mutex = [System.Threading.Mutex]::OpenExisting((Get-BcTrayMutexName))
    return $true
  } catch [System.Threading.WaitHandleCannotBeOpenedException] {
    return $false
  } catch {
    return $false
  } finally {
    if ($null -ne $mutex) { try { $mutex.Dispose() } catch {} }
  }
}

function Test-BcTrayReady {
  return ((Test-BcTrayProcessAlive) -and (Test-BcTrayLockPresent))
}

function Enter-BcNamedMutex {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [int]$TimeoutMs = 0
  )
  $createdNew = $false
  $mutex = [System.Threading.Mutex]::new($false, $Name, [ref]$createdNew)
  $owned = $false
  try {
    $owned = $mutex.WaitOne([Math]::Max(0, $TimeoutMs))
  } catch [System.Threading.AbandonedMutexException] {
    $owned = $true
  }
  if (-not $owned) {
    try { $mutex.Dispose() } catch {}
    return [pscustomobject]@{ Mutex = $null; Owned = $false; Created = $createdNew }
  }
  return [pscustomobject]@{ Mutex = $mutex; Owned = $true; Created = $createdNew }
}

function Send-BcNamedEvent {
  param([Parameter(Mandatory = $true)][string]$Name)
  $event = $null
  try {
    $event = [System.Threading.EventWaitHandle]::OpenExisting($Name)
    [void]$event.Set()
    return $true
  } catch [System.Threading.WaitHandleCannotBeOpenedException] {
    return $false
  } catch {
    return $false
  } finally {
    if ($null -ne $event) { try { $event.Dispose() } catch {} }
  }
}

function Request-BcTrayPanelEvent {
  return (Send-BcNamedEvent -Name (Get-BcTrayPanelEventName))
}

function Request-BcTrayShutdownEvent {
  return (Send-BcNamedEvent -Name (Get-BcTrayShutdownEventName))
}

function Start-BcTrayProcess {
  param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [ValidateSet("codex", "dsh")][string]$TargetHost = "dsh",
    [string]$DshUrl = "http://127.0.0.1:3080",
    [string]$DataRoot = "",
    [int]$Port = 0,
    [switch]$SkipBuild,
    [int]$TimeoutSeconds = 15
  )
  if (Test-BcTrayReady) {
    [void](Request-BcTrayPanelEvent)
    return [pscustomobject]@{ Started = $false; Alive = $true }
  }

  $trayScript = Join-Path $InstallRoot "apps\tray\start-tray.ps1"
  if (-not (Test-Path -LiteralPath $trayScript -PathType Leaf)) {
    throw "缺少托盘脚本：$trayScript"
  }

  $argList = New-Object System.Collections.Generic.List[string]
  [void]$argList.Add("-NoProfile")
  [void]$argList.Add("-ExecutionPolicy")
  [void]$argList.Add("Bypass")
  [void]$argList.Add("-File")
  [void]$argList.Add($trayScript)
  [void]$argList.Add("-TargetHost")
  [void]$argList.Add($TargetHost)
  if ($TargetHost -eq "dsh") {
    [void]$argList.Add("-DshUrl")
    [void]$argList.Add($DshUrl)
    if ($DataRoot) {
      [void]$argList.Add("-DataRoot")
      [void]$argList.Add($DataRoot)
    }
  } elseif ($Port -gt 0) {
    [void]$argList.Add("-Port")
    [void]$argList.Add("$Port")
  }
  if ($SkipBuild) { [void]$argList.Add("-SkipBuild") }

  $quoted = foreach ($a in $argList) {
    if ($a -match '[\s"]') { '"{0}"' -f ($a -replace '"', '\"') } else { $a }
  }

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = (Get-Command powershell.exe).Source
  $psi.Arguments = ($quoted -join " ")
  $psi.WorkingDirectory = $InstallRoot
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $proc = [System.Diagnostics.Process]::Start($psi)
  if ($null -eq $proc) {
    throw "无法创建 beautiCode 托盘进程。"
  }

  $deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(3, $TimeoutSeconds))
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-BcTrayReady) {
      [void](Request-BcTrayPanelEvent)
      return [pscustomobject]@{ Started = $true; Alive = $true }
    }
    if ($proc.HasExited) {
      throw ("beautiCode 托盘进程立即退出（代码 {0}）。日志：{1}" -f $proc.ExitCode, (Join-Path $env:LOCALAPPDATA "beautiCode\logs\tray.log"))
    }
    Start-Sleep -Milliseconds 120
  }
  throw "beautiCode 托盘未在超时内出现。"
}
