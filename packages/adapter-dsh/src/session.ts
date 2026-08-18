import path from "node:path";
import {
  ApplyTransaction,
  BackgroundStore,
  MediaServerController,
  buildHostApplyPayload,
  defaultDataRoot,
  type ApplyInput,
  type ApplyResult,
  type BackgroundTone,
  type HostSession,
  type HostSessionStatus,
  type SavedThemeInfo,
} from "@beauticode/core";
import { DshHostApplier, normalizeDshBaseUrl } from "./bridge.js";
import { DSH_HOST_DESCRIPTOR } from "./host-descriptor.js";
import { acquireDshInjectorLock } from "./injector-lock.js";
import { ensureBridgeToken } from "./token.js";
import { trayHandoffRequested } from "./tray-handoff.js";

export interface DshSessionOptions {
  baseUrl?: string;
  dataRoot?: string;
  verifyDeadlineMs?: number;
  pollMs?: number;
  onError?: (err: Error) => void;
  onStatus?: (msg: string) => void;
  /**
   * When true (plugin in-process session), stop if the tray claims the data
   * root. The tray session-host must leave this false — it writes the claim.
   */
  honorTrayHandoff?: boolean;
}

export class DshSession implements HostSession {
  readonly descriptor = DSH_HOST_DESCRIPTOR;
  readonly cdpPort = null;
  readonly dataRoot: string;
  readonly verifyDeadlineMs: number;
  readonly pollMs: number;
  readonly honorTrayHandoff: boolean;
  readonly baseUrl: URL;

  private store: BackgroundStore;
  private media: MediaServerController;
  private host: DshHostApplier | null = null;
  private releaseLock: (() => Promise<void>) | null = null;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private handoffTimer: ReturnType<typeof setInterval> | null = null;
  private watchTask: Promise<void> | null = null;
  private stopTask: Promise<void> | null = null;
  private activeOperations = new Set<Promise<unknown>>();
  private closed = false;
  private userBusy = false;
  private onError: ((err: Error) => void) | null;
  private onStatus: ((msg: string) => void) | null;
  private lastWatchError = "";
  private fishMode = false;
  private videoMuted = true;
  private backgroundTone: BackgroundTone = "auto";
  private activeThemeId: string | null = null;
  private lastProgressWriteAt = 0;
  private lastProgressWriteSec = -1;
  private progressWriteInFlight = false;

  constructor(opts: DshSessionOptions = {}) {
    this.dataRoot = opts.dataRoot ?? defaultDataRoot();
    this.verifyDeadlineMs = opts.verifyDeadlineMs ?? 30_000;
    this.pollMs = opts.pollMs ?? 2_000;
    this.honorTrayHandoff = opts.honorTrayHandoff !== false;
    this.baseUrl = normalizeDshBaseUrl(opts.baseUrl ?? "http://127.0.0.1:3080");
    this.store = new BackgroundStore({ root: this.dataRoot });
    this.media = new MediaServerController({
      enabled: true,
      trustedOrigins: [this.baseUrl.origin],
    });
    this.onError = opts.onError ?? null;
    this.onStatus = opts.onStatus ?? null;
  }

  get isBusy(): boolean {
    return this.userBusy;
  }

  get isOpen(): boolean {
    return !this.closed && this.releaseLock != null;
  }

  get isHostReady(): boolean {
    return (this.host?.activeSessionCount ?? 0) > 0;
  }

  async start(): Promise<{ port: number | null }> {
    if (this.closed) throw new Error("Session already stopped");
    if (this.releaseLock) throw new Error("Session already started");
    await this.store.init();
    this.releaseLock = await acquireDshInjectorLock(this.dataRoot);
    try {
      const token = await ensureBridgeToken(this.dataRoot);
      this.host = new DshHostApplier({
        baseUrl: this.baseUrl.href,
        token,
        pollMs: Math.min(250, Math.max(50, Math.floor(this.pollMs / 4))),
      });
    } catch (error) {
      await this.releaseLock().catch(() => {});
      this.releaseLock = null;
      throw error;
    }
    this.startWatchLoop();
    if (this.honorTrayHandoff) {
      this.startHandoffLoop();
      void this.yieldToTrayIfRequested();
    }
    void this.watchOnce();
    return { port: this.bridgePort() };
  }

