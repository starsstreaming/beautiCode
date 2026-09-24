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
  return [bool]($Text -match "(?m)^\s*-\s*id:\s*$bridgeId\s*$")
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

function Remove-BridgeFromPatch([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  $raw = [IO.File]::ReadAllText($Path)
  if (-not (Test-PatchHasBridge $raw)) { return $false }
  # 同缩进边界截断：子项行必须以 [ \t] 开头，末个缩进行允许无换行结尾，
  # 避免吞掉下一个顶层条目（C-1 同源问题）。
  $cleaned = [regex]::Replace(
    $raw,
    "(?ms)(?:^|\r?\n)# beauticode-bridge \(installer\)\r?\n- insert:\r?\n(?:[ \t]+[^\r\n]*(?:\r?\n|$))*",
    "`n"
  )
  $cleaned = [regex]::Replace(
    $cleaned,
    "(?ms)(?:^|\r?\n)- insert:\r?\n(?:[ \t]+[^\r\n]*(?:\r?\n|$))*?[ \t]+-\s*id:\s*$bridgeId[ \t]*(?:\r?\n|$)(?:[ \t]+[^\r\n]*(?:\r?\n|$))*",
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
  # C-1：任何对用户文件的写入前无条件备份，杜绝"无备份覆盖"路径。
  Backup-BridgePatch $Path
  if (Test-PatchHasBridge $raw) {
    # 块级替换：先匹配完整块再 Remove/Insert，两个形态分别对应
    # ① 本脚本写入的注释标注块；② 无注释但块内含 bridge id 的块。
    # 子项按 [ \t] 同缩进截断，末个缩进行允许无换行结尾（手工编辑的文件）。
    $patterns = @(
      '(?ms)(?:^|\r?\n)# beauticode-bridge \(installer\)\r?\n- insert:\r?\n(?:[ \t]+[^\r\n]*(?:\r?\n|$))*',
      "(?ms)(?:^|\r?\n)- insert:\r?\n(?:[ \t]+[^\r\n]*(?:\r?\n|$))*?[ \t]+-[ \t]*id:[ \t]*$bridgeId[ \t]*(?:\r?\n|$)(?:[ \t]+[^\r\n]*(?:\r?\n|$))*"
    )
    foreach ($pattern in $patterns) {
      $match = [regex]::Match($raw, $pattern)
      if (-not $match.Success) { continue }
      $updated = $raw.Remove($match.Index, $match.Length).Insert($match.Index, $Body + "`r`n")
      [IO.File]::WriteAllText($Path, $updated.TrimEnd() + "`r`n")
      return
    }
    # 失败关闭：无法安全定位块时绝不整文件覆盖，保留原文件交由用户手工处理。
    throw ("无法安全更新 {0} 中的 beauticode-bridge 块（格式不受支持）。原文件已保留并备份，请手工将该块替换为：`r`n{1}" -f $Path, $Body)
  }
  $stripped = $raw.Trim()
  if ($stripped -eq "" -or $stripped -eq "[]") {
    [IO.File]::WriteAllText($Path, $Body + "`r`n")
    return
  }
  [IO.File]::WriteAllText($Path, $stripped.TrimEnd() + "`r`n`r`n" + $Body + "`r`n")
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
  $utf8 = New-Object System.Text.UTF8Encoding $false
  $text = $json | ConvertTo-Json -Depth 8
  [IO.File]::WriteAllText($webPackage, ($text.TrimEnd() + "`n"), $utf8)
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
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [IO.File]::WriteAllText((Join-Path $installRoot (Get-BcIntegrationNoteName)), $text, $utf8)
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
  $utf8 = New-Object System.Text.UTF8Encoding $false
  $text = $json | ConvertTo-Json -Depth 8
  [IO.File]::WriteAllText($webPackage, ($text.TrimEnd() + "`n"), $utf8)
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
      Backup-BridgePatch $webPatch
      [void](Remove-BridgeFromPatch $webPatch)
    }
  } else {
    Write-BridgePatch $webPatch (Get-PackageInsert)
  }
  if (Test-Path -LiteralPath $homePatch -PathType Leaf) {
    $homeRaw = [IO.File]::ReadAllText($homePatch)
    if (Test-PatchHasBridge $homeRaw) {
      Backup-BridgePatch $homePatch
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
