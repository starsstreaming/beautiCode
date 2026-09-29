#Requires -Version 5.1
<#
.SYNOPSIS
  Wire the beautiCode Cordis plugin into the user's own DSH profile.

.DESCRIPTION
  Does not install or start DeepSeek Harness. If a web profile already exists,
  link the plugin package and insert it in that profile's patch. If DSH has
  not been initialized yet, write a home-level cordis.patch.yml so the first
  `dsh web` still loads the plugin.
#>
[CmdletBinding()]
param(
  [string]$PluginRoot = "",
  [string]$DshHome = "",
  [string]$InstallRoot = "",
  [switch]$Remove
)

$ErrorActionPreference = "Stop"

$scriptDir = $PSScriptRoot
if (-not $scriptDir) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$repoRoot = (Resolve-Path (Join-Path $scriptDir "..")).Path

if (-not $PluginRoot) {
  $PluginRoot = Join-Path $repoRoot "integrations\deepseek-harness"
}
$PluginRoot = [IO.Path]::GetFullPath($PluginRoot)
$indexFile = Join-Path $PluginRoot "index.mjs"
$packageFile = Join-Path $PluginRoot "package.json"

if (-not $DshHome) {
  if ($env:DSH_HOME) { $DshHome = $env:DSH_HOME }
  else { $DshHome = Join-Path $env:USERPROFILE ".dsh" }
}
$DshHome = [IO.Path]::GetFullPath($DshHome)
$webProfile = Join-Path $DshHome "profiles\web"
$webPatch = Join-Path $webProfile "cordis.patch.yml"
$webPackage = Join-Path $webProfile "package.json"
$homePatch = Join-Path $DshHome "cordis.patch.yml"
$pluginPatch = Join-Path $PluginRoot "cordis.patch.yml"
$pluginName = "beauticode-dsh"
$legacyPluginName = "@beauticode/dsh-plugin"
$bridgeId = "beauticode-bridge"

function Write-BcLog([string]$Message) {
  $line = "[{0:u}] {1}" -f (Get-Date).ToUniversalTime(), $Message
  Write-Host $line
  try {
    $logRoot = if ($env:LOCALAPPDATA) {
      Join-Path $env:LOCALAPPDATA "beautiCode\logs"
    } else {
      Join-Path ([IO.Path]::GetTempPath()) "beautiCode\logs"
    }
    if (-not (Test-Path -LiteralPath $logRoot)) {
      New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
    }
    Add-Content -LiteralPath (Join-Path $logRoot "dsh-plugin-install.log") -Value $line -Encoding UTF8
  } catch { }
}