  async apply(input: ApplyInput): Promise<ApplyResult> {
    return this.trackOperation(this.applyInternal(input));
  }

  private async applyInternal(input: ApplyInput): Promise<ApplyResult> {
    if (!this.releaseLock || this.closed || !this.host) {
      throw new Error("Session is not started");
    }
    if (this.userBusy) {
      return {
        ok: false,
        error: "Another background apply is already in progress.",
        rolledBack: false,
      };
    }
    this.userBusy = true;
    try {
      const tx = new ApplyTransaction({
        store: this.store,
        media: this.media,
        host: this.host,
        verifyDeadlineMs: this.verifyDeadlineMs,
        offline: false,
      });
      const result = await tx.run(input);
      if (result.ok) {
        this.activeThemeId = null;
        this.lastProgressWriteSec = -1;
        if (input.type === "clear") {
          this.fishMode = false;
        } else if (this.fishMode) {
          await this.host.setFishMode(true).catch(() => null);
        }
        if (!this.videoMuted || input.type === "video") {
          await this.host.setMuted(this.videoMuted).catch(() => null);
        }
        await this.host.setBackgroundTone(this.backgroundTone).catch(() => null);
      }
      return result;
    } finally {
      this.userBusy = false;
    }
  }

  async reapply(): Promise<ApplyResult> {
    return this.trackOperation(this.reapplyInternal());
  }

