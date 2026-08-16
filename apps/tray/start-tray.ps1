#Requires -Version 5.1
param(
  [int]$Port = 0,
  [string]$DataRoot = "",
  [string]$NodePath = "",
  [ValidateSet("codex", "dsh")]
  [string]$TargetHost = "codex",
  [string]$DshUrl = "http://127.0.0.1:3080",
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$script:targetHost = $TargetHost
$script:DshUrl = if ($DshUrl) { $DshUrl } else { "http://127.0.0.1:3080" }

$script:TrayLogRoot = if ($env:LOCALAPPDATA) {
  Join-Path $env:LOCALAPPDATA "beautiCode\logs"
} else {
  Join-Path ([System.IO.Path]::GetTempPath()) "beautiCode\logs"
}
$script:TrayLogPath = Join-Path $script:TrayLogRoot "tray.log"

function Write-BcTrayLog([string]$Message) {
  try {
    if (-not (Test-Path -LiteralPath $script:TrayLogRoot)) {
      New-Item -ItemType Directory -Path $script:TrayLogRoot -Force | Out-Null
    }
    Add-Content -LiteralPath $script:TrayLogPath `
      -Value (("[{0:u}] {1}" -f (Get-Date).ToUniversalTime(), $Message)) `
      -Encoding UTF8
  } catch { }
}

trap {
  $message = if ($_.Exception) { $_.Exception.Message } else { [string]$_ }
  Write-BcTrayLog ("tray failed: {0}" -f $message)
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
    [System.Windows.Forms.MessageBox]::Show(
      ("beautiCode 托盘启动失败：`n{0}`n`n日志：{1}" -f $message, $script:TrayLogPath),
      "beautiCode",
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
  } catch { }
  exit 1
}
Write-BcTrayLog "tray starting"

$script:trayInstanceMutex = $null
$script:trayInstanceMutexOwned = $false
$script:hostInstanceMutex = $null
$script:hostInstanceMutexOwned = $false
$script:showPanelEvent = $null
$script:shutdownEvent = $null
$script:showPanelTimer = $null
$createdNew = $false
$script:trayInstanceMutex = [System.Threading.Mutex]::new(
  $true,
  "Local\beautiCode.Engine.Tray.v1",
  [ref]$createdNew
)
if (-not $createdNew) {
  $script:trayInstanceMutex.Dispose()
  exit 0
}
$script:trayInstanceMutexOwned = $true
$hostMutexCreated = $false
$script:hostInstanceMutex = [System.Threading.Mutex]::new(
  $true,
  ("Local\beautiCode.Engine.Host.{0}.v1" -f $TargetHost),
  [ref]$hostMutexCreated
)
$script:hostInstanceMutexOwned = $hostMutexCreated
$showPanelEventCreated = $false
$script:showPanelEvent = [System.Threading.EventWaitHandle]::new(
  $false,
  [System.Threading.EventResetMode]::AutoReset,
  "Local\beautiCode.Engine.ShowPanel.v1",
  [ref]$showPanelEventCreated
)
$shutdownEventCreated = $false
$script:shutdownEvent = [System.Threading.EventWaitHandle]::new(
  $false,
  [System.Threading.EventResetMode]::AutoReset,
  "Local\beautiCode.Engine.Shutdown.v1",
  [ref]$shutdownEventCreated
)

$dpiNativeCode = @'
using System;
using System.Runtime.InteropServices;

public static class BeautiCodeDpiNative {
  private static readonly IntPtr PerMonitorAwareV2 = new IntPtr(-4);

  [DllImport("user32.dll", SetLastError = true)]
  private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

  [DllImport("user32.dll")]
  private static extern bool SetProcessDPIAware();

  [DllImport("user32.dll")]
  private static extern uint GetDpiForSystem();

  public static bool Enable() {
    try {
      if (SetProcessDpiAwarenessContext(PerMonitorAwareV2)) return true;
    } catch (EntryPointNotFoundException) {
      // Windows older than 10 1703.
    }
    try {
      return SetProcessDPIAware();
    } catch {
      return false;
    }
  }

  public static int SystemDpi() {
    try {
      return (int)GetDpiForSystem();
    } catch {
      return 96;
    }
  }
}
'@
Add-Type -TypeDefinition $dpiNativeCode -ErrorAction Stop
[void][BeautiCodeDpiNative]::Enable()

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
try {
  [System.Windows.Forms.Application]::SetCompatibleTextRenderingDefault($false)
} catch [System.InvalidOperationException] {
  Write-BcTrayLog "compatible text rendering was already initialized by the launcher"
}

if (-not ("BeautiCodeToggle" -as [type])) {
  $toggleCode = @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

public sealed class BeautiCodeToggle : Control {
  private bool isChecked;

  public BeautiCodeToggle() {
    SetStyle(
      ControlStyles.AllPaintingInWmPaint |
      ControlStyles.OptimizedDoubleBuffer |
      ControlStyles.ResizeRedraw |
      ControlStyles.UserPaint,
      true
    );
    Cursor = Cursors.Hand;
    TabStop = true;
  }

  public bool Checked {
    get { return isChecked; }
    set {
      if (isChecked == value) return;
      isChecked = value;
      Invalidate();
    }
  }

  public Color TrackOnColor { get; set; }
  public Color TrackOffColor { get; set; }
  public Color BorderOnColor { get; set; }
  public Color BorderOffColor { get; set; }
  public Color KnobColor { get; set; }

  private static GraphicsPath RoundedRect(RectangleF rect) {
    float diameter = rect.Height;
    GraphicsPath path = new GraphicsPath();
    path.AddArc(rect.Left, rect.Top, diameter, diameter, 90, 180);
    path.AddArc(rect.Right - diameter, rect.Top, diameter, diameter, 270, 180);
    path.CloseFigure();
    return path;
  }

  protected override void OnPaint(PaintEventArgs e) {
    base.OnPaint(e);
    e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
    e.Graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;

    RectangleF track = new RectangleF(
      0.75f,
      0.75f,
      Math.Max(1f, ClientSize.Width - 1.5f),
      Math.Max(1f, ClientSize.Height - 1.5f)
    );
    Color trackColor = isChecked ? TrackOnColor : TrackOffColor;
    Color borderColor = isChecked ? BorderOnColor : BorderOffColor;

    using (GraphicsPath path = RoundedRect(track))
    using (SolidBrush trackBrush = new SolidBrush(trackColor))
    using (Pen borderPen = new Pen(borderColor, 1f)) {
      e.Graphics.FillPath(trackBrush, path);
      e.Graphics.DrawPath(borderPen, path);
    }

    float inset = Math.Max(3f, track.Height * 0.14f);
    float knobSize = Math.Max(8f, track.Height - (inset * 2f));
    float knobX = isChecked
      ? track.Right - inset - knobSize
      : track.Left + inset;
    RectangleF knob = new RectangleF(
      knobX,
      track.Top + inset,
      knobSize,
      knobSize
    );
    RectangleF shadow = knob;
    shadow.Y += Math.Max(1f, track.Height * 0.04f);

    using (SolidBrush shadowBrush = new SolidBrush(Color.FromArgb(58, 0, 0, 0)))
    using (SolidBrush knobBrush = new SolidBrush(KnobColor)) {
      e.Graphics.FillEllipse(shadowBrush, shadow);
      e.Graphics.FillEllipse(knobBrush, knob);
    }

    if (Focused && ShowFocusCues) {
      Rectangle focus = ClientRectangle;
      focus.Inflate(-2, -2);
      ControlPaint.DrawFocusRectangle(e.Graphics, focus);
    }
  }

  protected override void OnKeyDown(KeyEventArgs e) {
    if (e.KeyCode == Keys.Space || e.KeyCode == Keys.Enter) {
      OnClick(EventArgs.Empty);
      e.Handled = true;
      e.SuppressKeyPress = true;
      return;
    }
    base.OnKeyDown(e);
  }
}
'@
  Add-Type -TypeDefinition $toggleCode -ReferencedAssemblies @(
    "System.Drawing",
    "System.Windows.Forms"
  ) -ErrorAction Stop
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$HostScript = Join-Path $PSScriptRoot "session-host.mjs"
$ReleaseManifest = Join-Path $RepoRoot "release-manifest.json"
$BundledNode = Join-Path $RepoRoot "runtime\node.exe"
$coreDist = Join-Path $RepoRoot "packages\core\dist\index.js"
$adapterFolder = if ($TargetHost -eq "dsh") { "adapter-dsh" } else { "adapter-codex" }
$adapterDist = Join-Path $RepoRoot ("packages\{0}\dist\index.js" -f $adapterFolder)

if ($NodePath) {
  if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
    throw ("未找到 Node.js 可执行文件：{0}" -f $NodePath)
  }
  $Node = (Resolve-Path -LiteralPath $NodePath).Path
} elseif (Test-Path -LiteralPath $BundledNode -PathType Leaf) {
  $Node = $BundledNode
} else {
  $Node = (Get-Command node -ErrorAction Stop).Source
}

if (Test-Path -LiteralPath $ReleaseManifest -PathType Leaf) {
  $SkipBuild = $true
}

if (-not (Test-Path -LiteralPath $HostScript)) {
  throw ("未找到 session-host.mjs：{0}" -f $HostScript)
}

if (-not $SkipBuild) {
  # Only build when dist is missing — full npm build on every tray start was a
  # multi-second tax. Development rebuilds: npm run build / npm run tray.
  $needBuild = -not ((Test-Path -LiteralPath $coreDist) -and (Test-Path -LiteralPath $adapterDist))
  if (-not $needBuild) {
    $distCutoff = @(
      (Get-Item -LiteralPath $coreDist).LastWriteTimeUtc,
      (Get-Item -LiteralPath $adapterDist).LastWriteTimeUtc
    ) | Sort-Object | Select-Object -First 1
    $inputFiles = @()
    foreach ($inputPath in @(
        (Join-Path $RepoRoot "packages\core\src"),
        (Join-Path $RepoRoot ("packages\{0}\src" -f $adapterFolder))
      )) {
      $inputFiles += @(Get-ChildItem -LiteralPath $inputPath -Recurse -File)
    }
    foreach ($inputPath in @(
        (Join-Path $RepoRoot "package.json"),
        (Join-Path $RepoRoot "package-lock.json"),
        (Join-Path $RepoRoot "packages\core\package.json"),
        (Join-Path $RepoRoot ("packages\{0}\package.json" -f $adapterFolder)),
        (Join-Path $RepoRoot "scripts\copy-renderer-assets.mjs")
      )) {
      if (Test-Path -LiteralPath $inputPath) {
        $inputFiles += @(Get-Item -LiteralPath $inputPath)
      }
    }
    $newestInput = $inputFiles |
      Sort-Object -Property LastWriteTimeUtc -Descending |
      Select-Object -First 1
    $needBuild = $newestInput -and ($newestInput.LastWriteTimeUtc -gt $distCutoff)
  }
  if ($needBuild) {
    Write-Host "Building packages (dist missing or stale)..."
    Push-Location $RepoRoot
    try {
      & npm.cmd run build
      if ($LASTEXITCODE -ne 0) {
        throw ("npm run build 失败（退出码 {0}）。" -f $LASTEXITCODE)
      }
    } finally {
      Pop-Location
    }
  }
}

foreach ($requiredRuntimeFile in @($HostScript, $coreDist, $adapterDist)) {
  if (-not (Test-Path -LiteralPath $requiredRuntimeFile -PathType Leaf)) {
    throw ("未找到 beautiCode 运行时文件：{0}" -f $requiredRuntimeFile)
  }
}

# Cryptographically strong token for the local control plane.
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $TokenBytes = New-Object byte[] 32
  $rng.GetBytes($TokenBytes)
} finally {
  $rng.Dispose()
}
$Token = -join ($TokenBytes | ForEach-Object { $_.ToString("x2") })

function ConvertTo-PsLiteral([string]$Value) {
  return "'" + ($Value -replace "'", "''") + "'"
}

# The data root is explicit: the tray (as launcher) always picks one and hands
# it to the engine — core never guesses a default. Default follows the Windows
# install convention; DSH/Codex control must share the same root.
if (-not $DataRoot) {
  $DataRoot = if ($env:LOCALAPPDATA) {
    Join-Path $env:LOCALAPPDATA "beautiCode"
  } else {
    Join-Path ([System.IO.Path]::GetTempPath()) "beautiCode"
  }
}

$nodeInvocationParts = @(
  (ConvertTo-PsLiteral $Node),
  (ConvertTo-PsLiteral $HostScript),
  "--host",
  $TargetHost
)
if ($TargetHost -eq "dsh") {
  $nodeInvocationParts += @("--dsh-url", (ConvertTo-PsLiteral $DshUrl))
}
if ($Port -gt 0) {
  $nodeInvocationParts += @("--port", "$Port")
}
if ($DataRoot) {
  $nodeInvocationParts += @("--data-root", (ConvertTo-PsLiteral $DataRoot))
}

