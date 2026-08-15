#Requires -Version 5.1
<#
.SYNOPSIS
  Install the supported DeepSeek Harness into a beautiCode-owned directory.

.DESCRIPTION
  Uses an exact package version, verifies npm's recorded SHA-512 integrity and
  the live CLI version, then atomically publishes a versioned runtime. It never
  performs a global npm installation.
#>
[CmdletBinding()]
param(
  [string]$InstallRoot = "",
  [string]$CompatibilityFile = "",
  [string]$PackageVersion = "",
  [string]$PackageIntegrity = "",
  [string]$NodeCommand = "",
  [string]$NpmCommand = "",
  [switch]$Force,
  [switch]$Offline,
  [switch]$PassThru
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $CompatibilityFile) {
  $CompatibilityFile = Join-Path $RepoRoot "integrations\deepseek-harness\compatibility.json"
}
if (-not (Test-Path -LiteralPath $CompatibilityFile -PathType Leaf)) {
  throw "缺少 DSH 兼容性清单：$CompatibilityFile"
}
$compatibility = Get-Content -Raw -LiteralPath $CompatibilityFile | ConvertFrom-Json
if ($compatibility.schema -ne "beauticode.dsh-compatibility/v1") {
  throw "DSH 兼容性清单版本无效。"
}
if (-not $PackageVersion) { $PackageVersion = [string]$compatibility.supportedVersion }
if (-not $PackageIntegrity) { $PackageIntegrity = [string]$compatibility.integrity }
if ($PackageVersion -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
  throw "DSH 版本格式无效：$PackageVersion"
}
if ($PackageIntegrity -notmatch '^sha512-[A-Za-z0-9+/]+={0,2}$') {
  throw "DSH SHA-512 integrity 无效。"
}

if (-not $InstallRoot) {
  $base = if ($env:LOCALAPPDATA) {
    Join-Path $env:LOCALAPPDATA "beautiCode"
  } else {
    Join-Path ([IO.Path]::GetTempPath()) "beautiCode"
  }
  $InstallRoot = Join-Path $base "dsh-runtime"
}
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$VersionsRoot = Join-Path $InstallRoot "versions"
$TargetRoot = Join-Path $VersionsRoot $PackageVersion
$CurrentManifest = Join-Path $InstallRoot "current.json"
$CliRelativePath = "node_modules\@deepseek-ai\dsh\lib\bin.js"

function Resolve-BcCommandPath {
  param([string]$Requested, [string]$Fallback)
  if ($Requested) {
    if (-not (Test-Path -LiteralPath $Requested -PathType Leaf)) {
      throw "命令不存在：$Requested"
    }
    return (Resolve-Path -LiteralPath $Requested).Path
  }
  $command = Get-Command $Fallback -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $command) { throw "未找到 $Fallback。" }
  return $command.Source
}

function Get-BcInstalledDshVersion {
  param([string]$RuntimeRoot, [string]$NodePath, [switch]$ThrowOnError)
  $cli = Join-Path $RuntimeRoot $CliRelativePath
  if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) { return $null }
  try {
    $output = @(& $NodePath $cli --version 2>&1)
    $exitCode = $LASTEXITCODE
    $version = ([string]($output | Select-Object -First 1)).Trim()
    if ($exitCode -eq 0 -and $version -match '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
      return $version
    }
    $detail = (($output | ForEach-Object { [string]$_ }) -join " ").Trim()
    if (-not $detail) { $detail = "无输出" }
    if ($ThrowOnError) {
      throw "DSH CLI 无法读取版本（退出码 $exitCode）：$detail"
    }
    return $null
  } catch {
    if ($ThrowOnError) { throw $_ }
    return $null
  }
}

