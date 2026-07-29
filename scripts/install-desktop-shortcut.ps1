#Requires -Version 5.1
<#
.SYNOPSIS
  Create a Desktop shortcut for the beautiCode engine launcher.
#>
param(
  [string]$DesktopPath = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Launcher = Join-Path $RepoRoot "scripts\start-beauticode-engine.ps1"
if (-not (Test-Path -LiteralPath $Launcher)) {
  throw "Missing launcher: $Launcher"
}

if (-not $DesktopPath) {
  $DesktopPath = [Environment]::GetFolderPath("Desktop")
}
if (-not (Test-Path -LiteralPath $DesktopPath)) {
  throw "Desktop not found: $DesktopPath"
}

# Build the Chinese label from code points so Windows PowerShell 5.1 can parse
# this source correctly regardless of the system ANSI code page.
$engineLabel = [string]::Concat([char]0x5F15, [char]0x64CE)
$shortcutPath = Join-Path $DesktopPath ("beautiCode {0}.lnk" -f $engineLabel)
$iconCandidate = @(
  (Join-Path $RepoRoot "apps\tray\icon.ico"),
  (Join-Path $env:LOCALAPPDATA "Programs\chatgpt\ChatGPT.exe"),
  (Join-Path ${env:ProgramFiles} "nodejs\node.exe")
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1

$wsh = New-Object -ComObject WScript.Shell
$sc = $wsh.CreateShortcut($shortcutPath)
$sc.TargetPath = "powershell.exe"
$sc.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Launcher`""
$sc.WorkingDirectory = $RepoRoot
$sc.WindowStyle = 7
$sc.Description = "Start beautiCode engine (system tray background for Codex)"
if ($iconCandidate) {
  $sc.IconLocation = "$iconCandidate,0"
}
$sc.Save()
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($wsh) | Out-Null

Write-Host "Desktop shortcut created:"
Write-Host "  $shortcutPath"
Write-Host "Target launcher:"
Write-Host "  $Launcher"
