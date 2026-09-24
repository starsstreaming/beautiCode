import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";
import {
  discoverDesktopCdp,
  parseRemoteDebuggingFlags,
  probeDesktopCdp,
} from "./cdp.js";
import type {
  DesktopCdpEndpoint,
  DesktopCdpHostSpec,
  DesktopEnsureLog,
  DesktopProcess,
} from "./types.js";

const execFileAsync = promisify(execFile);
export const DEFAULT_DESKTOP_REPAIR_WINDOW_MS = 10_000;
export const DEFAULT_DESKTOP_CDP_POLL_INTERVAL_MS = 150;

export type DesktopStartupDecision =
  | "repair-now"
  | "repair-suppressed"
  | "repair-failed"
  | "repair-backoff"
  | "repair-exhausted"
  | "wait-for-cdp"
  | "ignore-stale";

export type DesktopRepairResult = "verified" | "failed" | "deferred";

export function classifyDesktopStartupProcess(
  processInfo: DesktopProcess,
  nowMs = Date.now(),
  repairWindowMs = DEFAULT_DESKTOP_REPAIR_WINDOW_MS,
): DesktopStartupDecision {
  if (processInfo.port != null) return "wait-for-cdp";
  if (
    processInfo.createdAtMs == null ||
    !Number.isFinite(processInfo.createdAtMs)
  ) {
    return "ignore-stale";
  }
  const ageMs = nowMs - processInfo.createdAtMs;
  return ageMs >= 0 && ageMs < repairWindowMs
    ? "repair-now"
    : "ignore-stale";
}

export class DesktopStartupRepairController {
  private readonly handled = new Set<string>();
  private readonly inFlight = new Set<string>();
  private readonly retryAfter = new Map<string, number>();
  private readonly attempts = new Map<string, number>();
  private chain: Promise<unknown> = Promise.resolve();
  private lastVerifiedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly repair: (
      processInfo: DesktopProcess,
    ) => Promise<DesktopRepairResult | void>,
    private readonly now: () => number = Date.now,
    private readonly repairWindowMs = DEFAULT_DESKTOP_REPAIR_WINDOW_MS,
    private readonly repairSuppressionMs = 0,
    private readonly retryBackoffMs = 1_500,
  ) {}

  observe(processInfo: DesktopProcess): Promise<DesktopStartupDecision | "repaired" | "already-handled"> {
    const decision = classifyDesktopStartupProcess(
      processInfo,
      this.now(),
      this.repairWindowMs,
    );
    if (decision !== "repair-now") return Promise.resolve(decision);
    const key = `${processInfo.pid}:${processInfo.createdAtMs}`;
    if (this.handled.has(key) || this.inFlight.has(key)) {
      return Promise.resolve("already-handled");
    }
    const retryAt = this.retryAfter.get(key) ?? Number.NEGATIVE_INFINITY;
    if (this.now() < retryAt) return Promise.resolve("repair-backoff");
    if ((this.attempts.get(key) ?? 0) >= 2) {
      this.handled.add(key);
      return Promise.resolve("repair-exhausted");
    }
    const run = async () => {
      this.inFlight.add(key);
      try {
        if (
          this.repairSuppressionMs > 0 &&
          this.now() - this.lastVerifiedAt < this.repairSuppressionMs
        ) {
          this.handled.add(key);
          return "repair-suppressed" as const;
        }
        this.attempts.set(key, (this.attempts.get(key) ?? 0) + 1);
        const result = (await this.repair(processInfo)) ?? "verified";
        if (result !== "verified") {
          this.retryAfter.set(key, this.now() + this.retryBackoffMs);
          return "repair-failed" as const;
        }
        this.handled.add(key);
        this.retryAfter.delete(key);
        this.lastVerifiedAt = this.now();
        return "repaired" as const;
      } finally {
        this.inFlight.delete(key);
      }
    };
    const next = this.chain.then(run, run);
    this.chain = next.then(() => undefined, () => undefined);
    return next;
  }
}