function Get-BcLockIntegrity {
  param(
    [Parameter(Mandatory = $true)][string]$LockPath,
    [Parameter(Mandatory = $true)][string]$NodePath
  )
  $script = @"
const fs = require('node:fs');
const lock = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const entry = lock.packages?.['node_modules/@deepseek-ai/dsh'];
if (!entry?.integrity) process.exit(2);
process.stdout.write(entry.integrity);
"@
  $integrity = (& $NodePath -e $script $LockPath 2>$null | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { return $null }
  $integrity
}

function Write-BcCurrentManifest {
  param([string]$NodePath)
  $relativeRoot = Join-Path "versions" $PackageVersion
  $relativeCli = Join-Path $relativeRoot $CliRelativePath
  $manifest = [ordered]@{
    schema = "beauticode.dsh-runtime/v1"
    package = "@deepseek-ai/dsh"
    version = $PackageVersion
    integrity = $PackageIntegrity
    runtimeRoot = $relativeRoot
    cli = $relativeCli
    installedAtUtc = [DateTime]::UtcNow.ToString("o")
  }
  [IO.Directory]::CreateDirectory($InstallRoot) | Out-Null
  [IO.File]::WriteAllText(
    $CurrentManifest,
    ($manifest | ConvertTo-Json),
    (New-Object Text.UTF8Encoding($false))
  )
  return [pscustomobject]@{
    Version = $PackageVersion
    Integrity = $PackageIntegrity
    Root = $TargetRoot
    Cli = Join-Path $InstallRoot $relativeCli
    Node = $NodePath
    Installed = $true
  }
}

$nodePath = Resolve-BcCommandPath -Requested $NodeCommand -Fallback "node.exe"
$existingVersion = Get-BcInstalledDshVersion -RuntimeRoot $TargetRoot -NodePath $nodePath
if (-not $Force -and $existingVersion -eq $PackageVersion) {
  $result = Write-BcCurrentManifest -NodePath $nodePath
  $result.Installed = $false
  if ($PassThru) { $result }
  return
}

$npmPath = Resolve-BcCommandPath -Requested $NpmCommand -Fallback "npm.cmd"
[IO.Directory]::CreateDirectory($VersionsRoot) | Out-Null
$stagingRoot = Join-Path $InstallRoot (".staging-{0}-{1}" -f $PID, [guid]::NewGuid().ToString("N"))
$published = $false
try {
  [IO.Directory]::CreateDirectory($stagingRoot) | Out-Null
  $package = [ordered]@{
    name = "beauticode-dsh-runtime"
    version = "1.0.0"
    private = $true
    dependencies = [ordered]@{ "@deepseek-ai/dsh" = $PackageVersion }
  }
  [IO.File]::WriteAllText(
    (Join-Path $stagingRoot "package.json"),
    ($package | ConvertTo-Json -Depth 4),
    (New-Object Text.UTF8Encoding($false))
  )
  $npmArguments = @(
    "install",
    "--prefix", $stagingRoot,
    "--ignore-scripts",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    "--save-exact"
  )
  if ($Offline) { $npmArguments += "--offline" }
  & $npmPath @npmArguments
  if ($LASTEXITCODE -ne 0) {
    throw "DSH 私有运行时安装失败（npm 退出码 $LASTEXITCODE）。"
  }

  $packageJson = Get-Content -Raw -LiteralPath (
    Join-Path $stagingRoot "node_modules\@deepseek-ai\dsh\package.json"
  ) | ConvertFrom-Json
  if ([string]$packageJson.version -ne $PackageVersion) {
    throw "DSH 安装版本不匹配：期望 $PackageVersion，实际 $($packageJson.version)。"
  }
  $lockIntegrity = Get-BcLockIntegrity `
    -LockPath (Join-Path $stagingRoot "package-lock.json") `
    -NodePath $nodePath
  if ($lockIntegrity -ne $PackageIntegrity) {
    throw "DSH npm integrity 校验失败。"
  }
  $installedVersion = Get-BcInstalledDshVersion `
    -RuntimeRoot $stagingRoot `
    -NodePath $nodePath `
    -ThrowOnError
  if ($installedVersion -ne $PackageVersion) {
    throw "DSH CLI 版本校验失败：期望 $PackageVersion，实际 $installedVersion。"
  }

  if (Test-Path -LiteralPath $TargetRoot) {
    $quarantine = Join-Path $VersionsRoot (
      "{0}.invalid-{1}" -f $PackageVersion, (Get-Date -Format "yyyyMMddHHmmss")
    )
    Move-Item -LiteralPath $TargetRoot -Destination $quarantine
  }
  Move-Item -LiteralPath $stagingRoot -Destination $TargetRoot
  $published = $true
  $result = Write-BcCurrentManifest -NodePath $nodePath
  Write-Host ("DeepSeek Harness {0} 已安装到 beautiCode 私有运行时。" -f $PackageVersion)
  if ($PassThru) { $result }
} finally {
  if (-not $published -and (Test-Path -LiteralPath $stagingRoot)) {
    $safeRoot = $InstallRoot.TrimEnd("\") + "\"
    $resolvedStaging = [IO.Path]::GetFullPath($stagingRoot)
    if ($resolvedStaging.StartsWith($safeRoot, [StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $resolvedStaging -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}
