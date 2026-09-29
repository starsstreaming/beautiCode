/**
 * One repair budget for one observed client-launch chain. The host adapter
 * validates executable identity and process count before calling claim().
 * A child of our controlled relaunch is never repaired again, even if the
 * upstream launcher drops its CDP flags. Only verified CDP or a subsequent
 * observed user close releases that budget. A launch that produced no process
 * expires after a bounded settling window.
 */
export class StartupRepairChain {
  private readonly handled = new Map<string, number>();
  private active: {
    original: string;
    startedAt: number;
    launched: boolean;
    replacementSeen: boolean;
  } | null = null;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly freshWindowMs = 10_000,
    private readonly launchSettleMs = 30_000,
  ) {}

  claim(processInfo: { pid: number; createdAtMs: number | null }): boolean {
    const now = this.now();
    const created = processInfo.createdAtMs;
    if (
      !Number.isInteger(processInfo.pid) || processInfo.pid < 1 ||
      created == null || !Number.isFinite(created) ||
      now < created || now - created >= this.freshWindowMs
    ) return false;
    if (this.active) {
      if (this.active.replacementSeen || now - this.active.startedAt < this.launchSettleMs) {
        return false;
      }
      this.active = null;
    }
    const key = `${processInfo.pid}:${created}`;
    if (this.handled.has(key)) return false;
    this.handled.set(key, now);
    for (const [older, claimedAt] of this.handled) {
      if (now - claimedAt > 300_000) this.handled.delete(older);
    }
    this.active = { original: key, startedAt: now, launched: false, replacementSeen: false };
    return true;
  }

  markLaunched(): void {
    if (this.active) this.active.launched = true;
  }

  markVerified(): void {
    this.active = null;
  }

  markFailed(): void {
    this.active = null;
  }

  observeSnapshot(processes: readonly { pid: number; createdAtMs: number | null }[]): void {
    if (!this.active?.launched) return;
    if (processes.some((row) =>
      row.createdAtMs != null && `${row.pid}:${row.createdAtMs}` !== this.active?.original,
    )) this.active.replacementSeen = true;
    if (processes.length === 0 && this.active.replacementSeen) this.active = null;
  }
}