function ConvertTo-FileUri([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path).Replace("\", "/")
  if ($full -match '^[A-Za-z]:') {
    return "file:///" + $full
  }
  return "file://" + $full
}

function Get-FileUriInsert([string]$Uri) {
  return @(
    "# beauticode-bridge (installer)"
    "- insert:"
    "    - id: $bridgeId"
    "      name: '$Uri'"
    "      inject: [webServer]"
  ) -join "`n"
}

function Get-PackageInsert {
  return @(
    "# beauticode-bridge (installer)"
    "- insert:"
    "    - id: $bridgeId"
    "      name: '$pluginName'"
    "      inject: [webServer]"
  ) -join "`n"
}

function Test-PatchHasBridge([string]$Text) {
  return [bool]($Text -match "(?m)^[ \t]*-[ \t]*id:[ \t]*$bridgeId[ \t]*(?:#.*)?\r?$")
}

function Backup-BridgePatch([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return }
  $stamp = [DateTime]::UtcNow.ToString("yyyyMMddHHmmssfff")
  $backup = "$Path.beauticode-backup-$stamp"
  $suffix = 0
  while (Test-Path -LiteralPath $backup) {
    $suffix += 1
    $backup = "$Path.beauticode-backup-$stamp-$suffix"
  }
  Copy-Item -LiteralPath $Path -Destination $backup -Force:$false
  Write-BcLog ("Backed up beauticode bridge patch to {0}" -f $backup)
}

function Get-BridgeRewrite([string]$Raw) {
  $eol = if ($Raw.Contains("`r`n")) { "`r`n" } elseif ($Raw.Contains("`n")) { "`n" } else { "`r`n" }
  $hasTrailing = $Raw.EndsWith($eol)
  $lines = if ($Raw.Length -eq 0) { @() } else { $Raw -split "\r\n|\n|\r" }
  if ($hasTrailing -and $lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq "") {
    if ($lines.Count -eq 1) { $lines = @() } else { $lines = $lines[0..($lines.Count - 2)] }
  }
  $removed = New-Object bool[] $lines.Count
  $bridgeCount = 0
  $removedBridgeCount = 0

  for ($i = 0; $i -lt $lines.Count; $i += 1) {
    $insert = [regex]::Match([string]$lines[$i], '^([ \t]*)-[ \t]*insert:[ \t]*(?:#.*)?$')
    if (-not $insert.Success) { continue }
    $insertIndent = $insert.Groups[1].Value.Length
    $blockEnd = $i + 1
    while ($blockEnd -lt $lines.Count) {
      $line = [string]$lines[$blockEnd]
      if ($line.Trim() -and (($line -replace '^([ \t]*).*$', '$1').Length -le $insertIndent)) { break }
      $blockEnd += 1
    }
    $foundBridge = $false
    $bridgeRanges = @()
    for ($j = $i + 1; $j -lt $blockEnd; ) {
      $bridge = [regex]::Match([string]$lines[$j], '^([ \t]*)-[ \t]*id:[ \t]*' + [regex]::Escape($bridgeId) + '[ \t]*(?:#.*)?$')
      if (-not $bridge.Success -or $bridge.Groups[1].Value.Length -le $insertIndent) {
        $j += 1
        continue
      }
      $foundBridge = $true
      $bridgeCount += 1
      $itemIndent = $bridge.Groups[1].Value.Length
      $itemEnd = $j + 1
      while ($itemEnd -lt $blockEnd) {
        $line = [string]$lines[$itemEnd]
        if ($line.Trim() -and (($line -replace '^([ \t]*).*$', '$1').Length -le $itemIndent)) { break }
        $itemEnd += 1
      }
      $bridgeRanges += ,@($j, $itemEnd)
      $j = $itemEnd
    }
    if (-not $foundBridge) { continue }
    foreach ($range in $bridgeRanges) {
      $removedBridgeCount += 1
      for ($k = $range[0]; $k -lt $range[1]; $k += 1) {
        $removed[$k] = $true
      }
    }
    $hasSibling = $false
    for ($k = $i + 1; $k -lt $blockEnd; $k += 1) {
      $line = [string]$lines[$k]
      if (-not $removed[$k] -and $line.Trim() -and -not $line.TrimStart().StartsWith("#")) {
        $hasSibling = $true
        break
      }
    }
    if (-not $hasSibling) {
      for ($k = $i; $k -lt $blockEnd; $k += 1) { $removed[$k] = $true }
      if ($i -gt 0 -and $lines[$i - 1].TrimEnd() -eq ($insert.Groups[1].Value + "# beauticode-bridge (installer)")) {
        $removed[$i - 1] = $true
      }
    }
    $i = $blockEnd - 1
  }

  if ($bridgeCount -eq 0) {
    return [pscustomobject]@{ Safe = $true; Changed = $false; BridgeCount = 0; Text = $Raw }
  }
  if ($removedBridgeCount -ne $bridgeCount) {
    return [pscustomobject]@{ Safe = $false; Changed = $false; BridgeCount = $bridgeCount; Text = $Raw }
  }
  $keptLines = @()
  for ($i = 0; $i -lt $lines.Count; $i += 1) {
    if (-not $removed[$i]) { $keptLines += [string]$lines[$i] }
  }
  $rewritten = $keptLines -join $eol
  if ($hasTrailing -and $rewritten.Length -gt 0) { $rewritten += $eol }
  return [pscustomobject]@{ Safe = $true; Changed = $true; BridgeCount = $bridgeCount; Text = $rewritten }
}

function Write-RecoverableText([string]$Path, [string]$Text) {
  $dir = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  $existing = Test-Path -LiteralPath $Path -PathType Leaf
  if ($existing) { Backup-BridgePatch $Path }
  $temp = Join-Path $dir ([IO.Path]::GetRandomFileName())
  $utf8 = New-Object System.Text.UTF8Encoding $false
  try {
    [IO.File]::WriteAllText($temp, $Text, $utf8)
    Move-Item -LiteralPath $temp -Destination $Path -Force
  } catch {
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
    throw
  }
}

function Remove-BridgeFromPatch([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  $raw = [IO.File]::ReadAllText($Path)
  if (-not (Test-PatchHasBridge $raw)) { return $false }
  $rewrite = Get-BridgeRewrite $raw
  if (-not $rewrite.Safe -or -not $rewrite.Changed) {
    throw ("Unsafe DSH patch rewrite: cannot locate {0} beauticode bridge entries." -f $rewrite.BridgeCount)
  }
  $trimmed = $rewrite.Text.Trim()
  $emptyOverlay = $trimmed.Length -eq 0
  $emptyFlowOverlay = [bool]($trimmed -match '^\[\]$')
  if ($emptyOverlay -or $emptyFlowOverlay) {
    $dir = Split-Path -Parent $Path
    if (([IO.Path]::GetFileName($Path) -eq "cordis.patch.yml") -and ($dir -eq $DshHome)) {
      Backup-BridgePatch $Path
      Remove-Item -LiteralPath $Path -Force
      return $true
    }
    Write-RecoverableText $Path "# Your patch layer for this dsh profile.`r`n[]`r`n"
    return $true
  }
  Write-RecoverableText $Path ($trimmed.TrimEnd() + "`r`n")
  return $true
}

function Write-BridgePatch([string]$Path, [string]$Body) {
  $dir = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Write-RecoverableText $Path ($Body + "`r`n")
    return
  }
  $raw = [IO.File]::ReadAllText($Path)
  $rewrite = Get-BridgeRewrite $raw
  if (Test-PatchHasBridge $raw) {
    if (-not $rewrite.Safe -or -not $rewrite.Changed) {
      throw ("Unsafe DSH patch rewrite: cannot replace {0} beauticode bridge entries." -f $rewrite.BridgeCount)
    }
    $stripped = $rewrite.Text.Trim()
  } else {
    $stripped = $raw.Trim()
  }
  $emptyOverlay = $stripped.Length -eq 0
  $emptyFlowOverlay = [bool]($stripped -match '^\[\]$')
  if ($emptyOverlay -or $emptyFlowOverlay) {
    Write-RecoverableText $Path ($Body + "`r`n")
    return
  }
  Write-RecoverableText $Path ($stripped.TrimEnd() + "`r`n`r`n" + $Body + "`r`n")
}

function Ensure-PluginJunction {
  $link = Join-Path $webProfile "node_modules\$pluginName"
  $legacyLink = Join-Path $webProfile "node_modules\@beauticode\dsh-plugin"
  $linkParent = Split-Path -Parent $link
  if (-not (Test-Path -LiteralPath $linkParent)) {
    New-Item -ItemType Directory -Path $linkParent -Force | Out-Null
  }
  # npx beauticode-dsh installs used the scoped name; drop that wiring so the
  # profile never carries two links to different plugin copies.
  if (Test-Path -LiteralPath $legacyLink) {
    Remove-Item -LiteralPath $legacyLink -Force -Recurse
  }
  if (Test-Path -LiteralPath $link) {
    $item = Get-Item -LiteralPath $link -Force
    $target = $null
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      $target = $item.Target
      if ($target -is [array]) { $target = $target[0] }
    }
    if ($target -and ([IO.Path]::GetFullPath($target) -eq $PluginRoot)) {
      return
    }
    Remove-Item -LiteralPath $link -Force -Recurse
  }
  New-Item -ItemType Junction -Path $link -Target $PluginRoot | Out-Null
}

