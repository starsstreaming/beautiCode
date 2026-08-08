import type {
  HostApplyPayload,
  HostApplier,
  BackgroundTone,
  VerifyExpectation,
  VerifyResult,
} from "@beauticode/core";
import {
  browserIdFromVersion,
  CdpError,
  CdpIdentityMismatchError,
  CdpSession,
  connectPageTarget,
  fetchCdpVersion,
  listPageTargets,
  type CdpTargetInfo,
} from "./cdp.js";
import { buildInjectionExpression, loadRendererSource } from "./payload.js";
import {
  assessReadiness,
  SNAPSHOT_EXPRESSION,
  type ReadinessSnapshot,
} from "./readiness.js";

export interface CodexHostApplierOptions {
  port: number;
  /** Prefer targets whose URL starts with this prefix. Default app:// */
  urlPrefix?: string;
  /** Soft require app: protocol when selecting targets. Default true. */
  requireAppProtocol?: boolean;
  /** Poll interval while waiting for a target / verify. */
  pollMs?: number;
  /** How long connect() may wait for a page target. */
  connectDeadlineMs?: number;
}

export interface ConnectedTarget {
  target: CdpTargetInfo;
  session: CdpSession;
}

/**
 * Live Codex (or loopback test page) host applier over CDP.
 *
 * - Connects only to 127.0.0.1
 * - Tracks browser identity from /json/version
 * - Injects background-only runtime via Runtime.evaluate
 * - Verifies via __BEAUTICODE_BG__.snapshot() + assessReadiness
 */
export class CodexHostApplier implements HostApplier {
  readonly port: number;
  readonly urlPrefix: string;
  readonly requireAppProtocol: boolean;
  readonly pollMs: number;
  readonly connectDeadlineMs: number;

  private browserId: string | null = null;
  private sessions = new Map<string, CdpSession>();
  private lastPayload: HostApplyPayload | null = null;
  private runtimeIife: string | null = null;
  private defaultCss: string | null = null;
  private closed = false;
  /** Serialize inject+attach so watch ticks cannot thrash a cold video start. */
  private applyChain: Promise<void> = Promise.resolve();
  private applyInFlight = false;
  private lastApplyStartedAt = 0;
  /** Fish mode desired state — reapplied after inject / session heal. */
  private fishMode = false;
  /**
   * Preferred mute state for background video (default muted).
   * Process-local; re-asserted after inject / blob attach so watch cannot drop it.
   */
  private videoMuted = true;
  /** CSS overlay preference; dark preserves the pre-tone behavior. */
  private backgroundTone: BackgroundTone = "dark";

