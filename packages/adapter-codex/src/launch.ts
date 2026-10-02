import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";
import {
  DEFAULT_CDP_CANDIDATE_PORTS,
  discoverCdpEndpoints,
  parseRemoteDebuggingFlags,
  type DiscoveredCdpEndpoint,
} from "./host-discover.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_CODEX_CDP_PORT = 9335;
export const DEFAULT_CODEX_REPAIR_WINDOW_MS = 10_000;

export interface CodexProcess {
  pid: number;
  name: string;
  executablePath: string;
  commandLine: string;
  port: number | null;
  /** Main-process creation time. Null means it is unsafe to auto-restart. */
  createdAtMs: number | null;
}

export type CodexStartupProcessDecision =
  | "repair-now"
  | "wait-for-cdp"
  | "ignore-stale";

/**
 * Decide from immutable process evidence only. A missing CDP flag can never
 * become available later in the same Chromium main process, so a fresh blind
 * process is repaired immediately instead of waiting for an endpoint timeout.
 */
export function classifyCodexStartupProcess(
  proc: CodexProcess,
  nowMs = Date.now(),
  repairWindowMs = DEFAULT_CODEX_REPAIR_WINDOW_MS,
): CodexStartupProcessDecision {
  if (proc.port != null) return "wait-for-cdp";
  if (proc.createdAtMs == null || !Number.isFinite(proc.createdAtMs)) {
    return "ignore-stale";
  }
  const ageMs = nowMs - proc.createdAtMs;
  return ageMs >= 0 && ageMs < repairWindowMs
    ? "repair-now"
    : "ignore-stale";
}

export interface CodexStartupRepairControllerOptions {
  now?: () => number;
  repairWindowMs?: number;
  repair: (proc: CodexProcess) => Promise<void>;
}

export type CodexStartupRepairResult =
  | "repaired"
  | "already-handled"
  | "wait-for-cdp"
  | "ignore-stale";

/** Serialize and deduplicate process-start events by PID + creation time. */
export class CodexStartupRepairController {
  private readonly seen = new Set<string>();
  private chain: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly repairWindowMs: number;
  private readonly repair: (proc: CodexProcess) => Promise<void>;

  constructor(opts: CodexStartupRepairControllerOptions) {
    this.now = opts.now ?? Date.now;
    this.repairWindowMs =
      opts.repairWindowMs ?? DEFAULT_CODEX_REPAIR_WINDOW_MS;
    this.repair = opts.repair;
  }

  observe(proc: CodexProcess): Promise<CodexStartupRepairResult> {
    const decision = classifyCodexStartupProcess(
      proc,
      this.now(),
      this.repairWindowMs,
    );
    if (decision !== "repair-now") return Promise.resolve(decision);

    const generation = `${proc.pid}:${proc.createdAtMs}`;
    if (this.seen.has(generation)) return Promise.resolve("already-handled");
    this.seen.add(generation);

    const run = async (): Promise<CodexStartupRepairResult> => {
      await this.repair(proc);
      return "repaired";
    };
    const next = this.chain.then(run, run);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

export interface EnsureCodexLog {
  info: (...m: string[]) => void;
  warn: (...m: string[]) => void;
}

export interface EnsureCodexCdpOptions {
  preferredPort?: number;
  /** Bounded fallback ports; override in deterministic tests. */
  candidatePorts?: readonly number[];
  /** Include same-user process flags in discovery. Defaults to true on Windows. */
  scanProcesses?: boolean;
  launch?: boolean;
  restartIfBlind?: boolean;
  timeoutMs?: number;
  log?: EnsureCodexLog;
}

export interface EnsuredCodexCdp extends DiscoveredCdpEndpoint {
  launched: boolean;
  restarted: boolean;
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
  return true;
}

export function codexInstallCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const home = env.HOME || env.USERPROFILE || os.homedir();
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export async function listCodexProcesses(): Promise<CodexProcess[]> {
  return scanWindowsCodexProcesses();
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

/**
 * Choose a loopback port without colliding with WorkBuddy or another Electron
 * host. Both products historically default to 9335, so blindly reusing the
 * preferred port makes Codex auto-injection fail whenever WorkBuddy won the
 * race to bind it.
 */
export async function pickAvailableCodexPort(
  preferred: number = DEFAULT_CODEX_CDP_PORT,
  candidates: readonly number[] = DEFAULT_CDP_CANDIDATE_PORTS,
): Promise<number> {
  const ordered = [preferred, ...candidates.filter((port) => port !== preferred)];
  for (const port of ordered) {
    if (
      Number.isInteger(port) &&
      port >= 1 &&
      port <= 65535 &&
      (await isLoopbackPortFree(port))
    ) {
      return port;
    }
  }
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        address && typeof address === "object"
          ? address.port
          : DEFAULT_CODEX_CDP_PORT;
      server.close(() => resolve(port));
    });
  });
}

