import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ApplyTransaction,
  BackgroundStore,
  MediaServerController,
  defaultDataRoot,
  buildHostApplyPayload,
  resolveSessionBundledThemes,
  type ApplyInput,
  type ApplyResult,
  type BackgroundTone,
  type HostSession,
  type HostSessionStatus,
  type SavedThemeInfo,
} from "@beauticode/core";
import { CodexHostApplier } from "./host-applier.js";
import { CdpIdentityMismatchError, CdpError } from "./cdp.js";
import { probeCdp } from "./discovery.js";
import { findBestCdpPort } from "./host-discover.js";
import { acquireInjectorLock } from "./injector-lock.js";
import { loadRendererSource } from "./payload.js";
import { CODEX_HOST_DESCRIPTOR } from "./host-descriptor.js";

export interface BeautiSessionOptions {
  /** Fixed CDP port. If omitted, discover() is used on start. */
  port?: number;
  dataRoot?: string;
  verifyDeadlineMs?: number;
  requireAppProtocol?: boolean;
  urlPrefix?: string;
  pollMs?: number;
  autoDiscover?: boolean;
  /**
   * When true (default for tray), start() returns after store+lock init and
   * connects CDP in the background. Apply/reapply still await a live host.
   * Set false for one-shot CLI paths that need a connected host immediately.
   */
  deferHostConnect?: boolean;
  onError?: (err: Error) => void;
  onStatus?: (msg: string) => void;
  /** Pin the shipped 画窗 theme in 已保存主题. Default true. */
  bundledGallery?: boolean;
  bundledGalleryImagePath?: string;
}

/**
 * Long-lived owner for tray / watch:
 * single injector lock, media server, host applier, store.
 *
 * Video applies use CDP file input → blob inside the renderer. The Codex path
 * keeps its HTTP media controller disabled because app:// CSP blocks loopback.
 */
export class BeautiSession implements HostSession {
  readonly descriptor = CODEX_HOST_DESCRIPTOR;
  readonly dataRoot: string;
  readonly verifyDeadlineMs: number;
  readonly requireAppProtocol: boolean;
  readonly urlPrefix: string | undefined;
  readonly pollMs: number;
  readonly autoDiscover: boolean;
  readonly deferHostConnect: boolean;

  private port: number | null;
  private store: BackgroundStore;
  private media = new MediaServerController({ enabled: false });
  private host: CodexHostApplier | null = null;
  private releaseLock: (() => Promise<void>) | null = null;
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  /** User-facing apply/reapply/theme — must not be blocked by watch polls. */
  private userBusy = false;
  /** Watch tick in flight — separate so tray switches are not rejected. */
  private watchBusy = false;
  private startupTask: Promise<void> | null = null;
  private watchTask: Promise<void> | null = null;
  private activeOperations = new Set<Promise<unknown>>();
  private stopTask: Promise<void> | null = null;
  /** Ensures only one ensureHost chain runs at a time. */
  private hostConnectChain: Promise<void> = Promise.resolve();
  /** Session id set last time we successfully published media URLs. */
  private lastPublishSessionKey = "";
  /** Runtime-detached video generation already installed in the live session. */
  private detachedVideoKey = "";
  /**
   * Fish mode (摸鱼) desired state for this process only — not persisted.
   * Re-asserted after every successful publish so watch/reapply cannot drop it.
   */
  private fishMode = false;
  /**
   * Background video mute preference (default muted). Process-local only.
   * Independent of fish mode. Re-asserted after publish / blob attach.
   */
  private videoMuted = true;
  /** CSS overlay preference; process-local and dark by default for compatibility. */
  private backgroundTone: BackgroundTone = "dark";
  /**
   * Saved theme currently bound for continuous video-progress writes.
   * Set on useSavedTheme; cleared when the user applies a different media path
   * (image/video file picker, clear). Progress is written into that theme's
   * theme.json only — never into a different theme.
   */
  private activeThemeId: string | null = null;
  /** Throttle continuous theme progress disk writes. */
  private lastProgressWriteAt = 0;
  private lastProgressWriteSec = -1;
  private progressWriteInFlight = false;
  private onError: ((err: Error) => void) | null;
  private onStatus: ((msg: string) => void) | null;