  private async reapplyInternal(): Promise<ApplyResult> {
    if (!this.releaseLock || this.closed || !this.host) {
      throw new Error("Session is not started");
    }
    if (this.userBusy) {
      return {
        ok: false,
        error: "Another background apply is already in progress.",
        rolledBack: false,
      };
    }
    this.userBusy = true;
    let stagedImage = null;
    let stagedVideo = null;
    try {
      const manifest = await this.store.readActiveManifest();
      let resumeAt: number | null = null;
      if (manifest.background?.type === "video") {
        try {
          const position = await this.host.getPlaybackPosition();
          if (position.ok && position.hasVideo && Number.isFinite(position.currentTime)) {
            resumeAt = Math.max(0, position.currentTime);
          }
        } catch {
          /* Fall back to the bound saved theme below. */
        }
        if (resumeAt == null && this.activeThemeId) {
          resumeAt = await this.store.getSavedThemeVideoPosition(this.activeThemeId);
        }
      }
      if (manifest.background) {
        stagedImage = await this.media.stage(
          path.join(this.store.paths.activeDir, manifest.background.image),
        );
        if (manifest.background.type === "video" && manifest.background.video) {
          const runtimeVideoPath = await this.store.prepareRuntimeVideo(manifest);
          if (!runtimeVideoPath) {
            throw new Error("DSH video reapply requires a detached runtime copy.");
          }
          stagedVideo = await this.media.stage(runtimeVideoPath);
        }
      }
      const staged = { image: stagedImage, video: stagedVideo };
      const payload = await buildHostApplyPayload(this.store, manifest, staged, "");
      if (payload.video && resumeAt != null) payload.video.startAt = resumeAt;
      await this.host.apply(payload);
      const verify = await this.host.verify(
        {
          generation: manifest.generation,
          media: manifest.background?.type ?? "clear",
        },
        { deadlineMs: this.verifyDeadlineMs },
      );
      if (verify.status !== "pass") {
        await this.media.abort(stagedVideo);
        await this.media.abort(stagedImage);
        stagedVideo = null;
        stagedImage = null;
        return {
          ok: false,
          error: `Live verify did not pass (${verify.status}): ${verify.reason}`,
          rolledBack: false,
        };
      }
      await this.media.commit(staged);
      stagedVideo = null;
      stagedImage = null;
      if (!manifest.background) {
        this.fishMode = false;
        this.activeThemeId = null;
      } else if (this.fishMode) {
        await this.host.setFishMode(true).catch(() => null);
      }
      await this.host.setMuted(this.videoMuted).catch(() => null);
      await this.host.setBackgroundTone(this.backgroundTone).catch(() => null);
      return {
        ok: true,
        generation: manifest.generation,
        mode: manifest.background?.type ?? "clear",
      };
    } catch (error) {
      await this.media.abort(stagedVideo);
      await this.media.abort(stagedImage);
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        rolledBack: false,
      };
    } finally {
      this.userBusy = false;
    }
  }

  async status(): Promise<HostSessionStatus> {
    const manifest = await this.store.readActiveManifest();
    if (this.host) await this.host.status().catch(() => null);
    return {
      host: this.descriptor,
      port: this.bridgePort(),
      sessions: this.host?.activeSessionCount ?? 0,
      manifest,
      mediaServer: this.media.activeImage?.url ?? this.media.activeVideo?.url ?? null,
      fish: this.fishMode,
      muted: this.videoMuted,
      tone: this.backgroundTone,
    };
  }

  async saveCurrentTheme(name: string): Promise<SavedThemeInfo> {
    let videoPositionSec: number | null = null;
    if (this.host) {
      try {
        const position = await this.host.getPlaybackPosition();
        if (position.ok && position.hasVideo && Number.isFinite(position.currentTime)) {
          videoPositionSec = position.currentTime;
        }
      } catch {
        /* Save without a resume position when no browser client is available. */
      }
    }
    const theme = await this.store.saveCurrentTheme(name, { videoPositionSec });
    if (theme.type === "video") {
      this.activeThemeId = theme.id;
      this.lastProgressWriteSec = -1;
    } else {
      this.activeThemeId = null;
    }
    return theme;
  }

  async listSavedThemes(): Promise<SavedThemeInfo[]> {
    return this.store.listSavedThemes();
  }

  async deleteSavedTheme(themeId: string): Promise<boolean> {
    const deleted = await this.store.deleteSavedTheme(themeId);
    if (deleted && this.activeThemeId === themeId) {
      this.activeThemeId = null;
      this.lastProgressWriteSec = -1;
    }
    return deleted;
  }

  async useSavedTheme(themeId: string): Promise<ApplyResult> {
    try {
      const saved = await this.store.loadSavedTheme(themeId);
      const result = await this.apply(saved.input);
      if (result.ok) {
        this.activeThemeId = saved.input.type === "video" ? saved.themeId : null;
        this.lastProgressWriteSec = -1;
      }
      return result;
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        rolledBack: false,
      };
    }
  }

  async setFishMode(enabled: boolean): Promise<{
    ok: boolean;
    fish: boolean;
    sessions: number;
    error?: string;
  }> {
    if (!this.releaseLock || this.closed || !this.host) {
      return { ok: false, fish: this.fishMode, sessions: 0, error: "Session is not started" };
    }
    const want = Boolean(enabled);
    if (want) {
      const manifest = await this.store.readActiveManifest();
      if (!manifest.background) {
        this.fishMode = false;
        return {
          ok: false,
          fish: false,
          sessions: 0,
          error: "No active background. Apply an image or video first.",
        };
      }
    }
    this.fishMode = want;
    try {
      const result = await this.host.setFishMode(want);
      if (result.ok) this.fishMode = result.fish;
      else if (!want) this.fishMode = false;
      return result;
    } catch (error) {
      return {
        ok: false,
        fish: this.fishMode,
        sessions: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async setMuted(muted: boolean): Promise<{
    ok: boolean;
    muted: boolean;
    blocked: boolean;
    sessions: number;
    error?: string;
  }> {
    if (!this.releaseLock || this.closed || !this.host) {
      return {
        ok: false,
        muted: this.videoMuted,
        blocked: false,
        sessions: 0,
        error: "Session is not started",
      };
    }
    this.videoMuted = Boolean(muted);
    try {
      const result = await this.host.setMuted(this.videoMuted);
      if (result.ok) this.videoMuted = result.muted;
      return result;
    } catch (error) {
      return {
        ok: false,
        muted: this.videoMuted,
        blocked: false,
        sessions: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async setBackgroundTone(tone: BackgroundTone): Promise<{
    ok: boolean;
    tone: BackgroundTone;
    sessions: number;
    error?: string;
  }> {
    if (!this.releaseLock || this.closed || !this.host) {
      return { ok: false, tone: this.backgroundTone, sessions: 0, error: "Session is not started" };
    }
    this.backgroundTone = tone === "light" || tone === "auto" ? tone : "dark";
    try {
      const result = await this.host.setBackgroundTone(this.backgroundTone);
      if (result.ok) this.backgroundTone = result.tone;
      return result;
    } catch (error) {
      return {
        ok: false,
        tone: this.backgroundTone,
        sessions: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.stopTask = this.stopExclusive();
    return this.stopTask;
  }

  private async stopExclusive(): Promise<void> {
    this.closed = true;
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.watchTimer = null;
    if (this.handoffTimer) clearInterval(this.handoffTimer);
    this.handoffTimer = null;
    await Promise.allSettled(
      [this.watchTask, ...this.activeOperations].filter(
        (value): value is Promise<unknown> => Boolean(value),
      ),
    );
    if (this.fishMode && this.host) {
      await this.host.setFishMode(false).catch(() => null);
      this.fishMode = false;
    }
    await this.media.close().catch(() => {});
    if (this.releaseLock) await this.releaseLock().catch(() => {});
    this.releaseLock = null;
    this.host = null;
  }

  private trackOperation<T>(operation: Promise<T>): Promise<T> {
    this.activeOperations.add(operation);
    void operation.finally(() => this.activeOperations.delete(operation)).catch(() => {});
    return operation;
  }

  private bridgePort(): number {
    if (this.baseUrl.port) return Number(this.baseUrl.port);
    return 80;
  }

  private startWatchLoop(): void {
    this.watchTimer = setInterval(() => void this.watchOnce(), this.pollMs);
    this.watchTimer.unref?.();
  }

  private startHandoffLoop(): void {
    this.handoffTimer = setInterval(() => void this.yieldToTrayIfRequested(), 250);
    this.handoffTimer.unref?.();
  }

  private async yieldToTrayIfRequested(): Promise<void> {
    if (this.closed || this.stopTask) return;
    if (!(await trayHandoffRequested(this.dataRoot))) return;
    this.onStatus?.("beautiCode 托盘正在接管，正在释放本机会话。");
    await this.stop();
  }

  private async watchOnce(): Promise<void> {
    if (this.closed || !this.host || this.watchTask) return;
    const task = (async () => {
      try {
        const [status, manifest] = await Promise.all([
          this.host!.status(),
          this.store.readActiveManifest(),
        ]);
        this.lastWatchError = "";
        const media = manifest.background?.type ?? "clear";
        // Media URLs are process-local. After the tray/session host restarts,
        // the DSH page may still report the same generation while pointing at
        // a dead loopback server, so force one reapply when local handles are
        // absent.
        const localMediaMissing =
          media === "image"
            ? this.media.activeImage == null
            : media === "video"
              ? this.media.activeImage == null || this.media.activeVideo == null
              : false;
        const stale =
          status.connectedClients > 0 &&
          (status.current?.generation !== manifest.generation ||
            status.current.media !== media ||
            localMediaMissing);
        if (stale && !this.userBusy) {
          this.onStatus?.("DeepSeek Harness 已连接，正在恢复当前背景。");
          const result = await this.reapply();
          if (!result.ok) throw new Error(result.error);
        }
        await this.persistBoundThemeProgress();
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        if (err.message !== this.lastWatchError) {
          this.lastWatchError = err.message;
          this.onError?.(err);
        }
      }
    })();
    this.watchTask = task;
    await task.finally(() => {
      if (this.watchTask === task) this.watchTask = null;
    });
  }

  private async persistBoundThemeProgress(): Promise<void> {
    if (!this.activeThemeId || !this.host || this.progressWriteInFlight || this.userBusy) {
      return;
    }
    const now = Date.now();
    if (now - this.lastProgressWriteAt < 2_000) return;
    this.progressWriteInFlight = true;
    try {
      const position = await this.host.getPlaybackPosition();
      if (!position.ok || !position.hasVideo) return;
      let seconds = Number(position.currentTime);
      if (!Number.isFinite(seconds) || seconds < 0) return;
      if (position.duration > 0 && seconds >= position.duration - 0.25) seconds = 0;
      if (
        this.lastProgressWriteSec >= 0 &&
        Math.abs(seconds - this.lastProgressWriteSec) < 0.5 &&
        !(seconds === 0 && this.lastProgressWriteSec !== 0)
      ) {
        this.lastProgressWriteAt = now;
        return;
      }
      const result = await this.store.updateSavedThemeVideoPosition(
        this.activeThemeId,
        seconds,
      );
      if (result.ok) {
        this.lastProgressWriteAt = now;
        this.lastProgressWriteSec = result.positionSec ?? seconds;
      } else if (result.error === "Saved theme not found.") {
        this.activeThemeId = null;
      }
    } finally {
      this.progressWriteInFlight = false;
    }
  }
}