# Windows PowerShell 5.1 can throw while reading ProcessStartInfo.EnvironmentVariables
# when the inherited process has both Path and PATH. Start a tiny PowerShell bridge,
# pass the token through stdin, and let that bridge set the child-only environment.
$nodeInvocation = [string]::Join(" ", $nodeInvocationParts)
$bridgeScript = @"
`$token = [Console]::In.ReadToEnd()
if ([string]::IsNullOrWhiteSpace(`$token)) { throw "缺少 beautiCode 控制令牌。" }
`$env:BEAUTICODE_CONTROL_TOKEN = `$token.Trim()
& $nodeInvocation
exit `$LASTEXITCODE
"@
$bridgeBytes = [System.Text.Encoding]::Unicode.GetBytes($bridgeScript)
$bridgeCommand = [Convert]::ToBase64String($bridgeBytes)
$powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $powershell
$psi.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $bridgeCommand"
$psi.WorkingDirectory = $RepoRoot
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true

$proc = New-Object System.Diagnostics.Process
$proc.StartInfo = $psi

$stdoutSync = [hashtable]::Synchronized(@{ Lines = New-Object System.Collections.ArrayList })
$stderrSync = [hashtable]::Synchronized(@{ Lines = New-Object System.Collections.ArrayList })

$outEvent = Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived -MessageData $stdoutSync -Action {
  $line = $EventArgs.Data
  if (-not [string]::IsNullOrEmpty($line)) {
    [void]$Event.MessageData.Lines.Add($line)
  }
}
$errEvent = Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived -MessageData $stderrSync -Action {
  $line = $EventArgs.Data
  if (-not [string]::IsNullOrEmpty($line)) {
    [void]$Event.MessageData.Lines.Add($line)
  }
}

[void]$proc.Start()
$proc.BeginOutputReadLine()
$proc.BeginErrorReadLine()
$proc.StandardInput.WriteLine($Token)
$proc.StandardInput.Close()

$ready = $null
$deadline = [datetime]::UtcNow.AddSeconds(20)
while ([datetime]::UtcNow -lt $deadline) {
  if ($proc.HasExited) {
    $errDump = [string]::Join([Environment]::NewLine, @($stderrSync.Lines))
    $msg = "session-host exited early ({0}).{1}{2}" -f $proc.ExitCode, [Environment]::NewLine, $errDump
    throw $msg
  }
  foreach ($line in @($stdoutSync.Lines)) {
    if (($line -match '^\s*\{') -and ($line -match '"ready"')) {
      try {
        $ready = $line | ConvertFrom-Json
        break
      } catch {
        # keep waiting
      }
    }
  }
  if ($ready -and $ready.ready) { break }
  Start-Sleep -Milliseconds 40
}

if (-not $ready -or -not $ready.ready) {
  try { if (-not $proc.HasExited) { $proc.Kill() } } catch { }
  throw "等待 session-host 就绪超时。"
}

$controlPort = [int]$ready.controlPort
$cdpPort = if ($null -ne $ready.cdpPort) { [int]$ready.cdpPort } else { 0 }
$script:cdpPort = $cdpPort
$BaseUrl = "http://127.0.0.1:$controlPort"
Write-Host ("Tray control plane {0} (host: {1})" -f $BaseUrl, $TargetHost)
Write-BcTrayLog ("session-host ready host={0} controlPort={1} cdpPort={2}" -f $TargetHost, $controlPort, $cdpPort)

function Invoke-BcApi {
  param(
    [string]$Method,
    [string]$Path,
    [hashtable]$Body = $null
  )
  $uri = "$BaseUrl$Path"
  $headers = @{ Authorization = ("Bearer {0}" -f $Token) }
  try {
    if ($null -ne $Body) {
      # ConvertTo-Json + string Body under Windows PowerShell 5.1 often sends
      # system ANSI (GBK) despite charset=utf-8, mojibaking Chinese theme names
      # and ids. Always push explicit UTF-8 bytes.
      $json = $Body | ConvertTo-Json -Compress -Depth 6
      $utf8 = New-Object System.Text.UTF8Encoding $false
      $bytes = $utf8.GetBytes([string]$json)
      return Invoke-RestMethod -Uri $uri -Method $Method -Headers $headers -ContentType "application/json; charset=utf-8" -Body $bytes -TimeoutSec 120
    }
    return Invoke-RestMethod -Uri $uri -Method $Method -Headers $headers -TimeoutSec 60
  } catch {
    $msg = $_.Exception.Message
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
      try {
        $parsed = $_.ErrorDetails.Message | ConvertFrom-Json
        if ($parsed.error) { $msg = [string]$parsed.error }
      } catch {
        $msg = $_.ErrorDetails.Message
      }
    }
    throw (ConvertTo-BcChineseError -Message $msg)
  }
}

function ConvertTo-BcChineseError {
  param([AllowNull()][string]$Message)
  $text = if ($null -eq $Message) { "" } else { [string]$Message }
  if ($text -match '(?i)failed to fetch|fetch failed|fail fetch|No healthy loopback Codex CDP|CDP is missing or unreachable') {
    return "未发现注入CDP的Codex进程"
  }
  if ($text -match '(?i)No active background|no background|Apply an image or video') {
    return "当前没有背景，请先应用图片或视频。"
  }
  if ($text -match '(?i)No DeepSeek Harness browser client is connected') {
    return "未连接到 DeepSeek Harness 网页，请先打开页面。"
  }
  if ($text -match '(?i)Another background apply is already in progress|already in progress|\bbusy\b') {
    return "已有背景应用正在进行中，请等待当前操作完成。"
  }
  if ($text -match '(?i)Session is not started') { return "会话尚未启动。" }
  if ($text -match '(?i)Host is not connected') { return "尚未连接到 Codex 主机。" }
  if ($text -match '(?i)Saved theme not found') { return "未找到已保存的主题。" }
  if ($text -match '(?i)Invalid saved theme id') { return "已保存主题 ID 无效。" }
  if ($text -match '(?i)No live CDP sessions') { return "未发现活动的 CDP 会话。" }
  if ($text -match '(?i)Timed out waiting') { return "等待目标就绪超时。" }
  if ($text -match '(?i)Could not stop ChatGPT/Codex') { return "无法停止 ChatGPT/Codex 进程：$text" }
  if ($text -match '(?i)Cannot start ChatGPT/Codex') { return "无法启动 ChatGPT/Codex：$text" }
  if ($text -match '(?i)not found') { return "未找到所需文件或资源：$text" }
  return $text
}

function Show-Tip {
  param(
    [string]$Title,
    [string]$Text,
    [ValidateSet("Info", "Warning", "Error", "None")]
    [string]$Icon = "Info"
  )
  $Text = ConvertTo-BcChineseError -Message $Text
  switch ($Icon) {
    "Warning" { $toolIcon = [System.Windows.Forms.ToolTipIcon]::Warning }
    "Error" { $toolIcon = [System.Windows.Forms.ToolTipIcon]::Error }
    "None" { $toolIcon = [System.Windows.Forms.ToolTipIcon]::None }
    default { $toolIcon = [System.Windows.Forms.ToolTipIcon]::Info }
  }
  if ($Text.Length -gt 220) {
    $Text = $Text.Substring(0, 217) + "..."
  }
  $script:notify.BalloonTipTitle = $Title
  $script:notify.BalloonTipText = $Text
  $script:notify.BalloonTipIcon = $toolIcon
  $script:notify.ShowBalloonTip(4000)
}

function Get-OpenPath {
  param(
    [string]$Title,
    [string]$Filter,
    [string]$DefaultExt = "",
    [int]$FilterIndex = 1
  )
  $dlg = New-Object System.Windows.Forms.OpenFileDialog
  $dlg.Title = $Title
  # No "All files" entry — image picker is image-only, video picker is MP4-only.
  $dlg.Filter = $Filter
  $dlg.FilterIndex = [Math]::Max(1, $FilterIndex)
  $dlg.CheckFileExists = $true
  $dlg.Multiselect = $false
  $dlg.RestoreDirectory = $true
  $dlg.DereferenceLinks = $true
  $dlg.ValidateNames = $true
  if ($DefaultExt) {
    $dlg.DefaultExt = $DefaultExt
    $dlg.AddExtension = $true
  }
  $result = $dlg.ShowDialog()
  if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    return $dlg.FileName
  }
  return $null
}

function Test-BcImageExt([string]$Path) {
  $ext = [System.IO.Path]::GetExtension($Path)
  if (-not $ext) { return $false }
  switch ($ext.ToLowerInvariant()) {
    ".png" { return $true }
    ".jpg" { return $true }
    ".jpeg" { return $true }
    ".webp" { return $true }
    ".avif" { return $true }
    default { return $false }
  }
}

function Test-BcMp4Ext([string]$Path) {
  $ext = [System.IO.Path]::GetExtension($Path)
  return ($ext -and $ext.ToLowerInvariant() -eq ".mp4")
}

function Get-BcThemeName {
  param([string]$DefaultName = "")
  try {
    Add-Type -AssemblyName Microsoft.VisualBasic -ErrorAction Stop
    $name = [Microsoft.VisualBasic.Interaction]::InputBox(
      $L.SaveThemePrompt,
      $L.SaveThemeTitle,
      $DefaultName
    )
    if ($null -eq $name) { return $null }
    $trimmed = $name.Trim()
    if (-not $trimmed) { return $null }
    return $trimmed
  } catch {
    # Fallback if VisualBasic assembly is unavailable.
    $dlg = New-Object System.Windows.Forms.Form
    $dlg.Text = $L.SaveThemeTitle
    $dlg.Width = 420
    $dlg.Height = 160
    $dlg.StartPosition = "CenterScreen"
    $dlg.FormBorderStyle = "FixedDialog"
    $dlg.MaximizeBox = $false
    $dlg.MinimizeBox = $false
    $lbl = New-Object System.Windows.Forms.Label
    $lbl.Text = $L.SaveThemePrompt
    $lbl.Left = 12
    $lbl.Top = 12
    $lbl.Width = 380
    $tb = New-Object System.Windows.Forms.TextBox
    $tb.Left = 12
    $tb.Top = 40
    $tb.Width = 380
    $tb.Text = $DefaultName
    $ok = New-Object System.Windows.Forms.Button
    $ok.Text = "OK"
    $ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
    $ok.Left = 220
    $ok.Top = 80
    $cancel = New-Object System.Windows.Forms.Button
    $cancel.Text = "Cancel"
    $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
    $cancel.Left = 310
    $cancel.Top = 80
    $dlg.Controls.AddRange(@($lbl, $tb, $ok, $cancel))
    $dlg.AcceptButton = $ok
    $dlg.CancelButton = $cancel
    $result = $dlg.ShowDialog()
    if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
      $trimmed = $tb.Text.Trim()
      if ($trimmed) { return $trimmed }
    }
    return $null
  }
}

function Test-BcCdpPort([int]$CdpPort) {
  if ($CdpPort -le 0) { return $false }
  # Cheap TCP first — avoids 1s HTTP timeout on closed ports.
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $iar = $client.BeginConnect("127.0.0.1", $CdpPort, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne(80, $false)
    if (-not $ok) {
      try { $client.Close() } catch { }
      return $false
    }
    try { $client.EndConnect($iar) } catch {
      try { $client.Close() } catch { }
      return $false
    }
    try { $client.Close() } catch { }
  } catch {
    return $false
  }
  try {
    $r = Invoke-WebRequest -Uri ("http://127.0.0.1:{0}/json/version" -f $CdpPort) -UseBasicParsing -TimeoutSec 1
    return ($r.StatusCode -eq 200)
  } catch {
    return $false
  }
}

function Wait-BcCdpReady {
  param(
    [int]$PreferredPort = 0,
    [int]$TimeoutSec = 30
  )
  $deadline = [datetime]::UtcNow.AddSeconds($TimeoutSec)
  # Hot ports only — full list slows the miss path. session-host discover is fallback.
  $candidates = New-Object System.Collections.ArrayList
  if ($PreferredPort -gt 0) { [void]$candidates.Add([int]$PreferredPort) }
  foreach ($p in @(9335, 9222, 9223)) {
    if (-not $candidates.Contains([int]$p)) { [void]$candidates.Add([int]$p) }
  }
  $tick = 0
  while ([datetime]::UtcNow -lt $deadline) {
    foreach ($p in @($candidates)) {
      if (Test-BcCdpPort -CdpPort $p) { return [int]$p }
    }
    # Discover is heavier — only every ~1.2s, not every poll.
    $tick++
    if (($tick % 6) -eq 0) {
      try {
        $d = Invoke-BcApi -Method Post -Path "/discover" -Body @{}
        if ($d.ok -and $d.endpoints -and @($d.endpoints).Count -gt 0) {
          $hit = [int](@($d.endpoints)[0].port)
          if ($hit -gt 0 -and (Test-BcCdpPort -CdpPort $hit)) { return $hit }
        }
      } catch { }
    }
    Start-Sleep -Milliseconds 180
  }
  return 0
}

function Get-BcDshPageUrl {
  $raw = [string]$script:DshUrl
  if (-not $raw) { $raw = "http://127.0.0.1:3080" }
  return $raw.TrimEnd("/")
}

function Test-BcDshBridgeUp {
  try {
    $ver = Invoke-RestMethod -UseBasicParsing `
      -Uri ("{0}/__beauticode/version" -f (Get-BcDshPageUrl)) `
      -TimeoutSec 1
    return ($ver.ok -eq $true)
  } catch {
    return $false
  }
}

function Start-BcDshBridgeIfNeeded {
  if (Test-BcDshBridgeUp) { return $true }
  # beautiCode never starts DSH. The user runs `dsh web` with the
  # @beauticode/dsh-plugin installed; if the bridge is not reachable, ask the
  # user to bring DSH up instead of spawning anything.
  throw ("未检测到 DeepSeek Harness 桥接。请先用安装过 beautiCode 插件的 dsh 启动网页（dsh web，已安装 @beauticode/dsh-plugin），再点「应用或重新应用」。")
}

function Open-BcDshPage {
  Start-Process -FilePath (Get-BcDshPageUrl) | Out-Null
}

function Wait-BcDshBrowserClient {
  param([int]$TimeoutSec = 30)
  $deadline = [datetime]::UtcNow.AddSeconds([Math]::Max(5, $TimeoutSec))
  while ([datetime]::UtcNow -lt $deadline) {
    try {
      $st = Invoke-BcApi -Method Get -Path "/status"
      if ($st -and ([int]$st.sessions) -gt 0) { return $true }
    } catch { }
    Start-Sleep -Milliseconds 200
  }
  return $false
}

# DSH apply needs a live browser EventSource. beautiCode never starts DSH: if
# the bridge is missing, tell the user to bring DSH up; if the page is closed,
# open it before publishing.
function Ensure-BcDshReady {
  if ($script:targetHost -ne "dsh") { return $true }
  if (-not (Test-BcDshBridgeUp)) {
    throw ("未检测到 DeepSeek Harness 桥接。请先启动 DSH 网页（dsh web，已安装 @beauticode/dsh-plugin），再点「应用或重新应用」。")
  }
  $sessions = 0
  try {
    $st = Invoke-BcApi -Method Get -Path "/status"
    if ($st) { $sessions = [int]$st.sessions }
  } catch { }
  if ($sessions -gt 0) { return $true }
  Show-Tip -Title $L.AppName -Text $L.OpeningDsh -Icon Info
  Open-BcDshPage
  if (-not (Wait-BcDshBrowserClient)) {
    throw $L.DshPageWaitFail
  }
  return $true
}

# Re-publish the active (default) background into live pages. Used by tray
# "应用或重新应用". beautiCode never starts/stops a host:
# - DSH:   bridge up → open page if no client → reapply; else ask user to run dsh web
# - Codex: loopback CDP up → reapply; else ask user to open Codex with CDP flags
function Invoke-BcEnsureHostAndReapply {
  if ($script:targetHost -eq "dsh") {
    Ensure-BcDshReady
    $st = $null
    try { $st = Invoke-BcApi -Method Get -Path "/status" } catch { }
    $hasBg = $false
    if ($st -and $st.manifest -and $st.manifest.background) { $hasBg = $true }
    $res = Invoke-BcApi -Method Post -Path "/reapply" -Body @{}
    if ($res.ok) {
      if ($hasBg) {
        Show-Tip -Title $L.AppName -Text $L.ReapplyOk -Icon Info
      } else {
        Show-Tip -Title $L.AppName -Text $L.ReapplyNoBgDsh -Icon Info
      }
      return $true
    }
    $err = if ($res.error) { [string]$res.error } else { $L.ApplyFail }
    Show-Tip -Title $L.AppName -Text $err -Icon Error
    return $false
  }

  $preferred = 0
  try {
    if ($script:cdpPort -gt 0) { $preferred = [int]$script:cdpPort }
  } catch { }

  # Fast path: CDP already healthy → reapply immediately (no process scan).
  $cdpOk = $false
  if ($preferred -gt 0) { $cdpOk = Test-BcCdpPort -CdpPort $preferred }
  if (-not $cdpOk) {
    $probe = Wait-BcCdpReady -PreferredPort $preferred -TimeoutSec 1
    if ($probe -gt 0) {
      $preferred = $probe
      $cdpOk = $true
      $script:cdpPort = $probe
    }
  }

  if (-not $cdpOk) {
    # beautiCode never launches/restarts Codex. Ask the user to open Codex
    # Desktop with loopback CDP instead.
    throw "未发现健康的 Codex CDP。请先打开带本机 CDP 调试端口的 Codex Desktop（如 --remote-debugging-port=9335 --remote-debugging-address=127.0.0.1），再点「应用或重新应用」。"
  }

  # Import / re-publish the stored default (active) background into live pages.
  $st = $null
  try { $st = Invoke-BcApi -Method Get -Path "/status" } catch { }
  $hasBg = $false
  if ($st -and $st.manifest -and $st.manifest.background) { $hasBg = $true }

  $res = Invoke-BcApi -Method Post -Path "/reapply" -Body @{}
  if ($res.ok) {
    if ($hasBg) {
      Show-Tip -Title $L.AppName -Text $L.ReapplyOk -Icon Info
    } else {
      Show-Tip -Title $L.AppName -Text $L.ReapplyNoBg -Icon Info
    }
  } else {
    $err = if ($res.error) { [string]$res.error } else { $L.ApplyFail }
    Show-Tip -Title $L.AppName -Text $err -Icon Error
  }
}

$script:busy = $false
$script:notify = $null
# Fish mode is process-local (mirrors session-host memory; not persisted).
$script:fishMode = $false
# Video mute preference (default muted). Process-local; independent of fish.
$script:videoMuted = $true
# CSS overlay tone. Process-local; dark preserves the previous appearance.
$script:backgroundTone = "dark"
$script:fishHotkeyRegistered = $false
$script:fishNativeWindow = $null
# WM_HOTKEY id — arbitrary non-zero; unique per this process.
$script:FishHotkeyId = 0xBC01

# Chinese labels via Unicode escapes so the file stays ASCII-safe under PS 5.1.
function U([string]$HexSeq) {
  $chars = foreach ($h in ($HexSeq -split '\s+')) {
    [char][Convert]::ToInt32($h, 16)
  }
  return -join $chars
}

$L = @{
  AppName        = "beautiCode"
  StatusRunning  = (U "72B6 6001 FF1A 8FD0 884C 4E2D")                 # 状态：运行中
  StatusBusy     = (U "72B6 6001 FF1A 6B63 5728 5E94 7528 6216 6821 9A8C") # 状态：正在应用或校验
  StatusOffline  = (U "72B6 6001 FF1A 672A 8FDE 63A5")                   # 状态：未连接
  ChangeImage    = (U "66F4 6362 80CC 666F 56FE")                         # 更换背景图
  ChangeVideo    = (U "4E00 952E 66F4 6362 89C6 9891 80CC 666F")         # 一键更换视频背景
  ClearBg        = (U "6E05 9664 80CC 666F")                               # 清除背景
  Reapply        = (U "5E94 7528 6216 91CD 65B0 5E94 7528")               # 应用或重新应用
  FishMode       = (U "6478 9C7C 6A21 5F0F")                               # 摸鱼模式
  FishModeOn     = (U "6478 9C7C 6A21 5F0F 0020 2713")                     # 摸鱼模式 ✓
  FishOnTip      = (U "5DF2 8FDB 5165 6478 9C7C 6A21 5F0F 3002 0043 0074 0072 006C 002B 0053 0068 0069 0066 0074 002B 0053 0070 0061 0063 0065 0020 9000 51FA 3002") # 已进入摸鱼模式。Ctrl+Shift+Space 退出。
  FishOffTip     = (U "5DF2 9000 51FA 6478 9C7C 6A21 5F0F 3002")           # 已退出摸鱼模式。
  FishNeedBg     = (U "8BF7 5148 8BBE 7F6E 56FE 7247 6216 89C6 9891 80CC 666F 3002") # 请先设置图片或视频背景。
  FishLabel      = (U "6478 9C7C")                                         # 摸鱼
  VideoSound     = (U "89C6 9891 58F0 97F3")                               # 视频声音
  VideoSoundOn   = (U "89C6 9891 58F0 97F3 0020 2713")                     # 视频声音 ✓
  BackgroundTone = (U "80CC 666F 6837 5F0F")                               # 背景样式
  ToneDark       = (U "6DF1 8272")                                         # 深色
  ToneLight      = (U "6D45 8272")                                         # 浅色
  ToneAuto       = (U "8DDF 968F 7CFB 7EDF")                               # 跟随系统
  SoundOnTip     = (U "5DF2 5F00 542F 89C6 9891 58F0 97F3 3002")           # 已开启视频声音。
  SoundOffTip    = (U "5DF2 9759 97F3 89C6 9891 3002")                     # 已静音视频。
  SoundBlocked   = (U "5DF2 5C1D 8BD5 5F00 58F0 FF0C 4F46 88AB 6D4F 89C8 5668 81EA 52A8 64AD 653E 7B56 7565 62E6 622A FF0C 4ECD 4FDD 6301 9759 97F3 64AD 653E 3002") # 已尝试开声，但被浏览器自动播放策略拦截，仍保持静音播放。
  SoundLabel     = (U "58F0 97F3")                                         # 声音
  BackgroundMedia = (U "80CC 666F 4ECB 8D28")                              # 背景介质
  ViewingControls = (U "89C2 770B 63A7 5236")                              # 观看控制
  ThemeSection   = (U "4E3B 9898")                                         # 主题
  LocalEngine    = (U "672C 5730 5F15 64CE")                               # 本地引擎
  CurrentMedia   = (U "5F53 524D 4ECB 8D28")                               # 当前介质
  EnabledLabel   = (U "5DF2 5F00 542F")                                    # 已开启
  DisabledLabel  = (U "5DF2 5173 95ED")                                    # 已关闭
  ClearCurrentBg = (U "6E05 9664 5F53 524D 80CC 666F")                     # 清除当前背景
  BackLabel      = (U "8FD4 56DE")                                         # 返回
  DeleteShort    = (U "5220 9664")                                         # 删除
  SaveTheme      = (U "4FDD 5B58 5F53 524D 4E3B 9898")                     # 保存当前主题
  SavedThemes    = (U "5DF2 4FDD 5B58 4E3B 9898")                         # 已保存主题
  NoSavedThemes  = (U "6682 65E0 5DF2 4FDD 5B58 4E3B 9898")               # 暂无已保存主题
  SaveThemePrompt = (U "8F93 5165 4E3B 9898 540D 79F0 FF1A")             # 输入主题名称：
  SaveThemeTitle = (U "4FDD 5B58 0020 0062 0065 0061 0075 0074 0069 0043 006F 0064 0065 0020 4E3B 9898") # 保存 beautiCode 主题
  ThemeSaved     = (U "5DF2 4FDD 5B58 FF1A")                               # 已保存：
  ThemeApplied   = (U "5DF2 5E94 7528 FF1A")                               # 已应用：
  DeleteTheme    = (U "5220 9664 5DF2 4FDD 5B58 4E3B 9898")
  DeleteThemeConfirm = (U "786E 5B9A 5220 9664 5DF2 4FDD 5B58 4E3B 9898 0020 007B 0030 007D FF1F")
  ThemeDeleted   = (U "4E3B 9898 5DF2 5220 9664 FF1A")
  NeedActiveBg   = (U "5F53 524D 6CA1 6709 53EF 4FDD 5B58 7684 80CC 666F 3002") # 当前没有可保存的背景。
  Quit           = (U "9000 51FA 6258 76D8")                               # 退出托盘
  PickImage      = (U "9009 62E9 0020 0062 0065 0061 0075 0074 0069 0043 006F 0064 0065 0020 80CC 666F 56FE") # 选择 beautiCode 背景图
  PickMp4        = (U "9009 62E9 0020 0062 0065 0061 0075 0074 0069 0043 006F 0064 0065 0020 89C6 9891 80CC 666F") # 选择 beautiCode 视频背景
  ImagesLabel    = (U "56FE 7247 6587 4EF6")                               # 图片文件
  Mp4Label       = (U "004D 0050 0034 0020 89C6 9891")                     # MP4 视频
  NeedImage      = (U "8BF7 9009 62E9 0020 002E 0070 006E 0067 002F 002E 006A 0070 0067 002F 002E 006A 0070 0065 0067 002F 002E 0077 0065 0062 0070 002F 002E 0061 0076 0069 0066 0020 56FE 7247 3002") # 请选择 .png/.jpg/.jpeg/.webp/.avif 图片。
  NeedMp4        = (U "8BF7 9009 62E9 0020 002E 006D 0070 0034 0020 6587 4EF6 3002") # 请选择 .mp4 文件。
  ImgOk          = (U "80CC 666F 56FE 5DF2 66F4 65B0 3002")               # 背景图已更新。
  VidOk          = (U "89C6 9891 80CC 666F 5DF2 66F4 65B0 3002")         # 视频背景已更新。
  Cleared        = (U "80CC 666F 5DF2 6E05 9664 3002")                     # 背景已清除。
  ReapplyOk      = (U "5DF2 91CD 65B0 5E94 7528 5F53 524D 80CC 666F 3002") # 已重新应用当前背景。
  ReapplyNoBg    = (U "5DF2 6253 5F00 0020 0043 0068 0061 0074 0047 0050 0054 002F 0043 006F 0064 0065 0078 3002 5F53 524D 65E0 9ED8 8BA4 80CC 666F 53EF 5BFC 5165 3002") # 已打开 ChatGPT/Codex。当前无默认背景可导入。
  RolledBack     = (U "5DF2 56DE 6EDA 3002")                               # 已回滚。
  ApplyFail      = (U "5E94 7528 5931 8D25")                               # 应用失败
  BusyTip        = (U "6B63 5728 5E94 7528 6216 6821 9A8C FF0C 8BF7 7B49 5F85 5F53 524D 64CD 4F5C 5B8C 6210 3002") # 正在应用或校验，请等待当前操作完成。
  OpeningDsh     = (U "6B63 5728 6253 5F00 0020 0044 0065 0065 0070 0053 0065 0065 006B 0020 0048 0061 0072 006E 0065 0073 0073 0020 7F51 9875 2026") # 正在打开 DeepSeek Harness 网页…
  DshPageWaitFail = (U "5DF2 6253 5F00 0020 0044 0065 0065 0070 0053 0065 0065 006B 0020 0048 0061 0072 006E 0065 0073 0073 0020 7F51 9875 FF0C 4F46 9875 9762 5C1A 672A 8FDE 4E0A 3002 8BF7 5237 65B0 540E 518D 8BD5 3002") # 已打开 DeepSeek Harness 网页，但页面尚未连上。请刷新后再试。
  ReapplyNoBgDsh = (U "5DF2 6253 5F00 0020 0044 0065 0065 0070 0053 0065 0065 006B 0020 0048 0061 0072 006E 0065 0073 0073 3002 5F53 524D 65E0 9ED8 8BA4 80CC 666F 53EF 5BFC 5165 3002") # 已打开 DeepSeek Harness。当前无默认背景可导入。
  RunningTip     = (U "6258 76D8 5DF2 542F 52A8 3002 0043 0074 0072 006C 002B 0053 0068 0069 0066 0074 002B 0053 0070 0061 0063 0065 0020 6478 9C7C 3002") # 托盘已启动。Ctrl+Shift+Space 摸鱼。
  RunningTipDsh  = (U "6258 76D8 5DF2 542F 52A8 3002 8BF7 5148 6253 5F00 0020 0044 0065 0065 0070 0053 0065 0065 006B 0020 0048 0061 0072 006E 0065 0073 0073 0020 7F51 9875 3002") # 托盘已启动。请先打开 DeepSeek Harness 网页。
  HostCodex      = "Codex Desktop"
  HostDsh        = "DeepSeek Harness"
  MediaImage     = (U "56FE 7247")                                         # 图片
  MediaVideo     = (U "89C6 9891")                                         # 视频
  NoBackground   = (U "6682 65E0 80CC 666F")                               # 暂无背景
  HotkeyFail     = (U "5168 5C40 5FEB 6377 952E 6CE8 518C 5931 8D25 FF0C 4ECD 53EF 7528 6258 76D8 83DC 5355 5207 6362 6478 9C7C 6A21 5F0F 3002") # 全局快捷键注册失败，仍可用托盘菜单切换摸鱼模式。
}

function Show-BcError {
  param([string]$Message)
  $Message = ConvertTo-BcChineseError -Message $Message
  if ($Message -match '已有背景应用正在进行中|already in progress|Busy|busy') {
    Show-Tip -Title $L.AppName -Text $L.BusyTip -Icon Warning
    return
  }
  [void][System.Windows.Forms.MessageBox]::Show(
    $Message,
    $L.AppName,
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Error
  )
}

function Invoke-GuardedZh {
  param(
    [string]$Label,
    [scriptblock]$Action
  )
  if ($script:busy) {
    Show-Tip -Title $L.AppName -Text $L.BusyTip -Icon Warning
    return
  }
  $script:busy = $true
  try {
    & $Action
  } catch {
    Show-BcError -Message ("{0}" -f $_)
  } finally {
    $script:busy = $false
  }
}

function Add-BcTrayItem {
  param(
    # Fresh ContextMenuStrip.Items is empty — PS 5.1 rejects Mandatory
    # collections without AllowEmptyCollection.
    [Parameter(Mandatory = $true)]
    [AllowEmptyCollection()]
    [System.Windows.Forms.ToolStripItemCollection]$Items,
    [Parameter(Mandatory = $true)][string]$Text,
    [AllowNull()][scriptblock]$Action,
    [bool]$Enabled = $true,
    [string]$Name = ""
  )
  $item = New-Object System.Windows.Forms.ToolStripMenuItem
  $item.Text = $Text
  $item.Enabled = $Enabled
  if ($Name) { $item.Name = $Name }
  if ($null -ne $Action) {
    $item.Tag = $Action
    $null = $item.add_Click({
        param($sender, $eventArgs)
        try {
          $handler = $sender.Tag
          if ($null -ne $handler) { & $handler }
        } catch {
          Show-BcError -Message $_.Exception.Message
        }
      })
  }
  [void]$Items.Add($item)
  return $item
}

function Get-BcStatusLine {
  try {
    $st = Invoke-BcApi -Method Get -Path "/status"
    $mediaKey = if ($st.manifest.background) { [string]$st.manifest.background.type } else { "clear" }
    $mediaLabel = switch ($mediaKey) {
      "image" { $L.MediaImage }
      "video" { $L.MediaVideo }
      default { $L.NoBackground }
    }
    # Mirror host flags when reachable; fall back to local cache.
    if ($null -ne $st.fish) {
      $script:fishMode = [bool]$st.fish
    }
    if ($null -ne $st.muted) {
      $script:videoMuted = [bool]$st.muted
    }
    if ($st.tone -in @("dark", "light", "auto")) {
      $script:backgroundTone = [string]$st.tone
    }
    $base = if ($script:busy) { $L.StatusBusy } else { $L.StatusRunning }
    # Deliberately omit CDP port and generation — keep tray UX simple.
    $parts = New-Object System.Collections.ArrayList
    [void]$parts.Add($base)
    [void]$parts.Add($(if ($script:targetHost -eq "dsh") { $L.HostDsh } else { $L.HostCodex }))
    [void]$parts.Add($mediaLabel)
    if ($script:fishMode) { [void]$parts.Add($L.FishLabel) }
    if (-not $script:videoMuted -and $mediaKey -eq "video") {
      [void]$parts.Add($L.SoundLabel)
    }
    return ($parts -join " · ")
  } catch {
    return $L.StatusOffline
  }
}

function Get-BcToneLabel([string]$Tone) {
  switch ($Tone) {
    "light" { return $L.ToneLight }
    "auto" { return $L.ToneAuto }
    default { return $L.ToneDark }
  }
}

function Invoke-BcSetTone {
  param([string]$Tone)
  if ($Tone -notin @("dark", "light", "auto")) { return }
  if ($script:busy) {
    Show-Tip -Title $L.AppName -Text $L.BusyTip -Icon Warning
    return
  }
  $script:busy = $true
  try {
    $res = Invoke-BcApi -Method Post -Path "/mode/tone" -Body @{ tone = $Tone }
    if ($res.ok) {
      $script:backgroundTone = if ($res.tone -in @("dark", "light", "auto")) {
        [string]$res.tone
      } else {
        $Tone
      }
      if ($null -ne $script:bcToneButton) {
        $script:bcToneButton.Text = "{0} · {1}" -f $L.BackgroundTone, (Get-BcToneLabel $script:backgroundTone)
      }
      Show-Tip -Title $L.AppName -Text ("{0} · {1}" -f $L.BackgroundTone, (Get-BcToneLabel $script:backgroundTone)) -Icon Info
    } else {
      $err = if ($res.error) { [string]$res.error } else { $L.ApplyFail }
      Show-Tip -Title $L.AppName -Text $err -Icon Error
    }
  } catch {
    Show-BcError -Message ("{0}" -f $_)
  } finally {
    $script:busy = $false
  }
}

function Invoke-BcCycleTone {
  $next = switch ($script:backgroundTone) {
    "dark" { "light" }
    "light" { "auto" }
    default { "dark" }
  }
  Invoke-BcSetTone -Tone $next
}

# Toggle fish mode via control plane. Attribute-only on host — no media rebuild.
function Invoke-BcToggleFish {
  param(
    [switch]$Silent
  )
  if ($script:busy) {
    if (-not $Silent) {
      Show-Tip -Title $L.AppName -Text $L.BusyTip -Icon Warning
    }
    return
  }
  $script:busy = $true
  try {
    $want = -not [bool]$script:fishMode
    # Fast local refuse when enabling without a known background.
    if ($want) {
      try {
        $st = Invoke-BcApi -Method Get -Path "/status"
        $hasBg = $false
        if ($st -and $st.manifest -and $st.manifest.background) { $hasBg = $true }
        if (-not $hasBg) {
          $script:fishMode = $false
          if (-not $Silent) {
            Show-Tip -Title $L.AppName -Text $L.FishNeedBg -Icon Warning
          }
          return
        }
      } catch {
        # Fall through — host will reject if needed.
      }
    }
    $res = Invoke-BcApi -Method Post -Path "/mode/fish" -Body @{ enabled = [bool]$want }
    if ($res.ok) {
      $script:fishMode = [bool]$res.fish
      if (-not $Silent) {
        if ($script:fishMode) {
          Show-Tip -Title $L.AppName -Text $L.FishOnTip -Icon Info
        } else {
          Show-Tip -Title $L.AppName -Text $L.FishOffTip -Icon Info
        }
      }
    } else {
      $err = if ($res.error) { [string]$res.error } else { $L.ApplyFail }
      # Common case: no background — show the friendly tip.
      if ($err -match '当前没有背景|No active background|no background|Apply an image') {
        $script:fishMode = $false
        if (-not $Silent) {
          Show-Tip -Title $L.AppName -Text $L.FishNeedBg -Icon Warning
        }
      } else {
        if (-not $Silent) {
          Show-Tip -Title $L.AppName -Text $err -Icon Error
        }
      }
    }
  } catch {
    $msg = "{0}" -f $_
    if ($msg -match '当前没有背景|No active background|no background|Apply an image') {
      $script:fishMode = $false
      if (-not $Silent) {
        Show-Tip -Title $L.AppName -Text $L.FishNeedBg -Icon Warning
      }
    } else {
      if (-not $Silent) {
        Show-BcError -Message $msg
      }
    }
  } finally {
    $script:busy = $false
  }
}

# Toggle video mute via control plane. Property-only — no media rebuild.
function Invoke-BcToggleMuted {
  if ($script:busy) {
    Show-Tip -Title $L.AppName -Text $L.BusyTip -Icon Warning
    return
  }
  $script:busy = $true
  try {
    # muted=true is silent. Menu "视频声音 ✓" means sound is ON (muted=false).
    $wantMuted = -not [bool]$script:videoMuted
    $res = Invoke-BcApi -Method Post -Path "/mode/muted" -Body @{ muted = [bool]$wantMuted }
    if ($res.ok) {
      $script:videoMuted = [bool]$res.muted
      if ($res.blocked -and -not $script:videoMuted) {
        # Preference is sound-on but element stayed muted.
        Show-Tip -Title $L.AppName -Text $L.SoundBlocked -Icon Warning
      } elseif ($script:videoMuted) {
        Show-Tip -Title $L.AppName -Text $L.SoundOffTip -Icon Info
      } else {
        Show-Tip -Title $L.AppName -Text $L.SoundOnTip -Icon Info
      }
    } else {
      $err = if ($res.error) { [string]$res.error } else { $L.ApplyFail }
      Show-Tip -Title $L.AppName -Text $err -Icon Error
    }
  } catch {
    Show-BcError -Message ("{0}" -f $_)
  } finally {
    $script:busy = $false
  }
}

function Register-BcFishHotkey {
  # Ctrl+Shift+Space global toggle. Uses a message-only NativeWindow so we do
  # not need a visible Form. Fail soft — tray menu still works.
  if ($script:fishHotkeyRegistered) { return $true }
  try {
    $cs = @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class BeautiCodeHotkeyWindow : NativeWindow, IDisposable {
  public const int WM_HOTKEY = 0x0312;
  public event EventHandler HotkeyPressed;

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool UnregisterHotKey(IntPtr hWnd, int id);

  public BeautiCodeHotkeyWindow() {
    CreateHandle(new CreateParams());
  }

  protected override void WndProc(ref Message m) {
    if (m.Msg == WM_HOTKEY) {
      var handler = HotkeyPressed;
      if (handler != null) handler(this, EventArgs.Empty);
    }
    base.WndProc(ref m);
  }

  public void Dispose() {
    try { DestroyHandle(); } catch { }
  }
}
'@
    if (-not ("BeautiCodeHotkeyWindow" -as [type])) {
      Add-Type -TypeDefinition $cs -ReferencedAssemblies System.Windows.Forms -ErrorAction Stop
    }
    $win = New-Object BeautiCodeHotkeyWindow
    # MOD_CONTROL=0x0002, MOD_SHIFT=0x0004; VK_SPACE=0x20
    $mods = [uint32](0x0002 -bor 0x0004)
    $vk = [uint32]0x20
    $ok = [BeautiCodeHotkeyWindow]::RegisterHotKey(
      $win.Handle,
      [int]$script:FishHotkeyId,
      $mods,
      $vk
    )
    if (-not $ok) {
      try { $win.Dispose() } catch { }
      return $false
    }
    $null = $win.add_HotkeyPressed({
        try {
          Invoke-BcToggleFish
        } catch {
          # never throw out of native callback
        }
      })
    $script:fishNativeWindow = $win
    $script:fishHotkeyRegistered = $true
    return $true
  } catch {
    return $false
  }
}

function Unregister-BcFishHotkey {
  if (-not $script:fishHotkeyRegistered) { return }
  try {
    if ($null -ne $script:fishNativeWindow) {
      try {
        [void][BeautiCodeHotkeyWindow]::UnregisterHotKey(
          $script:fishNativeWindow.Handle,
          [int]$script:FishHotkeyId
        )
      } catch { }
      try { $script:fishNativeWindow.Dispose() } catch { }
    }
  } catch { }
  $script:fishNativeWindow = $null
  $script:fishHotkeyRegistered = $false
}

# --- UI ---
$notify = New-Object System.Windows.Forms.NotifyIcon
$script:notify = $notify
$notify.Text = $L.AppName
$notify.Visible = $true
$notify.Icon = [System.Drawing.SystemIcons]::Application

# Kept as a fail-soft fallback and as the native saved-theme submenu. The
# primary surface is the custom ink-console popup built below.
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$script:fallbackMenu = $menu

# Image: common formats. Video: MP4 only (Dream Skin style — no "all files").
$imgFilter = ("{0}|*.png;*.jpg;*.jpeg;*.webp;*.avif" -f $L.ImagesLabel)
$vidFilter = ("{0}|*.mp4" -f $L.Mp4Label)

function Rebuild-BcTrayMenu {
  $menu.Items.Clear()
  $opActive = [bool]$script:busy

  $null = Add-BcTrayItem -Items $menu.Items -Text (Get-BcStatusLine) -Action $null -Enabled $false -Name "status"
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

  $null = Add-BcTrayItem -Items $menu.Items -Text $L.Reapply -Enabled:(-not $opActive) -Name "reapply" -Action {
    Invoke-GuardedZh -Label $L.Reapply -Action {
      # Opens/restarts ChatGPT when needed, then imports the stored default bg.
      Invoke-BcEnsureHostAndReapply
    }
  }

  $null = Add-BcTrayItem -Items $menu.Items -Text $L.ChangeImage -Enabled:(-not $opActive) -Name "image" -Action {
    Invoke-GuardedZh -Label $L.ChangeImage -Action {
      $img = Get-OpenPath -Title $L.PickImage -Filter $imgFilter -DefaultExt "png"
      if (-not $img) { return }
      if (-not (Test-BcImageExt -Path $img)) {
        Show-Tip -Title $L.AppName -Text $L.NeedImage -Icon Warning
        return
      }
      Ensure-BcDshReady
      $res = Invoke-BcApi -Method Post -Path "/apply/image" -Body @{ imagePath = $img }
      if ($res.ok) {
        Show-Tip -Title $L.AppName -Text $L.ImgOk -Icon Info
      } else {
        $err = if ($res.error) { [string]$res.error } else { $L.ApplyFail }
        if ($res.rolledBack) { $err = "$err $($L.RolledBack)" }
        Show-Tip -Title $L.AppName -Text $err -Icon Error
      }
    }
  }

  # Dream Skin style: single MP4 picker (poster optional / auto).
  $null = Add-BcTrayItem -Items $menu.Items -Text $L.ChangeVideo -Enabled:(-not $opActive) -Name "video" -Action {
    Invoke-GuardedZh -Label $L.ChangeVideo -Action {
      $vid = Get-OpenPath -Title $L.PickMp4 -Filter $vidFilter -DefaultExt "mp4"
      if (-not $vid) { return }
      if (-not (Test-BcMp4Ext -Path $vid)) {
        Show-Tip -Title $L.AppName -Text $L.NeedMp4 -Icon Warning
        return
      }
      Ensure-BcDshReady
      $res = Invoke-BcApi -Method Post -Path "/apply/video" -Body @{ videoPath = $vid }
      if ($res.ok) {
        Show-Tip -Title $L.AppName -Text $L.VidOk -Icon Info
      } else {
        $err = if ($res.error) { [string]$res.error } else { $L.ApplyFail }
        if ($res.rolledBack) { $err = "$err $($L.RolledBack)" }
        Show-Tip -Title $L.AppName -Text $err -Icon Error
      }
    }
  }

  $null = Add-BcTrayItem -Items $menu.Items -Text $L.ClearBg -Enabled:(-not $opActive) -Name "clear" -Action {
    Invoke-GuardedZh -Label $L.ClearBg -Action {
      $res = Invoke-BcApi -Method Post -Path "/apply/clear" -Body @{}
      if ($res.ok) {
        $script:fishMode = $false
        Show-Tip -Title $L.AppName -Text $L.Cleared -Icon Info
      } else {
        $err = if ($res.error) { [string]$res.error } else { $L.ApplyFail }
        Show-Tip -Title $L.AppName -Text $err -Icon Error
      }
    }
  }

  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

  # Fish mode (摸鱼): hide host chrome, full-bleed media. Same as Ctrl+Shift+Space.
  $fishText = if ($script:fishMode) { $L.FishModeOn } else { $L.FishMode }
  $null = Add-BcTrayItem -Items $menu.Items -Text $fishText -Enabled:(-not $opActive) -Name "fish" -Action {
    Invoke-BcToggleFish
  }

  # Video sound: checked = unmuted. Default muted (no checkmark).
  $soundText = if (-not $script:videoMuted) { $L.VideoSoundOn } else { $L.VideoSound }
  $null = Add-BcTrayItem -Items $menu.Items -Text $soundText -Enabled:(-not $opActive) -Name "sound" -Action {
    Invoke-BcToggleMuted
  }

  $toneMenu = New-Object System.Windows.Forms.ToolStripMenuItem
  $toneMenu.Text = ("{0} · {1}" -f $L.BackgroundTone, (Get-BcToneLabel $script:backgroundTone))
  $toneMenu.Name = "tone"
  $toneMenu.Enabled = -not $opActive
  $null = Add-BcTrayItem -Items $toneMenu.DropDownItems -Text $L.ToneDark -Enabled:(-not $opActive) -Name "tone-dark" -Action {
    Invoke-BcSetTone -Tone "dark"
  }
  $null = Add-BcTrayItem -Items $toneMenu.DropDownItems -Text $L.ToneLight -Enabled:(-not $opActive) -Name "tone-light" -Action {
    Invoke-BcSetTone -Tone "light"
  }
  $null = Add-BcTrayItem -Items $toneMenu.DropDownItems -Text $L.ToneAuto -Enabled:(-not $opActive) -Name "tone-auto" -Action {
    Invoke-BcSetTone -Tone "auto"
  }
  $null = $toneMenu.add_Click({ Invoke-BcCycleTone })
  $null = $menu.Items.Add($toneMenu)

  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

  # Keep / restore current theme (Dream Skin "保存当前主题").
  $null = Add-BcTrayItem -Items $menu.Items -Text $L.SaveTheme -Enabled:(-not $opActive) -Name "save-theme" -Action {
    Invoke-GuardedZh -Label $L.SaveTheme -Action {
      $st = Invoke-BcApi -Method Get -Path "/status"
      if (-not $st.manifest.background) {
        Show-Tip -Title $L.AppName -Text $L.NeedActiveBg -Icon Warning
        return
      }
      $defaultName = if ($st.manifest.background.type -eq "video") {
        ("{0}-{1}" -f $L.MediaVideo, (Get-Date -Format "yyyyMMdd-HHmm"))
      } else {
        ("{0}-{1}" -f $L.MediaImage, (Get-Date -Format "yyyyMMdd-HHmm"))
      }
      $name = Get-BcThemeName -DefaultName $defaultName
      if (-not $name) { return }
      $res = Invoke-BcApi -Method Post -Path "/theme/save" -Body @{ name = $name }
      if ($res.ok) {
        $savedName = if ($res.theme -and $res.theme.name) { [string]$res.theme.name } else { $name }
        Show-Tip -Title $L.AppName -Text ("{0}{1}" -f $L.ThemeSaved, $savedName) -Icon Info
      } else {
        $err = if ($res.error) { [string]$res.error } else { $L.ApplyFail }
        Show-Tip -Title $L.AppName -Text $err -Icon Error
      }
    }
  }

  $savedMenu = New-Object System.Windows.Forms.ToolStripMenuItem
  $savedMenu.Text = $L.SavedThemes
  $savedMenu.Name = "themes"
  $savedMenu.Enabled = -not $opActive
  try {
    $listed = Invoke-BcApi -Method Get -Path "/theme/list"
    $themes = @()
    if ($listed.ok -and $listed.themes) { $themes = @($listed.themes) }
    if ($themes.Count -eq 0) {
      $empty = New-Object System.Windows.Forms.ToolStripMenuItem
      $empty.Text = $L.NoSavedThemes
      $empty.Enabled = $false
      [void]$savedMenu.DropDownItems.Add($empty)
    } else {
      foreach ($theme in $themes) {
        $themeId = [string]$theme.id
        $themeName = [string]$theme.name
        $themeType = [string]$theme.type
        if (-not $themeId) { continue }
        $label = if ($themeType) { "{0} ({1})" -f $themeName, $themeType } else { $themeName }
        $item = New-Object System.Windows.Forms.ToolStripMenuItem
        $item.Text = $label
        $item.Enabled = -not $opActive
        # Tag must be a simple string id — hashtable Tag + scriptblock capture
        # was flaky under WinForms click routing; name kept only for tip text.
        $item.Tag = $themeId
        $item.ToolTipText = $themeName
        $null = $item.add_Click({
            param($sender, $eventArgs)
            $useId = [string]$sender.Tag
            $useName = [string]$sender.ToolTipText
            if (-not $useId) { return }
            Invoke-GuardedZh -Label $L.SavedThemes -Action {
              Ensure-BcDshReady
              $res = Invoke-BcApi -Method Post -Path "/theme/use" -Body @{ id = $useId }
              if ($res.ok) {
                $shown = if ($useName) { $useName } else { $useId }
                Show-Tip -Title $L.AppName -Text ("{0}{1}" -f $L.ThemeApplied, $shown) -Icon Info
              } else {
                $err = if ($res.error) { [string]$res.error } else { $L.ApplyFail }
                Show-Tip -Title $L.AppName -Text $err -Icon Error
              }
            }
          })
        [void]$savedMenu.DropDownItems.Add($item)
      }
      [void]$savedMenu.DropDownItems.Add(
        (New-Object System.Windows.Forms.ToolStripSeparator)
      )
      $deleteMenu = New-Object System.Windows.Forms.ToolStripMenuItem
      $deleteMenu.Text = $L.DeleteTheme
      foreach ($theme in $themes) {
        $deleteId = [string]$theme.id
        $deleteName = [string]$theme.name
        if (-not $deleteId) { continue }
        $deleteItem = New-Object System.Windows.Forms.ToolStripMenuItem
        $deleteItem.Text = $deleteName
        $deleteItem.Tag = $deleteId
        $deleteItem.ToolTipText = $deleteName
        $null = $deleteItem.add_Click({
            param($sender, $eventArgs)
            $id = [string]$sender.Tag
            $name = [string]$sender.ToolTipText
            $answer = [System.Windows.Forms.MessageBox]::Show(
              ($L.DeleteThemeConfirm -f $name),
              $L.AppName,
              [System.Windows.Forms.MessageBoxButtons]::YesNo,
              [System.Windows.Forms.MessageBoxIcon]::Warning,
              [System.Windows.Forms.MessageBoxDefaultButton]::Button2
            )
            if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) { return }
            Invoke-GuardedZh -Label $L.DeleteTheme -Action {
              $res = Invoke-BcApi -Method Post -Path "/theme/delete" -Body @{ id = $id }
              if ($res.ok) {
                Show-Tip -Title $L.AppName -Text ("{0}{1}" -f $L.ThemeDeleted, $name) -Icon Info
              } else {
                $err = if ($res.error) { [string]$res.error } else { $L.ApplyFail }
                Show-Tip -Title $L.AppName -Text $err -Icon Error
              }
            }
          })
        [void]$deleteMenu.DropDownItems.Add($deleteItem)
      }
      [void]$savedMenu.DropDownItems.Add($deleteMenu)
    }
  } catch {
    $empty = New-Object System.Windows.Forms.ToolStripMenuItem
    $empty.Text = $L.NoSavedThemes
    $empty.Enabled = $false
    [void]$savedMenu.DropDownItems.Add($empty)
  }
  [void]$menu.Items.Add($savedMenu)

  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

  $null = Add-BcTrayItem -Items $menu.Items -Text $L.Quit -Name "quit" -Action {
    # Leave fish mode before killing the control plane so Codex UI is restored.
    try {
      if ($script:fishMode) {
        Invoke-BcApi -Method Post -Path "/mode/fish" -Body @{ enabled = $false } | Out-Null
        $script:fishMode = $false
      }
    } catch {
      # ignore
    }
    try {
      Invoke-BcApi -Method Post -Path "/shutdown" -Body @{} | Out-Null
    } catch {
      # ignore
    }
    Unregister-BcFishHotkey
    $script:notify.Visible = $false
    [System.Windows.Forms.Application]::Exit()
  }
}

function Get-BcUiColor([string]$Hex) {
  return [System.Drawing.ColorTranslator]::FromHtml($Hex)
}

function Set-BcRoundedRegion {
  param(
    [System.Windows.Forms.Control]$Control,
    [int]$Radius
  )
  if ($null -eq $Control -or $Control.Width -lt 2 -or $Control.Height -lt 2) {
    return
  }
  $diameter = [Math]::Max(2, $Radius * 2)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  try {
    $rect = New-Object System.Drawing.Rectangle(0, 0, ($Control.Width - 1), ($Control.Height - 1))
    $path.AddArc($rect.Left, $rect.Top, $diameter, $diameter, 180, 90)
    $path.AddArc(($rect.Right - $diameter), $rect.Top, $diameter, $diameter, 270, 90)
    $path.AddArc(($rect.Right - $diameter), ($rect.Bottom - $diameter), $diameter, $diameter, 0, 90)
    $path.AddArc($rect.Left, ($rect.Bottom - $diameter), $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    $oldRegion = $Control.Region
    $Control.Region = New-Object System.Drawing.Region($path)
    if ($null -ne $oldRegion) { $oldRegion.Dispose() }
  } finally {
    $path.Dispose()
  }
}

function Update-BcRoundedControls {
  foreach ($entry in @($script:bcRoundedControls)) {
    if ($null -ne $entry -and $null -ne $entry.Control) {
      Set-BcRoundedRegion -Control $entry.Control -Radius ([int]$entry.Radius)
    }
  }
}

function Enable-BcDoubleBufferTree([System.Windows.Forms.Control]$Control) {
  if ($null -eq $Control) {
    return
  }
  try {
    $flags = [System.Reflection.BindingFlags]::Instance -bor [System.Reflection.BindingFlags]::NonPublic
    $property = [System.Windows.Forms.Control].GetProperty("DoubleBuffered", $flags)
    if ($null -ne $property) {
      $property.SetValue($Control, $true, $null)
    }
  } catch {
    # Double buffering is a best-effort visual optimization.
  }
  foreach ($child in @($Control.Controls)) {
    Enable-BcDoubleBufferTree -Control $child
  }
}

function Get-BcDevicePixel([int]$Value) {
  return [int][Math]::Round(
    $Value * $script:bcGeometryScale,
    [MidpointRounding]::AwayFromZero
  )
}

function Set-BcIntegerLayoutTree([System.Windows.Forms.Control]$Control) {
  if ($null -eq $Control) {
    return
  }

  $bounds = $Control.Bounds
  $Control.Bounds = New-Object System.Drawing.Rectangle(
    (Get-BcDevicePixel $bounds.X),
    (Get-BcDevicePixel $bounds.Y),
    (Get-BcDevicePixel $bounds.Width),
    (Get-BcDevicePixel $bounds.Height)
  )

  $padding = $Control.Padding
  $Control.Padding = New-Object System.Windows.Forms.Padding(
    (Get-BcDevicePixel $padding.Left),
    (Get-BcDevicePixel $padding.Top),
    (Get-BcDevicePixel $padding.Right),
    (Get-BcDevicePixel $padding.Bottom)
  )

  $margin = $Control.Margin
  $Control.Margin = New-Object System.Windows.Forms.Padding(
    (Get-BcDevicePixel $margin.Left),
    (Get-BcDevicePixel $margin.Top),
    (Get-BcDevicePixel $margin.Right),
    (Get-BcDevicePixel $margin.Bottom)
  )

  foreach ($child in @($Control.Controls)) {
    Set-BcIntegerLayoutTree -Control $child
  }
}

function New-BcUiLabel {
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
  $label.TextAlign = $Align
  $label.UseCompatibleTextRendering = $false
  $label.AutoEllipsis = $true
  return $label
}

function New-BcUiButton {
  param(
    [string]$Text,
    [int]$X,
    [int]$Y,
    [int]$Width,
    [int]$Height,
    [System.Drawing.Font]$Font,
    [System.Drawing.Color]$BackColor,
    [System.Drawing.Color]$ForeColor,
    [System.Drawing.Color]$BorderColor,
    [System.Drawing.ContentAlignment]$Align = [System.Drawing.ContentAlignment]::MiddleCenter
  )
  $button = New-Object System.Windows.Forms.Button
  $button.Text = $Text
  $button.Location = New-Object System.Drawing.Point($X, $Y)
  $button.Size = New-Object System.Drawing.Size($Width, $Height)
  $button.Font = $Font
  $button.BackColor = $BackColor
  $button.ForeColor = $ForeColor
  $button.TextAlign = $Align
  $button.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
  $button.FlatAppearance.BorderSize = 1
  $button.FlatAppearance.BorderColor = $BorderColor
  $button.FlatAppearance.MouseOverBackColor = $script:bcUiColors.Hover
  $button.FlatAppearance.MouseDownBackColor = $script:bcUiColors.JadeDeep
  $button.UseVisualStyleBackColor = $false
  $button.UseCompatibleTextRendering = $false
  $button.Cursor = [System.Windows.Forms.Cursors]::Hand
  return $button
}

function Register-BcPanelAction {
  param(
    [System.Windows.Forms.Control]$Control,
    [string]$ActionName
  )
  $Control.Tag = $ActionName
  $null = $Control.add_Click({
      param($sender, $eventArgs)
      try {
        Invoke-BcPanelAction -ActionName ([string]$sender.Tag)
      } catch {
        Show-BcError -Message $_.Exception.Message
      }
    })
}

function Add-BcActionCard {
  param(
    [System.Windows.Forms.Control]$Parent,
    [string]$Title,
    [string]$Meta,
    [string]$ActionName,
    [int]$X,
    [int]$Y,
    [int]$Width,
    [bool]$Selected = $false
  )
  $card = New-Object System.Windows.Forms.Panel
  $card.Location = New-Object System.Drawing.Point($X, $Y)
  $card.Size = New-Object System.Drawing.Size($Width, 78)
  $card.BackColor = if ($Selected) { $script:bcUiColors.PanelSelected } else { $script:bcUiColors.Panel }
  $card.BorderStyle = [System.Windows.Forms.BorderStyle]::None
  $card.Cursor = [System.Windows.Forms.Cursors]::Hand
  $titleLabel = New-BcUiLabel -Text $Title -X 12 -Y 14 -Width ($Width - 24) -Height 24 `
    -Font $script:bcBodyStrongFont -Color $script:bcUiColors.Text
  $metaLabel = New-BcUiLabel -Text $Meta -X 12 -Y 41 -Width ($Width - 24) -Height 19 `
    -Font $script:bcMetaFont -Color $script:bcUiColors.Jade
  Register-BcPanelAction -Control $card -ActionName $ActionName
  Register-BcPanelAction -Control $titleLabel -ActionName $ActionName
  Register-BcPanelAction -Control $metaLabel -ActionName $ActionName
  [void]$card.Controls.Add($titleLabel)
  [void]$card.Controls.Add($metaLabel)
  [void]$Parent.Controls.Add($card)
  Set-BcRoundedRegion -Control $card -Radius 10
  return @{
    Panel = $card
    Meta = $metaLabel
  }
}

function Add-BcSwitchRow {
  param(
    [System.Windows.Forms.Control]$Parent,
    [string]$Title,
    [string]$ActionName,
    [int]$Y
  )
  $row = New-Object System.Windows.Forms.Panel
  $row.Location = New-Object System.Drawing.Point(14, $Y)
  $row.Size = New-Object System.Drawing.Size(388, 44)
  $row.BackColor = $script:bcUiColors.Panel
  $row.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
  $row.Cursor = [System.Windows.Forms.Cursors]::Hand
  $titleLabel = New-BcUiLabel -Text $Title -X 12 -Y 7 -Width 205 -Height 28 `
    -Font $script:bcBodyFont -Color $script:bcUiColors.Text
  $stateLabel = New-BcUiLabel -Text "" -X 218 -Y 7 -Width 96 -Height 28 `
    -Font $script:bcMetaFont -Color $script:bcUiColors.Muted `
    -Align ([System.Drawing.ContentAlignment]::MiddleRight)
  $toggle = New-Object BeautiCodeToggle
  $toggle.Location = New-Object System.Drawing.Point(326, 9)
  $toggle.Size = New-Object System.Drawing.Size(48, 24)
  $toggle.BackColor = $script:bcUiColors.Panel
  $toggle.TrackOnColor = $script:bcUiColors.JadeDeep
  $toggle.TrackOffColor = $script:bcUiColors.ToggleOff
  $toggle.BorderOnColor = $script:bcUiColors.Jade
  $toggle.BorderOffColor = $script:bcUiColors.ToggleOffBorder
  $toggle.KnobColor = $script:bcUiColors.ToggleKnob
  $toggle.AccessibleName = $Title
  Register-BcPanelAction -Control $row -ActionName $ActionName
  Register-BcPanelAction -Control $titleLabel -ActionName $ActionName
  Register-BcPanelAction -Control $stateLabel -ActionName $ActionName
  Register-BcPanelAction -Control $toggle -ActionName $ActionName
  [void]$row.Controls.Add($titleLabel)
  [void]$row.Controls.Add($stateLabel)
  [void]$row.Controls.Add($toggle)
  [void]$Parent.Controls.Add($row)
  return @{
    Panel = $row
    State = $stateLabel
    Toggle = $toggle
  }
}