/**
 * Deduplicates the same process when both a host event and the persistent
 * snapshot monitor report it. A PID is allowed to re-enter after it
 * disappears, while a PID + creation-time pair is only forwarded once.
 */
export class DesktopStartupSnapshotTracker {
  private readonly seen = new Set<string>();
  private readonly pending = new Map<
    string,
    { row: DesktopProcess; samples: number; firstSeenAt: number }
  >();
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly forward: (
      processInfo: DesktopProcess,
    ) => Promise<unknown> | unknown,
    private readonly options: {
      minStableSamples?: number;
      stabilityMs?: number;
      now?: () => number;
    } = {},
  ) {}

  observeSnapshot(rows: readonly DesktopProcess[]): Promise<void> {
    const next = this.chain.then(
      () => this.applySnapshot(rows),
      () => this.applySnapshot(rows),
    );
    this.chain = next.then(() => undefined, () => undefined);
    return next;
  }

  private async applySnapshot(rows: readonly DesktopProcess[]): Promise<void> {
    const now = this.options.now?.() ?? Date.now();
    const minStableSamples = Math.max(
      2,
      Math.trunc(this.options.minStableSamples ?? 2),
    );
    const stabilityMs = Math.max(0, this.options.stabilityMs ?? 0);
    const current = new Set<string>();
    for (const row of rows) {
      const pid = Number(row.pid);
      if (!Number.isInteger(pid) || pid < 1) continue;
      const key = `${pid}:${row.createdAtMs ?? "unknown"}`;
      current.add(key);
      if (this.seen.has(key)) continue;
      const existing = this.pending.get(key);
      const pending = existing ?? { row, samples: 0, firstSeenAt: now };
      pending.row = row;
      pending.samples += 1;
      this.pending.set(key, pending);
      if (
        pending.samples < minStableSamples ||
        now - pending.firstSeenAt < stabilityMs
      ) continue;
      const result = await this.forward(pending.row);
      if (
        result === "repair-failed" ||
        result === "repair-backoff" ||
        result === "repair-deferred"
      ) continue;
      this.seen.add(key);
      this.pending.delete(key);
    }
    for (const key of this.pending.keys()) {
      if (!current.has(key)) this.pending.delete(key);
    }
  }
}

function normalizedWinPath(value: string): string {
  try {
    return path.win32.normalize(value).toLowerCase();
  } catch {
    return String(value).toLowerCase();
  }
}

export function isDesktopMainProcess(
  spec: DesktopCdpHostSpec,
  commandLine: string,
  name: string,
  executablePath: string,
  platform = process.platform,
): boolean {
  if (platform !== "win32") return false;
  if (name.toLowerCase() !== spec.processName.toLowerCase()) return false;
  if (/(?:^|\s)--type(?:=|\s)/.test(commandLine)) return false;
  const actual = normalizedWinPath(executablePath);
  return spec.executableCandidates.some(
    (candidate) => normalizedWinPath(candidate) === actual,
  );
}

export async function listDesktopProcesses(
  spec: DesktopCdpHostSpec,
): Promise<DesktopProcess[]> {
  if (process.platform !== "win32") return [];
  const escapedName = spec.processName.replace(/'/g, "''");
  const script = [
    "$ErrorActionPreference='SilentlyContinue';",
    `Get-CimInstance Win32_Process -Filter \"Name='${escapedName}'\" | ForEach-Object {`,
    "$cmd=[string]$_.CommandLine;",
    "$exe=[string]$_.ExecutablePath;",
    "if(-not $cmd -or $cmd -match '(?:^|\\s)--type(?:=|\\s)'){return};",
    "$created=0;",
    "try{$created=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}catch{};",
    "$o=@{pid=$_.ProcessId;name=$_.Name;exe=$exe;cmd=$cmd;created=$created};",
    "($o | ConvertTo-Json -Compress -Depth 3)",
    "}",
  ].join(" ");
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: 10_000, maxBuffer: 2 * 1024 * 1024 },
    );
    const rows: DesktopProcess[] = [];
    for (const line of String(stdout ?? "").split(/\r?\n/)) {
      if (!line.trim().startsWith("{")) continue;
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const commandLine = typeof raw.cmd === "string" ? raw.cmd : "";
      const name = typeof raw.name === "string" ? raw.name : "";
      const executablePath = typeof raw.exe === "string" ? raw.exe : "";
      if (!isDesktopMainProcess(spec, commandLine, name, executablePath)) continue;
      const flags = parseRemoteDebuggingFlags(commandLine);
      rows.push({
        pid: Number(raw.pid) || 0,
        name,
        executablePath,
        commandLine,
        port: flags.safe ? flags.port : null,
        createdAtMs:
          Number.isFinite(Number(raw.created)) && Number(raw.created) > 0
            ? Number(raw.created)
            : null,
      });
    }
    return rows;
  } catch {
    return [];
  }
}

