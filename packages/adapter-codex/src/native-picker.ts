import { spawn } from "node:child_process";
import path from "node:path";

const PICKER_TIMEOUT_MS = 5 * 60 * 1000;
const NATIVE_PICKER_UNAVAILABLE = "native_picker_unavailable";

export type PickedMedia =
  | { ok: true; cancelled: true }
  | { ok: true; cancelled?: false; kind: "image" | "video"; path: string; name: string };

function pickerUnavailable(message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = NATIVE_PICKER_UNAVAILABLE;
  return error;
}

function buildWindowsPickerScript(kind: "image" | "video"): string {
  const filter =
    kind === "video"
      ? "Video (*.mp4;*.mov)|*.mp4;*.mov"
      : "Image Files (*.jpg;*.jpeg;*.png;*.webp;*.avif)|*.jpg;*.jpeg;*.png;*.webp;*.avif";
  return [
    "$ErrorActionPreference = 'Stop'",
    "$OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
    "[Console]::OutputEncoding = $OutputEncoding",
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "[System.Windows.Forms.Application]::EnableVisualStyles()",
    "$owner = New-Object System.Windows.Forms.Form",
    "$owner.ShowInTaskbar = $false",
    "$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen",
    "$owner.Size = [System.Drawing.Size]::new(1, 1)",
    "$owner.Opacity = 0.01",
    "$owner.TopMost = $true",
    "$dialog = New-Object System.Windows.Forms.OpenFileDialog",
    `$dialog.Filter = '${filter}'`,
    "$dialog.Multiselect = $false",
    "$dialog.CheckFileExists = $true",
    "$dialog.RestoreDirectory = $true",
    "$dialog.Title = '选择 beautiCode 背景文件'",
    "try { [void]$owner.Show(); [void]$owner.Hide(); [void]$owner.Show(); [void]$owner.Activate(); [void]$owner.BringToFront(); [System.Windows.Forms.Application]::DoEvents(); $result = $dialog.ShowDialog($owner); if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::WriteLine($dialog.FileName) } } finally { $dialog.Dispose(); $owner.Close(); $owner.Dispose() }",
  ].join("; ");
}

export async function pickLocalMedia(
  kind: "image" | "video",
): Promise<PickedMedia> {
  if (process.platform !== "win32") {
    throw pickerUnavailable("当前系统不支持 Windows 原生文件选择器。");
  }
  const encodedScript = Buffer.from(buildWindowsPickerScript(kind), "utf16le").toString(
    "base64",
  );
  return await new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-STA",
        "-EncodedCommand",
        encodedScript,
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (ok: boolean, value: PickedMedia | Error, terminate = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (terminate && !child.killed) child.kill("SIGKILL");
      if (ok) resolve(value as PickedMedia);
      else reject(value);
    };
    const timer = setTimeout(() => {
      finish(false, new Error("文件选择器超时。"), true);
    }, PICKER_TIMEOUT_MS);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      finish(
        false,
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? pickerUnavailable("找不到 Windows PowerShell，无法打开原生文件选择器。")
          : error,
      );
    });
    child.once("close", (code) => {
      if (code !== 0) {
        finish(
          false,
          pickerUnavailable(stderr.trim() || `文件选择器退出异常（${code}）。`),
        );
        return;
      }
      const selected = stdout.trim();
      if (!selected) {
        finish(true, { ok: true, cancelled: true });
        return;
      }
      finish(true, {
        ok: true,
        kind,
        path: path.resolve(selected),
        name: path.basename(selected.replaceAll("\\", "/")),
      });
    });
  });
}