function Get-BcMenuItem([string]$Name) {
  foreach ($item in @($menu.Items)) {
    if ($item.Name -eq $Name) { return $item }
  }
  return $null
}

function Set-BcFallbackMenuStyle {
  $menu.BackColor = $script:bcUiColors.Panel
  $menu.ForeColor = $script:bcUiColors.Text
  $menu.Font = $script:bcBodyFont
  $menu.ShowImageMargin = $false
  $menu.Padding = New-Object System.Windows.Forms.Padding(5)
  foreach ($item in @($menu.Items)) {
    $isClear = $item.Name -eq "clear"
    $item.BackColor = if ($isClear -and $item.Enabled) { $script:bcUiColors.DangerSurface } else { $script:bcUiColors.Panel }
    $item.ForeColor = if ($isClear -and $item.Enabled) {
      $script:bcUiColors.Danger
    } elseif ($item.Enabled) {
      $script:bcUiColors.Text
    } else {
      $script:bcUiColors.Muted
    }
    $item.Font = $script:bcBodyFont
    if ($item -is [System.Windows.Forms.ToolStripDropDownItem]) {
      $item.DropDown.BackColor = $script:bcUiColors.Panel
      $item.DropDown.ForeColor = $script:bcUiColors.Text
      $item.DropDown.Font = $script:bcBodyFont
      foreach ($child in @($item.DropDownItems)) {
        $child.BackColor = $script:bcUiColors.Panel
        $child.ForeColor = if ($child.Enabled) { $script:bcUiColors.Text } else { $script:bcUiColors.Muted }
        $child.Font = $script:bcBodyFont
      }
    }
  }
}

