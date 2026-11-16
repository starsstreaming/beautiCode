import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DesktopCdpHostSpec, DesktopEnsureLog, DesktopProcess } from "./types.js";

const execFileAsync = promisify(execFile);
type RunCommand = (args: string[], timeoutMs: number) => Promise<void>;

const runPowerShell: RunCommand = async (args, timeoutMs) => {
  await execFileAsync("powershell.exe", args, { windowsHide: true, timeout: timeoutMs });
};

export async function stopWindowsDesktopProcess(
  processInfo: DesktopProcess,
  action: "close" | "force",
  spec: DesktopCdpHostSpec,
  log?: DesktopEnsureLog,
  run: RunCommand = runPowerShell,
): Promise<boolean> {
  const pid = Math.trunc(processInfo.pid);
  const createdAtMs = Math.trunc(processInfo.createdAtMs ?? 0);
  if (pid < 1 || createdAtMs < 1) return false;
  const script = [
    "$ErrorActionPreference='SilentlyContinue';",
    `$p=Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\";`,
    `if(-not $p){exit 1};$created=0;try{$created=([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds()}catch{};`,
    `if($created -ne ${createdAtMs}){exit 2};`,
    action === "close"
      ? "$proc=Get-Process -Id " + pid + " -ErrorAction SilentlyContinue;if($proc -and $proc.MainWindowHandle -ne 0){[void]$proc.CloseMainWindow();exit 0};exit 3;"
      : `taskkill.exe /PID ${pid} /T /F | Out-Null;if($LASTEXITCODE -eq 0){exit 0};exit 4;`,
  ].join("");
  try {
    await run([
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ], spec.windowsProcessStopTimeoutMs ?? (action === "close" ? 2_000 : 3_000));
    return true;
  } catch (error) {
    const detail = error as { killed?: boolean; code?: unknown };
    const reason = detail.killed ? "timeout" : typeof detail.code === "number" ? `exit-${detail.code}` : "unavailable";
    log?.warn(`${spec.displayName} ${action === "close" ? "关闭窗口" : "结束进程"}失败：${reason}。`);
    return false;
  }
}