  constructor(opts: CodexHostApplierOptions) {
    if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
      throw new Error("CodexHostApplier port must be 1–65535");
    }
    this.port = opts.port;
    this.urlPrefix = opts.urlPrefix ?? "app://";
    this.requireAppProtocol = opts.requireAppProtocol ?? true;
    this.pollMs = opts.pollMs ?? 200;
    this.connectDeadlineMs = opts.connectDeadlineMs ?? 15_000;
  }

  get lastApplied(): HostApplyPayload | null {
    return this.lastPayload;
  }

  get activeSessionCount(): number {
    return this.sessions.size;
  }

  get isFishMode(): boolean {
    return this.fishMode;
  }

  get isVideoMuted(): boolean {
    return this.videoMuted;
  }

  async ensureSources(): Promise<void> {
    if (this.runtimeIife && this.defaultCss) return;
    const src = await loadRendererSource();
    this.runtimeIife = src.runtimeIife;
    this.defaultCss = src.cssText;
  }

  /**
   * Discover browser identity and at least one page session.
   * Fails closed if CDP is missing (#235).
   */
  async connect(): Promise<ConnectedTarget[]> {
    this.assertOpen();
    await this.ensureSources();
    const version = await fetchCdpVersion(this.port);
    this.browserId = browserIdFromVersion(version, this.port);

    const deadline = Date.now() + this.connectDeadlineMs;
    let lastError: unknown = null;
    while (Date.now() < deadline) {
      try {
        const connected = await this.reconcileSessions();
        if (connected.length > 0) return connected;
        lastError = new CdpError("No candidate page targets on CDP port");
      } catch (err) {
        lastError = err;
        if (this.closed) throw new CdpError("CodexHostApplier is closed");
        if (err instanceof CdpIdentityMismatchError) throw err;
      }
      await sleep(this.pollMs);
    }
    throw lastError instanceof Error
      ? lastError
      : new CdpError("Timed out waiting for a CDP page target");
  }

  /** Refresh target list; open new sessions; drop dead ones. */
  async reconcileSessions(): Promise<ConnectedTarget[]> {
    this.assertOpen();
    const targets = await listPageTargets(this.port, this.browserId, {
      allowLoopbackHttp: !this.requireAppProtocol,
    });
    const preferred = this.rankTargets(targets);
    const liveIds = new Set(preferred.map((t) => t.id));

    for (const [id, session] of this.sessions) {
      if (!liveIds.has(id) || session.closed) {
        session.close();
        this.sessions.delete(id);
      }
    }

    const connected: ConnectedTarget[] = [];
    for (const target of preferred) {
      let session = this.sessions.get(target.id);
      if (!session || session.closed) {
        try {
          session = await connectPageTarget(target, this.port);
          // Soft readiness: need a document body. Do not require fragile chrome selectors (#244).
          const probe = await session.evaluate<{
            hasBody: boolean;
            protocol: string;
          }>(`({
            hasBody: Boolean(document.body),
            protocol: location.protocol
          })`);
          if (!probe?.hasBody) {
            session.close();
            continue;
          }
          // Best-effort focus so paint/video decode are not stuck on a fully
          // backgrounded target. Failure is non-fatal (#267/#294).
          try {
            await session.send("Page.bringToFront");
          } catch {
            /* ignore */
          }
          if (
            this.requireAppProtocol &&
            probe.protocol !== "app:"
          ) {
            session.close();
            continue;
          }
          this.sessions.set(target.id, session);
        } catch {
          session?.close();
          this.sessions.delete(target.id);
          continue;
        }
      }
      connected.push({ target, session });
    }
    return connected;
  }

  private rankTargets(targets: CdpTargetInfo[]): CdpTargetInfo[] {
    const scored = targets
      .map((t) => {
        let score = 0;
        const url = t.url ?? "";
        if (
          this.requireAppProtocol &&
          !/^(?:app:\/\/-)(?:\/|$)/i.test(url)
        ) {
          return { t, score: -1_000 };
        }
        if (
          this.requireAppProtocol &&
          !/codex|chatgpt|openai/i.test(t.title ?? "")
        ) {
          return { t, score: -1_000 };
        }
        if (url.startsWith(this.urlPrefix)) score += 10;
        if (url.startsWith("app://")) score += 5;
        if (/codex|chatgpt/i.test(t.title ?? "")) score += 2;
        // Main shell only — skip chrome overlays (avatar, titlebar popouts).
        // Injecting a full-viewport stage into those is unstable and unneeded.
        if (
          /avatar-overlay|titlebar|utility-overlay|initialRoute=%2Favatar/i.test(
            url,
          )
        ) {
          score -= 100;
        }
        return { t, score };
      })
      .filter((s) => s.score >= 0);
    scored.sort((a, b) => b.score - a.score);
    // Prefer a single primary shell when several score equally.
    if (scored.length === 0) return [];
    const best = scored[0]!.score;
    return scored
      .filter((s) => s.score === best)
      .sort((a, b) => a.t.id.localeCompare(b.t.id))
      .slice(0, 1)
      .map((s) => s.t);
  }

  async apply(
    payload: HostApplyPayload,
    opts: { forceRebuild?: boolean } = {},
  ): Promise<void> {
    // Queue applies so watch ticks cannot interrupt inject+blob attach.
    const run = this.applyChain.then(() =>
      this.applyExclusive(payload, opts.forceRebuild === true),
    );
    this.applyChain = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
  }

  private async applyExclusive(
    payload: HostApplyPayload,
    forceRebuild: boolean,
  ): Promise<void> {
    this.assertOpen();
    await this.ensureSources();
    this.lastPayload = payload;
    // Clear background always exits fish mode (no wallpaper to show).
    if (payload.media === "clear") {
      this.fishMode = false;
    }
    this.applyInFlight = true;
    this.lastApplyStartedAt = Date.now();
    try {
      if (this.sessions.size === 0) {
        await this.connect();
      } else {
        await this.reconcileSessions();
      }
      if (this.sessions.size === 0) {
        throw new CdpError("No live CDP sessions to apply background");
      }
      const cssText = payload.cssText || this.defaultCss || "";
      const expression = buildInjectionExpression(
        this.runtimeIife!,
        payload,
        cssText,
        forceRebuild,
      );
      const errors: string[] = [];
      let ok = 0;
      for (const [id, session] of this.sessions) {
        if (session.closed) {
          this.sessions.delete(id);
          continue;
        }
        try {
          // Same-generation healthy stage: do not re-inject or re-attach the MP4.
          // Watch polls used to full-apply every second and flash poster/video.
          if (
            !forceRebuild &&
            (await sessionHasHealthyPayload(session, payload))
          ) {
            // Still re-assert fish / mute prefs in case a heal dropped them.
            if (this.fishMode) {
              await setSessionFishMode(session, true).catch(() => false);
            }
            await setSessionMuted(session, this.videoMuted).catch(() => null);
            await setSessionBackgroundTone(session, this.backgroundTone).catch(
              () => false,
            );
            ok += 1;
            continue;
          }
          const injectResult = await session.evaluate<{
            skipped?: boolean;
            installed?: boolean;
            generation?: number;
          } | null>(expression);
          // Runtime same-gen short-circuit — do not re-attach blob (would flash).
          if (injectResult && injectResult.skipped === true) {
            if (this.fishMode) {
              await setSessionFishMode(session, true).catch(() => false);
            }
            await setSessionMuted(session, this.videoMuted).catch(() => null);
            await setSessionBackgroundTone(session, this.backgroundTone).catch(
              () => false,
            );
            ok += 1;
            continue;
          }
          // Dream Skin path: after a real inject, ALWAYS push the local MP4.
          // Do not re-check "healthy" here — handoff keeps the previous video
          // ready, which would falsely skip blob attach and leave the new
          // generation stuck on the old frame (image/video switch retries).
          if (payload.video?.mode === "blob" && payload.video.localPath) {
            await attachBlobVideoToSession(session, payload.video.localPath);
          }
          // Re-apply fish / mute after rebuild so prefs are not lost on reinject.
          if (this.fishMode) {
            await setSessionFishMode(session, true).catch(() => false);
          }
          await setSessionMuted(session, this.videoMuted).catch(() => null);
          await setSessionBackgroundTone(session, this.backgroundTone).catch(
            () => false,
          );
          ok += 1;
        } catch (err) {
          errors.push(
            `${id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (ok === 0) {
        throw new CdpError(
          `Failed to inject background into any session: ${errors.join("; ")}`,
        );
      }
    } finally {
      this.applyInFlight = false;
    }
  }

  /**
   * Toggle fish mode (摸鱼) without rebuilding media.
   * Returns how many live sessions accepted the attribute write.
   * Fail closed when no sessions can be updated.
   */
  async setFishMode(enabled: boolean): Promise<{
    ok: boolean;
    fish: boolean;
    sessions: number;
    error?: string;
  }> {
    this.assertOpen();
    const want = Boolean(enabled);
    if (want) {
      // Refuse fish with no background — avoids a black "broken" window.
      const media = this.lastPayload?.media;
      if (!media || media === "clear") {
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
      if (this.sessions.size === 0) {
        await this.connect();
      } else {
        await this.reconcileSessions();
      }
    } catch (err) {
      // Desired state is still remembered for the next successful inject.
      return {
        ok: false,
        fish: this.fishMode,
        sessions: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (this.sessions.size === 0) {
      return {
        ok: false,
        fish: this.fishMode,
        sessions: 0,
        error: "No live CDP sessions",
      };
    }
    let okCount = 0;
    const errors: string[] = [];
    for (const [id, session] of this.sessions) {
      if (session.closed) {
        this.sessions.delete(id);
        continue;
      }
      try {
        const applied = await setSessionFishMode(session, want);
        if (applied) okCount += 1;
        else {
          errors.push(`${id}: runtime rejected fish mode (no background?)`);
        }
      } catch (err) {
        errors.push(
          `${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (okCount === 0) {
      return {
        ok: false,
        fish: this.fishMode,
        sessions: 0,
        error:
          errors[0] ??
          "Could not toggle fish mode on any session",
      };
    }
    return { ok: true, fish: this.fishMode, sessions: okCount };
  }

  /** Change only the CSS overlay tone; media and generation stay untouched. */
  async setBackgroundTone(tone: BackgroundTone): Promise<{
    ok: boolean;
    tone: BackgroundTone;
    sessions: number;
    error?: string;
  }> {
    this.assertOpen();
    const want: BackgroundTone =
      tone === "light" || tone === "auto" ? tone : "dark";
    this.backgroundTone = want;
    // There may be no injected runtime yet (fresh tray / cleared background).
    // Remember the preference and apply it on the next background publish.
    if (!this.lastPayload || this.lastPayload.media === "clear") {
      return { ok: true, tone: this.backgroundTone, sessions: 0 };
    }
    try {
      if (this.sessions.size === 0) {
        await this.connect();
      } else {
        await this.reconcileSessions();
      }
    } catch (err) {
      return {
        ok: false,
        tone: this.backgroundTone,
        sessions: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    let okCount = 0;
    const errors: string[] = [];
    for (const [id, session] of this.sessions) {
      if (session.closed) {
        this.sessions.delete(id);
        continue;
      }
      try {
        if (await setSessionBackgroundTone(session, want)) okCount += 1;
        else errors.push(`${id}: renderer does not support background tone`);
      } catch (err) {
        errors.push(
          `${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (okCount === 0) {
      return {
        ok: false,
        tone: this.backgroundTone,
        sessions: 0,
        error: errors[0] ?? "Could not set background tone on any session",
      };
    }
    return { ok: true, tone: this.backgroundTone, sessions: okCount };
  }

  /**
   * Toggle background video mute without rebuilding media.
   * muted=true → silent (default). muted=false → try to enable sound.
   * Fail soft on autoplay policy: keep playing muted and report blocked.
   */
  async setMuted(muted: boolean): Promise<{
    ok: boolean;
    muted: boolean;
    blocked: boolean;
    sessions: number;
    error?: string;
  }> {
    this.assertOpen();
    const wantMuted = Boolean(muted);
    this.videoMuted = wantMuted;
    try {
      if (this.sessions.size === 0) {
        await this.connect();
      } else {
        await this.reconcileSessions();
      }
    } catch (err) {
      return {
        ok: false,
        muted: this.videoMuted,
        blocked: false,
        sessions: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (this.sessions.size === 0) {
      // Preference remembered for the next inject even with no live page.
      return {
        ok: true,
        muted: this.videoMuted,
        blocked: false,
        sessions: 0,
      };
    }
    let okCount = 0;
    let anyBlocked = false;
    const errors: string[] = [];
    for (const [id, session] of this.sessions) {
      if (session.closed) {
        this.sessions.delete(id);
        continue;
      }
      try {
        const result = await setSessionMuted(session, wantMuted);
        if (result && result.ok) {
          okCount += 1;
          if (result.blocked) anyBlocked = true;
        } else if (result) {
          // Runtime present but no video yet — still count as accepted preference.
          okCount += 1;
        } else {
          errors.push(`${id}: runtime rejected mute toggle`);
        }
      } catch (err) {
        errors.push(
          `${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (okCount === 0) {
      return {
        ok: false,
        muted: this.videoMuted,
        blocked: false,
        sessions: 0,
        error: errors[0] ?? "Could not toggle mute on any session",
      };
    }
    return {
      ok: true,
      muted: this.videoMuted,
      blocked: anyBlocked,
      sessions: okCount,
    };
  }

  /**
   * Read live video currentTime from the first healthy session.
   * Used for continuous per-theme progress persistence.
   */
  async getPlaybackPosition(): Promise<{
    ok: boolean;
    currentTime: number;
    duration: number;
    hasVideo: boolean;
  }> {
    this.assertOpen();
    for (const [id, session] of this.sessions) {
      if (session.closed) {
        this.sessions.delete(id);
        continue;
      }
      try {
        const result = await readSessionPlaybackPosition(session);
        if (result && result.ok && result.hasVideo) {
          return result;
        }
        if (result && result.ok) {
          // Keep scanning; another session may have the video.
          continue;
        }
      } catch {
        /* try next */
      }
    }
    return { ok: false, currentTime: 0, duration: 0, hasVideo: false };
  }

  /**
   * Seek live video (or remember for pending attach). Invalid / past end → 0.
   */
  async seekTo(seconds: number): Promise<{
    ok: boolean;
    currentTime: number;
    sessions: number;
  }> {
    this.assertOpen();
    const sec = Number(seconds);
    const safe = Number.isFinite(sec) ? sec : 0;
    let okCount = 0;
    let lastTime = 0;
    for (const [id, session] of this.sessions) {
      if (session.closed) {
        this.sessions.delete(id);
        continue;
      }
      try {
        const result = await seekSessionTo(session, safe);
        if (result && result.ok) {
          okCount += 1;
          lastTime = result.currentTime;
        }
      } catch {
        /* try next */
      }
    }
    return {
      ok: okCount > 0,
      currentTime: lastTime,
      sessions: okCount,
    };
  }

  async verify(
    expected: VerifyExpectation,
    opts: { deadlineMs: number },
  ): Promise<VerifyResult> {
    this.assertOpen();
    if (this.sessions.size === 0) {
      try {
        await this.reconcileSessions();
      } catch (err) {
        return {
          status: "fail",
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    }
    const deadline = Date.now() + Math.max(0, opts.deadlineMs);
    let lastFail: VerifyResult | null = null;
    let lastInconclusive: VerifyResult | null = null;
    let stableFailHits = 0;

    while (Date.now() <= deadline) {
      if (this.closed) {
        return {
          status: "fail",
          reason: "host closed during verification",
        };
      }
      await this.reconcileSessions().catch(() => []);
      if (this.sessions.size === 0) {
        lastFail = {
          status: "fail",
          reason: "injector offline: no CDP sessions",
        };
        await sleep(this.pollMs);
        continue;
      }

      const results: VerifyResult[] = [];
      for (const [id, session] of this.sessions) {
        if (session.closed) {
          this.sessions.delete(id);
          continue;
        }
        try {
          const snap = await session.evaluate<
            ReadinessSnapshot & { missingRuntime?: boolean }
          >(SNAPSHOT_EXPRESSION);
          if (snap?.missingRuntime) {
            results.push({
              status: "inconclusive",
              reason: "runtime not yet present",
            });
            continue;
          }
          results.push(assessReadiness(snap, expected));
        } catch (err) {
          // Transient evaluate blips retry within deadline (#294).
          results.push({
            status: "inconclusive",
            reason: `evaluate transient: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }

      if (results.length === 0) {
        await sleep(this.pollMs);
        continue;
      }

      const pass = results.find((r) => r.status === "pass");
      if (pass) {
        return pass;
      }

      const fails = results.filter((r) => r.status === "fail");
      const inconclusives = results.filter((r) => r.status === "inconclusive");
      if (fails.length > 0) {
        lastFail = fails[0]!;
        // Structural fails that cannot self-heal by waiting on paint.
        const structural = fails.every(
          (r) =>
            r.reason.includes("generation mismatch") ||
            r.reason.includes("horizontal document overflow") ||
            r.reason.includes("pointer-events") ||
            r.reason.includes("decode/playback failed") ||
            r.reason.includes("decode failed") ||
            r.reason.includes("playable local source") ||
            r.reason.includes("expected but renderer reports") ||
            r.reason.includes("node missing") ||
            r.reason.includes("stage missing") ||
            r.reason.includes("poster/image missing") ||
            r.reason.includes("clear expected"),
        );
        if (structural) {
          stableFailHits += 1;
          // Confirm once so a single torn read cannot abort a good apply.
          if (stableFailHits >= 2) return lastFail;
        } else {
          stableFailHits = 0;
        }
      }
      if (inconclusives.length > 0) {
        lastInconclusive = inconclusives[0]!;
      }
      if (this.closed) {
        return {
          status: "fail",
          reason: "host closed during verification",
        };
      }
      await sleep(this.pollMs);
    }

    // Pass already returned; prefer hard fail over a merely inconclusive sample.
    if (lastFail) return lastFail;
    if (lastInconclusive) return lastInconclusive;
    return {
      status: "fail",
      reason: "no verification samples collected",
    };
  }

  /**
   * Heal targets that lost the runtime; no-op when the last payload is already
   * live and healthy. Watch loops must not full-reinject every poll.
   */
  async reapplyLast(): Promise<void> {
    if (!this.lastPayload) return;
    // Let an in-flight inject+attach finish; re-entering resets the stage.
    if (this.applyInFlight) return;
    // Grace window after a recent apply so cold decode can reach ready
    // without the watch loop tearing the stage down mid-blob.
    if (Date.now() - this.lastApplyStartedAt < 8_000) {
      // Still heal only if completely missing runtime; otherwise wait.
      let missingAll = true;
      for (const session of this.sessions.values()) {
        if (session.closed) continue;
        try {
          const snap = await session.evaluate<{ missingRuntime?: boolean }>(
            SNAPSHOT_EXPRESSION,
          );
          if (snap && !snap.missingRuntime) {
            missingAll = false;
            break;
          }
        } catch {
          /* treat as missing */
        }
      }
      if (!missingAll) return;
    }
    await this.reconcileSessions().catch(() => []);
    if (this.sessions.size === 0) {
      await this.apply(this.lastPayload);
      return;
    }
    const payload = this.lastPayload;
    let needsApply = false;
    for (const session of this.sessions.values()) {
      if (session.closed) continue;
      if (!(await sessionHasHealthyPayload(session, payload))) {
        needsApply = true;
        break;
      }
    }
    if (!needsApply) return;
    await this.apply(payload);
  }

  close(): void {
    this.closed = true;
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }

  private assertOpen(): void {
    if (this.closed) throw new CdpError("CodexHostApplier is closed");
  }
}

const VIDEO_INPUT_SELECTOR = "#beauticode-video-input";

async function setSessionFishMode(
  session: CdpSession,
  enabled: boolean,
): Promise<boolean> {
  // enabled is a boolean literal — never interpolate untrusted input here.
  const flag = enabled ? "true" : "false";
  const expr = `(() => {
    const api = window.__BEAUTICODE_BG__;
    if (!api || typeof api.setFishMode !== "function") return false;
    try {
      return Boolean(api.setFishMode(${flag}));
    } catch (_) {
      return false;
    }
  })()`;
  const result = await session.evaluate<boolean>(expr);
  return Boolean(result);
}

async function setSessionMuted(
  session: CdpSession,
  muted: boolean,
): Promise<{ ok: boolean; muted: boolean; blocked: boolean; hasVideo: boolean } | null> {
  const flag = muted ? "true" : "false";
  // userGesture helps Chromium accept unmute after a muted autoplay start.
  const expr = `(() => {
    const api = window.__BEAUTICODE_BG__;
    if (!api || typeof api.setMuted !== "function") return null;
    try {
      const r = api.setMuted(${flag});
      if (!r || typeof r !== "object") {
        return { ok: false, muted: true, blocked: false, hasVideo: false };
      }
      return {
        ok: Boolean(r.ok),
        muted: Boolean(r.muted),
        blocked: Boolean(r.blocked),
        hasVideo: Boolean(r.hasVideo),
      };
    } catch (_) {
      return null;
    }
  })()`;
  const result = await session.evaluate<{
    ok: boolean;
    muted: boolean;
    blocked: boolean;
    hasVideo: boolean;
  } | null>(expr, { userGesture: true });
  return result ?? null;
}

async function setSessionBackgroundTone(
  session: CdpSession,
  tone: BackgroundTone,
): Promise<boolean> {
  const toneLiteral = JSON.stringify(tone);
  const expr = `(() => {
    const api = window.__BEAUTICODE_BG__;
    if (!api || typeof api.setBackgroundTone !== "function") return false;
    try {
      return Boolean(api.setBackgroundTone(${toneLiteral}));
    } catch (_) {
      return false;
    }
  })()`;
  return Boolean(await session.evaluate<boolean>(expr));
}

async function readSessionPlaybackPosition(
  session: CdpSession,
): Promise<{
  ok: boolean;
  currentTime: number;
  duration: number;
  hasVideo: boolean;
} | null> {
  const expr = `(() => {
    const api = window.__BEAUTICODE_BG__;
    if (!api || typeof api.getPlaybackPosition !== "function") return null;
    try {
      const r = api.getPlaybackPosition();
      if (!r || typeof r !== "object") return null;
      const t = Number(r.currentTime);
      const d = Number(r.duration);
      return {
        ok: Boolean(r.ok),
        currentTime: Number.isFinite(t) && t >= 0 ? t : 0,
        duration: Number.isFinite(d) && d > 0 ? d : 0,
        hasVideo: Boolean(r.hasVideo),
      };
    } catch (_) {
      return null;
    }
  })()`;
  return (
    (await session.evaluate<{
      ok: boolean;
      currentTime: number;
      duration: number;
      hasVideo: boolean;
    } | null>(expr)) ?? null
  );
}

async function seekSessionTo(
  session: CdpSession,
  seconds: number,
): Promise<{ ok: boolean; currentTime: number; hasVideo: boolean } | null> {
  // seconds is a finite number from our code — JSON-encode for the page.
  const secLit = JSON.stringify(Number.isFinite(seconds) ? seconds : 0);
  const expr = `(() => {
    const api = window.__BEAUTICODE_BG__;
    if (!api || typeof api.seekTo !== "function") return null;
    try {
      const r = api.seekTo(${secLit});
      if (!r || typeof r !== "object") return null;
      const t = Number(r.currentTime);
      return {
        ok: Boolean(r.ok),
        currentTime: Number.isFinite(t) && t >= 0 ? t : 0,
        hasVideo: Boolean(r.hasVideo),
      };
    } catch (_) {
      return null;
    }
  })()`;
  return (
    (await session.evaluate<{
      ok: boolean;
      currentTime: number;
      hasVideo: boolean;
    } | null>(expr)) ?? null
  );
}

/**
 * True when the renderer already shows the requested generation/media in a
 * stable state — used to skip watch-loop reinject and blob re-attach.
 */
async function sessionHasHealthyPayload(
  session: CdpSession,
  payload: HostApplyPayload,
): Promise<boolean> {
  try {
    const snap = await session.evaluate<{
      missingRuntime?: boolean;
      generation?: number;
      active?: boolean;
      media?: string | null;
      videoReady?: boolean;
      videoFailed?: boolean;
      hasStage?: boolean;
      hasImage?: boolean;
      imageLoaded?: boolean;
      imageFailed?: boolean;
      hasVideo?: boolean;
      hasPlayableSrc?: boolean;
    }>(SNAPSHOT_EXPRESSION);
    if (!snap || snap.missingRuntime) return false;
    if (Number(snap.generation) !== Number(payload.generation)) return false;
    if (payload.media === "clear") {
      return snap.active !== true && snap.hasStage !== true;
    }
    if (!snap.active || !snap.hasStage) return false;
    if (payload.media === "image") {
      return (
        Boolean(snap.hasImage) &&
        snap.imageLoaded === true &&
        snap.imageFailed !== true &&
        snap.media === "image"
      );
    }
    if (payload.media === "video") {
      // Only skip when THIS generation's video is actually playable.
      // Handoff can leave a previous <video> mounted — that is not healthy
      // for the new payload and must not skip blob attach.
      if (
        !snap.videoFailed &&
        snap.media === "video" &&
        snap.videoReady &&
        snap.hasVideo &&
        snap.hasPlayableSrc === true
      ) {
        return true;
      }
      return false;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Push a host-local MP4 into the page via CDP DOM.setFileInputFiles, then
 * ask the runtime to turn the File into a blob: object URL (Dream Skin path).
 * Required on Codex Desktop: data: multi-MB sources stall at readyState 0,
 * and loopback fetch is blocked by CSP.
 */
async function attachBlobVideoToSession(
  session: CdpSession,
  localPath: string,
): Promise<void> {
  const deadline = Date.now() + 8_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const inputReady = await session.evaluate<boolean>(
        `Boolean(window.__BEAUTICODE_BG__ && typeof window.__BEAUTICODE_BG__.ensureVideoInput === "function" && window.__BEAUTICODE_BG__.ensureVideoInput())`,
      );
      if (!inputReady) {
        throw new Error("Renderer did not create the video file input");
      }
      await session.send("DOM.enable");
      const doc = (await session.send("DOM.getDocument", {
        depth: 0,
        pierce: false,
      })) as { root?: { nodeId?: number } };
      const rootId = doc?.root?.nodeId;
      if (typeof rootId !== "number") {
        throw new Error("DOM.getDocument returned no root nodeId");
      }
      const node = (await session.send("DOM.querySelector", {
        nodeId: rootId,
        selector: VIDEO_INPUT_SELECTOR,
      })) as { nodeId?: number };
      if (!node?.nodeId) {
        throw new Error("Video file input is not attached to the renderer DOM");
      }
      await session.send("DOM.setFileInputFiles", {
        nodeId: node.nodeId,
        files: [localPath],
      });
      // attachVideoFile is async — expression must return the Promise so
      // Runtime.evaluate(awaitPromise) waits for the blob URL assignment.
      const attached = await session.evaluate<boolean>(
        `(async () => {
        const api = window.__BEAUTICODE_BG__;
        if (!api || typeof api.attachVideoFile !== "function") return false;
        try {
          return Boolean(await api.attachVideoFile());
        } catch (_) {
          return false;
        }
      })()`,
        { userGesture: true },
      );
      if (attached) {
        // Second gesture-backed play nudge — attach may mark ready while
        // autoplay is still settling on a cold decoder. Keep cold play muted
        // for autoplay policy; host apply path re-asserts mute preference after.
        await session
          .evaluate(
            `(async () => {
          const v = document.querySelector("#beauticode-bg-stage video");
          if (!v) return false;
          try {
            v.muted = true;
            v.defaultMuted = true;
            const p = v.play();
            if (p && typeof p.then === "function") await p.catch(() => {});
          } catch (_) {}
          try {
            const api = window.__BEAUTICODE_BG__;
            if (api && typeof api.applyMutePreference === "function") {
              api.applyMutePreference();
            }
          } catch (_) {}
          return !v.paused || v.readyState >= 2;
        })()`,
            { userGesture: true },
          )
          .catch(() => false);
        return;
      }
      const prepared = await session.evaluate<boolean>(`(() => {
        const api = window.__BEAUTICODE_BG__;
        const video = document.querySelector("#beauticode-bg-stage video");
        return Boolean(video && video.src && !(api && api.videoFailed));
      })()`);
      if (prepared) return;
      const failed = await session.evaluate<boolean>(
        `Boolean(window.__BEAUTICODE_BG__ && window.__BEAUTICODE_BG__.videoFailed)`,
      );
      // Runtime already reported failure — let verify surface it; don't loop.
      if (failed) return;
    } catch (err) {
      lastError = err;
    }
    await sleep(120);
  }
  const detail =
    lastError instanceof Error ? lastError.message : String(lastError ?? "timed out");
  throw new CdpError(`Could not attach the local MP4 through CDP: ${detail}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