function Register-BcThemeSourceAction {
  param(
    [System.Windows.Forms.Control]$Control,
    [System.Windows.Forms.ToolStripItem]$SourceItem
  )
  $Control.Tag = $SourceItem
  $null = $Control.add_Click({
      param($sender, $eventArgs)
      $source = $sender.Tag
      if ($null -eq $source) { return }
      if ($null -ne $script:trayPanel) { $script:trayPanel.Hide() }
      $source.PerformClick()
    })
}

function Show-BcThemeOverlay {
  $themesItem = Get-BcMenuItem -Name "themes"
  if ($null -eq $themesItem -or $null -eq $script:bcThemeFlow) {
    Show-BcFallbackMenu
    return
  }
  $script:bcThemeFlow.SuspendLayout()
  try {
    foreach ($oldControl in @($script:bcThemeFlow.Controls)) {
      try { $oldControl.Dispose() } catch { }
    }
    $script:bcThemeFlow.Controls.Clear()
    $themeItems = New-Object System.Collections.ArrayList
    $deleteMenu = $null
    foreach ($sourceItem in @($themesItem.DropDownItems)) {
      if ($sourceItem -is [System.Windows.Forms.ToolStripSeparator]) { continue }
      if (
        $sourceItem -is [System.Windows.Forms.ToolStripDropDownItem] -and
        $sourceItem.Text -eq $L.DeleteTheme
      ) {
        $deleteMenu = $sourceItem
        continue
      }
      if (
        $sourceItem -is [System.Windows.Forms.ToolStripMenuItem] -and
        $sourceItem.Text -ne $L.NoSavedThemes
      ) {
        [void]$themeItems.Add($sourceItem)
      }
    }

    if ($themeItems.Count -eq 0) {
      $empty = New-BcUiLabel -Text $L.NoSavedThemes -X 8 -Y 8 -Width 340 -Height 36 `
        -Font $script:bcBodyFont -Color $script:bcUiColors.Muted
      Set-BcIntegerLayoutTree -Control $empty
      [void]$script:bcThemeFlow.Controls.Add($empty)
    } else {
      foreach ($sourceItem in @($themeItems)) {
        $row = New-Object System.Windows.Forms.Panel
        $row.Size = New-Object System.Drawing.Size(370, 50)
        $row.Margin = New-Object System.Windows.Forms.Padding(0, 0, 0, 8)
        $row.BackColor = $script:bcUiColors.Window

        $apply = New-BcUiButton -Text ([string]$sourceItem.Text) -X 0 -Y 2 -Width 286 -Height 43 `
          -Font $script:bcBodyFont -BackColor $script:bcUiColors.Panel `
          -ForeColor $script:bcUiColors.Text -BorderColor $script:bcUiColors.Line `
          -Align ([System.Drawing.ContentAlignment]::MiddleLeft)
        $apply.Padding = New-Object System.Windows.Forms.Padding(11, 0, 0, 0)
        Register-BcThemeSourceAction -Control $apply -SourceItem $sourceItem
        [void]$row.Controls.Add($apply)

        if ($null -ne $deleteMenu) {
          $themeName = [string]$sourceItem.ToolTipText
          $deleteSource = $null
          foreach ($candidate in @($deleteMenu.DropDownItems)) {
            if ($candidate.Text -eq $themeName) {
              $deleteSource = $candidate
              break
            }
          }
          if ($null -ne $deleteSource) {
            $delete = New-BcUiButton -Text $L.DeleteShort -X 294 -Y 2 -Width 72 -Height 43 `
              -Font $script:bcMetaFont -BackColor $script:bcUiColors.Panel `
              -ForeColor $script:bcUiColors.Copper -BorderColor $script:bcUiColors.Line
            Register-BcThemeSourceAction -Control $delete -SourceItem $deleteSource
            [void]$row.Controls.Add($delete)
          }
        }
        Set-BcIntegerLayoutTree -Control $row
        [void]$script:bcThemeFlow.Controls.Add($row)
      }
    }
  } finally {
    $script:bcThemeFlow.ResumeLayout()
  }
  $script:bcThemeOverlay.Visible = $true
  $script:bcThemeOverlay.BringToFront()
}

