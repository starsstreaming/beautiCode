import type { CodexProcess } from "./processes.js";

export const DEFAULT_CODEX_REPAIR_WINDOW_MS = 10_000;

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