export function findDesktopExecutable(spec: DesktopCdpHostSpec): string | null {
  for (const candidate of spec.executableCandidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Continue to the next measured install location.
    }
  }
  return null;
}

export async function isLoopbackPortFree(port: number): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

export async function pickAvailableDesktopPort(
  spec: DesktopCdpHostSpec,
): Promise<number> {
  for (const port of [spec.defaultPort, ...spec.candidatePorts]) {
    const own = await probeDesktopCdp(spec, port, 250);
    if (own || (await isLoopbackPortFree(port))) return port;
  }
  throw new Error(`${spec.displayName} 的受限 CDP 端口均被占用。`);
}

export function buildDesktopLaunchCommand(
  executable: string,
  port: number,
  originalArguments = "",
): { file: string; args: string[] } {
  // Preserve only flag-shaped arguments. The source is a live process command
  // line, not trusted shell input; never copy separators or free-form tokens
  // into PowerShell's ArgumentList.
  const preserved = (String(originalArguments).match(
    /--[A-Za-z0-9][A-Za-z0-9_.-]*(?:=(?:"[^"]*"|'[^']*'|[^\s;&|<>]+))?/g,
  ) ?? []).join(" ");
  return {
    file: executable,
    args: [
      ...(preserved ? [preserved] : []),
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${port}`,
    ],
  };
}

function originalDesktopArguments(
  commandLine: string,
  executable: string,
): string {
  const raw = String(commandLine).trim();
  if (!raw) return "";
  let remainder = "";
  if (raw.startsWith('"')) {
    const end = raw.indexOf('"', 1);
    remainder = end >= 0 ? raw.slice(end + 1) : "";
  } else if (raw.toLowerCase().startsWith(executable.toLowerCase())) {
    remainder = raw.slice(executable.length);
  }
  return remainder
    .replace(
      /--remote-debugging-address(?:=|\s+)(?:"[^"]*"|'[^']*'|[^\s"']+)/gi,
      "",
    )
    .replace(
      /--remote-debugging-port(?:=|\s+)(?:"[^\"]*"|'[^']*'|[^\s"']+)/gi,
      "",
    )
    .trim();
}

export async function launchDesktopWithCdp(
  executable: string,
  port: number,
  originalArguments = "",
): Promise<void> {
  const command = buildDesktopLaunchCommand(executable, port, originalArguments);
  if (process.platform === "win32") {
    const psLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`;
    const script = [
      "$ErrorActionPreference='Stop';",
      `Start-Process -FilePath ${psLiteral(command.file)} `,
      `-WorkingDirectory ${psLiteral(path.win32.dirname(command.file))} `,
      `-ArgumentList @(${command.args.map(psLiteral).join(",")}) | Out-Null;`,
    ].join("");
    await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { windowsHide: true, timeout: 10_000 },
    );
    return;
  }
  const child = spawn(command.file, command.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}

export function buildWindowsDesktopProcessStartScript(
  spec: DesktopCdpHostSpec,
  parentPid: number,
): string {
  const processBase = path.win32.basename(spec.processName, ".exe").replace(/'/g, "''");
  return [
    "$ErrorActionPreference='SilentlyContinue';",
    "while($true){",
    `if(-not (Get-Process -Id ${Math.max(0, Math.trunc(parentPid))} -ErrorAction SilentlyContinue)){break};`,
    "$rows=@();",
    `$matches=Get-CimInstance Win32_Process -Filter \"Name='${processBase}.exe'\" -ErrorAction SilentlyContinue;`,
    "foreach($p in @($matches)){",
    "$pidValue=[int]$p.ProcessId;",
    "if($null -eq $p){continue};",
    "$cmd=[string]$p.CommandLine;",
    "if(-not $cmd -or $cmd -match '(?:^|\\s)--type(?:=|\\s)'){continue};",
    "$exe=[string]$p.ExecutablePath;",
    "if(-not $exe){continue};",
    "$created=0;",
    "try{$created=([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds()}catch{};",
    "if($created -le 0){continue};",
    "$o=@{pid=$pidValue;name=[string]$p.Name;exe=$exe;cmd=$cmd;created=$created};",
    "$rows += $o;",
    "}",
    "([pscustomobject]@{snapshot=$true;rows=$rows} | ConvertTo-Json -Compress -Depth 4);",
    "Start-Sleep -Milliseconds 500;",
    "}",
  ].join(" ");
}

export interface DesktopRepairMonitor {
  close(): void;
}

export interface DesktopRepairOperations {
  listProcesses: () => Promise<DesktopProcess[]>;
  terminate: (processInfo: DesktopProcess) => Promise<boolean>;
  forceTerminate: (processInfo: DesktopProcess) => Promise<boolean>;
  pickPort: () => Promise<number>;
  launch: (
    executable: string,
    port: number,
    originalArguments?: string,
  ) => Promise<void>;
  waitForCdp: (
    spec: DesktopCdpHostSpec,
    ports: readonly number[],
    timeoutMs: number,
  ) => Promise<DesktopCdpEndpoint | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  exists: (file: string) => boolean;
}

function processIdentity(processInfo: DesktopProcess): string {
  return `${processInfo.pid}:${processInfo.createdAtMs ?? "unknown"}`;
}

function defaultRepairOperations(
  spec: DesktopCdpHostSpec,
): DesktopRepairOperations {
  const runPowerShellForProcess = async (
    processInfo: DesktopProcess,
    action: "close" | "force",
  ): Promise<boolean> => {
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
      await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        { windowsHide: true, timeout: action === "close" ? 2_000 : 3_000 },
      );
      return true;
    } catch {
      return false;
    }
  };
  return {
    listProcesses: () => listDesktopProcesses(spec),
    terminate: (processInfo) => runPowerShellForProcess(processInfo, "close"),
    forceTerminate: (processInfo) => runPowerShellForProcess(processInfo, "force"),
    pickPort: () => pickAvailableDesktopPort(spec),
    launch: (executable, port, originalArguments) =>
      launchDesktopWithCdp(executable, port, originalArguments),
    waitForCdp: (hostSpec, ports, timeoutMs) =>
      waitForDesktopCdp(hostSpec, ports, timeoutMs),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    exists: (file) => fs.existsSync(file),
  };
}

/**
 * Repair one stable host process as a transaction. The transaction owns all
 * fresh no-CDP generations that appear while the old process is being torn
 * down, and only succeeds after the exact host target is reachable over CDP.
 */
export async function repairDesktopProcess(
  spec: DesktopCdpHostSpec,
  observed: DesktopProcess,
  log?: DesktopEnsureLog,
  injected?: Partial<DesktopRepairOperations>,
): Promise<DesktopRepairResult> {
  const operations = { ...defaultRepairOperations(spec), ...injected };
  const live = await operations.listProcesses();
  const exact = live.find((row) => row.pid === observed.pid);
  if (!exact || processIdentity(exact) !== processIdentity(observed)) {
    return "deferred";
  }
  if (classifyDesktopStartupProcess(exact, operations.now()) !== "repair-now") {
    return "deferred";
  }
  if (live.some((row) => processIdentity(row) !== processIdentity(exact))) {
    log?.warn(`${spec.displayName} 已有主进程，跳过自动重启。`);
    return "deferred";
  }
  const executable = exact.executablePath;
  if (!operations.exists(executable)) return "failed";
  const port = await operations.pickPort();
  log?.warn(
    `${spec.displayName} 新主进程 ${exact.pid} 未带 CDP，立即使用 :${port} 修复性重启。`,
  );
  const killed = new Set<string>();
  const gracefulAt = new Map<string, number>();
  const forceAttempted = new Set<string>();
  let current = exact;
  const deadline = operations.now() + 10_000;
  let emptySnapshots = 0;
  while (operations.now() < deadline) {
    const currentKey = processIdentity(current);
    if (!killed.has(currentKey)) {
      await operations.terminate(current);
      killed.add(currentKey);
      gracefulAt.set(currentKey, operations.now());
    }
    const rows = await operations.listProcesses();
    const replacement = rows.find(
      (row) => row.port == null && !killed.has(processIdentity(row)),
    );
    if (replacement) {
      current = replacement;
      emptySnapshots = 0;
      continue;
    }
    if (rows.length > 0) {
      emptySnapshots = 0;
      const sameGeneration = rows.find(
        (row) => processIdentity(row) === currentKey,
      );
      const closedAt = gracefulAt.get(currentKey);
      if (
        sameGeneration &&
        closedAt != null &&
        operations.now() - closedAt >= 2_000 &&
        !forceAttempted.has(currentKey)
      ) {
        await operations.forceTerminate(sameGeneration);
        forceAttempted.add(currentKey);
      }
      await operations.sleep(50);
      continue;
    }
    emptySnapshots += 1;
    if (emptySnapshots < 2) {
      await operations.sleep(100);
      continue;
    }
    // No fixed host-specific delay: launch only after the old process tree is
    // actually gone for two consecutive snapshots, then verify the exact host
    // target before success.
    await operations.launch(
      executable,
      port,
      originalDesktopArguments(exact.commandLine, executable),
    );
    const endpoint = await operations.waitForCdp(spec, [port], 30_000);
    return endpoint ? "verified" : "failed";
  }
  return "failed";
}

export function startDesktopStartupRepairMonitor(
  spec: DesktopCdpHostSpec,
  log?: DesktopEnsureLog,
): DesktopRepairMonitor {
  if (process.platform !== "win32") return { close() {} };
  let closed = false;
  let child: ChildProcess | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  const controller = new DesktopStartupRepairController((row) =>
    repairDesktopProcess(spec, row, log),
    Date.now,
    DEFAULT_DESKTOP_REPAIR_WINDOW_MS,
    spec.repairSuppressionMs ?? 0,
  );

  const tracker = new DesktopStartupSnapshotTracker(async (row) => {
    const result = await controller.observe(row);
    if (result === "repair-suppressed") {
      log?.info(`${spec.displayName} 本次启动已在已验证的 CDP 修复窗口内，跳过重复修复。`);
    } else if (result === "repair-failed") {
      log?.warn(`${spec.displayName} CDP 修复未通过端口和目标页验证；仅短退避后重试。`);
    }
  });
  const start = () => {
    if (closed) return;
    const monitor = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        buildWindowsDesktopProcessStartScript(spec, process.pid),
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    child = monitor;
    // 监视器稳定存活 30s 后重置退避计数，正常偶发退出不受长期惩罚
    setTimeout(() => {
      if (!finished) restartAttempt = 0;
    }, 30_000).unref();
    const lines = readline.createInterface({ input: monitor.stdout! });
    lines.on("line", (line) => {
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (raw.snapshot === true && Array.isArray(raw.rows)) {
        const rows = raw.rows.flatMap((value) => {
          if (!value || typeof value !== "object") return [];
          const row = value as Record<string, unknown>;
          const commandLine = typeof row.cmd === "string" ? row.cmd : "";
          const name = typeof row.name === "string" ? row.name : "";
          const executablePath = typeof row.exe === "string" ? row.exe : "";
          if (!isDesktopMainProcess(spec, commandLine, name, executablePath)) return [];
          const flags = parseRemoteDebuggingFlags(commandLine);
          return [{
            pid: Number(row.pid) || 0,
            name,
            executablePath,
            commandLine,
            port: flags.safe ? flags.port : null,
            createdAtMs: Number(row.created) || null,
          } satisfies DesktopProcess];
        });
        void tracker.observeSnapshot(rows).catch((error) => {
          log?.warn(`${spec.displayName} 启动修复失败：${String(error)}`);
        });
        return;
      }
    });
    let finished = false;
    let restartAttempt = 0;
    const finish = () => {
      if (finished) return;
      finished = true;
      lines.close();
      if (child === monitor) child = null;
      if (!closed) {
        // 指数退避（1s → 2s → 4s…上限 60s）：PowerShell 被安全策略拦截
        // 或脚本持续崩溃时，1s 固定重启会无限刷日志并持续占用 CPU。
        const delay = Math.min(1_000 * 2 ** restartAttempt, 60_000);
        restartAttempt += 1;
        if (restartAttempt === 5) {
          log?.warn(
            `${spec.displayName} 启动修复监视器连续退出，已进入指数退避；若持续失败请检查 PowerShell 是否被安全策略拦截。`,
          );
        }
        restartTimer = setTimeout(start, delay);
      }
    };
    monitor.once("error", finish);
    monitor.once("exit", finish);
    void listDesktopProcesses(spec).then((rows) => tracker.observeSnapshot(rows)).catch((error) => {
      log?.warn(`${spec.displayName} 快照扫描失败：${String(error)}`);
    });
  };
  start();
  return {
    close() {
      closed = true;
      if (restartTimer) clearTimeout(restartTimer);
      child?.kill();
      child = null;
    },
  };
}

export async function waitForDesktopCdp(
  spec: DesktopCdpHostSpec,
  ports: readonly number[],
  timeoutMs: number,
  options: {
    discover?: typeof discoverDesktopCdp;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<DesktopCdpEndpoint | null> {
  const discover = options.discover ?? discoverDesktopCdp;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + Math.max(1_000, timeoutMs);
  while (now() < deadline) {
    const found = await discover(spec, ports);
    if (found) return found;
    await sleep(DEFAULT_DESKTOP_CDP_POLL_INTERVAL_MS);
  }
  return null;
}

/**
 * Attach or repair only a fresh, already-started host. A missing process is
 * never launched: that invariant is what makes an intentional user close stay
 * closed while the guardian remains alive.
 */
export async function ensureDesktopCdp(
  spec: DesktopCdpHostSpec,
  opts: { timeoutMs?: number; log?: DesktopEnsureLog } = {},
): Promise<DesktopCdpEndpoint> {
  const ports = [spec.defaultPort, ...spec.candidatePorts];
  const existing = await discoverDesktopCdp(spec, ports);
  if (existing) return existing;
  const processes = await listDesktopProcesses(spec);
  if (processes.length === 0) {
    throw new Error(`${spec.displayName} 未运行；等待用户从原始图标启动。`);
  }
  const declared = processes
    .map((row) => row.port)
    .filter((port): port is number => port != null);
  if (declared.length > 0) {
    const ready = await waitForDesktopCdp(
      spec,
      declared,
      Math.min(opts.timeoutMs ?? 15_000, 15_000),
    );
    if (ready) return ready;
    throw new Error(`${spec.displayName} 已带 CDP 参数，但目标页尚未就绪。`);
  }
  const repairable = processes.filter(
    (row) => classifyDesktopStartupProcess(row) === "repair-now",
  );
  if (processes.length !== 1 || repairable.length !== 1) {
    throw new Error(`${spec.displayName} 已运行超过 10 秒；为保护用户会话，不自动重启。`);
  }
  const repaired = await repairDesktopProcess(spec, repairable[0]!, opts.log);
  if (repaired !== "verified") {
    throw new Error(`${spec.displayName} 修复事务未通过 CDP 验证。`);
  }
  const ready = await waitForDesktopCdp(spec, ports, opts.timeoutMs ?? 30_000);
  if (!ready) throw new Error(`${spec.displayName} 修复性重启后 CDP 未就绪。`);
  return ready;
}