function Update-BcTrayPanel {
  if ($null -eq $script:trayPanel) { return }
  Rebuild-BcTrayMenu
  Set-BcFallbackMenuStyle

  $statusItem = Get-BcMenuItem -Name "status"
  $statusText = if ($null -ne $statusItem) { [string]$statusItem.Text } else { $L.StatusOffline }
  $script:bcStatusLabel.Text = $statusText
  $online = -not $statusText.StartsWith($L.StatusOffline)
  $script:bcStatusLabel.ForeColor = if ($online) { $script:bcUiColors.Jade } else { $script:bcUiColors.Copper }

  $isVideo = $statusText.Contains($L.MediaVideo)
  $isImage = $statusText.Contains($L.MediaImage)
  $script:bcMediaLabel.Text = if ($isVideo) {
    "{0} · MP4" -f $L.MediaVideo
  } elseif ($isImage) {
    "{0} · PNG/JPG" -f $L.MediaImage
  } else {
    $L.NoBackground
  }
  $script:bcImageCard.Meta.Text = if ($isImage) {
    "PNG/JPG/WEBP/AVIF · {0}" -f $L.CurrentMedia
  } else {
    "PNG · JPG · WEBP · AVIF"
  }
  $script:bcVideoCard.Meta.Text = if ($isVideo) {
    "MP4 · {0}" -f $L.CurrentMedia
  } else {
    "MP4"
  }
  $script:bcImageCard.Panel.BackColor = if ($isImage) { $script:bcUiColors.PanelSelected } else { $script:bcUiColors.Panel }
  $script:bcVideoCard.Panel.BackColor = if ($isVideo) { $script:bcUiColors.PanelSelected } else { $script:bcUiColors.Panel }

  $fishOn = [bool]$script:fishMode
  $script:bcFishSwitch.State.Text = if ($fishOn) { $L.EnabledLabel } else { $L.DisabledLabel }
  $script:bcFishSwitch.State.ForeColor = if ($fishOn) { $script:bcUiColors.Jade } else { $script:bcUiColors.Muted }
  $script:bcFishSwitch.Toggle.Checked = $fishOn

  $soundOn = -not [bool]$script:videoMuted
  $script:bcSoundSwitch.State.Text = if ($soundOn) { $L.EnabledLabel } else { $L.DisabledLabel }
  $script:bcSoundSwitch.State.ForeColor = if ($soundOn) { $script:bcUiColors.Jade } else { $script:bcUiColors.Muted }
  $script:bcSoundSwitch.Toggle.Checked = $soundOn

  $script:bcToneButton.Text = "{0} · {1}" -f $L.BackgroundTone, (Get-BcToneLabel $script:backgroundTone)

  $savedItem = Get-BcMenuItem -Name "themes"
  $themeText = $L.NoSavedThemes
  if ($null -ne $savedItem -and $savedItem.DropDownItems.Count -gt 0) {
    foreach ($child in @($savedItem.DropDownItems)) {
      if (
        $child -is [System.Windows.Forms.ToolStripMenuItem] -and
        $child.Text -ne $L.DeleteTheme -and
        $child.Text -ne $L.NoSavedThemes
      ) {
        $themeText = [string]$child.Text
        break
      }
    }
  }
  $script:bcThemeMeta.Text = $themeText
}

