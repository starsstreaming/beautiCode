import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WindowsProcessGeneration {
  pid: number;
  createdAtMs: number | null;
  name: string;
  executablePath: string;
}

const psLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

/** Validate the current PID in the same PowerShell operation that ends it. */
export function buildWindowsGenerationKillScript(
  processInfo: WindowsProcessGeneration,
  tree: boolean,
): string {
  const { pid, createdAtMs, name, executablePath } = processInfo;
  if (!Number.isSafeInteger(pid) || pid < 1 ||
      !Number.isSafeInteger(createdAtMs) || (createdAtMs ?? 0) < 1 ||
      !/^[A-Za-z0-9._-]+\.exe$/i.test(name) || !executablePath) {
    throw new Error("Unsafe Windows process identity");
  }
  return [
    "$ErrorActionPreference='SilentlyContinue';",
    `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}";`,
    "if(-not $p){exit 1};",
    "$created=0;try{$created=([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds()}catch{};",
    `if($created -ne ${createdAtMs}){exit 2};`,
    `if([string]$p.Name -ine ${psLiteral(name)}){exit 3};`,
    `if([string]$p.ExecutablePath -ine ${psLiteral(executablePath)}){exit 4};`,
    "if(-not $p.CommandLine -or $p.CommandLine -match '\\s--type='){exit 5};",
    `taskkill.exe /PID ${pid} ${tree ? "/T " : ""}/F | Out-Null;`,
    "if($LASTEXITCODE -ne 0){exit 6};",
  ].join("");
}

export async function terminateWindowsProcessGeneration(
  processInfo: WindowsProcessGeneration,
  tree = false,
): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const script = buildWindowsGenerationKillScript(processInfo, tree);
  try {
    await execFileAsync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
    ], { windowsHide: true, timeout: 3_000 });
    return true;
  } catch { return false; }
}
