#Requires -Version 5.1
param(
  [string]$DshUrl = "http://127.0.0.1:3080",
  [string]$DataRoot = "",
  [switch]$SkipBuild,
  [switch]$NoBrowser,
  [switch]$EnsureBridgeOnly,
  [switch]$HealOnly,
  [string]$DshCommand = "",
  [switch]$VersionOnly,
  [switch]$NoVersionCheck
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
. (Join-Path $repoRoot "scripts\bc-tray-singleton.ps1")
$trayScript = Join-Path $repoRoot "apps\tray\start-tray.ps1"
$pluginSourceRoot = Join-Path $repoRoot "integrations\deepseek-harness"
$compatibilityFile = Join-Path $pluginSourceRoot "compatibility.json"
$runtimeInstaller = Join-Path $repoRoot "scripts\install-dsh-runtime.ps1"
$healScript = Join-Path $repoRoot "scripts\heal-dsh-profile.mjs"

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
    $manifestPath = Join-Path $targetRoot "bridge-manifest.json"
    $publishedRevision = $null
    try {
      if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
        $publishedRevision = [string](Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json).revision
      }
    } catch {}
    if ($publishedRevision -ne $revision) {
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

function Test-BcDshServer {
  param(
    [Uri]$BaseUri,
    [int]$WaitMilliseconds = 80
  )
  $client = New-Object Net.Sockets.TcpClient
  try {
    $connect = $client.BeginConnect($BaseUri.Host, $BaseUri.Port, $null, $null)
    if (-not $connect.AsyncWaitHandle.WaitOne([Math]::Max(20, $WaitMilliseconds))) { return $false }
    $client.EndConnect($connect)
    return $client.Connected
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Get-BcDshVersionProbe {
  param([Uri]$BaseUri)
  if (-not (Test-BcDshServer -BaseUri $BaseUri -WaitMilliseconds 80)) {
    return [pscustomobject]@{ Kind = "down"; Identity = $null }
  }
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri ([Uri]::new($BaseUri, "/__beauticode/version")) -TimeoutSec 1
    $text = [string]$response.Content
    try {
      $probe = $text | ConvertFrom-Json
      if ($probe.ok -eq $true -and $probe.protocol -is [int] -and $probe.revision -is [string]) {
        return [pscustomobject]@{ Kind = "bridge"; Identity = $probe }
      }
    } catch {}
    return [pscustomobject]@{ Kind = "http"; Identity = $null }
  } catch {
    $httpResponse = $_.Exception.Response
    if ($null -ne $httpResponse) {
      return [pscustomobject]@{ Kind = "http"; Identity = $null }
    }
    return [pscustomobject]@{ Kind = "starting"; Identity = $null }
  }
}

function Get-BcDshBridgeInfo {
  param([Uri]$BaseUri)
  $probe = Get-BcDshVersionProbe -BaseUri $BaseUri
  if ($probe.Kind -eq "bridge") { return $probe.Identity }
  return $null
}

function Test-BcMatchingBridge {
  param([pscustomobject]$Identity, [pscustomobject]$Bridge)
  return [bool](
    $Identity -and
    $Identity.protocol -eq $bridgeProtocol -and
    $Identity.revision -eq $Bridge.Revision
  )
}

function Wait-BcDshOccupant {
  param(
    [Uri]$BaseUri,
    [pscustomobject]$Bridge,
    [int]$TimeoutSeconds = 45
  )
  $deadline = (Get-Date).AddSeconds([Math]::Max(2, $TimeoutSeconds))
  while ((Get-Date) -lt $deadline) {
    $probe = Get-BcDshVersionProbe -BaseUri $BaseUri
    if ($probe.Kind -eq "bridge") {
      if (Test-BcMatchingBridge -Identity $probe.Identity -Bridge $Bridge) {
        return [pscustomobject]@{ Kind = "ready"; Identity = $probe.Identity }
      }
      return [pscustomobject]@{ Kind = "foreign"; Identity = $probe.Identity }
    }
    if ($probe.Kind -eq "down") {
      return [pscustomobject]@{ Kind = "empty"; Identity = $null }
    }
    Start-Sleep -Milliseconds 100
  }
  return [pscustomobject]@{ Kind = "timeout"; Identity = $null }
}

function Enter-BcDshLaunchLock {
  param([int]$TimeoutSeconds = 180)
  $createdNew = $false
  $script:dshLaunchMutex = [System.Threading.Mutex]::new(
    $false,
    "Local\beautiCode.Engine.DshLaunch.v1",
    [ref]$createdNew
  )
  try {
    $script:dshLaunchMutexOwned = $script:dshLaunchMutex.WaitOne([TimeSpan]::FromSeconds([Math]::Max(5, $TimeoutSeconds)))
  } catch [System.Threading.AbandonedMutexException] {
    $script:dshLaunchMutexOwned = $true
  }
  if (-not $script:dshLaunchMutexOwned) {
    throw "另一个 beautiCode 正在启动 DeepSeek Harness，请稍后重试。"
  }
}

function Exit-BcDshLaunchLock {
  if ($script:dshLaunchMutexOwned -and $null -ne $script:dshLaunchMutex) {
    try { [void]$script:dshLaunchMutex.ReleaseMutex() } catch {}
    $script:dshLaunchMutexOwned = $false
  }
  if ($null -ne $script:dshLaunchMutex) {
    $script:dshLaunchMutex.Dispose()
    $script:dshLaunchMutex = $null
  }
}

function Get-BcDshLaunchFailureKind {
  param([string]$Stderr)
  $text = if ($Stderr -and (Test-Path -LiteralPath $Stderr)) {
    Get-Content -Raw -LiteralPath $Stderr
  } else {
    ""
  }
  if ($text -match "ERR_MODULE_NOT_FOUND|Cannot find package") { return "modules" }
  if ($text -match "EADDRINUSE|address already in use|EADDRNOTAVAIL") { return "port-busy" }
  if ($text -match "EPERM|EACCES") { return "locked" }
  return "crash"
}

function Get-BcDshInstallAnchor {
  param([pscustomobject]$Runtime)
  $cli = $null
  if ($Runtime.Arguments -and $Runtime.Arguments.Count -gt 0) {
    $cli = [string]$Runtime.Arguments[0]
    $cli = $cli.Trim().Trim('"')
  }
  if (-not $cli -or -not (Test-Path -LiteralPath $cli -PathType Leaf)) {
    return $null
  }
  $anchor = Join-Path (Split-Path (Split-Path $cli)) "package.json"
  if (-not (Test-Path -LiteralPath $anchor -PathType Leaf)) {
    throw "DSH 安装锚点缺失：$anchor"
  }
  return $anchor
}

function Invoke-BcHealDshProfile {
  param([pscustomobject]$Runtime, [string]$EffectiveDshHome)
  if (-not (Test-Path -LiteralPath $healScript -PathType Leaf)) {
    throw "缺少 DSH profile 修复脚本：$healScript"
  }
  $anchor = Get-BcDshInstallAnchor -Runtime $Runtime
  if (-not $anchor) {
    Write-Warning "未找到捆绑 DSH 安装锚点，跳过 profile 模块预热。"
    return
  }
  $output = & $Runtime.FilePath $healScript --dsh-home $EffectiveDshHome --install-anchor $anchor 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw ("预热 DSH profile 模块失败：{0}" -f (($output | ForEach-Object { [string]$_ }) -join "`n"))
  }
  Write-Host "DSH profile 模块已就绪。"
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
    # Trust the pinned current.json + CLI path. Spawning `dsh --version` on
    # every click only re-checks what the installer already verified.
    return [pscustomobject]@{
      FilePath = $NodePath
      Arguments = @('"{0}"' -f $cli.Replace('"', '\"'))
      Version = [string]$manifest.version
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

function Start-BcDshProcess {
  param(
    [Uri]$BaseUri,
    [pscustomobject]$Bridge,
    [pscustomobject]$Runtime,
    [string]$EffectiveDataRoot,
    [string]$EffectiveDshHome,
    [string]$WorkspaceRoot
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
  $oldTelemetry = $env:DSH_TELEMETRY_DISABLED
  $processEnvironment = [Environment]::GetEnvironmentVariables()
  $pathKeys = @($processEnvironment.Keys | Where-Object { $_ -ieq "path" })
  $duplicatePath = $pathKeys.Count -gt 1 -and $pathKeys -contains "PATH"
  $oldUpperPath = if ($duplicatePath) { $processEnvironment["PATH"] } else { $null }
  try {
    if ($duplicatePath) { [Environment]::SetEnvironmentVariable("PATH", $null, "Process") }
    $env:BEAUTICODE_DATA_ROOT = $EffectiveDataRoot
    $env:DSH_HOME = $EffectiveDshHome
    $env:DSH_TELEMETRY_DISABLED = "1"
    Remove-Item Env:NODE_COMPILE_CACHE -ErrorAction SilentlyContinue
    $process = Start-Process `
      -FilePath $Runtime.FilePath `
      -ArgumentList $arguments `
      -WorkingDirectory $WorkspaceRoot `
      -WindowStyle Hidden `
      -RedirectStandardOutput $stdout `
      -RedirectStandardError $stderr `
      -PassThru
  } finally {
    if ($null -eq $oldDataRoot) { Remove-Item Env:BEAUTICODE_DATA_ROOT -ErrorAction SilentlyContinue } else { $env:BEAUTICODE_DATA_ROOT = $oldDataRoot }
    if ($null -eq $oldDshHome) { Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue } else { $env:DSH_HOME = $oldDshHome }
    if ($null -eq $oldTelemetry) { Remove-Item Env:DSH_TELEMETRY_DISABLED -ErrorAction SilentlyContinue } else { $env:DSH_TELEMETRY_DISABLED = $oldTelemetry }
    if ($duplicatePath) { [Environment]::SetEnvironmentVariable("PATH", $oldUpperPath, "Process") }
  }

  Write-Host ("正在启动 DeepSeek Harness {0}（PID {1}）……" -f $Runtime.Version, $process.Id)
  return [pscustomobject]@{ Process = $process; Stdout = $stdout; Stderr = $stderr }
}

function Wait-BcDshBridge {
  param(
    [Uri]$BaseUri,
    [pscustomobject]$Bridge,
    [System.Diagnostics.Process]$Process,
    [string]$Stdout,
    [string]$Stderr,
    [int]$TimeoutSeconds = 300
  )
  $deadline = (Get-Date).AddSeconds([Math]::Max(5, $TimeoutSeconds))
  while ((Get-Date) -lt $deadline) {
    $identity = Get-BcDshBridgeInfo -BaseUri $BaseUri
    if ($identity -and $identity.protocol -eq $bridgeProtocol -and $identity.revision -eq $Bridge.Revision) {
      return $identity
    }
    if ($Process -and $Process.HasExited) {
      $Process.Refresh()
      $rawDetail = if ($Stderr -and (Test-Path -LiteralPath $Stderr)) { Get-Content -Raw -LiteralPath $Stderr } else { "" }
      $detail = if ($rawDetail) { $rawDetail.Trim() } else { "" }
      if ($detail.Length -gt 1200) { $detail = $detail.Substring(0, 1200) + "`n…" }
      throw ("DeepSeek Harness 启动失败（退出码 {0}）。{1}`n日志：{2}" -f $Process.ExitCode, $detail, $Stderr)
    }
    Start-Sleep -Milliseconds 100
  }
  throw ("等待 DeepSeek Harness 桥接超时。日志：{0} / {1}" -f $Stdout, $Stderr)
}

function Start-BcDshTray {
  param(
    [Uri]$BaseUri,
    [string]$EffectiveDataRoot
  )
  [void](Start-BcTrayProcess `
    -InstallRoot $repoRoot `
    -TargetHost dsh `
    -DshUrl $BaseUri.AbsoluteUri `
    -DataRoot $EffectiveDataRoot `
    -SkipBuild:$SkipBuild)
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
# DSH treats cwd as the default workspace. Do not launch from the install /
# repo root — that tree includes the bundled runtime (tens of thousands of
# files) and makes the first web boot crawl.
$dshWorkspace = Join-Path $effectiveDataRoot "dsh-workspace"
[IO.Directory]::CreateDirectory($dshWorkspace) | Out-Null
$runtime = Get-BcDshRuntime -PrivateRuntimeRoot $privateRuntimeRoot -AllowInstall:(-not $VersionOnly)

if ($VersionOnly) {
  $latestVersion = Get-BcLatestDshVersion -EffectiveDataRoot $effectiveDataRoot
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

function Show-BcDshTrayIfNeeded {
  if ($EnsureBridgeOnly) { return }
  Start-BcDshTray -BaseUri $baseUri -EffectiveDataRoot $effectiveDataRoot
}

function Wait-BcStartedDsh {
  param([pscustomobject]$Started)
  try {
    [void](Wait-BcDshBridge -BaseUri $baseUri -Bridge $bridge -Process $Started.Process -Stdout $Started.Stdout -Stderr $Started.Stderr)
    return $Started
  } catch {
    $kind = Get-BcDshLaunchFailureKind -Stderr $Started.Stderr
    if ($kind -eq "port-busy") {
      Write-Host "端口在启动瞬间被占用，改为等待现有进程……"
      $waited = Wait-BcDshOccupant -BaseUri $baseUri -Bridge $bridge -TimeoutSeconds 8
      if ($waited.Kind -eq "ready") { return $null }
    }
    throw
  }
}

$script:dshLaunchMutex = $null
$script:dshLaunchMutexOwned = $false
$started = $null
try {
  Enter-BcDshLaunchLock
  Invoke-BcHealDshProfile -Runtime $runtime -EffectiveDshHome $effectiveDshHome
  if ($HealOnly) { return }

  $attempts = 0
  while ($attempts -lt 2) {
    $attempts += 1
    $probe = Get-BcDshVersionProbe -BaseUri $baseUri
    if ($probe.Kind -eq "bridge") {
      if (Test-BcMatchingBridge -Identity $probe.Identity -Bridge $bridge) {
        Write-Host ("复用已加载当前 beautiCode 桥接的 DSH：{0}" -f $baseUri.AbsoluteUri)
        Show-BcDshTrayIfNeeded
        break
      }
      throw ("目标地址正在运行旧版 beautiCode 桥接（协议 {0}，版本 {1}）。插件已更新到 {2}，但为避免中断现有会话不会自动重启；请关闭该 DSH 后重新运行此启动器。" -f $probe.Identity.protocol, $probe.Identity.revision, $bridge.Revision.Substring(0, 12))
    }

    if ($probe.Kind -ne "down") {
      Write-Host "目标端口已有进程，正在确认是否可复用……"
      Show-BcDshTrayIfNeeded
      $waited = Wait-BcDshOccupant -BaseUri $baseUri -Bridge $bridge -TimeoutSeconds 8
      if ($waited.Kind -eq "ready") {
        Write-Host ("复用正在启动的 DeepSeek Harness：{0}" -f $baseUri.AbsoluteUri)
        break
      }
      if ($waited.Kind -eq "foreign") {
        throw "目标地址已有 DeepSeek Harness，但未加载 beautiCode 桥接。为避免中断现有会话，脚本不会自动重启；请关闭该 DSH 后重新运行此启动器。"
      }
      if ($waited.Kind -ne "empty") {
        throw ("目标端口已被占用，且未出现 beautiCode 桥接。地址：{0}" -f $baseUri.AbsoluteUri)
      }
    }

    $launched = Start-BcDshProcess `
      -BaseUri $baseUri `
      -Bridge $bridge `
      -Runtime $runtime `
      -EffectiveDataRoot $effectiveDataRoot `
      -EffectiveDshHome $effectiveDshHome `
      -WorkspaceRoot $dshWorkspace
    Show-BcDshTrayIfNeeded
    try {
      $started = Wait-BcStartedDsh -Started $launched
      break
    } catch {
      $kind = Get-BcDshLaunchFailureKind -Stderr $launched.Stderr
      if ($kind -in @("locked", "modules") -and $attempts -lt 2) {
        Write-Host "DeepSeek Harness 首次启动未就绪，正在修复 profile 并重试……"
        Invoke-BcHealDshProfile -Runtime $runtime -EffectiveDshHome $effectiveDshHome
        Start-Sleep -Milliseconds 300
        continue
      }
      throw
    }
  }
} finally {
  Exit-BcDshLaunchLock
}

if ($EnsureBridgeOnly) {
  if ($started) {
    Write-Host ("DeepSeek Harness 桥接已就绪；退出托盘时不会自动结束该进程。日志：{0}" -f $started.Stdout)
  }
  return
}

if ($started) {
  Write-Host ("DeepSeek Harness 桥接已就绪；退出托盘时不会自动结束该进程。日志：{0}" -f $started.Stdout)
}
if (-not $NoBrowser) { Start-Process -FilePath $baseUri.AbsoluteUri | Out-Null }

$latestVersion = Get-BcLatestDshVersion -EffectiveDataRoot $effectiveDataRoot
if ($latestVersion -and $latestVersion -ne $supportedVersion) {
  Write-Warning ("检测到 npm 最新 DSH {0}；当前兼容版本仍为 {1}，不会自动升级未经验证的 DSH。" -f $latestVersion, $supportedVersion)
}
