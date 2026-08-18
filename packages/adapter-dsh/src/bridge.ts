import type {
  BackgroundTone,
  HostApplier,
  HostApplyPayload,
  VerifyExpectation,
  VerifyResult,
} from "@beauticode/core";

export interface DshBridgeStatus {
  ok: true;
  connectedClients: number;
  current: { generation: number; media: "image" | "video" | "clear" } | null;
  readyClients: number;
  failedClients: number;
  visibleClients: number;
  modeReadyClients: number;
  blockedClients: number;
  resolvedTone: "dark" | "light" | null;
  modes: { fish: boolean; muted: boolean; tone: BackgroundTone };
  playback: {
    currentTime: number;
    duration: number;
    hasVideo: boolean;
    muted: boolean;
    paused: boolean;
    blocked: boolean;
  } | null;
}

export interface DshHostApplierOptions {
  baseUrl?: string;
  token: string;
  requestTimeoutMs?: number;
  pollMs?: number;
}

export function normalizeDshBaseUrl(value: string): URL {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(hostname) ||
    url.username ||
    url.password ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search ||
    url.hash
  ) {
    throw new Error("DeepSeek Harness URL must be loopback HTTP.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class DshHostApplier implements HostApplier {
  readonly baseUrl: URL;
  readonly requestTimeoutMs: number;
  readonly pollMs: number;
  private token: string;
  private lastStatus: DshBridgeStatus | null = null;

  constructor(opts: DshHostApplierOptions) {
    this.baseUrl = normalizeDshBaseUrl(opts.baseUrl ?? "http://127.0.0.1:3080");
    this.token = opts.token;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 3_000;
    this.pollMs = opts.pollMs ?? 150;
  }

  get origin(): string {
    return this.baseUrl.origin;
  }

  get activeSessionCount(): number {
    return this.lastStatus?.connectedClients ?? 0;
  }

  async status(): Promise<DshBridgeStatus> {
    try {
      const status = await this.#request<DshBridgeStatus>("status", { method: "GET" });
      if (!status || status.ok !== true || !Number.isInteger(status.connectedClients)) {
        throw new Error("DeepSeek Harness bridge returned an invalid status.");
      }
      this.lastStatus = status;
      return status;
    } catch (error) {
      this.lastStatus = null;
      throw error;
    }
  }

  async apply(payload: HostApplyPayload): Promise<void> {
    if (payload.media !== "clear" && !payload.imageUrl) {
      throw new Error("DeepSeek Harness background apply requires a loopback poster URL.");
    }
    if (payload.media === "video" && !payload.video?.srcUrl) {
      throw new Error("DeepSeek Harness video apply requires a loopback MP4 URL.");
    }
    const body: Record<string, unknown> = {
      generation: payload.generation,
      media: payload.media,
      imageUrl: payload.media === "clear" ? null : payload.imageUrl,
      videoUrl: payload.media === "video" ? payload.video?.srcUrl : null,
      startAt:
        payload.media === "video" && Number.isFinite(payload.video?.startAt)
          ? Math.max(0, Number(payload.video?.startAt))
          : null,
    };
    if (payload.atmosphere?.preset) body.atmosphere = payload.atmosphere;
    await this.#request("apply", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async setFishMode(enabled: boolean): Promise<{
    ok: boolean;
    fish: boolean;
    sessions: number;
    error?: string;
  }> {
    const result = await this.#setMode({ fish: Boolean(enabled) });
    return { ok: result.ok, fish: Boolean(enabled), sessions: result.sessions, ...(result.error ? { error: result.error } : {}) };
  }

  async setMuted(muted: boolean): Promise<{
    ok: boolean;
    muted: boolean;
    blocked: boolean;
    sessions: number;
    error?: string;
  }> {
    const result = await this.#setMode({ muted: Boolean(muted) });
    return {
      ok: result.ok,
      muted: Boolean(muted),
      blocked: result.blocked,
      sessions: result.sessions,
      ...(result.error ? { error: result.error } : {}),
    };
  }

  async setBackgroundTone(tone: BackgroundTone): Promise<{
    ok: boolean;
    tone: BackgroundTone;
    sessions: number;
    error?: string;
  }> {
    const normalized = tone === "light" || tone === "auto" ? tone : "dark";
    const result = await this.#setMode({ tone: normalized });
    return { ok: result.ok, tone: normalized, sessions: result.sessions, ...(result.error ? { error: result.error } : {}) };
  }

  async getPlaybackPosition(): Promise<{
    ok: boolean;
    currentTime: number;
    duration: number;
    hasVideo: boolean;
  }> {
    const status = await this.status();
    const playback = status.playback;
    if (!playback?.hasVideo) {
      return { ok: false, currentTime: 0, duration: 0, hasVideo: false };
    }
    return {
      ok: true,
      currentTime: Number.isFinite(playback.currentTime) ? playback.currentTime : 0,
      duration: Number.isFinite(playback.duration) ? playback.duration : 0,
      hasVideo: true,
    };
  }

  async verify(
    expected: VerifyExpectation,
    opts: { deadlineMs: number },
  ): Promise<VerifyResult> {
    const deadline = Date.now() + Math.max(0, opts.deadlineMs);
    let last: DshBridgeStatus | null = null;
    let lastError = "DeepSeek Harness bridge is unavailable.";
    do {
      try {
        last = await this.status();
        const currentMatches =
          last.current?.generation === expected.generation &&
          last.current.media === expected.media;
        if (currentMatches && last.readyClients > 0) {
          return {
            status: "pass",
            reason: "DeepSeek Harness client acknowledged the background.",
            details: { ...last },
          };
        }
        if (currentMatches && last.failedClients > 0 && last.readyClients === 0) {
          return {
            status: "fail",
            reason: "DeepSeek Harness client failed to render the background.",
            details: { ...last },
          };
        }
        lastError =
          last.connectedClients === 0
            ? "No DeepSeek Harness browser client is connected."
            : "DeepSeek Harness client has not acknowledged this generation.";
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (Date.now() >= deadline) break;
      await delay(Math.min(this.pollMs, Math.max(0, deadline - Date.now())));
    } while (true);
    return {
      status: "inconclusive",
      reason: lastError,
      ...(last ? { details: { ...last } } : {}),
    };
  }

  async #request<T = unknown>(
    route: "apply" | "mode" | "status",
    init: RequestInit,
  ): Promise<T> {
    const endpoint = new URL(`__beauticode/${route}`, this.baseUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await fetch(endpoint, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      });
      const body = (await response.json().catch(() => null)) as
        | { error?: unknown }
        | null;
      if (!response.ok) {
        const detail = typeof body?.error === "string" ? body.error : `HTTP ${response.status}`;
        throw new Error(`DeepSeek Harness bridge request failed: ${detail}`);
      }
      return body as T;
    } catch (error) {
      if ((error as Error)?.name === "AbortError") {
        throw new Error("DeepSeek Harness bridge request timed out.");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async #setMode(change: Partial<{ fish: boolean; muted: boolean; tone: BackgroundTone }>): Promise<{
    ok: boolean;
    sessions: number;
    blocked: boolean;
    error?: string;
  }> {
    await this.#request("mode", { method: "POST", body: JSON.stringify(change) });
    const deadline = Date.now() + this.requestTimeoutMs;
    let last: DshBridgeStatus | null = null;
    do {
      try {
        last = await this.status();
        if (last.connectedClients === 0) {
          return { ok: true, sessions: 0, blocked: false };
        }
        if (last.modeReadyClients > 0) {
          return {
            ok: true,
            sessions: last.modeReadyClients,
            blocked: last.blockedClients > 0,
          };
        }
      } catch (error) {
        if (Date.now() >= deadline) {
          return { ok: false, sessions: 0, blocked: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      if (Date.now() >= deadline) break;
      await delay(Math.min(this.pollMs, Math.max(0, deadline - Date.now())));
    } while (true);
    return {
      ok: false,
      sessions: 0,
      blocked: false,
      error: last?.connectedClients
        ? "DeepSeek Harness client did not acknowledge the mode change."
        : "No DeepSeek Harness browser client is connected.",
    };
  }
}