  constructor(opts: BeautiSessionOptions = {}) {
    this.dataRoot = opts.dataRoot ?? defaultDataRoot();
    this.port = opts.port ?? null;
    this.verifyDeadlineMs = opts.verifyDeadlineMs ?? 30_000;
    this.requireAppProtocol = opts.requireAppProtocol ?? true;
    this.urlPrefix = opts.urlPrefix;
    this.pollMs = opts.pollMs ?? 1_000;
    this.autoDiscover = opts.autoDiscover ?? true;
    // Default deferred: tray wants the control plane up immediately.
    this.deferHostConnect = opts.deferHostConnect ?? true;
    this.onError = opts.onError ?? null;
    this.onStatus = opts.onStatus ?? null;
    this.store = new BackgroundStore({
      root: this.dataRoot,
      bundledThemes: resolveSessionBundledThemes({
        enabled: opts.bundledGallery,
        imagePath: opts.bundledGalleryImagePath,
        searchRoots: [
          path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."),
          process.cwd(),
        ],
      }),
    });
  }

  get cdpPort(): number | null {
    return this.port;
  }

  get isBusy(): boolean {
    return this.userBusy;
  }

  get isOpen(): boolean {
    // Open once start() acquired the injector lock — host may still be connecting.
    return !this.closed && this.releaseLock != null;
  }

  get isHostReady(): boolean {
    return Boolean(this.host && this.port != null && this.host.activeSessionCount > 0);
  }

  get activeSessionCount(): number {
    return this.host?.activeSessionCount ?? 0;
  }

  get isFishMode(): boolean {
    return this.fishMode;
  }

  get isVideoMuted(): boolean {
    return this.videoMuted;
  }

  async start(): Promise<{ port: number | null }> {
    this.assertOpenable();
    await this.store.init();

    // Hold the single-owner lock early (port 0 = not yet bound to a CDP port).
    // Real port is written once ensureHost resolves a live endpoint.
    this.releaseLock = await acquireInjectorLock(this.dataRoot, this.port ?? 0);

    if (!this.deferHostConnect) {
      await this.ensureHost({ allowDiscover: true });
      await this.republishActive().catch((err) => {
        this.onError?.(err instanceof Error ? err : new Error(String(err)));
      });
      this.startWatchLoop();
      return { port: this.port };
    }

    // Fast path for tray: return immediately, connect + publish in background.
    this.startWatchLoop();
    const startup = this.ensureHost({ allowDiscover: true })
      .then(() => this.republishActive())
      .catch((err) => {
        this.onError?.(err instanceof Error ? err : new Error(String(err)));
      });
    this.startupTask = startup;
    void startup.finally(() => {
      if (this.startupTask === startup) this.startupTask = null;
    });
    return { port: this.port };
  }