function Show-BcFallbackMenu {
  try {
    Rebuild-BcTrayMenu
    Set-BcFallbackMenuStyle
    $menu.Show([System.Windows.Forms.Cursor]::Position)
  } catch {
    Show-BcError -Message $_.Exception.Message
  }
}

function Invoke-BcPanelAction {
  param([string]$ActionName)
  if (-not $ActionName) { return }
  if ($ActionName -eq "themes") {
    Show-BcThemeOverlay
    return
  }
  if ($ActionName -eq "tone") {
    Invoke-BcCycleTone
    return
  }
  if ($null -ne $script:trayPanel) { $script:trayPanel.Hide() }
  $item = Get-BcMenuItem -Name $ActionName
  if ($null -eq $item) {
    Show-BcFallbackMenu
    return
  }
  $item.PerformClick()
}

function Show-BcTrayPanel {
  param([switch]$EnsureVisible)
  if ($null -eq $script:trayPanel) {
    Show-BcFallbackMenu
    return
  }
  if ($script:trayPanel.Visible) {
    if ($EnsureVisible) {
      $script:trayPanel.Activate()
      $script:trayPanel.BringToFront()
      return
    }
    $script:trayPanel.Hide()
    return
  }
  try {
    Update-BcTrayPanel
    if ($null -ne $script:bcThemeOverlay) {
      $script:bcThemeOverlay.Visible = $false
    }
    $cursor = [System.Windows.Forms.Cursor]::Position
    $screen = [System.Windows.Forms.Screen]::FromPoint($cursor)
    $work = $screen.WorkingArea
    $x = [Math]::Max($work.Left + 8, $work.Right - $script:trayPanel.Width - 8)
    $y = [Math]::Max($work.Top + 8, $work.Bottom - $script:trayPanel.Height - 8)
    $script:trayPanel.Location = New-Object System.Drawing.Point($x, $y)
    $script:trayPanel.Show()
    $script:trayPanel.Activate()
    $script:trayPanel.BringToFront()
  } catch {
    if ($null -ne $script:trayPanel) { $script:trayPanel.Hide() }
    Show-BcFallbackMenu
  }
}

