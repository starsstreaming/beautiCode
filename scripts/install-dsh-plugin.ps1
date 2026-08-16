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
$pluginName = "@beauticode/dsh-plugin"
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
  return [bool]($Text -match "(?m)^\s*-\s*id:\s*$bridgeId\s*$")
}

function Remove-BridgeFromPatch([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  $raw = [IO.File]::ReadAllText($Path)
  if (-not (Test-PatchHasBridge $raw)) { return $false }
  $cleaned = [regex]::Replace(
    $raw,
    "(?ms)(?:^|\r?\n)# beauticode-bridge \(installer\)\r?\n- insert:\r?\n(?:[ \t]+.*\r?\n)*",
    "`n"
  )
  $cleaned = [regex]::Replace(
    $cleaned,
    "(?ms)(?:^|\r?\n)- insert:\r?\n(?:[ \t]+.*\r?\n)*?[ \t]+-\s*id:\s*$bridgeId\r?\n(?:[ \t]+.*\r?\n)*",
    "`n"
  )
  $trimmed = $cleaned.Trim()
  if ($trimmed -eq "" -or $trimmed -eq "[]") {
    $dir = Split-Path -Parent $Path
    if ([IO.Path]::GetFileName($Path) -eq "cordis.patch.yml" -and
        $dir -eq $DshHome) {
      Remove-Item -LiteralPath $Path -Force
      return $true
    }
    [IO.File]::WriteAllText($Path, "# Your patch layer for this dsh profile.`r`n[]`r`n")
    return $true
  }
  [IO.File]::WriteAllText($Path, $trimmed.TrimEnd() + "`r`n")
  return $true
}

function Write-BridgePatch([string]$Path, [string]$Body) {
  $dir = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    [IO.File]::WriteAllText($Path, $Body + "`r`n")
    return
  }
  $raw = [IO.File]::ReadAllText($Path)
  if (Test-PatchHasBridge $raw) {
    $replaced = [regex]::Replace(
      $raw,
      "(?ms)(?:# beauticode-bridge \(installer\)\r?\n)?- insert:\r?\n(?:[ \t]+.*\r?\n)*?[ \t]+-\s*id:\s*$bridgeId\r?\n(?:[ \t]+.*\r?\n)*",
      ($Body + "`r`n")
    )
    if ($replaced -eq $raw) {
      [IO.File]::WriteAllText($Path, $Body + "`r`n")
    } else {
      [IO.File]::WriteAllText($Path, $replaced.TrimEnd() + "`r`n")
    }
    return
  }
  $stripped = $raw.Trim()
  if ($stripped -eq "" -or $stripped -eq "[]") {
    [IO.File]::WriteAllText($Path, $Body + "`r`n")
    return
  }
  [IO.File]::WriteAllText($Path, $stripped.TrimEnd() + "`r`n`r`n" + $Body + "`r`n")
}

function Ensure-PluginJunction {
  $linkParent = Join-Path $webProfile "node_modules\@beauticode"
  $link = Join-Path $linkParent "dsh-plugin"
  if (-not (Test-Path -LiteralPath $linkParent)) {
    New-Item -ItemType Directory -Path $linkParent -Force | Out-Null
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
  $current = $null
  if ($deps.PSObject.Properties.Name -contains $pluginName) {
    $current = [string]$deps.$pluginName
  }
  if ($current -eq $linkSpec) { return }
  $deps | Add-Member -NotePropertyName $pluginName -NotePropertyValue $linkSpec -Force
  $json | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $webPackage -Encoding UTF8
}

if (-not (Test-Path -LiteralPath $indexFile -PathType Leaf)) {
  throw ("缺少 DSH 插件入口：{0}" -f $indexFile)
}
if (-not (Test-Path -LiteralPath $packageFile -PathType Leaf)) {
  throw ("缺少 DSH 插件清单：{0}" -f $packageFile)
}

if ($Remove) {
  $removed = $false
  if (Remove-BridgeFromPatch $webPatch) { $removed = $true }
  if (Remove-BridgeFromPatch $homePatch) { $removed = $true }
  $link = Join-Path $webProfile "node_modules\@beauticode\dsh-plugin"
  if (Test-Path -LiteralPath $link) {
    Remove-Item -LiteralPath $link -Force -Recurse
    $removed = $true
  }
  if ($removed) { Write-BcLog "Removed beautiCode DSH plugin wiring." }
  else { Write-BcLog "No beautiCode DSH plugin wiring to remove." }
  exit 0
}

$fileUri = ConvertTo-FileUri $indexFile
$webExists = Test-Path -LiteralPath $webPackage -PathType Leaf

if ($webExists) {
  Ensure-PluginJunction
  Ensure-WebPackageDep
  Write-BridgePatch $webPatch (Get-PackageInsert)
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

exit 0
