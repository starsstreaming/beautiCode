#Requires -Version 5.1
param(
  [string]$DshUrl = "http://127.0.0.1:3080",
  [string]$DataRoot = "",
  [switch]$SkipBuild,
  [switch]$NoBrowser,
  [switch]$EnsureBridgeOnly,
  [string]$DshCommand = "",
  [switch]$VersionOnly,
  [switch]$NoVersionCheck
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$trayScript = Join-Path $repoRoot "apps\tray\start-tray.ps1"
$pluginSourceRoot = Join-Path $repoRoot "integrations\deepseek-harness"
$compatibilityFile = Join-Path $pluginSourceRoot "compatibility.json"
$runtimeInstaller = Join-Path $repoRoot "scripts\install-dsh-runtime.ps1"

if (-not (Test-Path -LiteralPath $compatibilityFile -PathType Leaf)) {
  throw "缺少 DSH 兼容性清单：$compatibilityFile"
}
$compatibility = Get-Content -Raw -LiteralPath $compatibilityFile | ConvertFrom-Json
if ($compatibility.schema -ne "beauticode.dsh-compatibility/v1") {
  throw "DSH 兼容性清单版本无效。"
}
$supportedVersion = [string]$compatibility.supportedVersion
$bridgeProtocol = [int]$compatibility.bridgeProtocol

function ConvertTo-BcDshUrl {
  param([string]$Value)
  $uri = [Uri]$Value
  if (
    $uri.Scheme -ne "http" -or
    $uri.Host -notin @("127.0.0.1", "localhost", "::1") -or
    $uri.UserInfo -or
    ($uri.AbsolutePath -and $uri.AbsolutePath -ne "/") -or
    $uri.Query -or
    $uri.Fragment
  ) {
    throw "DSH 地址必须是本机 HTTP 根地址，例如 http://127.0.0.1:3080。"
  }
  return $uri
}

function Get-BcFileSha256 {
  param([string]$Path)
  $stream = $null
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $stream = [IO.File]::OpenRead($Path)
    return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
    $sha.Dispose()
  }
}

function Get-BcBridgeRevision {
  param([string]$SourceRoot)
  $parts = @()
  foreach ($name in @("index.mjs", "client.js")) {
    $file = Join-Path $SourceRoot $name
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
      throw "DSH 桥接文件缺失：$file"
    }
    $parts += ("{0}:{1}" -f $name, (Get-BcFileSha256 -Path $file))
  }
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $digest = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($parts -join "`n")))
    return -join ($digest | ForEach-Object { $_.ToString("x2") })
  } finally {
    $sha.Dispose()
  }
}