function Ensure-WebPackageDep {
  if (-not (Test-Path -LiteralPath $webPackage -PathType Leaf)) { return }
  $raw = [IO.File]::ReadAllText($webPackage)
  $json = $raw | ConvertFrom-Json
  if (-not $json.dependencies) {
    $json | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force
  }
  $linkSpec = "link:" + ($PluginRoot -replace "\\", "/")
  $deps = $json.dependencies
  # Swap any legacy scoped dep (npx-installed copy) for the installer's link.
  $hadLegacy = $deps.PSObject.Properties.Name -contains $legacyPluginName
  $deps.PSObject.Properties.Remove($legacyPluginName)
  $current = $null
  if ($deps.PSObject.Properties.Name -contains $pluginName) {
    $current = [string]$deps.$pluginName
  }
  if ($current -eq $linkSpec -and -not $hadLegacy) { return }
  $deps | Add-Member -NotePropertyName $pluginName -NotePropertyValue $linkSpec -Force
  # Windows PowerShell 5.1 Set-Content -Encoding UTF8 writes a BOM.
  # DSH reads the profile manifest with JSON.parse and rejects that.
  $text = $json | ConvertTo-Json -Depth 8
  Write-RecoverableText $webPackage ($text.TrimEnd() + "`n")
}

function Get-BcIntegrationNoteName {
  # 集成说明.txt — built from code points so this ASCII script stays PS 5.1-safe.
  return ((-join @(0x96C6, 0x6210, 0x8BF4, 0x660E | ForEach-Object { [char]$_ })) + ".txt")
}