  /**
   * Resolve CDP port (if needed), open host sessions, and keep host non-null.
   * Serialized — concurrent apply/watch share one connect attempt.
   */
  private ensureHost(opts: { allowDiscover?: boolean } = {}): Promise<void> {
    const run = async () => {
      if (this.closed) throw new CdpError("Session already stopped");

      if (this.port == null) {
        if (!(opts.allowDiscover ?? true) || !this.autoDiscover) {
          throw new CdpError(
            "No CDP port configured. Pass --port or enable auto-discover.",
          );
        }
        this.onStatus?.("Discovering loopback Codex CDP…");
        const best = await findBestCdpPort({
          requirePages: true,
          timeoutMs: 450,
        });
        if (!best) {
          throw new CdpError(
            "No healthy loopback Codex CDP endpoint found. Open Codex Desktop, then use tray 应用或重新应用.",
          );
        }
        if (this.closed) throw new CdpError("Session already stopped");
        this.port = best.port;
        this.onStatus?.(
          `Using CDP :${best.port} (${best.browser ?? "unknown"}; primaryPages=${best.primaryPages})`,
        );
      }

      await probeCdp(this.port, "127.0.0.1", { timeoutMs: 800 });
      if (this.closed) throw new CdpError("Session already stopped");
      if (!this.host || this.host.port !== this.port) {
        this.host?.close();
        this.host = this.createHost(this.port);
        this.detachedVideoKey = "";
      }
      const connectCurrentHost = async () => {
        if (!this.host) throw new CdpError("Host is not connected");
        if (this.host.activeSessionCount === 0) {
          await this.host.connect();
        } else {
          await this.host.reconcileSessions();
          if (this.host.activeSessionCount === 0) {
            await this.host.connect();
          }
        }
      };

      try {
        await connectCurrentHost();
      } catch (err) {
        if (!(err instanceof CdpIdentityMismatchError) || this.port == null) {
          throw err;
        }

        // A normal Codex restart keeps the loopback port but replaces the
        // Chromium browser identity. Drop every stale target and bind once to
        // the freshly probed browser so the triggering user action can finish.
        this.onStatus?.(`Codex CDP restarted on :${this.port}; reconnecting…`);
        this.host?.close();
        this.host = this.createHost(this.port);
        this.detachedVideoKey = "";
        this.lastPublishSessionKey = "";
        await connectCurrentHost();
      }
      if (this.closed) {
        this.host.close();
        throw new CdpError("Session already stopped");
      }
    };

    this.hostConnectChain = this.hostConnectChain.then(run, run);
    return this.hostConnectChain;
  }

  async apply(input: ApplyInput): Promise<ApplyResult> {
    return this.#trackOperation(this.applyInternal(input));
  }

  private async applyInternal(input: ApplyInput): Promise<ApplyResult> {
    if (this.closed || !this.releaseLock) {
      throw new CdpError("Session is not started");
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
      await this.ensureHost({ allowDiscover: true });
      if (!this.host || this.port == null) {
        throw new CdpError("Host is not connected");
      }
      const { cssText } = await loadRendererSource();
      const tx = new ApplyTransaction({
        store: this.store,
        media: this.media,
        host: this.host,
        cssText,
        verifyDeadlineMs: this.verifyDeadlineMs,
        offline: false,
      });
      const result = await tx.run(input);
      if (result.ok) {
        this.lastPublishSessionKey = `${this.port}:${this.host.activeSessionCount}`;
        this.detachedVideoKey =
          input.type === "video"
            ? `${this.lastPublishSessionKey}:${result.generation}`
            : "";
        // Manual apply leaves the previous theme binding — progress must not
        // keep writing into a theme the user is no longer viewing.
        this.activeThemeId = null;
        this.lastProgressWriteSec = -1;
        // clear always exits fish; other applies re-assert if still wanted.
        if (input.type === "clear") {
          this.fishMode = false;
        } else if (this.fishMode) {
          await this.host.setFishMode(true).catch(() => null);
        }
        // Mute preference is independent of clear; re-assert on live video.
        if (!this.videoMuted || input.type === "video") {
          await this.host.setMuted(this.videoMuted).catch(() => null);
        }
        await this.reassertBackgroundTone();
      }
      return result;
    } finally {
      this.userBusy = false;
    }
  }

  async status(): Promise<HostSessionStatus> {
    await this.store.init();
    const manifest = await this.store.readActiveManifest();
    return {
      host: this.descriptor,
      port: this.port,
      sessions: this.host?.activeSessionCount ?? 0,
      manifest,
      mediaServer:
        this.media.activeImage?.url ?? this.media.activeVideo?.url ?? null,
      fish: this.fishMode,
      muted: this.videoMuted,
      tone: this.backgroundTone,
    };
  }

