import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { listLinuxProcesses, readLinuxProcess, selectLinuxMainProcesses, signalLinuxProcess } from "@beauticode/core";
import { parseRemoteDebuggingFlags } from "./host-discover.js";

const execFileAsync = promisify(execFile);

export interface CodexProcess {
  pid: number;
  name: string;
  executablePath: string;
  commandLine: string;
  port: number | null;
  /** Main-process creation time. Null means it is unsafe to auto-restart. */
  createdAtMs: number | null;
}

export function looksLikeCodexMain(
  commandLine: string,
  name: string,
  exePath = "",
): boolean {
  const hay = `${name} ${exePath} ${commandLine}`;
  if (!/\b(ChatGPT|Codex)\.exe\b/i.test(hay) && !/\b(ChatGPT|Codex)\b/i.test(hay)) {
    return false;
  }
  if (/\s--type=/.test(commandLine)) return false;
  if (/\bapp-server\b/i.test(commandLine)) return false;
  if (/\\resources\\/i.test(exePath) || /\\resources\\/i.test(commandLine)) {
    return false;
  }
  // Linux/macOS bundle the Codex CLI app-server under resources/ as well.
  if (/\/resources\//i.test(exePath)) return false;
  return true;
}

export function codexInstallCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  if (platform === "linux") {
    return [
      "/usr/lib/chatgpt/ChatGPT",
      "/opt/ChatGPT/ChatGPT",
      "/opt/chatgpt/ChatGPT",
      "/usr/lib/codex/Codex",
      "/opt/Codex/Codex",
      path.posix.join(home, ".local", "share", "chatgpt", "ChatGPT"),
      path.posix.join(home, ".local", "opt", "ChatGPT", "ChatGPT"),
    ];
  }
  if (platform !== "win32") return [];
  const local = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const pf = env.ProgramFiles || "C:\\Program Files";
  const pf86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const relatives = [
    ["Programs", "ChatGPT", "ChatGPT.exe"],
    ["Programs", "chatgpt", "ChatGPT.exe"],
    ["Programs", "Codex", "Codex.exe"],
    ["Programs", "codex", "Codex.exe"],
    ["OpenAI", "ChatGPT", "ChatGPT.exe"],
    ["OpenAI", "Codex", "Codex.exe"],
  ];
  const out: string[] = [];
  for (const root of [local, pf, pf86]) {
    for (const rel of relatives) {
      out.push(path.join(root, ...rel));
    }
  }
  return out;
}

export function findCodexExecutable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  for (const candidate of codexInstallCandidates(env, platform)) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export function parseAppxCodexInstallLocations(stdout: string): string[] {
  return [...new Set(
    String(stdout ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => path.win32.isAbsolute(line)),
  )];
}

export async function findPackagedCodexExecutable(
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  if (platform !== "win32") return null;
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | ForEach-Object { $_.InstallLocation }",
      ],
      { windowsHide: true, timeout: 12_000, maxBuffer: 1024 * 1024 },
    );
    for (const installLocation of parseAppxCodexInstallLocations(stdout)) {
      const executable = path.win32.join(installLocation, "app", "ChatGPT.exe");
      if (fs.existsSync(executable)) return executable;
    }
  } catch {
    /* package absent or AppX query unavailable */
  }
  return null;
}

