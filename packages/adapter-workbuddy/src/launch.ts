import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_WORKBUDDY_CDP_PORT,
  DEFAULT_WORKBUDDY_CDP_PORTS,
  WORKBUDDY_CDP_ENV_KEY,
  discoverWorkBuddyCdp,
  parseRemoteDebuggingFlags,
  probeCdpPort,
  probeWorkBuddyCdp,
  type DiscoveredWorkBuddyCdp,
} from "./discovery.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_WORKBUDDY_REPAIR_WINDOW_MS = 10_000;

export interface WorkBuddyProcess {
  pid: number;
  name: string;
  executablePath: string;
  commandLine: string;
  port: number | null;
  /** Main-process creation time. Null means it is unsafe to auto-restart. */
  createdAtMs: number | null;
}

export type WorkBuddyStartupProcessDecision =
  | "repair-now"
  | "wait-for-cdp"
  | "ignore-stale";

export function classifyWorkBuddyStartupProcess(
  proc: WorkBuddyProcess,
  nowMs = Date.now(),
  repairWindowMs = DEFAULT_WORKBUDDY_REPAIR_WINDOW_MS,
): WorkBuddyStartupProcessDecision {
  if (proc.port != null) return "wait-for-cdp";
  if (proc.createdAtMs == null || !Number.isFinite(proc.createdAtMs)) {
    return "ignore-stale";
  }
  const ageMs = nowMs - proc.createdAtMs;
  return ageMs >= 0 && ageMs < repairWindowMs
    ? "repair-now"
    : "ignore-stale";
}

export interface WorkBuddyEnsureLog {
  info: (...m: string[]) => void;
  warn: (...m: string[]) => void;
}

export interface EnsureWorkBuddyCdpOptions {
  preferredPort?: number;
  launch?: boolean;
  /** Whether a missing WorkBuddy process may be launched. Disable in guards. */
  launchIfMissing?: boolean;
  restartIfBlind?: boolean;
  repairWindowMs?: number;
  timeoutMs?: number;
  log?: WorkBuddyEnsureLog;
}

export interface EnsuredWorkBuddyCdp extends DiscoveredWorkBuddyCdp {
  launched: boolean;
  restarted: boolean;
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

export function workBuddyInstallCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  if (platform === "win32") {
    const local = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    const pf = env.ProgramFiles || "C:\\Program Files";
    const pf86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    return [
      path.join(local, "Programs", "WorkBuddy", "WorkBuddy.exe"),
      path.join(local, "WorkBuddy", "WorkBuddy.exe"),
      path.join(pf, "WorkBuddy", "WorkBuddy.exe"),
      path.join(pf86, "WorkBuddy", "WorkBuddy.exe"),
    ];
  }
  if (platform === "darwin") {
    return [
      "/Applications/WorkBuddy.app/Contents/MacOS/Electron",
      "/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy",
    ];
  }
  return [];
}

export function findWorkBuddyExecutable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  for (const candidate of workBuddyInstallCandidates(env, platform)) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export async function isLoopbackPortFree(port: number): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

export async function pickAvailableLoopbackPort(
  preferred: number = DEFAULT_WORKBUDDY_CDP_PORT,
): Promise<number> {
  const ordered = [
    preferred,
    ...DEFAULT_WORKBUDDY_CDP_PORTS.filter((p) => p !== preferred),
  ];
  for (const port of ordered) {
    const existing = await probeCdpPort(port, { timeoutMs: 200 });
    if (!existing && (await isLoopbackPortFree(port))) return port;
    const workbuddy = await probeWorkBuddyCdp(port, { timeoutMs: 200 });
    if (workbuddy) return port;
  }
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        address && typeof address === "object" ? address.port : preferred;
      server.close(() => resolve(port));
    });
  });
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

export async function listWorkBuddyProcesses(): Promise<WorkBuddyProcess[]> {
  if (process.platform === "win32") return scanWindowsWorkBuddyProcesses();
  return scanUnixWorkBuddyProcesses();
}

