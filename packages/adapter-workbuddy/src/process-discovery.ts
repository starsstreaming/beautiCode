import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { listLinuxProcesses, selectLinuxMainProcesses } from "@beauticode/core";
import { parseRemoteDebuggingFlags, WORKBUDDY_CDP_ENV_KEY } from "./discovery.js";

const execFileAsync = promisify(execFile);

export interface WorkBuddyProcess {
  pid: number;
  name: string;
  executablePath: string;
  commandLine: string;
  port: number | null;
  /** Main-process creation time. Null means it is unsafe to auto-restart. */
  createdAtMs: number | null;
}

function executableFromCommandLine(commandLine: string): string {
  const quoted = commandLine.match(/^\s*["']([^"']+)["']/);
  return quoted?.[1] ?? commandLine.trim().split(/\s+/)[0] ?? "";
}

export function isWorkBuddyMainProcess(
  commandLine: string,
  name: string,
  exePath = "",
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (/\s--type=/.test(commandLine)) return false;
  const executable = exePath || executableFromCommandLine(commandLine);
  if (!executable) return false;
  if (platform === "win32") {
    // WorkBuddy starts its stdio service and prewarm worker with the same
    // executable as the desktop process, without Electron's --type flag.
    const args = commandLine.match(/"[^"]*"|[^\s"]+/g)?.slice(1) ?? [];
    if (args.some(arg => /^--(?:stdio|prewarm-id)(?:=|$)/.test(arg))) return false;
    return (
      name.toLowerCase() === "workbuddy.exe" &&
      path.win32.basename(executable).toLowerCase() === "workbuddy.exe"
    );
  }
  if (platform === "darwin") {
    return /\/WorkBuddy\.app\/Contents\/MacOS\/(?:Electron|WorkBuddy)$/i.test(
      executable,
    );
  }
  return path.basename(executable).toLowerCase() === "workbuddy";
}

export function parsePsElapsedSeconds(value: string): number | null {
  const match = /^(?:(\d+)-)?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(
    value.trim(),
  );
  if (!match) return null;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
}

async function scanWindowsWorkBuddyProcesses(): Promise<WorkBuddyProcess[]> {
  const script = [
    "$ErrorActionPreference='SilentlyContinue';",
    "Get-CimInstance Win32_Process | ForEach-Object {",
    "$cmd=$_.CommandLine;",
    "if(-not $cmd){return};",
    "if($cmd -match '\\s--type='){return};",
    "if($_.Name -ine 'WorkBuddy.exe'){return};",
    "$created=0;",
    "try{$created=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}catch{};",
    "$o=@{pid=$_.ProcessId;name=$_.Name;exe=$_.ExecutablePath;cmd=$cmd;created=$created};",
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
      { windowsHide: true, timeout: 12_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const found: WorkBuddyProcess[] = [];
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
      const name = typeof row.name === "string" ? row.name : "unknown";
      const executablePath = typeof row.exe === "string" ? row.exe : "";
      if (!isWorkBuddyMainProcess(commandLine, name, executablePath, "win32")) {
        continue;
      }
      const flags = parseRemoteDebuggingFlags(commandLine);
      found.push({
        pid: Number(row.pid) || 0,
        name,
        executablePath,
        commandLine,
        port: flags.safe ? flags.port : null,
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

async function scanUnixWorkBuddyProcesses(): Promise<WorkBuddyProcess[]> {
  try {
    const elapsedField = process.platform === "darwin" ? "etime=" : "etimes=";
    const { stdout } = await execFileAsync("ps", [
      "-axo",
      `pid=,${elapsedField},command=`,
    ], {
      timeout: 5_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const found: WorkBuddyProcess[] = [];
    for (const line of String(stdout ?? "").split(/\n/)) {
      const match = /^\s*(\d+)\s+(\S+)\s+(\S.*)$/.exec(line);
      if (!match) continue;
      const commandLine = match[3] ?? "";
      const executablePath = executableFromCommandLine(commandLine);
      const processName = path.basename(executablePath);
      if (
        !isWorkBuddyMainProcess(
          commandLine,
          processName,
          executablePath,
          process.platform,
        )
      ) {
        continue;
      }
      const flags = parseRemoteDebuggingFlags(commandLine);
      const elapsedSeconds =
        process.platform === "darwin"
          ? parsePsElapsedSeconds(match[2] ?? "")
          : Number(match[2]);
      found.push({
        pid: Number(match[1]) || 0,
        name: "WorkBuddy",
        executablePath,
        commandLine,
        port: flags.safe ? flags.port : null,
        createdAtMs: elapsedSeconds != null && Number.isFinite(elapsedSeconds)
          ? Date.now() - elapsedSeconds * 1_000
          : null,
      });
    }
    return found;
  } catch {
    return [];
  }
}

/**
 * Linux reads /proc so ELECTRON_RUN_AS_NODE workers (`workbuddy <script.js>`,
 * same binary, no --type) are excluded by parent image instead of counting
 * as extra main processes.
 */
function scanLinuxWorkBuddyProcesses(): WorkBuddyProcess[] {
  const rows = listLinuxProcesses((row) => path.posix.basename(row.executablePath).toLowerCase() === "workbuddy");
  return selectLinuxMainProcesses(rows, (row) =>
    isWorkBuddyMainProcess(row.commandLine, row.name, row.executablePath, "linux"),
  ).map((row) => {
    const flags = parseRemoteDebuggingFlags(row.commandLine);
    // WorkBuddy enables CDP from its environment, not argv. A same-user
    // /proc/<pid>/environ read tells a CDP launch apart from a blind one, so a
    // just-started CDP process is never mistaken for a repair candidate.
    const envPort = linuxProcessEnvPort(row.pid);
    return {
      pid: row.pid,
      name: "WorkBuddy",
      executablePath: row.executablePath,
      commandLine: row.commandLine,
      port: flags.safe && flags.port != null ? flags.port : envPort,
      createdAtMs: row.createdAtMs,
    };
  });
}

function linuxProcessEnvPort(pid: number): number | null {
  try {
    const prefix = `${WORKBUDDY_CDP_ENV_KEY}=`;
    const entry = fs.readFileSync(`/proc/${pid}/environ`, "utf8")
      .split("\0")
      .find((value) => value.startsWith(prefix));
    const port = Number(entry?.slice(prefix.length));
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

export async function listWorkBuddyProcesses(): Promise<WorkBuddyProcess[]> {
  if (process.platform === "win32") return scanWindowsWorkBuddyProcesses();
  if (process.platform === "linux") return scanLinuxWorkBuddyProcesses();
  return scanUnixWorkBuddyProcesses();
}