function Write-IntegrationNote([string]$Root) {
  if (-not $Root) { return }
  $installRoot = [IO.Path]::GetFullPath($Root)
  $pluginPath = Join-Path $installRoot "integrations\deepseek-harness"
  $template = Join-Path $scriptDir "integration-note.zh.txt"
  if (-not (Test-Path -LiteralPath $template -PathType Leaf)) {
    throw ("missing integration note template: {0}" -f $template)
  }
  $text = [IO.File]::ReadAllText($template)
  $text = $text.Replace("{INSTALL_ROOT}", $installRoot).Replace("{PLUGIN_PATH}", $pluginPath)
  Write-RecoverableText (Join-Path $installRoot (Get-BcIntegrationNoteName)) $text
}

if (-not (Test-Path -LiteralPath $indexFile -PathType Leaf)) {
  throw ("缺少 DSH 插件入口：{0}" -f $indexFile)
}
if (-not (Test-Path -LiteralPath $packageFile -PathType Leaf)) {
  throw ("缺少 DSH 插件清单：{0}" -f $packageFile)
}

function Remove-WebPackageDeps {
  if (-not (Test-Path -LiteralPath $webPackage -PathType Leaf)) { return $false }
  $raw = [IO.File]::ReadAllText($webPackage)
  $json = $raw | ConvertFrom-Json
  if (-not $json.dependencies) { return $false }
  $deps = $json.dependencies
  $changed = $false
  foreach ($name in @($pluginName, $legacyPluginName)) {
    if ($deps.PSObject.Properties.Name -contains $name) {
      $deps.PSObject.Properties.Remove($name)
      $changed = $true
    }
  }
  if (-not $changed) { return $false }
  $text = $json | ConvertTo-Json -Depth 8
  Write-RecoverableText $webPackage ($text.TrimEnd() + "`n")
  return $true
}

if ($Remove) {
  $removed = $false
  if (Remove-BridgeFromPatch $webPatch) { $removed = $true }
  if (Remove-BridgeFromPatch $homePatch) { $removed = $true }
  foreach ($link in @(
      (Join-Path $webProfile "node_modules\$pluginName"),
      (Join-Path $webProfile "node_modules\@beauticode\dsh-plugin")
    )) {
    if (Test-Path -LiteralPath $link) {
      Remove-Item -LiteralPath $link -Force -Recurse
      $removed = $true
    }
  }
  if (Remove-WebPackageDeps) { $removed = $true }
  if ($removed) { Write-BcLog "Removed beautiCode DSH plugin wiring." }
  else { Write-BcLog "No beautiCode DSH plugin wiring to remove." }
  if ($InstallRoot) {
    $note = Join-Path ([IO.Path]::GetFullPath($InstallRoot)) (Get-BcIntegrationNoteName)
    if (Test-Path -LiteralPath $note -PathType Leaf) {
      Remove-Item -LiteralPath $note -Force
    }
  }
  exit 0
}

$fileUri = ConvertTo-FileUri $indexFile
$webExists = Test-Path -LiteralPath $webPackage -PathType Leaf

if ($webExists) {
  Ensure-PluginJunction
  Ensure-WebPackageDep
  # DSH also loads a package's own cordis.patch.yml. Keep one loader entry:
  # when the plugin ships the bridge, retain that patch and remove only our
  # managed profile block (with a backup); otherwise install the profile entry.
  $pluginShipsBridge = $false
  if (Test-Path -LiteralPath $pluginPatch -PathType Leaf) {
    $pluginShipsBridge = Test-PatchHasBridge ([IO.File]::ReadAllText($pluginPatch))
  }
  if ($pluginShipsBridge) {
    if (Test-PatchHasBridge ([IO.File]::ReadAllText($webPatch))) {
      [void](Remove-BridgeFromPatch $webPatch)
    }
  } else {
    Write-BridgePatch $webPatch (Get-PackageInsert)
  }
  if (Test-Path -LiteralPath $homePatch -PathType Leaf) {
    $homeRaw = [IO.File]::ReadAllText($homePatch)
    if (Test-PatchHasBridge $homeRaw) {
      [void](Remove-BridgeFromPatch $homePatch)
    }
  }
  Write-BcLog ("Linked $pluginName into $webProfile")
} else {
  if (-not (Test-Path -LiteralPath $DshHome)) {
    New-Item -ItemType Directory -Path $DshHome -Force | Out-Null
  }
  Write-BridgePatch $homePatch (Get-FileUriInsert $fileUri)
  Write-BcLog ("DSH web profile not found; wrote home patch $homePatch")
}

if ($InstallRoot) {
  try {
    Write-IntegrationNote $InstallRoot
    Write-BcLog ("Wrote integration note to {0}" -f ([IO.Path]::GetFullPath($InstallRoot)))
  } catch {
    Write-BcLog ("Failed to write integration note: {0}" -f $_.Exception.Message)
  }
}

exit 0