export async function stopWorkBuddyProcesses(
  procs: readonly WorkBuddyProcess[],
): Promise<void> {
  for (const proc of procs) {
    if (!proc.pid || proc.pid <= 0) continue;
    if (process.platform === "win32") {
      await execFileAsync("taskkill.exe", ["/PID", String(proc.pid), "/T"], {
        windowsHide: true,
        timeout: 8_000,
      }).catch(() => {});
    } else {
      try {
        process.kill(proc.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const still = await listWorkBuddyProcesses();
    if (still.length === 0) return;
    await delay(200);
  }
  for (const proc of await listWorkBuddyProcesses()) {
    if (process.platform === "win32") {
      await execFileAsync(
        "taskkill.exe",
        ["/PID", String(proc.pid), "/T", "/F"],
        { windowsHide: true, timeout: 8_000 },
      ).catch(() => {});
    } else {
      try {
        process.kill(proc.pid, "SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }
}

export async function launchWorkBuddyWithCdp(
  port: number,
  executable: string,
): Promise<void> {
  const child = spawn(executable, [], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, [WORKBUDDY_CDP_ENV_KEY]: String(port) },
    windowsHide: false,
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}

async function stopFreshWorkBuddyProcess(
  proc: WorkBuddyProcess,
): Promise<boolean> {
  if (!proc.pid || proc.pid <= 0) return false;
  if (process.platform === "win32") {
    try {
      await execFileAsync(
        "taskkill.exe",
        ["/PID", String(proc.pid), "/T", "/F"],
        { windowsHide: true, timeout: 2_000 },
      );
      return true;
    } catch {
      return false;
    }
  }
  try {
    process.kill(proc.pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

async function waitForWorkBuddyCdp(
  ports: readonly number[],
  timeoutMs: number,
): Promise<DiscoveredWorkBuddyCdp | null> {
  const candidates = [
    ...new Set([...ports, ...DEFAULT_WORKBUDDY_CDP_PORTS]),
  ];
  const deadline = Date.now() + Math.max(1_000, timeoutMs);
  while (Date.now() < deadline) {
    const hit = await discoverWorkBuddyCdp({
      ports: candidates,
      timeoutMs: 400,
    });
    if (hit) return hit;
    await delay(400);
  }
  return null;
}

/**
 * Codex-style ensure: attach if a WorkBuddy CDP is already up; otherwise
 * launch (or restart a blind instance) with WORKBUDDY_REMOTE_DEBUGGING_PORT.
 */
export async function ensureWorkBuddyCdp(
  opts: EnsureWorkBuddyCdpOptions = {},
): Promise<EnsuredWorkBuddyCdp> {
  const preferred = opts.preferredPort ?? DEFAULT_WORKBUDDY_CDP_PORT;
  const launch = opts.launch !== false;
  const launchIfMissing = opts.launchIfMissing !== false;
  const restartIfBlind = opts.restartIfBlind !== false;
  const repairWindowMs =
    opts.repairWindowMs ?? DEFAULT_WORKBUDDY_REPAIR_WINDOW_MS;
  const timeoutMs = opts.timeoutMs ?? 40_000;
  const log = opts.log;

  const existing = await discoverWorkBuddyCdp({
    ports: [preferred, ...DEFAULT_WORKBUDDY_CDP_PORTS],
    timeoutMs: 450,
  });
  if (existing) {
    return { ...existing, launched: false, restarted: false };
  }

  if (!launch) {
    throw new Error(
      `WorkBuddy CDP is missing on loopback (preferred ${preferred}). Start WorkBuddy with ${WORKBUDDY_CDP_ENV_KEY}.`,
    );
  }

  const procs = await listWorkBuddyProcesses();
  const exe =
    findWorkBuddyExecutable() ||
    parseExecutableFromCommand(procs[0]?.commandLine ?? "");
  if (!exe) {
    throw new Error(
      "找不到 WorkBuddy。请先安装，或用带 WORKBUDDY_REMOTE_DEBUGGING_PORT 的方式启动它。",
    );
  }

  let restarted = false;
  if (procs.length > 0) {
    const hasCdp = procs.some((p) => p.port != null);
    if (!hasCdp && restartIfBlind) {
      const repairable = procs.filter(
        (proc) =>
          classifyWorkBuddyStartupProcess(proc, Date.now(), repairWindowMs) ===
          "repair-now",
      );
      if (repairable.length !== 1 || procs.length !== 1) {
        throw new Error(
          "WorkBuddy 已运行超过 10 秒或存在多个主进程；为保护用户会话，不自动重启。",
        );
      }
      const proc = repairable[0]!;
      log?.warn(
        `WorkBuddy 新主进程 ${proc.pid} 没有 CDP，正在执行一次修复性重启…`,
      );
      if (!(await stopFreshWorkBuddyProcess(proc))) {
        throw new Error("WorkBuddy 新主进程已退出，取消本次自动重启。");
      }
      await delay(120);
      restarted = true;
    } else if (hasCdp) {
      const declaredPorts = procs
        .map((proc) => proc.port)
        .filter((port): port is number => port != null);
      const waiting = await waitForWorkBuddyCdp(
        declaredPorts,
        Math.min(timeoutMs, 8_000),
      );
      if (waiting) return { ...waiting, launched: false, restarted: false };
      throw new Error("WorkBuddy 进程带有调试端口，但本机 CDP 尚未就绪。");
    } else if (!restartIfBlind) {
      throw new Error(
        "WorkBuddy 已在运行但未开启 CDP。请退出后用带 WORKBUDDY_REMOTE_DEBUGGING_PORT 的方式启动。",
      );
    }
  } else if (!launchIfMissing) {
    throw new Error("WorkBuddy 未运行；等待用户从原始图标启动。");
  }

  const port = await pickAvailableLoopbackPort(preferred);
  log?.info(`带 ${WORKBUDDY_CDP_ENV_KEY}=${port} 启动 WorkBuddy`);
  await launchWorkBuddyWithCdp(port, exe);
  const ready = await waitForWorkBuddyCdp([port], timeoutMs);
  if (!ready) {
    throw new Error(
      `已启动 WorkBuddy，但 ${timeoutMs}ms 内未出现本机 CDP。请确认官方版本仍读取 ${WORKBUDDY_CDP_ENV_KEY}。`,
    );
  }
  return { ...ready, launched: true, restarted };
}

function parseExecutableFromCommand(commandLine: string): string | null {
  if (!commandLine) return null;
  const quoted = commandLine.match(/^"([^"]+\.(?:exe|app\/Contents\/MacOS\/[^"]+))"/i);
  if (quoted?.[1] && fs.existsSync(quoted[1])) return quoted[1];
  const first = commandLine.split(/\s+/)[0];
  if (first && fs.existsSync(first)) return first;
  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