function Install-BcBridgeRevision {
  param([string]$SourceRoot, [string]$EffectiveDshHome)
  $revision = Get-BcBridgeRevision -SourceRoot $SourceRoot
  $versionsRoot = Join-Path $EffectiveDshHome "beauticode-bridge\versions"
  $targetRoot = Join-Path $versionsRoot $revision
  $targetIndex = Join-Path $targetRoot "index.mjs"
  if (Test-Path -LiteralPath $targetRoot -PathType Container) {
    if ((Get-BcBridgeRevision -SourceRoot $targetRoot) -ne $revision) {
      throw "已发布的 DSH 桥接版本内容已损坏：$targetRoot"
    }
    return [pscustomobject]@{ Revision = $revision; Index = $targetIndex; Root = $targetRoot }
  }

  [IO.Directory]::CreateDirectory($versionsRoot) | Out-Null
  $stagingRoot = Join-Path $versionsRoot (".staging-{0}-{1}" -f $PID, [guid]::NewGuid().ToString("N"))
  try {
    [IO.Directory]::CreateDirectory($stagingRoot) | Out-Null
    Copy-Item -LiteralPath (Join-Path $SourceRoot "index.mjs") -Destination $stagingRoot
    Copy-Item -LiteralPath (Join-Path $SourceRoot "client.js") -Destination $stagingRoot
    $manifest = [ordered]@{
      schema = "beauticode.dsh-bridge/v1"
      protocol = $bridgeProtocol
      revision = $revision
      publishedAtUtc = [DateTime]::UtcNow.ToString("o")
    }
    [IO.File]::WriteAllText(
      (Join-Path $stagingRoot "bridge-manifest.json"),
      ($manifest | ConvertTo-Json),
      (New-Object Text.UTF8Encoding($false))
    )
    try {
      Move-Item -LiteralPath $stagingRoot -Destination $targetRoot
    } catch {
      if (-not (Test-Path -LiteralPath $targetRoot -PathType Container)) { throw }
    }
  } finally {
    if (Test-Path -LiteralPath $stagingRoot) {
      Remove-Item -LiteralPath $stagingRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  return [pscustomobject]@{ Revision = $revision; Index = $targetIndex; Root = $targetRoot }
}

function Get-BcDshBridgeInfo {
  param([Uri]$BaseUri)
  try {
    $probe = Invoke-RestMethod -UseBasicParsing -Uri ([Uri]::new($BaseUri, "/__beauticode/version")) -TimeoutSec 2
    if ($probe.ok -eq $true -and $probe.protocol -is [int] -and $probe.revision -is [string]) {
      return $probe
    }
  } catch {}
  return $null
}

function Test-BcDshServer {
  param([Uri]$BaseUri)
  $client = New-Object Net.Sockets.TcpClient
  try {
    $connect = $client.BeginConnect($BaseUri.Host, $BaseUri.Port, $null, $null)
    if (-not $connect.AsyncWaitHandle.WaitOne(750)) { return $false }
    $client.EndConnect($connect)
    return $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Get-BcNodePath {
  $bundled = Join-Path $repoRoot "runtime\node.exe"
  if (Test-Path -LiteralPath $bundled -PathType Leaf) { return $bundled }
  $node = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($node) { return $node.Source }
  return $null
}

function Get-BcRuntimeFromRoot {
  param([string]$RuntimeRoot, [string]$NodePath, [string]$Source)
  $manifestPath = Join-Path $RuntimeRoot "current.json"
  if (-not $NodePath -or -not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { return $null }
  try {
    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    if (
      $manifest.schema -ne "beauticode.dsh-runtime/v1" -or
      $manifest.package -ne [string]$compatibility.package -or
      $manifest.version -ne $supportedVersion -or
      $manifest.integrity -ne [string]$compatibility.integrity
    ) { return $null }
    $cli = [string]$manifest.cli
    if (-not [IO.Path]::IsPathRooted($cli)) { $cli = Join-Path $RuntimeRoot $cli }
    if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) { return $null }
    $output = @(& $NodePath $cli --version 2>&1)
    $version = ([string]($output | Select-Object -First 1)).Trim()
    if ($LASTEXITCODE -ne 0 -or $version -ne $supportedVersion) { return $null }
    return [pscustomobject]@{
      FilePath = $NodePath
      Arguments = @('"{0}"' -f $cli.Replace('"', '\"'))
      Version = $version
      Source = $Source
      Root = $RuntimeRoot
    }
  } catch {
    return $null
  }
}

function Get-BcDshRuntime {
  param([string]$PrivateRuntimeRoot, [switch]$AllowInstall)
  if ($DshCommand) {
    if (-not (Test-Path -LiteralPath $DshCommand -PathType Leaf)) {
      throw "指定的 DSH 命令不存在：$DshCommand"
    }
    $command = (Resolve-Path -LiteralPath $DshCommand).Path
    $output = @(& $command --version 2>&1)
    $version = ([string]($output | Select-Object -First 1)).Trim()
    if ($LASTEXITCODE -ne 0 -or $version -ne $supportedVersion) {
      throw "指定的 DSH 版本不兼容：需要 $supportedVersion，实际 $version。"
    }
    return [pscustomobject]@{
      FilePath = $command; Arguments = @(); Version = $version; Source = "override"; Root = ""
    }
  }

  $nodePath = Get-BcNodePath
  $bundledRoot = Join-Path $repoRoot "runtime\dsh"
  $runtime = Get-BcRuntimeFromRoot -RuntimeRoot $bundledRoot -NodePath $nodePath -Source "bundled"
  if ($runtime) { return $runtime }
  $runtime = Get-BcRuntimeFromRoot -RuntimeRoot $PrivateRuntimeRoot -NodePath $nodePath -Source "private"
  if ($runtime -or -not $AllowInstall) { return $runtime }

  if (-not $nodePath) { throw "未找到 Node.js，无法创建 beautiCode 私有 DSH 运行时。" }
  $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $npm) { throw "未找到 npm.cmd，无法创建 beautiCode 私有 DSH 运行时。" }
  & $runtimeInstaller `
    -InstallRoot $PrivateRuntimeRoot `
    -CompatibilityFile $compatibilityFile `
    -NodeCommand $nodePath `
    -NpmCommand $npm.Source
  $runtime = Get-BcRuntimeFromRoot -RuntimeRoot $PrivateRuntimeRoot -NodePath $nodePath -Source "private"
  if (-not $runtime) { throw "DSH 私有运行时安装后校验失败。" }
  return $runtime
}

function Get-BcLatestDshVersion {
  param([string]$EffectiveDataRoot)
  if ($NoVersionCheck) { return $null }
  $cachePath = Join-Path $EffectiveDataRoot "dsh-version-check.json"
  try {
    if (Test-Path -LiteralPath $cachePath -PathType Leaf) {
      $cache = Get-Content -Raw -LiteralPath $cachePath | ConvertFrom-Json
      $checkedAt = [DateTime]::Parse([string]$cache.checkedAtUtc).ToUniversalTime()
      if ([DateTime]::UtcNow - $checkedAt -lt [TimeSpan]::FromHours(24)) {
        return [string]$cache.latestVersion
      }
    }
  } catch {}
  try {
    $latest = Invoke-RestMethod -UseBasicParsing -Uri "https://registry.npmjs.org/@deepseek-ai%2fdsh/latest" -TimeoutSec 5
    $version = [string]$latest.version
    if ($version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') { return $null }
    [IO.Directory]::CreateDirectory($EffectiveDataRoot) | Out-Null
    $cache = [ordered]@{
      schema = "beauticode.dsh-version-check/v1"
      latestVersion = $version
      checkedAtUtc = [DateTime]::UtcNow.ToString("o")
    }
    [IO.File]::WriteAllText($cachePath, ($cache | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
    return $version
  } catch {
    return $null
  }
}

function New-BcDshPatch {
  param([string]$BridgePluginPath, [string]$Revision)
  $patchRoot = Join-Path ([IO.Path]::GetTempPath()) "beautiCode\dsh-patches"
  [IO.Directory]::CreateDirectory($patchRoot) | Out-Null
  $patchPath = Join-Path $patchRoot ("beauticode-bridge-{0}.yml" -f $Revision)
  $pluginUri = ([Uri](Resolve-Path -LiteralPath $BridgePluginPath).Path).AbsoluteUri
  $content = @(
    "- insert:"
    "    - id: beauticode-bridge"
    ("      name: '{0}'" -f $pluginUri.Replace("'", "''"))
    "      inject: [webServer]"
    ""
  ) -join "`r`n"
  [IO.File]::WriteAllText($patchPath, $content, (New-Object Text.UTF8Encoding($false)))
  return $patchPath
}

function Start-BcDshBridge {
  param(
    [Uri]$BaseUri,
    [pscustomobject]$Bridge,
    [pscustomobject]$Runtime,
    [string]$EffectiveDataRoot,
    [string]$EffectiveDshHome
  )
  $port = if ($BaseUri.IsDefaultPort) { 80 } else { $BaseUri.Port }
  $patchPath = New-BcDshPatch -BridgePluginPath $Bridge.Index -Revision $Bridge.Revision
  $quotedPatchPath = '"{0}"' -f $patchPath.Replace('"', '\"')
  $arguments = @($Runtime.Arguments) + @("web", "--patch", $quotedPatchPath, "--port", [string]$port)

  $logRoot = Join-Path ([IO.Path]::GetTempPath()) "beautiCode\dsh-logs"
  [IO.Directory]::CreateDirectory($logRoot) | Out-Null
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $stdout = Join-Path $logRoot ("dsh-{0}.out.log" -f $stamp)
  $stderr = Join-Path $logRoot ("dsh-{0}.err.log" -f $stamp)
  $oldDataRoot = $env:BEAUTICODE_DATA_ROOT
  $oldDshHome = $env:DSH_HOME
  $processEnvironment = [Environment]::GetEnvironmentVariables()
  $pathKeys = @($processEnvironment.Keys | Where-Object { $_ -ieq "path" })
  $duplicatePath = $pathKeys.Count -gt 1 -and $pathKeys -contains "PATH"
  $oldUpperPath = if ($duplicatePath) { $processEnvironment["PATH"] } else { $null }
  try {
    if ($duplicatePath) { [Environment]::SetEnvironmentVariable("PATH", $null, "Process") }
    $env:BEAUTICODE_DATA_ROOT = $EffectiveDataRoot
    $env:DSH_HOME = $EffectiveDshHome
    $process = Start-Process `
      -FilePath $Runtime.FilePath `
      -ArgumentList $arguments `
      -WorkingDirectory $repoRoot `
      -WindowStyle Hidden `
      -RedirectStandardOutput $stdout `
      -RedirectStandardError $stderr `
      -PassThru
  } finally {
    if ($null -eq $oldDataRoot) { Remove-Item Env:BEAUTICODE_DATA_ROOT -ErrorAction SilentlyContinue } else { $env:BEAUTICODE_DATA_ROOT = $oldDataRoot }
    if ($null -eq $oldDshHome) { Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue } else { $env:DSH_HOME = $oldDshHome }
    if ($duplicatePath) { [Environment]::SetEnvironmentVariable("PATH", $oldUpperPath, "Process") }
  }

  Write-Host ("正在启动 DeepSeek Harness {0}（PID {1}）……" -f $Runtime.Version, $process.Id)
  $deadline = (Get-Date).AddSeconds(300)
  while ((Get-Date) -lt $deadline) {
    $identity = Get-BcDshBridgeInfo -BaseUri $BaseUri
    if ($identity -and $identity.protocol -eq $bridgeProtocol -and $identity.revision -eq $Bridge.Revision) {
      return [pscustomobject]@{ Process = $process; Stdout = $stdout; Stderr = $stderr }
    }
    if ($process.HasExited) {
      $process.Refresh()
      $rawDetail = if (Test-Path -LiteralPath $stderr) { Get-Content -Raw -LiteralPath $stderr } else { "" }
      $detail = if ($rawDetail) { $rawDetail.Trim() } else { "" }
      throw ("DeepSeek Harness 启动失败（退出码 {0}）。{1}`n日志：{2}" -f $process.ExitCode, $detail, $stderr)
    }
    Start-Sleep -Milliseconds 500
  }
  throw ("等待 DeepSeek Harness 桥接超时。日志：{0} / {1}" -f $stdout, $stderr)
}

$baseUri = ConvertTo-BcDshUrl -Value $DshUrl
$effectiveDataRoot = if ($DataRoot) {
  [IO.Path]::GetFullPath($DataRoot)
} elseif ($env:LOCALAPPDATA) {
  Join-Path $env:LOCALAPPDATA "beautiCode"
} else {
  Join-Path $env:APPDATA "beautiCode"
}
$effectiveDshHome = "{0}-dsh-home" -f $effectiveDataRoot.TrimEnd("\", "/")
$privateRuntimeRoot = Join-Path $effectiveDataRoot "dsh-runtime"
$runtime = Get-BcDshRuntime -PrivateRuntimeRoot $privateRuntimeRoot -AllowInstall:(-not $VersionOnly)
$latestVersion = Get-BcLatestDshVersion -EffectiveDataRoot $effectiveDataRoot

if ($VersionOnly) {
  $runningBridge = Get-BcDshBridgeInfo -BaseUri $baseUri
  [pscustomobject]@{
    schema = "beauticode.dsh-version/v1"
    supportedVersion = $supportedVersion
    installedVersion = if ($runtime) { $runtime.Version } else { $null }
    installedSource = if ($runtime) { $runtime.Source } else { $null }
    latestVersion = $latestVersion
    updateAvailable = [bool]($latestVersion -and $latestVersion -ne $supportedVersion)
    bridgeProtocol = $bridgeProtocol
    runningBridge = $runningBridge
  } | ConvertTo-Json -Depth 5
  return
}

if (-not $runtime) { throw "未找到兼容的 DeepSeek Harness $supportedVersion 运行时。" }
$bridge = Install-BcBridgeRevision -SourceRoot $pluginSourceRoot -EffectiveDshHome $effectiveDshHome

Write-Host "beautiCode · DeepSeek Harness"
Write-Host ("DSH {0}（{1}）；桥接协议 {2}，版本 {3}。" -f $runtime.Version, $runtime.Source, $bridgeProtocol, $bridge.Revision.Substring(0, 12))
if ($latestVersion -and $latestVersion -ne $supportedVersion) {
  Write-Warning ("检测到 npm 最新 DSH {0}；当前兼容版本仍为 {1}，不会自动升级未经验证的 DSH。" -f $latestVersion, $supportedVersion)
}

$runningBridge = Get-BcDshBridgeInfo -BaseUri $baseUri
if ($runningBridge) {
  if ($runningBridge.protocol -eq $bridgeProtocol -and $runningBridge.revision -eq $bridge.Revision) {
    Write-Host ("复用已加载当前 beautiCode 桥接的 DSH：{0}" -f $baseUri.AbsoluteUri)
  } else {
    throw ("目标地址正在运行旧版 beautiCode 桥接（协议 {0}，版本 {1}）。插件已更新到 {2}，但为避免中断现有会话不会自动重启；请关闭该 DSH 后重新运行此启动器。" -f $runningBridge.protocol, $runningBridge.revision, $bridge.Revision.Substring(0, 12))
  }
} elseif (Test-BcDshServer -BaseUri $baseUri) {
  throw "目标地址已有 DeepSeek Harness，但未加载 beautiCode 桥接。为避免中断现有会话，脚本不会自动重启；请关闭该 DSH 后重新运行此启动器。"
} else {
  $started = Start-BcDshBridge `
    -BaseUri $baseUri `
    -Bridge $bridge `
    -Runtime $runtime `
    -EffectiveDataRoot $effectiveDataRoot `
    -EffectiveDshHome $effectiveDshHome
  Write-Host ("DeepSeek Harness 桥接已就绪；退出托盘时不会自动结束该进程。日志：{0}" -f $started.Stdout)
}

if ($EnsureBridgeOnly) { return }
if (-not $NoBrowser) { Start-Process -FilePath $baseUri.AbsoluteUri | Out-Null }

$arguments = @{
  TargetHost = "dsh"
  DshUrl = $baseUri.AbsoluteUri
  SkipBuild = $SkipBuild
  DataRoot = $effectiveDataRoot
}
& $trayScript @arguments