function New-BcTrayIcon {
  if (-not ("BeautiCodeUiNative" -as [type])) {
    $nativeCode = @'
using System;
using System.Runtime.InteropServices;
public static class BeautiCodeUiNative {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool DestroyIcon(IntPtr handle);
}
'@
    Add-Type -TypeDefinition $nativeCode -ErrorAction Stop
  }

  $assetPath = [System.IO.Path]::GetFullPath(
    (Join-Path $PSScriptRoot "..\..\assets\beauticode-icon-borderless.png")
  )
  if (Test-Path -LiteralPath $assetPath -PathType Leaf) {
    $source = $null
    $assetBitmap = $null
    $assetGraphics = $null
    try {
      $source = [System.Drawing.Image]::FromFile($assetPath)
      $assetBitmap = New-Object System.Drawing.Bitmap(32, 32)
      $assetGraphics = [System.Drawing.Graphics]::FromImage($assetBitmap)
      $assetGraphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
      $assetGraphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $assetGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $assetGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $assetGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $assetGraphics.Clear([System.Drawing.Color]::Transparent)
      $assetGraphics.DrawImage($source, 0, 0, 32, 32)

      $handle = $assetBitmap.GetHicon()
      try {
        return ([System.Drawing.Icon]::FromHandle($handle).Clone())
      } finally {
        [void][BeautiCodeUiNative]::DestroyIcon($handle)
      }
    } catch {
      # Keep the generated glyph below as a fail-soft fallback.
    } finally {
      if ($null -ne $assetGraphics) { $assetGraphics.Dispose() }
      if ($null -ne $assetBitmap) { $assetBitmap.Dispose() }
      if ($null -ne $source) { $source.Dispose() }
    }
  }

  $bitmap = New-Object System.Drawing.Bitmap(32, 32)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $brush = New-Object System.Drawing.SolidBrush($script:bcUiColors.Panel)
  $pen = New-Object System.Drawing.Pen($script:bcUiColors.Jade, 1.8)
  $textBrush = New-Object System.Drawing.SolidBrush($script:bcUiColors.Jade)
  $format = New-Object System.Drawing.StringFormat
  try {
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.FillEllipse($brush, 2, 2, 27, 27)
    $graphics.DrawEllipse($pen, 2, 2, 27, 27)
    $format.Alignment = [System.Drawing.StringAlignment]::Center
    $format.LineAlignment = [System.Drawing.StringAlignment]::Center
    $rect = New-Object System.Drawing.RectangleF(1, 1, 29, 29)
    $graphics.DrawString((U "7F8E"), $script:bcIconFont, $textBrush, $rect, $format)
    $handle = $bitmap.GetHicon()
    try {
      return ([System.Drawing.Icon]::FromHandle($handle).Clone())
    } finally {
      [void][BeautiCodeUiNative]::DestroyIcon($handle)
    }
  } finally {
    $format.Dispose()
    $textBrush.Dispose()
    $pen.Dispose()
    $brush.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

function New-BcHeaderMark {
  $assetPath = [System.IO.Path]::GetFullPath(
    (Join-Path $PSScriptRoot "..\..\assets\beauticode-icon-borderless.png")
  )
  if (Test-Path -LiteralPath $assetPath -PathType Leaf) {
    $source = $null
    $iconImage = $null
    try {
      $source = [System.Drawing.Image]::FromFile($assetPath)
      $iconImage = $source.Clone()
      $mark = New-Object System.Windows.Forms.PictureBox
      $mark.Location = New-Object System.Drawing.Point(18, 16)
      $mark.Size = New-Object System.Drawing.Size(39, 39)
      $mark.BackColor = [System.Drawing.Color]::Transparent
      $mark.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::Zoom
      $mark.Image = $iconImage
      $script:bcHeaderIconImage = $iconImage
      $iconImage = $null
      return $mark
    } catch {
      # Keep the generated glyph below as a fail-soft fallback.
    } finally {
      if ($null -ne $iconImage) { $iconImage.Dispose() }
      if ($null -ne $source) { $source.Dispose() }
    }
  }

  $mark = New-BcUiLabel -Text (U "7F8E") -X 18 -Y 16 -Width 39 -Height 39 `
    -Font $script:bcDisplayFont -Color $script:bcUiColors.Jade `
    -Align ([System.Drawing.ContentAlignment]::MiddleCenter)
  $mark.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
  Set-BcRoundedRegion -Control $mark -Radius 19
  return $mark
}

function Initialize-BcTrayPanel {
  $systemDpi = [Math]::Max(96, [BeautiCodeDpiNative]::SystemDpi())
  $script:bcGeometryScale = 0.86 * ($systemDpi / 96.0)
  $script:bcUiColors = @{
    Window = Get-BcUiColor "#1E201D"
    Panel = Get-BcUiColor "#242723"
    PanelSelected = Get-BcUiColor "#2D332E"
    Hover = Get-BcUiColor "#30362F"
    Line = Get-BcUiColor "#454942"
    Text = Get-BcUiColor "#F1EEE7"
    Muted = Get-BcUiColor "#9CA198"
    Jade = Get-BcUiColor "#86AA91"
    JadeDeep = Get-BcUiColor "#496854"
    Copper = Get-BcUiColor "#B98265"
    Danger = Get-BcUiColor "#FF6B6B"
    DangerSurface = Get-BcUiColor "#542B2B"
    DangerHover = Get-BcUiColor "#713333"
    DangerDeep = Get-BcUiColor "#8F3E3E"
    ToggleOff = Get-BcUiColor "#4F554E"
    ToggleOffBorder = Get-BcUiColor "#737A71"
    ToggleKnob = Get-BcUiColor "#F1F3EE"
  }

  $displayFamily = "KaiTi"
  $script:bcDisplayFont = New-Object System.Drawing.Font($displayFamily, 15, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
  $script:bcBrandFont = New-Object System.Drawing.Font($displayFamily, 16, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
  $script:bcBodyFont = New-Object System.Drawing.Font("Microsoft YaHei UI", 10, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
  $script:bcBodyStrongFont = New-Object System.Drawing.Font("Microsoft YaHei UI", 10, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Point)
  $script:bcMetaFont = New-Object System.Drawing.Font("Microsoft YaHei UI", 9, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
  $script:bcSectionFont = New-Object System.Drawing.Font("Microsoft YaHei UI", 8.5, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Point)
  $script:bcIconFont = New-Object System.Drawing.Font($displayFamily, 15, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)

  $form = New-Object System.Windows.Forms.Form
  $form.Text = $L.AppName
  $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
  $form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
  $form.ShowInTaskbar = $false
  $form.TopMost = $true
  $form.KeyPreview = $true
  $form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::Dpi
  $form.ClientSize = New-Object System.Drawing.Size(420, 640)
  $form.BackColor = $script:bcUiColors.Line
  $form.Padding = New-Object System.Windows.Forms.Padding(1)
  $script:trayPanel = $form

  $root = New-Object System.Windows.Forms.Panel
  $root.Dock = [System.Windows.Forms.DockStyle]::Fill
  $root.BackColor = $script:bcUiColors.Window
  [void]$form.Controls.Add($root)

  $header = New-Object System.Windows.Forms.Panel
  $header.Location = New-Object System.Drawing.Point(0, 0)
  $header.Size = New-Object System.Drawing.Size(418, 122)
  $header.BackColor = $script:bcUiColors.Panel
  [void]$root.Controls.Add($header)

  $mark = New-BcHeaderMark
  [void]$header.Controls.Add($mark)

  $brand = New-BcUiLabel -Text $L.AppName -X 69 -Y 12 -Width 205 -Height 31 `
    -Font $script:bcBrandFont -Color $script:bcUiColors.Text
  [void]$header.Controls.Add($brand)
  $script:bcMediaLabel = New-BcUiLabel -Text "" -X 69 -Y 42 -Width 205 -Height 20 `
    -Font $script:bcMetaFont -Color $script:bcUiColors.Muted
  [void]$header.Controls.Add($script:bcMediaLabel)
  $script:bcStatusLabel = New-BcUiLabel -Text "" -X 272 -Y 20 -Width 128 -Height 26 `
    -Font $script:bcMetaFont -Color $script:bcUiColors.Jade `
    -Align ([System.Drawing.ContentAlignment]::MiddleRight)
  [void]$header.Controls.Add($script:bcStatusLabel)

  $reapply = New-BcUiButton -Text $L.Reapply -X 18 -Y 72 -Width 382 -Height 37 `
    -Font $script:bcBodyStrongFont -BackColor $script:bcUiColors.JadeDeep `
    -ForeColor $script:bcUiColors.Text -BorderColor $script:bcUiColors.Jade
  Register-BcPanelAction -Control $reapply -ActionName "reapply"
  [void]$header.Controls.Add($reapply)
  Set-BcRoundedRegion -Control $reapply -Radius 9

  $body = New-Object System.Windows.Forms.Panel
  $body.Location = New-Object System.Drawing.Point(0, 122)
  $body.Size = New-Object System.Drawing.Size(418, 471)
  $body.BackColor = $script:bcUiColors.Window
  [void]$root.Controls.Add($body)

  $section1 = New-BcUiLabel -Text $L.BackgroundMedia -X 14 -Y 7 -Width 180 -Height 22 `
    -Font $script:bcSectionFont -Color $script:bcUiColors.Muted
  [void]$body.Controls.Add($section1)
  $script:bcImageCard = Add-BcActionCard -Parent $body -Title $L.ChangeImage `
    -Meta "PNG · JPG · WEBP" -ActionName "image" -X 14 -Y 29 -Width 190
  $script:bcVideoCard = Add-BcActionCard -Parent $body -Title $L.ChangeVideo `
    -Meta "MP4" -ActionName "video" -X 212 -Y 29 -Width 190

  $clear = New-BcUiButton -Text $L.ClearCurrentBg -X 14 -Y 113 -Width 388 -Height 32 `
    -Font $script:bcMetaFont -BackColor $script:bcUiColors.DangerSurface `
    -ForeColor $script:bcUiColors.Danger -BorderColor $script:bcUiColors.Danger `
    -Align ([System.Drawing.ContentAlignment]::MiddleLeft)
  $clear.Padding = New-Object System.Windows.Forms.Padding(8, 0, 0, 0)
  $clear.FlatAppearance.MouseOverBackColor = $script:bcUiColors.DangerHover
  $clear.FlatAppearance.MouseDownBackColor = $script:bcUiColors.DangerDeep
  Register-BcPanelAction -Control $clear -ActionName "clear"
  [void]$body.Controls.Add($clear)

  $section2 = New-BcUiLabel -Text $L.ViewingControls -X 14 -Y 151 -Width 180 -Height 22 `
    -Font $script:bcSectionFont -Color $script:bcUiColors.Muted
  [void]$body.Controls.Add($section2)
  $script:bcFishSwitch = Add-BcSwitchRow -Parent $body -Title $L.FishMode -ActionName "fish" -Y 173
  $script:bcSoundSwitch = Add-BcSwitchRow -Parent $body -Title $L.VideoSound -ActionName "sound" -Y 217

  $section3 = New-BcUiLabel -Text $L.ThemeSection -X 14 -Y 273 -Width 180 -Height 22 `
    -Font $script:bcSectionFont -Color $script:bcUiColors.Muted
  [void]$body.Controls.Add($section3)
  $themeCard = New-Object System.Windows.Forms.Panel
  $themeCard.Location = New-Object System.Drawing.Point(14, 295)
  $themeCard.Size = New-Object System.Drawing.Size(388, 58)
  $themeCard.BackColor = $script:bcUiColors.Panel
  $themeCard.BorderStyle = [System.Windows.Forms.BorderStyle]::None
  $themeCard.Cursor = [System.Windows.Forms.Cursors]::Hand
  $themeTitle = New-BcUiLabel -Text $L.SavedThemes -X 12 -Y 7 -Width 280 -Height 23 `
    -Font $script:bcBodyStrongFont -Color $script:bcUiColors.Text
  $script:bcThemeMeta = New-BcUiLabel -Text "" -X 12 -Y 30 -Width 330 -Height 19 `
    -Font $script:bcMetaFont -Color $script:bcUiColors.Jade
  $themeArrow = New-BcUiLabel -Text ">" -X 345 -Y 8 -Width 25 -Height 40 `
    -Font $script:bcBodyFont -Color $script:bcUiColors.Muted `
    -Align ([System.Drawing.ContentAlignment]::MiddleCenter)
  Register-BcPanelAction -Control $themeCard -ActionName "themes"
  Register-BcPanelAction -Control $themeTitle -ActionName "themes"
  Register-BcPanelAction -Control $script:bcThemeMeta -ActionName "themes"
  Register-BcPanelAction -Control $themeArrow -ActionName "themes"
  [void]$themeCard.Controls.Add($themeTitle)
  [void]$themeCard.Controls.Add($script:bcThemeMeta)
  [void]$themeCard.Controls.Add($themeArrow)
  [void]$body.Controls.Add($themeCard)
  Set-BcRoundedRegion -Control $themeCard -Radius 10

  $saveTheme = New-BcUiButton -Text $L.SaveTheme -X 14 -Y 359 -Width 388 -Height 38 `
    -Font $script:bcBodyFont -BackColor $script:bcUiColors.Window `
    -ForeColor $script:bcUiColors.Text -BorderColor $script:bcUiColors.Window `
    -Align ([System.Drawing.ContentAlignment]::MiddleLeft)
  $saveTheme.Padding = New-Object System.Windows.Forms.Padding(8, 0, 0, 0)
  Register-BcPanelAction -Control $saveTheme -ActionName "save-theme"
  [void]$body.Controls.Add($saveTheme)

  $script:bcToneButton = New-BcUiButton -Text ("{0} · {1}" -f $L.BackgroundTone, (Get-BcToneLabel $script:backgroundTone)) -X 14 -Y 405 -Width 388 -Height 38 `
    -Font $script:bcBodyFont -BackColor $script:bcUiColors.Panel `
    -ForeColor $script:bcUiColors.Jade -BorderColor $script:bcUiColors.Line `
    -Align ([System.Drawing.ContentAlignment]::MiddleLeft)
  $script:bcToneButton.Padding = New-Object System.Windows.Forms.Padding(8, 0, 0, 0)
  Register-BcPanelAction -Control $script:bcToneButton -ActionName "tone"
  [void]$body.Controls.Add($script:bcToneButton)

  $footer = New-Object System.Windows.Forms.Panel
  $footer.Location = New-Object System.Drawing.Point(0, 593)
  $footer.Size = New-Object System.Drawing.Size(418, 45)
  $footer.BackColor = $script:bcUiColors.Panel
  [void]$root.Controls.Add($footer)
  $engineLabel = New-BcUiLabel -Text ("{0} {1}" -f $L.AppName, $L.LocalEngine) `
    -X 17 -Y 7 -Width 230 -Height 30 -Font $script:bcMetaFont -Color $script:bcUiColors.Muted
  [void]$footer.Controls.Add($engineLabel)
  $quit = New-BcUiButton -Text $L.Quit -X 286 -Y 7 -Width 114 -Height 30 `
    -Font $script:bcMetaFont -BackColor $script:bcUiColors.Panel `
    -ForeColor $script:bcUiColors.Copper -BorderColor $script:bcUiColors.Panel
  Register-BcPanelAction -Control $quit -ActionName "quit"
  [void]$footer.Controls.Add($quit)

  $script:bcThemeOverlay = New-Object System.Windows.Forms.Panel
  $script:bcThemeOverlay.Location = New-Object System.Drawing.Point(0, 122)
  $script:bcThemeOverlay.Size = New-Object System.Drawing.Size(418, 471)
  $script:bcThemeOverlay.BackColor = $script:bcUiColors.Window
  $script:bcThemeOverlay.Visible = $false
  [void]$root.Controls.Add($script:bcThemeOverlay)

  $overlayTitle = New-BcUiLabel -Text $L.SavedThemes -X 18 -Y 8 -Width 250 -Height 37 `
    -Font $script:bcBodyStrongFont -Color $script:bcUiColors.Text
  [void]$script:bcThemeOverlay.Controls.Add($overlayTitle)
  $overlayBack = New-BcUiButton -Text $L.BackLabel -X 316 -Y 9 -Width 84 -Height 34 `
    -Font $script:bcMetaFont -BackColor $script:bcUiColors.Panel `
    -ForeColor $script:bcUiColors.Jade -BorderColor $script:bcUiColors.Line
  $null = $overlayBack.add_Click({ $script:bcThemeOverlay.Visible = $false })
  [void]$script:bcThemeOverlay.Controls.Add($overlayBack)

  $script:bcThemeFlow = New-Object System.Windows.Forms.FlowLayoutPanel
  $script:bcThemeFlow.Location = New-Object System.Drawing.Point(18, 55)
  $script:bcThemeFlow.Size = New-Object System.Drawing.Size(382, 400)
  $script:bcThemeFlow.BackColor = $script:bcUiColors.Window
  $script:bcThemeFlow.FlowDirection = [System.Windows.Forms.FlowDirection]::TopDown
  $script:bcThemeFlow.WrapContents = $false
  $script:bcThemeFlow.AutoScroll = $true
  [void]$script:bcThemeOverlay.Controls.Add($script:bcThemeFlow)

  $script:bcRoundedControls = @(
    @{ Control = $form; Radius = 17 },
    @{ Control = $mark; Radius = 19 },
    @{ Control = $reapply; Radius = 9 },
    @{ Control = $script:bcImageCard.Panel; Radius = 10 },
    @{ Control = $script:bcVideoCard.Panel; Radius = 10 },
    @{ Control = $themeCard; Radius = 10 },
    @{ Control = $clear; Radius = 8 },
    @{ Control = $script:bcToneButton; Radius = 8 }
  )
  Set-BcIntegerLayoutTree -Control $form
  Enable-BcDoubleBufferTree -Control $form
  Update-BcRoundedControls
  $null = $form.add_Shown({ Update-BcRoundedControls })
  $null = $form.add_Resize({ Update-BcRoundedControls })
  $script:bcHideTimer = New-Object System.Windows.Forms.Timer
  $script:bcHideTimer.Interval = 140
  $null = $script:bcHideTimer.add_Tick({
      $script:bcHideTimer.Stop()
      if ($null -ne $script:trayPanel -and -not $script:trayPanel.ContainsFocus) {
        $script:trayPanel.Hide()
      }
    })
  $null = $form.add_Activated({ $script:bcHideTimer.Stop() })
  $null = $form.add_Deactivate({ $script:bcHideTimer.Start() })
  $null = $form.add_KeyDown({
      param($sender, $eventArgs)
      if ($eventArgs.KeyCode -eq [System.Windows.Forms.Keys]::Escape) {
        if ($null -ne $script:bcThemeOverlay -and $script:bcThemeOverlay.Visible) {
          $script:bcThemeOverlay.Visible = $false
        } else {
          $sender.Hide()
        }
        $eventArgs.Handled = $true
      }
    })

  try {
    $script:trayIcon = New-BcTrayIcon
    $notify.Icon = $script:trayIcon
  } catch {
    $notify.Icon = [System.Drawing.SystemIcons]::Application
  }
}

$null = $menu.add_Opening({
    Rebuild-BcTrayMenu
    if ($null -ne $script:bcUiColors) { Set-BcFallbackMenuStyle }
  })

try {
  Initialize-BcTrayPanel
} catch {
  $script:trayPanel = $null
  Write-Warning ("Custom tray panel unavailable; native fallback enabled: {0}" -f $_.Exception.Message)
}

$script:showPanelTimer = New-Object System.Windows.Forms.Timer
$script:showPanelTimer.Interval = 100
$null = $script:showPanelTimer.add_Tick({
    try {
      if (
        $null -ne $script:shutdownEvent -and
        $script:shutdownEvent.WaitOne(0)
      ) {
        Write-BcTrayLog "shutdown event received"
        [System.Windows.Forms.Application]::Exit()
        return
      }
      if (
        $null -ne $script:showPanelEvent -and
        $script:showPanelEvent.WaitOne(0)
      ) {
        Write-BcTrayLog "show-panel event received"
        Show-BcTrayPanel -EnsureVisible
      }
    } catch {
      Write-BcTrayLog ("show-panel event failed: {0}" -f $_.Exception.Message)
    }
  })
$script:showPanelTimer.Start()

Rebuild-BcTrayMenu
if ($null -ne $script:bcUiColors) { Set-BcFallbackMenuStyle }

$null = $notify.add_MouseUp({
    param($sender, $eventArgs)
    if (
      $eventArgs.Button -eq [System.Windows.Forms.MouseButtons]::Left -or
      $eventArgs.Button -eq [System.Windows.Forms.MouseButtons]::Right
    ) {
      Show-BcTrayPanel
    }
  })

if (-not (Register-BcFishHotkey)) {
  Show-Tip -Title $L.AppName -Text $L.HotkeyFail -Icon Warning
}

$runningText = if ($script:targetHost -eq "dsh") { $L.RunningTipDsh } else { $L.RunningTip }
Show-Tip -Title $L.AppName -Text $runningText -Icon Info

try {
  [System.Windows.Forms.Application]::Run()
} finally {
  Unregister-BcFishHotkey
  try {
    if (-not $proc.HasExited) {
      # Best-effort leave fish before shutdown (session.stop also restores).
      try {
        if ($script:fishMode) {
          Invoke-BcApi -Method Post -Path "/mode/fish" -Body @{ enabled = $false } | Out-Null
          $script:fishMode = $false
        }
      } catch {
        # ignore
      }
      try {
        Invoke-BcApi -Method Post -Path "/shutdown" -Body @{} | Out-Null
      } catch {
        # ignore
      }
      Start-Sleep -Milliseconds 300
      if (-not $proc.HasExited) {
        try { $proc.Kill() } catch { }
      }
    }
  } catch {
    # ignore
  }
  try {
    $notify.Visible = $false
    $notify.Dispose()
  } catch {
    # ignore
  }
  try {
    if ($null -ne $script:showPanelTimer) {
      $script:showPanelTimer.Stop()
      $script:showPanelTimer.Dispose()
      $script:showPanelTimer = $null
    }
  } catch {
    # ignore
  }
  try {
    if ($null -ne $script:bcHideTimer) {
      $script:bcHideTimer.Stop()
      $script:bcHideTimer.Dispose()
    }
  } catch {
    # ignore
  }
  try {
    if ($null -ne $script:trayPanel) {
      $script:trayPanel.Dispose()
    }
  } catch {
    # ignore
  }
  try {
    if ($null -ne $script:trayIcon) {
      $script:trayIcon.Dispose()
    }
  } catch {
    # ignore
  }
  try {
    if ($null -ne $script:bcHeaderIconImage) {
      $script:bcHeaderIconImage.Dispose()
    }
  } catch {
    # ignore
  }
  foreach ($fontName in @(
      "bcDisplayFont",
      "bcBrandFont",
      "bcBodyFont",
      "bcBodyStrongFont",
      "bcMetaFont",
      "bcSectionFont",
      "bcIconFont"
    )) {
    try {
      $font = Get-Variable -Name $fontName -Scope Script -ValueOnly -ErrorAction SilentlyContinue
      if ($null -ne $font) { $font.Dispose() }
    } catch {
      # ignore
    }
  }
  if ($outEvent) {
    Unregister-Event -SourceIdentifier $outEvent.Name -ErrorAction SilentlyContinue
  }
  if ($errEvent) {
    Unregister-Event -SourceIdentifier $errEvent.Name -ErrorAction SilentlyContinue
  }
  if ($null -ne $script:trayInstanceMutex) {
    if ($script:trayInstanceMutexOwned) {
      try { $script:trayInstanceMutex.ReleaseMutex() } catch { }
      $script:trayInstanceMutexOwned = $false
    }
    try { $script:trayInstanceMutex.Dispose() } catch { }
    $script:trayInstanceMutex = $null
  }
  if ($null -ne $script:hostInstanceMutex) {
    if ($script:hostInstanceMutexOwned) {
      try { $script:hostInstanceMutex.ReleaseMutex() } catch { }
      $script:hostInstanceMutexOwned = $false
    }
    try { $script:hostInstanceMutex.Dispose() } catch { }
    $script:hostInstanceMutex = $null
  }
  if ($null -ne $script:showPanelEvent) {
    try { $script:showPanelEvent.Dispose() } catch { }
    $script:showPanelEvent = $null
  }
  if ($null -ne $script:shutdownEvent) {
    try { $script:shutdownEvent.Dispose() } catch { }
    $script:shutdownEvent = $null
  }
}
