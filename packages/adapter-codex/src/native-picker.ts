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

/** zenity first, then kdialog. Exit 1 with no output is a user cancel for both. */
async function pickLinuxMedia(kind: "image" | "video"): Promise<PickedMedia> {
  const patterns = kind === "video" ? "*.mp4 *.mov" : "*.jpg *.jpeg *.png *.webp *.avif";
  const title = "选择 beautiCode 背景文件";
  const candidates: Array<[string, string[]]> = [
    ["zenity", ["--file-selection", `--title=${title}`, `--file-filter=${kind === "video" ? "Video" : "Image"} | ${patterns}`]],
    ["kdialog", ["--title", title, "--getopenfilename", ".", patterns]],
  ];
  for (const [command, args] of candidates) {
    const result = await new Promise<{ missing: boolean; code: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), PICKER_TIMEOUT_MS);
      child.stdout?.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
      child.stderr?.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      child.once("error", (error) => {
        clearTimeout(timer);
        resolve({ missing: (error as NodeJS.ErrnoException).code === "ENOENT", code: null, stdout, stderr: String(error) });
      });
      child.once("close", (code) => { clearTimeout(timer); resolve({ missing: false, code, stdout, stderr }); });
    });
    if (result.missing) continue;
    const selected = result.stdout.trim();
    if (result.code === 0 && selected) {
      return { ok: true, kind, path: path.resolve(selected), name: path.basename(selected) };
    }
    if (result.code === 1 && !selected) return { ok: true, cancelled: true };
    throw pickerUnavailable(result.stderr.trim() || `文件选择器退出异常（${result.code}）。`);
  }
  throw pickerUnavailable("没有找到 zenity 或 kdialog，无法打开文件选择器。请安装 zenity（例如 sudo apt install zenity）。");
}

export async function pickLocalMedia(
  kind: "image" | "video",
): Promise<PickedMedia> {
  if (process.platform === "linux") return pickLinuxMedia(kind);
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
