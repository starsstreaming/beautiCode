#Requires -Version 5.1
<#
.SYNOPSIS
  Choose which host beautiCode should control.

.DESCRIPTION
  The normal beautiCode shortcut opens a small host picker, then delegates to
  the Codex launcher or the DSH tray. Codex still starts the desktop host.
  DeepSeek Harness is user-managed: install the plugin into your DSH profile
  and run `dsh web` yourself. beautiCode never starts DSH.
#>
[CmdletBinding()]
param(
  [ValidateSet("prompt", "codex", "dsh")]
  [string]$TargetHost = "prompt",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$codexLauncher = Join-Path $repoRoot "scripts\start-beauticode-engine.ps1"
$dshTray = Join-Path $repoRoot "apps\tray\start-tray.ps1"
$iconPath = Join-Path $repoRoot "beauticode.ico"
$brandImagePath = Join-Path $repoRoot "assets\beauticode-icon-borderless.png"

function Show-BcHostPicker {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  if (-not ("BeautiCodeHostPickerNative" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BeautiCodeHostPickerNative {
  private static readonly IntPtr PerMonitorAwareV2 = new IntPtr(-4);
  [DllImport("user32.dll", SetLastError = true)]
  private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")]
  private static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]
  public static extern bool ReleaseCapture();
  [DllImport("user32.dll")]
  public static extern IntPtr SendMessage(IntPtr hWnd, int message, IntPtr wParam, IntPtr lParam);
  public static bool EnableDpi() {
    try {
      if (SetProcessDpiAwarenessContext(PerMonitorAwareV2)) return true;
    } catch (EntryPointNotFoundException) { }
    try { return SetProcessDPIAware(); } catch { return false; }
  }
}
'@
  }
  [void][BeautiCodeHostPickerNative]::EnableDpi()
  [System.Windows.Forms.Application]::EnableVisualStyles()
  try {
    [System.Windows.Forms.Application]::SetCompatibleTextRenderingDefault($false)
  } catch [System.InvalidOperationException] {
    # The setting is process-wide and may already be locked by another WinForms window.
  }

  $colors = @{
    Window = [System.Drawing.ColorTranslator]::FromHtml("#1E201D")
    Panel = [System.Drawing.ColorTranslator]::FromHtml("#242723")
    PanelSelected = [System.Drawing.ColorTranslator]::FromHtml("#2D332E")
    Hover = [System.Drawing.ColorTranslator]::FromHtml("#30362F")
    Line = [System.Drawing.ColorTranslator]::FromHtml("#454942")
    Text = [System.Drawing.ColorTranslator]::FromHtml("#F1EEE7")
    Muted = [System.Drawing.ColorTranslator]::FromHtml("#9CA198")
    Jade = [System.Drawing.ColorTranslator]::FromHtml("#86AA91")
    JadeDeep = [System.Drawing.ColorTranslator]::FromHtml("#496854")
    Copper = [System.Drawing.ColorTranslator]::FromHtml("#B98265")
  }
  $brandFont = New-Object System.Drawing.Font("Microsoft YaHei UI", 15, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Point)
  $titleFont = New-Object System.Drawing.Font("Microsoft YaHei UI", 12, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Point)
  $bodyStrongFont = New-Object System.Drawing.Font("Microsoft YaHei UI", 10.5, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Point)
  $bodyFont = New-Object System.Drawing.Font("Microsoft YaHei UI", 9.5, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
  $metaFont = New-Object System.Drawing.Font("Microsoft YaHei UI", 9.5, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
  $sectionFont = New-Object System.Drawing.Font("Microsoft YaHei UI", 9, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
  $ownedFonts = @($brandFont, $titleFont, $bodyStrongFont, $bodyFont, $metaFont, $sectionFont)
  $brandImage = $null

  function Set-BcPickerRoundedRegion {
    param(
      [System.Windows.Forms.Control]$Control,
      [int]$Radius
    )
    if ($Control.Width -le 0 -or $Control.Height -le 0) { return }
    $diameter = [Math]::Max(2, $Radius * 2)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    try {
      $path.AddArc(0, 0, $diameter, $diameter, 180, 90)
      $path.AddArc($Control.Width - $diameter, 0, $diameter, $diameter, 270, 90)
      $path.AddArc($Control.Width - $diameter, $Control.Height - $diameter, $diameter, $diameter, 0, 90)
      $path.AddArc(0, $Control.Height - $diameter, $diameter, $diameter, 90, 90)
      $path.CloseFigure()
      $oldRegion = $Control.Region
      $Control.Region = New-Object System.Drawing.Region($path)
      if ($null -ne $oldRegion) { $oldRegion.Dispose() }
    } finally {
      $path.Dispose()
    }
  }

  function New-BcPickerLabel {
    param(
      [string]$Text,
      [int]$X,
      [int]$Y,
      [int]$Width,
      [int]$Height,
      [System.Drawing.Font]$Font,
      [System.Drawing.Color]$Color,
      [System.Drawing.ContentAlignment]$Align = [System.Drawing.ContentAlignment]::MiddleLeft
    )
    $label = New-Object System.Windows.Forms.Label
    $label.Text = $Text
    $label.Location = New-Object System.Drawing.Point($X, $Y)
    $label.Size = New-Object System.Drawing.Size($Width, $Height)
    $label.Font = $Font
    $label.ForeColor = $Color
    $label.BackColor = [System.Drawing.Color]::Transparent
    $label.TextAlign = $Align
    $label.UseCompatibleTextRendering = $false
    return $label
  }

  $form = New-Object System.Windows.Forms.Form
  $form.Text = "beautiCode"
  $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
  $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
  $form.ClientSize = New-Object System.Drawing.Size(520, 320)
  $form.MaximizeBox = $false
  $form.MinimizeBox = $false
  $form.ShowInTaskbar = $true
  $form.TopMost = $true
  $form.KeyPreview = $true
  $form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::Dpi
  $form.BackColor = $colors.Line
  $form.Padding = New-Object System.Windows.Forms.Padding(1)
  if (Test-Path -LiteralPath $iconPath -PathType Leaf) {
    try { $form.Icon = New-Object System.Drawing.Icon($iconPath) } catch {}
  }

  $root = New-Object System.Windows.Forms.Panel
  $root.Dock = [System.Windows.Forms.DockStyle]::Fill
  $root.BackColor = $colors.Window
  [void]$form.Controls.Add($root)

  $header = New-Object System.Windows.Forms.Panel
  $header.Location = New-Object System.Drawing.Point(0, 0)
  $header.Size = New-Object System.Drawing.Size(518, 92)
  $header.BackColor = $colors.Panel
  [void]$root.Controls.Add($header)

  $mark = New-Object System.Windows.Forms.Panel
  $mark.Location = New-Object System.Drawing.Point(20, 19)
  $mark.Size = New-Object System.Drawing.Size(54, 54)
  $mark.BackColor = $colors.Window
  [void]$header.Controls.Add($mark)
  Set-BcPickerRoundedRegion -Control $mark -Radius 14
  if (Test-Path -LiteralPath $brandImagePath -PathType Leaf) {
    try {
      $brandImage = [System.Drawing.Image]::FromFile($brandImagePath)
      $picture = New-Object System.Windows.Forms.PictureBox
      $picture.Location = New-Object System.Drawing.Point(7, 7)
      $picture.Size = New-Object System.Drawing.Size(40, 40)
      $picture.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::Zoom
      $picture.Image = $brandImage
      [void]$mark.Controls.Add($picture)
    } catch { }
  }
  if ($mark.Controls.Count -eq 0) {
    $fallbackMark = New-BcPickerLabel -Text "美" -X 0 -Y 0 -Width 54 -Height 54 `
      -Font $brandFont -Color $colors.Jade -Align ([System.Drawing.ContentAlignment]::MiddleCenter)
    [void]$mark.Controls.Add($fallbackMark)
  }

  $brand = New-BcPickerLabel -Text "beautiCode" -X 88 -Y 17 -Width 220 -Height 30 `
    -Font $brandFont -Color $colors.Text
  [void]$header.Controls.Add($brand)
  $eyebrow = New-BcPickerLabel -Text "LOCAL APPEARANCE ENGINE" -X 89 -Y 47 -Width 230 -Height 21 `
    -Font $sectionFont -Color $colors.Jade
  [void]$header.Controls.Add($eyebrow)

  $currentHost = Get-BcRunningHost
  $statusText = if ($currentHost -eq "dsh") {
    "● 已连接 DeepSeek Harness"
  } elseif ($currentHost -eq "codex") {
    "● 已连接 Codex Desktop"
  } else {
    "● 本地引擎待连接"
  }
  $statusColor = if ($currentHost) { $colors.Jade } else { $colors.Muted }
  $status = New-BcPickerLabel -Text $statusText -X 314 -Y 19 -Width 184 -Height 25 `
    -Font $sectionFont -Color $statusColor -Align ([System.Drawing.ContentAlignment]::MiddleRight)
  [void]$header.Controls.Add($status)

  $title = New-BcPickerLabel -Text "选择本次控制目标" -X 20 -Y 105 -Width 250 -Height 29 `
    -Font $titleFont -Color $colors.Text
  [void]$root.Controls.Add($title)
  $hint = New-BcPickerLabel -Text "点击后立即启动" -X 350 -Y 107 -Width 148 -Height 25 `
    -Font $sectionFont -Color $colors.Muted -Align ([System.Drawing.ContentAlignment]::MiddleRight)
  [void]$root.Controls.Add($hint)

  function Add-BcHostCard {
    param(
      [string]$CardHost,
      [string]$Title,
      [string]$Description,
      [string]$Action,
      [int]$X,
      [bool]$Current
    )
    $outer = New-Object System.Windows.Forms.Panel
    $outer.Location = New-Object System.Drawing.Point($X, 140)
    $outer.Size = New-Object System.Drawing.Size(232, 116)
    $outer.BackColor = if ($Current) { $colors.JadeDeep } else { $colors.Line }
    $outer.Cursor = [System.Windows.Forms.Cursors]::Hand
    Set-BcPickerRoundedRegion -Control $outer -Radius 12

    $inner = New-Object System.Windows.Forms.Panel
    $inner.Location = New-Object System.Drawing.Point(1, 1)
    $inner.Size = New-Object System.Drawing.Size(230, 114)
    $inner.BackColor = if ($Current) { $colors.PanelSelected } else { $colors.Panel }
    $inner.Cursor = [System.Windows.Forms.Cursors]::Hand
    Set-BcPickerRoundedRegion -Control $inner -Radius 11
    [void]$outer.Controls.Add($inner)

    $titleWidth = if ($Current) { 148 } else { 198 }
    $titleLabel = New-BcPickerLabel -Text $Title -X 14 -Y 12 -Width $titleWidth -Height 24 `
      -Font $bodyStrongFont -Color $colors.Text
    $descriptionLabel = New-BcPickerLabel -Text $Description -X 14 -Y 39 -Width 196 -Height 43 `
      -Font $metaFont -Color $colors.Muted
    $actionLabel = New-BcPickerLabel -Text $Action -X 132 -Y 83 -Width 78 -Height 20 `
      -Font $sectionFont -Color $colors.Jade -Align ([System.Drawing.ContentAlignment]::MiddleRight)
    [void]$inner.Controls.Add($titleLabel)
    [void]$inner.Controls.Add($descriptionLabel)
    [void]$inner.Controls.Add($actionLabel)

    $badge = $null
    if ($Current) {
      $badge = New-Object System.Windows.Forms.Panel
      $badge.Location = New-Object System.Drawing.Point(170, 11)
      $badge.Size = New-Object System.Drawing.Size(46, 22)
      $badge.BackColor = $colors.Window
      Set-BcPickerRoundedRegion -Control $badge -Radius 10
      $badgeLabel = New-BcPickerLabel -Text "当前" -X 0 -Y 0 -Width 46 -Height 22 `
        -Font $sectionFont -Color $colors.Jade -Align ([System.Drawing.ContentAlignment]::MiddleCenter)
      [void]$badge.Controls.Add($badgeLabel)
      [void]$inner.Controls.Add($badge)
    }

    # Event callbacks run after this helper scope exits, so capture concrete
    # objects instead of resolving parent-scope variables at hover/click time.
    $pickerForm = $form
    $hoverBorderColor = $colors.Jade
    $hoverSurfaceColor = $colors.Hover
    $restBorderColor = if ($Current) { $colors.JadeDeep } else { $colors.Line }
    $restSurfaceColor = if ($Current) { $colors.PanelSelected } else { $colors.Panel }
    $selectHost = {
      $pickerForm.Tag = $CardHost
      $pickerForm.DialogResult = [System.Windows.Forms.DialogResult]::OK
      $pickerForm.Close()
    }.GetNewClosure()
    $showHover = {
      $outer.BackColor = $hoverBorderColor
      $inner.BackColor = $hoverSurfaceColor
    }.GetNewClosure()
    $clearHover = {
      $cursorPoint = $outer.PointToClient([System.Windows.Forms.Cursor]::Position)
      if (-not $outer.ClientRectangle.Contains($cursorPoint)) {
        $outer.BackColor = $restBorderColor
        $inner.BackColor = $restSurfaceColor
      }
    }.GetNewClosure()
    $interactiveControls = @($outer, $inner, $titleLabel, $descriptionLabel, $actionLabel)
    if ($null -ne $badge) { $interactiveControls += @($badge, $badge.Controls[0]) }
    foreach ($control in $interactiveControls) {
      $control.Cursor = [System.Windows.Forms.Cursors]::Hand
      $null = $control.add_Click($selectHost)
      $null = $control.add_MouseEnter($showHover)
      $null = $control.add_MouseLeave($clearHover)
    }
    [void]$root.Controls.Add($outer)
  }

  Add-BcHostCard -CardHost "dsh" -Title "DeepSeek Harness" `
    -Description "连接你已启动的 DSH 网页，套上图片或视频背景。" -Action "打开 →" `
    -X 20 -Current ($currentHost -eq "dsh")
  Add-BcHostCard -CardHost "codex" -Title "Codex Desktop" `
    -Description "连接 Codex 桌面端，应用背景与显示控制。" -Action "启动 →" `
    -X 266 -Current ($currentHost -eq "codex")

  $footerHint = New-BcPickerLabel -Text "选择会替换当前托盘目标" -X 20 -Y 275 -Width 250 -Height 25 `
    -Font $sectionFont -Color $colors.Muted
  [void]$root.Controls.Add($footerHint)
  $cancel = New-Object System.Windows.Forms.Button
  $cancel.Text = "Esc 取消"
  $cancel.Font = $sectionFont
  $cancel.Location = New-Object System.Drawing.Point(420, 274)
  $cancel.Size = New-Object System.Drawing.Size(78, 27)
  $cancel.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
  $cancel.FlatAppearance.BorderSize = 0
  $cancel.FlatAppearance.MouseOverBackColor = $colors.Panel
  $cancel.FlatAppearance.MouseDownBackColor = $colors.PanelSelected
  $cancel.BackColor = $colors.Window
  $cancel.ForeColor = $colors.Copper
  $cancel.UseVisualStyleBackColor = $false
  $cancel.UseCompatibleTextRendering = $false
  $cancel.Cursor = [System.Windows.Forms.Cursors]::Hand
  $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $form.CancelButton = $cancel
  [void]$root.Controls.Add($cancel)

  $dragWindow = {
    param($sender, $eventArgs)
    if ($eventArgs.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
      [void][BeautiCodeHostPickerNative]::ReleaseCapture()
      [void][BeautiCodeHostPickerNative]::SendMessage($form.Handle, 0xA1, [IntPtr]2, [IntPtr]::Zero)
    }
  }.GetNewClosure()
  foreach ($dragControl in @($header, $mark, $brand, $eyebrow, $status)) {
    $null = $dragControl.add_MouseDown($dragWindow)
  }
  $null = $form.add_KeyDown({
    param($sender, $eventArgs)
    if ($eventArgs.KeyCode -eq [System.Windows.Forms.Keys]::Escape) {
      $form.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
      $form.Close()
      $eventArgs.Handled = $true
    }
  })
  $form.Add_Shown({
    Set-BcPickerRoundedRegion -Control $form -Radius 16
    [void][BeautiCodeHostPickerNative]::ShowWindow($form.Handle, 5)
    [void][BeautiCodeHostPickerNative]::SetForegroundWindow($form.Handle)
    $form.Activate()
  })
  try {
    $result = $form.ShowDialog()
    if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
      return [string]$form.Tag
    }
    return $null
  } finally {
    if ($null -ne $brandImage) { $brandImage.Dispose() }
    foreach ($font in $ownedFonts) { $font.Dispose() }
    if ($null -ne $form.Icon) { $form.Icon.Dispose() }
    $form.Dispose()
  }
}

function Get-BcRunningHost {
  foreach ($candidate in @("codex", "dsh")) {
    $mutex = $null
    try {
      $mutex = [System.Threading.Mutex]::OpenExisting(
        ("Local\beautiCode.Engine.Host.{0}.v1" -f $candidate)
      )
      return $candidate
    } catch [System.Threading.WaitHandleCannotBeOpenedException] {
      continue
    } finally {
      if ($null -ne $mutex) { $mutex.Dispose() }
    }
  }
  return $null
}

function Test-BcTrayRunning {
  $mutex = $null
  try {
    $mutex = [System.Threading.Mutex]::OpenExisting("Local\beautiCode.Engine.Tray.v1")
    return $true
  } catch [System.Threading.WaitHandleCannotBeOpenedException] {
    return $false
  } finally {
    if ($null -ne $mutex) { $mutex.Dispose() }
  }
}

function Send-BcTrayEvent {
  param([string]$Name)
  $event = $null
  try {
    $event = [System.Threading.EventWaitHandle]::OpenExisting($Name)
    [void]$event.Set()
    return $true
  } catch [System.Threading.WaitHandleCannotBeOpenedException] {
    return $false
  } finally {
    if ($null -ne $event) { $event.Dispose() }
  }
}

function Show-BcSwitchError([string]$Message) {
  Add-Type -AssemblyName System.Windows.Forms
  if (-not ("BeautiCodeHostPickerNative" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BeautiCodeHostPickerNative {
  [DllImport("user32.dll")]
  public static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);
}
'@
  }

  $owner = New-Object System.Windows.Forms.Form
  $owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
  $owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedToolWindow
  $owner.ShowInTaskbar = $false
  $owner.TopMost = $true
  $owner.Opacity = 0
  try {
    $owner.Show()
    [void][BeautiCodeHostPickerNative]::ShowWindow($owner.Handle, 5)
    [void][BeautiCodeHostPickerNative]::SetForegroundWindow($owner.Handle)
    [System.Windows.Forms.MessageBox]::Show(
      $owner,
      $Message,
      "beautiCode",
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Warning
    ) | Out-Null
  } finally {
    $owner.Close()
    $owner.Dispose()
  }
}

if ($DryRun -and $TargetHost -eq "prompt") {
  throw "DryRun 必须显式指定 -TargetHost codex 或 dsh。"
}

$selected = if ($TargetHost -eq "prompt") {
  Show-BcHostPicker
} else {
  $TargetHost
}
if (-not $selected) { return }

$route = if ($selected -eq "dsh") {
  [pscustomobject]@{
    Host = "dsh"
    Script = $dshTray
    Arguments = @{ TargetHost = "dsh"; SkipBuild = $true }
  }
} else {
  [pscustomobject]@{
    Host = "codex"
    Script = $codexLauncher
    Arguments = @{}
  }
}
if (-not (Test-Path -LiteralPath $route.Script -PathType Leaf)) {
  Show-BcSwitchError "缺少 beautiCode 启动脚本：$($route.Script)"
  return
}

if ($DryRun) {
  $route | ConvertTo-Json -Depth 3
  return
}

if ($route.Host -eq "dsh") {
  $pluginInstaller = Join-Path $repoRoot "scripts\install-dsh-plugin.ps1"
  $pluginRoot = Join-Path $repoRoot "integrations\deepseek-harness"
  if (Test-Path -LiteralPath $pluginInstaller -PathType Leaf) {
    try {
      & $pluginInstaller -PluginRoot $pluginRoot
    } catch {
      Write-Host ("未能自动写入 DSH 插件：{0}" -f $_.Exception.Message)
    }
  }
}

$runningHost = Get-BcRunningHost
if ($runningHost -eq $route.Host) {
  [void](Send-BcTrayEvent -Name "Local\beautiCode.Engine.ShowPanel.v1")
  return
}
if (Test-BcTrayRunning) {
  if (-not $runningHost) {
    Show-BcSwitchError "检测到旧版或未知的 beautiCode 托盘。请先从托盘菜单退出，再重新选择目标应用。"
    return
  }
  if (-not (Send-BcTrayEvent -Name "Local\beautiCode.Engine.Shutdown.v1")) {
    Show-BcSwitchError "无法通知当前 beautiCode 托盘退出。请手动退出后重试。"
    return
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while (Test-BcTrayRunning) {
    if ([DateTime]::UtcNow -ge $deadline) {
      Show-BcSwitchError "等待当前 beautiCode 托盘退出超时。请手动退出后重试。"
      return
    }
    Start-Sleep -Milliseconds 100
  }
}

try {
  $routeArguments = $route.Arguments
  & $route.Script @routeArguments
} catch {
  Show-BcSwitchError ("启动 {0} 失败：{1}" -f $route.Host, $_.Exception.Message)
  exit 1
}
