import fs from "node:fs";
import { StartupRepairChain, signalLinuxProcess } from "@beauticode/core";
import { discoverDesktopCdp } from "./cdp.js";
import { launchDesktopWithCdp, listDesktopProcesses, originalDesktopArguments, pickAvailableDesktopPort } from "./launch.js";
import type { DesktopCdpEndpoint, DesktopCdpHostSpec, DesktopEnsureLog, DesktopProcess } from "./types.js";
import { stopWindowsDesktopProcess } from "./windows-process-stop.js";

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
  log?: DesktopEnsureLog,
): DesktopRepairOperations {
  // Linux: SIGTERM is Electron's graceful quit; SIGKILL is the force path.
  // Both re-check the creation time so a recycled PID is never signalled.
  const signalForProcess = async (
    processInfo: DesktopProcess,
    action: "close" | "force",
  ): Promise<boolean> =>
    processInfo.createdAtMs != null &&
    signalLinuxProcess(
      Math.trunc(processInfo.pid),
      action === "close" ? "SIGTERM" : "SIGKILL",
      processInfo.createdAtMs,
    );
  const stop = process.platform === "linux"
    ? signalForProcess
    : (processInfo: DesktopProcess, action: "close" | "force") => stopWindowsDesktopProcess(processInfo, action, spec, log);
  return {
    listProcesses: () => listDesktopProcesses(spec),
    terminate: (processInfo) => stop(processInfo, "close"),
    forceTerminate: (processInfo) => stop(processInfo, "force"),
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
  const operations = { ...defaultRepairOperations(spec, log), ...injected };
  const startedAt = operations.now();
  const reportElapsed = (stage: string, result: string) => {
    log?.info(`${spec.displayName} 启动诊断 stage=${stage} elapsedMs=${Math.max(0, operations.now() - startedAt)} result=${result}`);
  };
  const live = await operations.listProcesses();
  const exact = live.find((row) => row.pid === observed.pid);
  if (!exact || processIdentity(exact) !== processIdentity(observed)) {
    return "deferred";
  }
  if (classifyDesktopStartupProcess(exact, operations.now(), spec.repairWindowMs) !== "repair-now") {
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
  const deadline = operations.now() + (spec.repairTransactionTimeoutMs ?? 10_000);
  let emptySnapshots = 0;
  while (operations.now() < deadline) {
    const currentKey = processIdentity(current);
    if (!killed.has(currentKey)) {
      const closed = await operations.terminate(current);
      reportElapsed("graceful-close", closed ? "sent" : "failed");
      killed.add(currentKey);
      gracefulAt.set(currentKey, operations.now());
    }
    const rows = await operations.listProcesses();
    if (operations.now() >= deadline) {
      reportElapsed("teardown", "timeout");
      return "failed";
    }
    const replacement = rows.find(
      (row) => row.port == null && !killed.has(processIdentity(row)),
    );
    if (replacement) {
      // Doubao Work replaces itself and drops the debug port. Closing that
      // second process is the window the user just saw disappear.
      if (spec.chaseReplacements === false) {
        reportElapsed("replacement-kept", "deferred");
        return "deferred";
      }
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
        const stopped = await operations.forceTerminate(sameGeneration);
        forceAttempted.add(currentKey);
        reportElapsed("force-terminate", stopped ? "sent" : "failed");
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