export async function stopCodexProcesses(
  procs: readonly CodexProcess[],
): Promise<void> {
  for (const proc of procs) {
    if (!proc.pid || proc.pid <= 0) continue;
    await execFileAsync("taskkill.exe", ["/PID", String(proc.pid), "/T"], {
      windowsHide: true,
      timeout: 8_000,
    }).catch(() => {});
  }
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const still = await listCodexProcesses();
    if (still.length === 0) return;
    await delay(250);
  }
  for (const proc of await listCodexProcesses()) {
    await execFileAsync(
      "taskkill.exe",
      ["/PID", String(proc.pid), "/T", "/F"],
      { windowsHide: true, timeout: 8_000 },
    ).catch(() => {});
  }
}

export interface CodexLaunchCommand {
  file: string;
  args: string[];
}

export function buildCodexLaunchCommand(
  port: number,
  executable: string,
): CodexLaunchCommand {
  return {
    file: executable,
    args: [
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`,
    ],
  };
}

async function launchCodexWithCdp(
  port: number,
  executable: string,
): Promise<void> {
  const command = buildCodexLaunchCommand(port, executable);
  const child = spawn(command.file, command.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}

export interface CodexStartupRepairMonitorOptions {
  preferredPort?: number;
  candidatePorts?: readonly number[];
  repairWindowMs?: number;
  log?: EnsureCodexLog;
}

export interface CodexStartupRepairMonitor {
  close: () => void;
}

/**
 * PowerShell emits one compact JSON record for each new Codex main process.
 * Win32_ProcessStartTrace requires privileges that are unavailable on some
 * desktop installs, so PID discovery uses cheap Get-Process snapshots and only
 * performs a targeted CIM command-line read once per new PID.
 */
export function buildWindowsCodexProcessStartScript(parentPid: number): string {
  const safeParentPid = Math.max(0, Math.trunc(parentPid));
  return [
    "$ErrorActionPreference='SilentlyContinue';",
    "$seen=@{};",
    "while($true){",
    `if(-not (Get-Process -Id ${safeParentPid} -ErrorAction SilentlyContinue)){break};`,
    "$current=@{};",
    "$matches=Get-Process -Name ChatGPT,Codex -ErrorAction SilentlyContinue;",
    "foreach($match in @($matches)){",
    "$pidValue=[int]$match.Id;",
    "$current[$pidValue]=$true;",
    "if($seen.ContainsKey($pidValue)){continue};",
    "$p=Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $pidValue);",
    "if($null -eq $p){continue};",
    "$name=[string]$p.Name;",
    "$cmd=[string]$p.CommandLine;",
    "$path=[string]$p.ExecutablePath;",
    "if(-not $cmd){continue};",
    "if($cmd -match '\\s--type='){continue};",
    "if($cmd -match '\\bapp-server\\b'){continue};",
    "$created=0;",
    "try{$created=([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds()}catch{};",
    "if($created -le 0){$created=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()};",
    "$seen[$pidValue]=$true;",
    "$o=@{pid=$pidValue;name=$name;exe=$path;cmd=$cmd;created=$created};",
    "($o | ConvertTo-Json -Compress -Depth 3);",
    "}",
    "foreach($known in @($seen.Keys)){if(-not $current.ContainsKey($known)){$seen.Remove($known)}};",
    "Start-Sleep -Milliseconds 200;",
    "}",
  ].join(" ");
}

async function repairFreshBlindCodexProcess(
  observed: CodexProcess,
  opts: CodexStartupRepairMonitorOptions,
): Promise<void> {
  const repairWindowMs =
    opts.repairWindowMs ?? DEFAULT_CODEX_REPAIR_WINDOW_MS;
  const live = await listCodexProcesses();
  const exact = live.find((proc) => proc.pid === observed.pid);
  if (!exact) return;
  if (
    classifyCodexStartupProcess(exact, Date.now(), repairWindowMs) !==
    "repair-now"
  ) {
    return;
  }

  // Never recycle a newly spawned secondary instance while an older primary
  // is already serving the user. That path needs an explicit/manual repair.
  if (live.some((proc) => proc.pid !== exact.pid)) {
    opts.log?.warn(
      `检测到 Codex 新进程 ${exact.pid}，但已有主进程；跳过自动重启以保护正在运行的任务。`,
    );
    return;
  }

  const executable =
    parseExecutableFromProcess(exact) ||
    (await findPackagedCodexExecutable()) ||
    findCodexExecutable();
  if (!executable) {
    opts.log?.warn("检测到新的 Codex 进程，但无法确认可执行文件；跳过自动重启。");
    return;
  }

  const preferred = opts.preferredPort ?? DEFAULT_CODEX_CDP_PORT;
  const candidates = opts.candidatePorts ?? DEFAULT_CDP_CANDIDATE_PORTS;
  const port = await pickAvailableCodexPort(preferred, candidates);
  opts.log?.warn(
    `Codex 新主进程 ${exact.pid} 未带 CDP 参数，立即使用 :${port} 修复性重启。`,
  );

  try {
    // Exact fresh PID only: no /T and no name-wide kill. At <10s there is no
    // established user task to preserve, and /F avoids the old 8s stop delay.
    await execFileAsync("taskkill.exe", ["/PID", String(exact.pid), "/F"], {
      windowsHide: true,
      timeout: 2_000,
    });
  } catch {
    return;
  }
  await delay(120);
  await launchCodexWithCdp(port, executable);
  opts.log?.info(`已立即带 --remote-debugging-port=${port} 重启 Codex`);
}

/**
 * Event-driven fast lane for the original Windows icon. It does not wait for
 * CDP when the newly created main process has no debugging flag at all.
 */
export function startCodexStartupRepairMonitor(
  opts: CodexStartupRepairMonitorOptions = {},
): CodexStartupRepairMonitor {
  if (process.platform !== "win32") return { close: () => {} };

  let closed = false;
  let child: ChildProcess | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  const controllerOptions: CodexStartupRepairControllerOptions = {
    repair: (proc) => repairFreshBlindCodexProcess(proc, opts),
  };
  if (opts.repairWindowMs !== undefined) {
    controllerOptions.repairWindowMs = opts.repairWindowMs;
  }
  const controller = new CodexStartupRepairController(controllerOptions);

  const observe = (proc: CodexProcess) => {
    void controller.observe(proc).catch((error) => {
      opts.log?.warn(
        `Codex 启动快速修复失败：${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };

  const reconcile = () => {
    void listCodexProcesses().then(
      (processes) => processes.forEach(observe),
      () => undefined,
    );
  };

  const startChild = () => {
    if (closed) return;
    const script = buildWindowsCodexProcessStartScript(process.pid);
    const monitor = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    child = monitor;
    let stderr = "";
    monitor.stderr?.on("data", (chunk) => {
      if (stderr.length < 2_000) stderr += String(chunk);
    });
    const lines = readline.createInterface({ input: monitor.stdout! });
    lines.on("line", (line) => {
      let row: {
        pid?: unknown;
        name?: unknown;
        exe?: unknown;
        cmd?: unknown;
        created?: unknown;
      };
      try {
        row = JSON.parse(line) as typeof row;
      } catch {
        return;
      }
      const commandLine = typeof row.cmd === "string" ? row.cmd : "";
      const name = typeof row.name === "string" ? row.name : "ChatGPT.exe";
      const executablePath = typeof row.exe === "string" ? row.exe : "";
      if (!looksLikeCodexMain(commandLine, name, executablePath)) return;
      const flags = parseRemoteDebuggingFlags(commandLine);
      observe({
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
    });
    let finished = false;
    const finish = (code: number | null, spawnError?: Error) => {
      if (finished) return;
      finished = true;
      lines.close();
      if (child === monitor) child = null;
      if (!closed) {
        const detail = (spawnError?.message || stderr)
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 500);
        opts.log?.warn(
          `Codex 进程启动监听器退出（${code ?? "unknown"}）${detail ? `：${detail}` : ""}，1 秒后恢复。`,
        );
        restartTimer = setTimeout(startChild, 1_000);
      }
    };
    monitor.once("error", (error) => finish(null, error));
    monitor.once("exit", (code) => finish(code));
    reconcile();
  };

  startChild();

  return {
    close: () => {
      closed = true;
      if (restartTimer) clearTimeout(restartTimer);
      restartTimer = null;
      child?.kill();
      child = null;
    },
  };
}

async function waitForCodexCdp(
  port: number,
  timeoutMs: number,
): Promise<DiscoveredCdpEndpoint | null> {
  return await waitForAnyCodexCdp([port], timeoutMs);
}

async function waitForAnyCodexCdp(
  ports: readonly number[],
  timeoutMs: number,
): Promise<DiscoveredCdpEndpoint | null> {
  const deadline = Date.now() + Math.max(1_000, timeoutMs);
  while (Date.now() < deadline) {
    const hits = await discoverCdpEndpoints({
      ports: [...new Set(ports)],
      scanProcesses: false,
      requirePages: true,
      timeoutMs: 400,
    });
    const hit = hits[0];
    if (hit) return hit;
    await delay(400);
  }
  return null;
}

function parseExecutableFromProcess(proc: CodexProcess | undefined): string | null {
  if (!proc) return null;
  if (proc.executablePath && fs.existsSync(proc.executablePath)) {
    return proc.executablePath;
  }
  const quoted = proc.commandLine.match(/^"([^"]+\.exe)"/i);
  if (quoted?.[1] && fs.existsSync(quoted[1])) return quoted[1];
  return null;
}

let ensureChain: Promise<unknown> = Promise.resolve();

async function ensureCodexCdpUnqueued(
  opts: EnsureCodexCdpOptions,
): Promise<EnsuredCodexCdp> {
  const preferred = opts.preferredPort ?? DEFAULT_CODEX_CDP_PORT;
  const candidatePorts = opts.candidatePorts ?? DEFAULT_CDP_CANDIDATE_PORTS;
  const launch = opts.launch !== false;
  const restartIfBlind = opts.restartIfBlind !== false;
  const timeoutMs = opts.timeoutMs ?? 40_000;
  const log = opts.log;

  const existing = (
    await discoverCdpEndpoints({
      ports: [preferred, ...candidatePorts],
      scanProcesses: opts.scanProcesses ?? process.platform === "win32",
      requirePages: true,
      timeoutMs: 450,
    })
  )[0];
  if (existing) {
    return { ...existing, launched: false, restarted: false };
  }

  if (!launch) {
    throw new Error(
      `Codex CDP is missing on loopback (preferred ${preferred}). Start Codex with --remote-debugging-port.`,
    );
  }

  const procs = await listCodexProcesses();
  const exe =
    parseExecutableFromProcess(procs[0]) ||
    (await findPackagedCodexExecutable()) ||
    findCodexExecutable();
  if (!exe) {
    throw new Error(
      "找不到 Codex/ChatGPT Desktop。请先安装，或用带 --remote-debugging-port=9335 的方式启动它。",
    );
  }

  let restarted = false;
  if (procs.length > 0) {
    const hasCdp = procs.some((p) => p.port != null);
    if (!hasCdp && restartIfBlind) {
      const repairable = procs.filter(
        (proc) =>
          classifyCodexStartupProcess(proc, Date.now()) === "repair-now",
      );
      if (repairable.length !== 1 || procs.length !== 1) {
        throw new Error(
          "Codex 已运行超过 10 秒或存在多个主进程；为保护正在运行的任务，不自动重启。请手动退出后重开。",
        );
      }
      const proc = repairable[0]!;
      log?.warn(
        `Codex 新主进程 ${proc.pid} 未带 CDP 参数，立即修复性重启…`,
      );
      try {
        await execFileAsync("taskkill.exe", ["/PID", String(proc.pid), "/F"], {
          windowsHide: true,
          timeout: 2_000,
        });
      } catch {
        throw new Error("Codex 新主进程已退出，取消本次自动重启。");
      }
      await delay(120);
      restarted = true;
    } else if (hasCdp) {
      const declaredPorts = procs
        .map((proc) => proc.port)
        .filter((port): port is number => port != null);
      const waiting = await waitForAnyCodexCdp(
        declaredPorts,
        Math.min(timeoutMs, 15_000),
      );
      if (waiting) return { ...waiting, launched: false, restarted: false };
      throw new Error(
        "Codex 已带调试端口，但 CDP 尚未就绪；已停止自动重启以避免启动循环。",
      );
    } else if (!restartIfBlind) {
      throw new Error(
        "Codex 已在运行但未开启 CDP。请退出后用带 --remote-debugging-address=127.0.0.1 --remote-debugging-port=9335 的方式启动。",
      );
    }
  }

  const port = await pickAvailableCodexPort(preferred, candidatePorts);
  if (port !== preferred) {
    log?.warn(`本机端口 ${preferred} 已被占用，Codex 改用 ${port}`);
  }
  log?.info(`带 --remote-debugging-port=${port} 启动 Codex`);
  await launchCodexWithCdp(port, exe);
  const ready = await waitForCodexCdp(port, timeoutMs);
  if (!ready) {
    throw new Error(
      `已直接启动 Codex，但 ${timeoutMs}ms 内未出现带 app:// 主页面的本机 CDP。`,
    );
  }
  return { ...ready, launched: true, restarted };
}

/**
 * WorkBuddy-style ensure: attach if a Codex CDP is already up; otherwise
 * launch (or restart a blind instance) with loopback debugging flags.
 */
export function ensureCodexCdp(
  opts: EnsureCodexCdpOptions = {},
): Promise<EnsuredCodexCdp> {
  const run = () => ensureCodexCdpUnqueued(opts);
  const next = ensureChain.then(run, run);
  ensureChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}