  /**
   * Toggle fish mode (摸鱼). Attribute-only in the renderer — no media rebuild.
   * Not persisted across tray/process restarts. Requires an active background.
   */
  async setFishMode(enabled: boolean): Promise<{
    ok: boolean;
    fish: boolean;
    sessions: number;
    error?: string;
  }> {
    if (this.closed || !this.releaseLock) {
      return {
        ok: false,
        fish: this.fishMode,
        sessions: 0,
        error: "Session is not started",
      };
    }
    const want = Boolean(enabled);
    if (want) {
      await this.store.init();
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
    // Remember desired state even if host is momentarily down; watch will
    // re-assert after the next successful publish.
    this.fishMode = want;
    try {
      await this.ensureHost({ allowDiscover: true });
    } catch (err) {
      return {
        ok: false,
        fish: this.fishMode,
        sessions: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (!this.host) {
      return {
        ok: false,
        fish: this.fishMode,
        sessions: 0,
        error: "Host is not connected",
      };
    }
    const result = await this.host.setFishMode(want);
    // Host may refuse (e.g. clear media) — mirror that.
    if (result.ok) this.fishMode = result.fish;
    else if (!want) this.fishMode = false;
    return result;
  }

  /**
   * Toggle background video mute. Attribute/property only — no media rebuild.
   * Default muted. Not persisted across tray/process restarts.
   * Independent of fish mode. If unmute is blocked by autoplay policy the
   * video keeps playing muted and `blocked: true` is returned.
   */
  async setMuted(muted: boolean): Promise<{
    ok: boolean;
    muted: boolean;
    blocked: boolean;
    sessions: number;
    error?: string;
  }> {
    if (this.closed || !this.releaseLock) {
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
      await this.ensureHost({ allowDiscover: true });
    } catch (err) {
      // Preference kept for the next successful publish.
      return {
        ok: true,
        muted: this.videoMuted,
        blocked: false,
        sessions: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (!this.host) {
      return {
        ok: true,
        muted: this.videoMuted,
        blocked: false,
        sessions: 0,
      };
    }
    const result = await this.host.setMuted(this.videoMuted);
    if (result.ok) this.videoMuted = result.muted;
    return result;
  }

  /** Change only the injected CSS overlay; media and generation are untouched. */
  async setBackgroundTone(tone: BackgroundTone): Promise<{
    ok: boolean;
    tone: BackgroundTone;
    sessions: number;
    error?: string;
  }> {
    if (this.closed || !this.releaseLock) {
      return {
        ok: false,
        tone: this.backgroundTone,
        sessions: 0,
        error: "Session is not started",
      };
    }
    this.backgroundTone =
      tone === "light" || tone === "auto" ? tone : "dark";
    try {
      await this.ensureHost({ allowDiscover: true });
    } catch (err) {
      // Keep the preference for the next Codex connection.
      return {
        ok: true,
        tone: this.backgroundTone,
        sessions: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (!this.host || !this.host.setBackgroundTone) {
      return { ok: true, tone: this.backgroundTone, sessions: 0 };
    }
    const result = await this.host.setBackgroundTone(this.backgroundTone);
    if (result.ok) this.backgroundTone = result.tone;
    return result;
  }

  /**
   * Re-publish the currently active background into live sessions without
   * bumping generation / re-importing media (tray "应用或重新应用").
   */
  async reapply(): Promise<ApplyResult> {
    return this.#trackOperation(this.reapplyInternal());
  }

  private async reapplyInternal(): Promise<ApplyResult> {
    if (this.closed || !this.releaseLock) {
      throw new CdpError("Session is not started");
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
      await this.ensureHost({ allowDiscover: true });
      if (!this.host || this.port == null) {
        throw new CdpError("Host is not connected");
      }
      const manifest = await this.store.readActiveManifest();
      await this.republishActive();
      const verify = await this.host.verify(
        {
          generation: manifest.generation,
          media: manifest.background?.type ?? "clear",
        },
        { deadlineMs: this.verifyDeadlineMs },
      );
      if (verify.status !== "pass") {
        return {
          ok: false,
          error: `Live verify did not pass (${verify.status}): ${verify.reason}`,
          rolledBack: false,
        };
      }
      this.lastPublishSessionKey = `${this.port}:${this.host.activeSessionCount}`;
      return {
        ok: true,
        generation: manifest.generation,
        mode: manifest.background?.type ?? "clear",
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        rolledBack: false,
      };
    } finally {
      this.userBusy = false;
    }
  }

  /** Persist the active image/video under a user-facing name. */
  async saveCurrentTheme(name: string): Promise<SavedThemeInfo> {
    return this.#trackOperation(this.saveCurrentThemeInternal(name));
  }

  private async saveCurrentThemeInternal(name: string): Promise<SavedThemeInfo> {
    if (this.closed || !this.releaseLock) {
      throw new CdpError("Session is not started");
    }
    await this.store.init();
    let videoPositionSec: number | null = null;
    // Capture live progress at save time when a video is playing.
    if (this.host) {
      try {
        const pos = await this.host.getPlaybackPosition();
        if (pos.ok && pos.hasVideo && Number.isFinite(pos.currentTime)) {
          videoPositionSec = pos.currentTime;
        }
      } catch {
        /* save without position */
      }
    }
    const theme = await this.store.saveCurrentTheme(name, { videoPositionSec });
    // Bind continuous writes to the freshly saved theme when it is video.
    if (theme.type === "video") {
      this.activeThemeId = theme.id;
      this.lastProgressWriteSec = -1;
    } else {
      this.activeThemeId = null;
    }
    return theme;
  }

  async listSavedThemes(): Promise<SavedThemeInfo[]> {
    await this.store.init();
    return this.store.listSavedThemes();
  }

  async deleteSavedTheme(themeId: string): Promise<boolean> {
    const id = String(themeId ?? "").trim();
    const deleted = await this.store.deleteSavedTheme(id);
    if (deleted && this.activeThemeId === id) {
      this.activeThemeId = null;
      this.lastProgressWriteSec = -1;
    }
    return deleted;
  }

  /**
   * Restore a previously saved theme into active and publish to live sessions.
   * Video themes resume at the last written position (invalid → 0).
   * Binds continuous progress writes to this theme id.
   */
  async useSavedTheme(themeId: string): Promise<ApplyResult> {
    return this.#trackOperation(this.useSavedThemeInternal(themeId));
  }

  private async useSavedThemeInternal(themeId: string): Promise<ApplyResult> {
    if (this.closed || !this.releaseLock) {
      throw new CdpError("Session is not started");
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
      const saved = await this.store.loadSavedTheme(themeId);
      await this.ensureHost({ allowDiscover: true });
      if (!this.host || this.port == null) {
        throw new CdpError("Host is not connected");
      }
      const { cssText } = await loadRendererSource();
      const tx = new ApplyTransaction({
        store: this.store,
        media: this.media,
        host: this.host,
        cssText,
        verifyDeadlineMs: this.verifyDeadlineMs,
        offline: false,
      });
      const result = await tx.run(saved.input);
      if (!result.ok) return result;

      // Bind progress only after disk, host apply and live verify all passed.
      this.activeThemeId =
        saved.input.type === "video" ? saved.themeId : null;
      this.detachedVideoKey =
        saved.input.type === "video"
          ? `${this.port}:${this.host.activeSessionCount}:${result.generation}`
          : "";
      this.lastProgressWriteSec = -1;
      this.lastPublishSessionKey = `${this.port}:${this.host.activeSessionCount}`;
      if (this.fishMode) {
        await this.host.setFishMode(true).catch(() => null);
      }
      if (!this.videoMuted || saved.input.type === "video") {
        await this.host.setMuted(this.videoMuted).catch(() => null);
      }
      await this.reassertBackgroundTone();
      return result;
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        rolledBack: false,
      };
    } finally {
      this.userBusy = false;
    }
  }

  async stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    const task = this.stopExclusive();
    this.stopTask = task;
    return task;
  }

  private async stopExclusive(): Promise<void> {
    this.closed = true;
    if (this.watchTimer) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
    // Best-effort restore host UI before tearing down CDP (tray quit path).
    if (this.fishMode && this.host) {
      try {
        await this.host.setFishMode(false);
      } catch {
        /* ignore */
      }
      this.fishMode = false;
    }
    this.host?.close();
    const pending = [
      this.startupTask,
      this.watchTask,
      this.hostConnectChain,
      ...this.activeOperations,
    ].filter((value): value is Promise<unknown> => Boolean(value));
    await Promise.allSettled(pending);
    this.host?.close();
    this.host = null;
    await this.media.close().catch(() => {});
    if (this.releaseLock) {
      await this.releaseLock().catch(() => {});
      this.releaseLock = null;
    }
  }

  private createHost(port: number): CodexHostApplier {
    const options: ConstructorParameters<typeof CodexHostApplier>[0] = {
      port,
      requireAppProtocol: this.requireAppProtocol,
      pollMs: Math.min(this.pollMs, 400),
    };
    if (this.urlPrefix !== undefined) options.urlPrefix = this.urlPrefix;
    return new CodexHostApplier(options);
  }

  private startWatchLoop(): void {
    if (this.watchTimer) return;
    this.watchTimer = setInterval(() => {
      const task = this.watchTick();
      this.watchTask = task;
      void task.finally(() => {
        if (this.watchTask === task) this.watchTask = null;
      });
    }, this.pollMs);
    this.watchTimer.unref?.();
  }

  private async watchTick(): Promise<void> {
    // Skip while a user apply is running, or if a previous watch tick is open.
    // Never hold userBusy here — that made tray image/video switches fail with
    // "already in progress" and forced multi-retry.
    if (this.closed || this.userBusy || this.watchBusy || !this.releaseLock) {
      return;
    }
    this.watchBusy = true;
    try {
      // Soft connect: if Codex is not up yet, stay quiet until the next tick
      // (or until the user hits 应用或重新应用 which launches the host).
      try {
        await this.ensureHost({ allowDiscover: true });
      } catch {
        return;
      }
      if (!this.host || this.port == null) return;

      await this.host.reconcileSessions();
      if (this.host.activeSessionCount === 0) {
        await this.host.connect();
      }
      // After Codex restart session ids change. Always restage fresh media URLs
      // for new sessions — reapplyLast would re-inject dead/stale loopback URLs
      // and surface as "fail fetch" in the renderer.
      // When the session set is stable, only heal missing/unhealthy runtimes.
      // Full reapply every poll was the main image↔video alternate flash source
      // (session 019fa31c / Dream Skin watch path).
      const sessionKey = `${this.port}:${this.host.activeSessionCount}`;
      if (
        sessionKey !== this.lastPublishSessionKey ||
        !this.host.lastApplied
      ) {
        await this.republishActive();
        this.lastPublishSessionKey = sessionKey;
      } else {
        await this.host.reapplyLast();
      }
      // Continuous per-theme progress write (video only, bound theme only).
      await this.persistBoundThemeProgress().catch(() => {});
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.onError?.(error);
      if (err instanceof CdpIdentityMismatchError && this.port != null) {
        try {
          this.host?.close();
          this.host = this.createHost(this.port);
          this.lastPublishSessionKey = "";
          await this.ensureHost({ allowDiscover: false });
          await this.republishActive();
          this.lastPublishSessionKey = `${this.port}:${this.host?.activeSessionCount ?? 0}`;
        } catch (re) {
          this.onError?.(re instanceof Error ? re : new Error(String(re)));
        }
      }
    } finally {
      this.watchBusy = false;
    }
  }

  #trackOperation<T>(operation: Promise<T>): Promise<T> {
    this.activeOperations.add(operation);
    void operation.then(
      () => this.activeOperations.delete(operation),
      () => this.activeOperations.delete(operation),
    );
    return operation;
  }

  /**
   * While a saved video theme is active, periodically write currentTime into
   * that theme's theme.json. Fail-soft; never blocks user applies.
   */
  private async persistBoundThemeProgress(): Promise<void> {
    if (
      !this.activeThemeId ||
      !this.host ||
      this.progressWriteInFlight ||
      this.userBusy
    ) {
      return;
    }
    const now = Date.now();
    // ~2s cadence is enough for resume and keeps disk quiet.
    if (now - this.lastProgressWriteAt < 2_000) return;

    this.progressWriteInFlight = true;
    try {
      const pos = await this.host.getPlaybackPosition();
      if (!pos.ok || !pos.hasVideo) return;
      let t = Number(pos.currentTime);
      if (!Number.isFinite(t) || t < 0) return;
      // Near end: store 0 so next restore starts cleanly (product: invalid → 0).
      if (pos.duration > 0 && t >= pos.duration - 0.25) {
        t = 0;
      }
      // Skip tiny moves (<0.5s) to cut writes further.
      if (
        this.lastProgressWriteSec >= 0 &&
        Math.abs(t - this.lastProgressWriteSec) < 0.5 &&
        !(t === 0 && this.lastProgressWriteSec !== 0)
      ) {
        this.lastProgressWriteAt = now;
        return;
      }
      const result = await this.store.updateSavedThemeVideoPosition(
        this.activeThemeId,
        t,
      );
      if (result.ok) {
        this.lastProgressWriteAt = now;
        this.lastProgressWriteSec =
          result.positionSec != null ? result.positionSec : t;
      } else if (result.error === "Saved theme not found.") {
        // Theme deleted under us — stop binding.
        this.activeThemeId = null;
      }
    } finally {
      this.progressWriteInFlight = false;
    }
  }

  private async republishActive(): Promise<void> {
    if (!this.host) return;
    const manifest = await this.store.readActiveManifest();
    const { cssText } = await loadRendererSource();

    if (!manifest.background) {
      this.fishMode = false;
      this.activeThemeId = null;
      this.detachedVideoKey = "";
      await this.host.apply(
        await buildHostApplyPayload(this.store, manifest, null, cssText),
      );
      await this.reassertBackgroundTone();
      await this.media.commit(null);
      return;
    }

    const imagePath = path.join(
      this.store.paths.activeDir,
      manifest.background.image,
    );
    // Codex CSP requires data:/blob:; loopback is secondary only.
    const imageHandle = await this.media.stage(imagePath);
    let videoHandle = null as Awaited<ReturnType<MediaServerController["stage"]>>;

    if (manifest.background.type === "video" && manifest.background.video) {
      const videoPath = path.join(
        this.store.paths.activeDir,
        manifest.background.video,
      );
      videoHandle = await this.media.stage(videoPath);
      // Codex Desktop primary: CDP file-input → blob: (Dream Skin path).
      // Skip multi-MB dataUrl — host applier attaches the local file.
    }

    let committed = false;
    let runtimeVideoPath: string | null = null;
    const videoKey =
      manifest.background.type === "video"
        ? `${this.port}:${this.host.activeSessionCount}:${manifest.generation}`
        : "";
    const forceVideoRebuild =
      Boolean(videoKey) && this.detachedVideoKey !== videoKey;
    const previousDetachedVideoKey = this.detachedVideoKey;
    if (forceVideoRebuild) this.detachedVideoKey = videoKey;
    try {
      const payload = await buildHostApplyPayload(
        this.store,
        manifest,
        { image: imageHandle, video: videoHandle },
        cssText,
      );
      runtimeVideoPath = payload.video?.localPath ?? null;
      await this.host.apply(payload, { forceRebuild: forceVideoRebuild });
      await this.media.commit({ image: imageHandle, video: videoHandle });
      await this.store.pruneRuntimeMedia(runtimeVideoPath);
      committed = true;
    } catch (error) {
      if (
        forceVideoRebuild &&
        this.detachedVideoKey === videoKey
      ) {
        this.detachedVideoKey = previousDetachedVideoKey;
      }
      throw error;
    } finally {
      if (!committed) {
        await this.media.abort(videoHandle).catch(() => {});
        await this.media.abort(imageHandle).catch(() => {});
      }
    }
    // Watch / reapply must not drop fish / mute prefs after a reinject.
    if (this.fishMode) {
      await this.host.setFishMode(true).catch(() => null);
    }
    await this.host.setMuted(this.videoMuted).catch(() => null);
    await this.reassertBackgroundTone();
  }

  private async reassertBackgroundTone(): Promise<void> {
    if (!this.host?.setBackgroundTone) return;
    await this.host.setBackgroundTone(this.backgroundTone).catch(() => null);
  }

  private assertOpenable(): void {
    if (this.closed) throw new CdpError("Session already stopped");
    if (this.releaseLock) throw new CdpError("Session already started");
  }
}