async function scanWindowsCodexProcesses(): Promise<CodexProcess[]> {
  if (process.platform !== "win32") return [];
  const script = [
    "$ErrorActionPreference='SilentlyContinue';",
    "Get-CimInstance Win32_Process | ForEach-Object {",
    "$cmd=[string]$_.CommandLine;",
    "$name=[string]$_.Name;",
    "$path=[string]$_.ExecutablePath;",
    "$created=0;",
    "try{$created=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}catch{};",
    "if($name -notmatch '^(ChatGPT|Codex)\\.exe$'){return};",
    "if($cmd -match '\\s--type='){return};",
    "if($path -match '\\\\resources\\\\'){return};",
    "$o=@{pid=$_.ProcessId;name=$name;exe=$path;cmd=$cmd;created=$created};",
    "($o | ConvertTo-Json -Compress -Depth 3)",
    "}",
  ].join(" ");
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ],
      {
        windowsHide: true,
        timeout: 12_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const found: CodexProcess[] = [];
    for (const line of String(stdout ?? "").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      let row: {
        pid?: unknown;
        name?: unknown;
        exe?: unknown;
        cmd?: unknown;
        created?: unknown;
      };
      try {
        row = JSON.parse(trimmed) as typeof row;
      } catch {
        continue;
      }
      const commandLine = typeof row.cmd === "string" ? row.cmd : "";
      const name = typeof row.name === "string" ? row.name : "ChatGPT.exe";
      const executablePath = typeof row.exe === "string" ? row.exe : "";
      if (!looksLikeCodexMain(commandLine, name, executablePath)) continue;
      const flags = parseRemoteDebuggingFlags(commandLine);
      found.push({
        pid: Number(row.pid) || 0,
        name,
        executablePath,
        commandLine,
        port: flags.port,
        createdAtMs:
          Number.isFinite(Number(row.created)) && Number(row.created) > 0
            ? Number(row.created)
            : null,
      });
    }
    return found;
  } catch {
    return [];
  }
}

/** Resolve known desktop installations; the standalone CLI is also named codex. */
function canonicalLinuxExecutable(executable: string): string {
  try { return fs.realpathSync(executable); }
  catch { return path.posix.normalize(executable); }
}

/** /proc counterpart of the Win32_Process scan: trusted desktop binaries only. */
export function scanLinuxCodexProcesses(): CodexProcess[] {
  const desktopImages = new Set(codexInstallCandidates(process.env, "linux").map(canonicalLinuxExecutable));
  const rows = listLinuxProcesses((row) => row.executablePath !== "" &&
    desktopImages.has(canonicalLinuxExecutable(row.executablePath)));
  return selectLinuxMainProcesses(rows, (row) =>
    looksLikeCodexMain(row.commandLine, path.posix.basename(row.executablePath), row.executablePath),
  ).map((row) => ({
    pid: row.pid,
    name: path.posix.basename(row.executablePath),
    executablePath: row.executablePath,
    commandLine: row.commandLine,
    port: parseRemoteDebuggingFlags(row.commandLine).port,
    createdAtMs: row.createdAtMs,
  }));
}

export async function listCodexProcesses(): Promise<CodexProcess[]> {
  if (process.platform === "linux") return scanLinuxCodexProcesses();
  return scanWindowsCodexProcesses();
}

/**
 * Stop one exact Linux main process (PID + creation time) and wait for it to
 * exit: a relaunch while the old instance is alive would just hand its
 * arguments to the singleton and drop the CDP flags.
 */
export async function stopLinuxCodexProcess(
  proc: CodexProcess,
  graceful: boolean,
  timeoutMs = 8_000,
): Promise<boolean> {
  if (!proc.pid || proc.pid <= 0) return false;
  if (!signalLinuxProcess(proc.pid, graceful ? "SIGTERM" : "SIGKILL", proc.createdAtMs)) {
    return false;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!readLinuxProcess(proc.pid)) return true;
    await delay(100);
  }
  signalLinuxProcess(proc.pid, "SIGKILL", proc.createdAtMs);
  await delay(250);
  return !readLinuxProcess(proc.pid);
}

export function parseExecutableFromProcess(proc: CodexProcess | undefined): string | null {
  if (!proc) return null;
  if (proc.executablePath && fs.existsSync(proc.executablePath)) {
    return proc.executablePath;
  }
  const quoted = proc.commandLine.match(/^"([^"]+\.exe)"/i);
  if (quoted?.[1] && fs.existsSync(quoted[1])) return quoted[1];
  return null;
}
