import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";
import { promisify } from "node:util";
import { StartupRepairChain } from "@beauticode/core";
import { discoverDesktopCdp, parseRemoteDebuggingFlags } from "./cdp.js";
import { buildWindowsDesktopProcessStartScript, isDesktopMainProcess, launchDesktopWithCdp, listDesktopProcesses, originalDesktopArguments, pickAvailableDesktopPort } from "./launch.js";
import type { DesktopCdpEndpoint, DesktopCdpHostSpec, DesktopEnsureLog, DesktopProcess } from "./types.js";

const execFileAsync = promisify(execFile);

export const DEFAULT_DESKTOP_REPAIR_WINDOW_MS = 10_000;
export const DEFAULT_DESKTOP_CDP_POLL_INTERVAL_MS = 150;

export type DesktopStartupDecision =
  | "repair-now"
  | "repair-suppressed"
  | "repair-failed"
  | "wait-for-cdp"
  | "ignore-stale";

export type DesktopRepairResult = "verified" | "launched" | "failed" | "deferred";

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
  private chain: Promise<unknown> = Promise.resolve();
  private lastVerifiedAt = Number.NEGATIVE_INFINITY;
  private readonly repairChain: StartupRepairChain;

  constructor(
    private readonly repair: (
      processInfo: DesktopProcess,
    ) => Promise<DesktopRepairResult | void>,
    private readonly now: () => number = Date.now,
    private readonly repairWindowMs = DEFAULT_DESKTOP_REPAIR_WINDOW_MS,
    private readonly repairSuppressionMs = 0,
  ) {
    this.repairChain = new StartupRepairChain(now, repairWindowMs);
  }

  observeSnapshot(rows: readonly DesktopProcess[]): void {
    this.repairChain.observeSnapshot(rows);
  }

  markVerified(): void {
    this.repairChain.markVerified();
    this.lastVerifiedAt = this.now();
  }

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
    const run = async () => {
      this.inFlight.add(key);
      this.handled.add(key);
      try {
        if (
          this.repairSuppressionMs > 0 &&
          this.now() - this.lastVerifiedAt < this.repairSuppressionMs
        ) {
          return "repair-suppressed" as const;
        }
        if (!this.repairChain.claim(processInfo)) {
          return "repair-suppressed" as const;
        }
        const result = (await this.repair(processInfo)) ?? "verified";
        if (result !== "verified" && result !== "launched") {
          this.repairChain.markFailed();
          return "repair-failed" as const;
        }
        if (result === "verified") this.markVerified();
        else this.repairChain.markLaunched();
        return "repaired" as const;
      } catch (error) {
        this.repairChain.markFailed();
        throw error;
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
      1,
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
  onVerification?: (endpoint: DesktopCdpEndpoint | null) => void;
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
 * down. It returns after launching the verified executable; CDP verification
 * continues asynchronously so a slow renderer cannot block later start events.
 */
export async function repairDesktopProcess(
  spec: DesktopCdpHostSpec,
  observed: DesktopProcess,
  log?: DesktopEnsureLog,
  injected?: Partial<DesktopRepairOperations>,
): Promise<DesktopRepairResult> {
  const operations = { ...defaultRepairOperations(spec), ...injected };
  const startedAt = operations.now();
  const reportElapsed = (stage: string, result: string) => {
    log?.info(`${spec.displayName} 启动诊断 stage=${stage} elapsedMs=${Math.max(0, operations.now() - startedAt)} result=${result}`);
  };
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
  reportElapsed("fresh-process-validated", "repair-started");
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
        operations.now() - closedAt >= 500 &&
        !forceAttempted.has(currentKey)
      ) {
        await operations.forceTerminate(sameGeneration);
        forceAttempted.add(currentKey);
        reportElapsed("force-terminate", "attempted");
      }
      await operations.sleep(50);
      continue;
    }
    emptySnapshots += 1;
    if (emptySnapshots < 2) {
      await operations.sleep(100);
      continue;
    }
    // No fixed host-specific delay: launch only after two consecutive snapshots
    // confirm the old process tree is gone, then verify CDP without holding the
    // startup-event controller queue.
    await operations.launch(
      executable,
      port,
      originalDesktopArguments(exact.commandLine, executable),
    );
    reportElapsed("client-relaunched", "awaiting-cdp");
    void operations.waitForCdp(spec, [port], 30_000).then(
      (endpoint) => {
        reportElapsed("cdp-verification", endpoint ? "ready" : "timeout");
        operations.onVerification?.(endpoint);
      },
      () => {
        reportElapsed("cdp-verification", "probe-failed");
        operations.onVerification?.(null);
      },
    );
    return "launched";
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
    repairDesktopProcess(spec, row, log, {
      onVerification: (endpoint) => {
        if (endpoint) controller.markVerified();
      },
    }),
    Date.now,
    DEFAULT_DESKTOP_REPAIR_WINDOW_MS,
    spec.repairSuppressionMs ?? 0,
  );

  const tracker = new DesktopStartupSnapshotTracker(async (row) => {
    const result = await controller.observe(row);
    if (result === "repair-suppressed") {
      log?.info(`${spec.displayName} 本次启动已在已验证的 CDP 修复窗口内，跳过重复修复。`);
    } else if (result === "repair-failed") {
      log?.warn(`${spec.displayName} CDP 修复未通过端口和目标页验证；本次进程不再自动重启。`);
    }
  }, { minStableSamples: 1 });
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
        controller.observeSnapshot(rows);
        void tracker.observeSnapshot(rows).catch((error) => {
          log?.warn(`${spec.displayName} 启动修复失败：${String(error)}`);
        });
        return;
      }
    });
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      lines.close();
      if (child === monitor) child = null;
      if (!closed) restartTimer = setTimeout(start, 1_000);
    };
    monitor.once("error", finish);
    monitor.once("exit", finish);
    void listDesktopProcesses(spec).then((rows) => {
      controller.observeSnapshot(rows);
      return tracker.observeSnapshot(rows);
    }).catch((error) => {
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
