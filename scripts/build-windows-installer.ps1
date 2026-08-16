#Requires -Version 5.1
<#
.SYNOPSIS
  Build a self-contained beautiCode Windows installer.

.DESCRIPTION
  Builds TypeScript, stages the beautiCode runtime and host adapters,
  downloads and verifies the official Node.js Windows x64 runtime, then
  compiles an Inno Setup installer. DeepSeek Harness is NOT bundled: the
  bridge ships as plugin files the user installs into their own DSH profile.
#>
[CmdletBinding()]
param(
  [ValidatePattern("^\d+\.\d+\.\d+$")]
  [string]$NodeVersion = "24.18.0",
  [string]$InnoCompiler = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ArtifactsRoot = Join-Path $RepoRoot "artifacts\windows"
$StageRoot = Join-Path $ArtifactsRoot "stage"
$CacheRoot = Join-Path $ArtifactsRoot "cache"
$OutputRoot = Join-Path $ArtifactsRoot "installer"
$InstallerScript = Join-Path $RepoRoot "installer\windows\beauticode.iss"
$PinnedNodeVersion = "24.18.0"
$PinnedNodeArchiveSha256 = "0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821"

if ($env:OS -ne "Windows_NT") {
  throw "The Windows installer must be built on Windows."
}

function Assert-WorkspaceChild([string]$Path) {
  $root = [System.IO.Path]::GetFullPath($RepoRoot).TrimEnd("\") + "\"
  $target = [System.IO.Path]::GetFullPath($Path)
  if (-not $target.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw ("Refusing to modify a path outside the repository: {0}" -f $target)
  }
}

function Get-Sha256Hex([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha256.Dispose()
    $stream.Dispose()
  }
}

function Reset-Directory([string]$Path) {
  Assert-WorkspaceChild $Path
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force
  }
  New-Item -ItemType Directory -Path $Path -Force | Out-Null
}

function Copy-RuntimeDirectory([string]$Source, [string]$Destination) {
  if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
    throw ("Missing runtime directory: {0}" -f $Source)
  }
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  Copy-Item -Path (Join-Path $Source "*") -Destination $Destination -Recurse -Force
}

function Invoke-VerifiedDownload(
  [string]$Url,
  [string]$Destination
) {
  if (Test-Path -LiteralPath $Destination -PathType Leaf) {
    return
  }
  $curl = (Get-Command curl.exe -ErrorAction Stop).Source
  & $curl -L --fail --retry 5 --retry-delay 2 --retry-all-errors `
    --connect-timeout 20 --max-time 600 -o $Destination $Url
  if ($LASTEXITCODE -ne 0) {
    throw ("Download failed ({0}): {1}" -f $LASTEXITCODE, $Url)
  }
}

function Resolve-InnoCompiler([string]$RequestedPath) {
  $candidates = @()
  if ($RequestedPath) {
    $candidates += $RequestedPath
  }
  $command = Get-Command ISCC.exe -ErrorAction SilentlyContinue
  if ($command) {
    $candidates += $command.Source
  }
  $candidates += @(
    (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe"),
    (Join-Path ${env:ProgramFiles} "Inno Setup 6\ISCC.exe"),
    (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe")
  )
  $resolved = $candidates |
    Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } |
    Select-Object -First 1
  if (-not $resolved) {
    throw "Inno Setup 6 was not found. Install it with: winget install --id JRSoftware.InnoSetup -e"
  }
  return (Resolve-Path -LiteralPath $resolved).Path
}

function New-InstallerIcon([string]$SourcePng, [string]$DestinationIco) {
  Add-Type -AssemblyName System.Drawing
  if (-not ("BeautiCodeInstallerNative" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BeautiCodeInstallerNative {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool DestroyIcon(IntPtr handle);
}
'@
  }

  $source = $null
  $bitmap = $null
  $graphics = $null
  $icon = $null
  $stream = $null
  $handle = [IntPtr]::Zero
  try {
    $source = [System.Drawing.Image]::FromFile($SourcePng)
    $bitmap = New-Object System.Drawing.Bitmap(64, 64)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.DrawImage($source, 0, 0, 64, 64)
    $handle = $bitmap.GetHicon()
    $icon = [System.Drawing.Icon]::FromHandle($handle)
    $stream = [System.IO.File]::Open(
      $DestinationIco,
      [System.IO.FileMode]::Create,
      [System.IO.FileAccess]::Write
    )
    $icon.Save($stream)
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
    if ($null -ne $icon) { $icon.Dispose() }
    if ($handle -ne [IntPtr]::Zero) {
      [void][BeautiCodeInstallerNative]::DestroyIcon($handle)
    }
    if ($null -ne $graphics) { $graphics.Dispose() }
    if ($null -ne $bitmap) { $bitmap.Dispose() }
    if ($null -ne $source) { $source.Dispose() }
  }
}

if (-not (Test-Path -LiteralPath $InstallerScript -PathType Leaf)) {
  throw ("Missing Inno Setup script: {0}" -f $InstallerScript)
}

$package = Get-Content -Raw -LiteralPath (Join-Path $RepoRoot "package.json") |
  ConvertFrom-Json
$appVersion = [string]$package.version
if ($appVersion -notmatch "^\d+\.\d+\.\d+$") {
  throw ("Installer requires a numeric three-part package version: {0}" -f $appVersion)
}

Push-Location $RepoRoot
try {
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) {
    throw ("npm run build failed ({0})" -f $LASTEXITCODE)
  }
} finally {
  Pop-Location
}

Reset-Directory $StageRoot
Reset-Directory $OutputRoot
New-Item -ItemType Directory -Path $CacheRoot -Force | Out-Null

$nodeArchiveName = "node-v{0}-win-x64.zip" -f $NodeVersion
$nodeArchive = Join-Path $CacheRoot $nodeArchiveName
$nodeShasums = Join-Path $CacheRoot ("SHASUMS256-{0}.txt" -f $NodeVersion)
$nodeBaseUrl = "https://nodejs.org/dist/v{0}" -f $NodeVersion
Invoke-VerifiedDownload "$nodeBaseUrl/$nodeArchiveName" $nodeArchive
Invoke-VerifiedDownload "$nodeBaseUrl/SHASUMS256.txt" $nodeShasums

$checksumLine = Get-Content -LiteralPath $nodeShasums |
  Where-Object { $_ -match ("^[a-fA-F0-9]{{64}}\s+{0}$" -f [regex]::Escape($nodeArchiveName)) } |
  Select-Object -First 1
if (-not $checksumLine) {
  throw ("Official checksum was not found for {0}" -f $nodeArchiveName)
}
$expectedHash = ($checksumLine -split "\s+")[0].ToLowerInvariant()
$actualHash = Get-Sha256Hex $nodeArchive
if ($actualHash -ne $expectedHash) {
  throw ("Node.js archive checksum mismatch: expected {0}, got {1}" -f $expectedHash, $actualHash)
}
if ($NodeVersion -eq $PinnedNodeVersion -and $actualHash -ne $PinnedNodeArchiveSha256) {
  throw ("Pinned Node.js archive checksum mismatch: expected {0}, got {1}" -f $PinnedNodeArchiveSha256, $actualHash)
}

$nodeExtractRoot = Join-Path $ArtifactsRoot "node-extract"
Reset-Directory $nodeExtractRoot
Expand-Archive -LiteralPath $nodeArchive -DestinationPath $nodeExtractRoot -Force
$nodeDistribution = Join-Path $nodeExtractRoot ("node-v{0}-win-x64" -f $NodeVersion)

foreach ($relativeDir in @(
    "apps\tray",
    "assets",
    "scripts",
    "packages\core",
    "packages\adapter-codex",
    "packages\adapter-dsh",
    "integrations\deepseek-harness",
    "node_modules\@beauticode\core",
    "runtime",
    "licenses\node"
  )) {
  New-Item -ItemType Directory -Path (Join-Path $StageRoot $relativeDir) -Force | Out-Null
}

foreach ($relativeFile in @(
    "apps\tray\session-host.mjs",
    "apps\tray\start-tray.ps1",
    "assets\beauticode-icon-borderless.png",
    "scripts\codex-launch.ps1",
    "scripts\start-beauticode.ps1",
    "scripts\start-beauticode-engine.ps1",
    "scripts\install-dsh-plugin.ps1",
    "packages\core\package.json",
    "packages\adapter-codex\package.json",
    "packages\adapter-dsh\package.json",
    "integrations\deepseek-harness\index.mjs",
    "integrations\deepseek-harness\client.js",
    "integrations\deepseek-harness\package.json",
    "integrations\deepseek-harness\cordis.patch.example.yml",
    "integrations\deepseek-harness\README.zh-CN.md",
    "LICENSE",
    "NOTICE.md",
    "THIRD_PARTY_NOTICES.md"
  )) {
  $source = Join-Path $RepoRoot $relativeFile
  $destination = Join-Path $StageRoot $relativeFile
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
    throw ("Missing runtime file: {0}" -f $source)
  }
  Copy-Item -LiteralPath $source -Destination $destination -Force
}

Copy-RuntimeDirectory `
  (Join-Path $RepoRoot "packages\core\dist") `
  (Join-Path $StageRoot "packages\core\dist")
Copy-RuntimeDirectory `
  (Join-Path $RepoRoot "packages\adapter-codex\dist") `
  (Join-Path $StageRoot "packages\adapter-codex\dist")
Copy-RuntimeDirectory `
  (Join-Path $RepoRoot "packages\adapter-dsh\dist") `
  (Join-Path $StageRoot "packages\adapter-dsh\dist")
Copy-Item -LiteralPath (Join-Path $RepoRoot "packages\core\package.json") `
  -Destination (Join-Path $StageRoot "node_modules\@beauticode\core\package.json") -Force
Copy-RuntimeDirectory `
  (Join-Path $RepoRoot "packages\core\dist") `
  (Join-Path $StageRoot "node_modules\@beauticode\core\dist")

Copy-Item -LiteralPath (Join-Path $nodeDistribution "node.exe") `
  -Destination (Join-Path $StageRoot "runtime\node.exe") -Force
Copy-Item -LiteralPath (Join-Path $nodeDistribution "LICENSE") `
  -Destination (Join-Path $StageRoot "licenses\node\LICENSE") -Force

New-InstallerIcon `
  (Join-Path $RepoRoot "assets\beauticode-icon-borderless.png") `
  (Join-Path $StageRoot "beauticode.ico")

$commit = (& git -C $RepoRoot rev-parse --short=12 HEAD).Trim()
$trackedChanges = @(& git -C $RepoRoot status --porcelain --untracked-files=no)
$manifest = [ordered]@{
  schema = "beauticode.release/v1"
  appVersion = $appVersion
  nodeVersion = $NodeVersion
  platform = "win-x64"
  commit = $commit
  dirty = ($trackedChanges.Count -gt 0)
  builtAtUtc = [DateTime]::UtcNow.ToString("o")
}
$manifest | ConvertTo-Json | Set-Content `
  -LiteralPath (Join-Path $StageRoot "release-manifest.json") `
  -Encoding UTF8

$stagedNode = Join-Path $StageRoot "runtime\node.exe"
$stagedNodeVersion = (& $stagedNode --version).TrimStart("v")
if ($LASTEXITCODE -ne 0 -or $stagedNodeVersion -ne $NodeVersion) {
  throw ("Staged Node.js version mismatch: expected {0}, got {1}" -f $NodeVersion, $stagedNodeVersion)
}
$adapterUrl = ([System.Uri](Join-Path $StageRoot "packages\adapter-codex\dist\index.js")).AbsoluteUri
$adapterProbe = & $stagedNode --input-type=module -e `
  "const m=await import(process.argv[1]); console.log(typeof m.BeautiSession);" `
  $adapterUrl
if ($LASTEXITCODE -ne 0 -or $adapterProbe -ne "function") {
  throw ("Staged adapter import failed: {0}" -f $adapterProbe)
}
$dshAdapterUrl = ([System.Uri](Join-Path $StageRoot "packages\adapter-dsh\dist\index.js")).AbsoluteUri
$dshAdapterProbe = & $stagedNode --input-type=module -e `
  "const m=await import(process.argv[1]); console.log(typeof m.DshSession);" `
  $dshAdapterUrl
if ($LASTEXITCODE -ne 0 -or $dshAdapterProbe -ne "function") {
  throw ("Staged DSH adapter import failed: {0}" -f $dshAdapterProbe)
}

$iscc = Resolve-InnoCompiler $InnoCompiler
& $iscc `
  ("/DMyAppVersion={0}" -f $appVersion) `
  ("/DStageDir={0}" -f $StageRoot) `
  ("/DOutputDir={0}" -f $OutputRoot) `
  $InstallerScript
if ($LASTEXITCODE -ne 0) {
  throw ("Inno Setup compilation failed ({0})" -f $LASTEXITCODE)
}

$installer = Get-ChildItem -LiteralPath $OutputRoot -Filter "beautiCode-Setup-*.exe" |
  Sort-Object -Property LastWriteTimeUtc -Descending |
  Select-Object -First 1
if (-not $installer) {
  throw "Inno Setup completed without producing an installer."
}

$installerHash = Get-Sha256Hex $installer.FullName
Write-Host ""
Write-Host "Windows installer created:"
Write-Host ("  {0}" -f $installer.FullName)
Write-Host ("  SHA256 {0}" -f $installerHash.ToUpperInvariant())
