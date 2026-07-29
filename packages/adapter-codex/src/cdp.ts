import {
  MAX_CDP_JSON_BYTES,
  readBoundedJson,
} from "./discovery.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;

export class CdpError extends Error {
  cdpCode?: number;
  constructor(message: string, cdpCode?: number) {
    super(message);
    this.name = "CdpError";
    if (cdpCode !== undefined) this.cdpCode = cdpCode;
  }
}

export class CdpIdentityMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CdpIdentityMismatchError";
  }
}

export interface CdpTargetInfo {
  id: string;
  type: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

export interface CdpVersionInfo {
  Browser?: string;
  "Protocol-Version"?: string;
  webSocketDebuggerUrl?: string;
}

export interface PageTargetFilterOptions {
  /**
   * Permit exact loopback HTTP origins for test pages.
   * Production callers should keep this false.
   */
  allowLoopbackHttp?: boolean;
  /** Permit about:blank during explicit test/bootstrap flows. */
  allowAboutBlank?: boolean;
}

function isAllowedPageUrl(
  value: string,
  opts: PageTargetFilterOptions,
): boolean {
  if (value === "about:blank") return opts.allowAboutBlank === true;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (
    url.protocol === "app:" &&
    url.hostname === "-" &&
    !url.username &&
    !url.password
  ) {
    return true;
  }
  if (!opts.allowLoopbackHttp || url.protocol !== "http:") return false;
  return (
    (url.hostname === "127.0.0.1" ||
      url.hostname === "localhost" ||
      url.hostname === "[::1]") &&
    !url.username &&
    !url.password
  );
}

/**
 * Only accept loopback debugger URLs with a strict path shape.
 * Upstream lesson: never follow a CDP-advertised ws:// off-box.
 */
export function validatedDebuggerUrl(
  target: { webSocketDebuggerUrl?: string },
  port: number,
): string {
  if (typeof target.webSocketDebuggerUrl !== "string") {
    throw new CdpError("CDP target is missing webSocketDebuggerUrl");
  }
  let url: URL;
  try {
    url = new URL(target.webSocketDebuggerUrl);
  } catch {
    throw new CdpError("CDP webSocketDebuggerUrl is not a valid URL");
  }
  const pathIsValid = /^\/devtools\/(?:page|browser)\/[A-Za-z0-9._-]{1,200}$/.test(
    url.pathname,
  );
  if (
    url.protocol !== "ws:" ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    Number(url.port) !== port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !pathIsValid
  ) {
    throw new CdpError(
      "Rejected a CDP WebSocket URL outside the allowed loopback endpoint shape",
    );
  }
  // Normalize hostname to 127.0.0.1 for the actual connection.
  url.hostname = "127.0.0.1";
  return url.href;
}

export function browserIdFromVersion(
  version: CdpVersionInfo,
  port: number,
): string {
  const href = validatedDebuggerUrl(version, port);
  const parsed = new URL(href);
  const match = parsed.pathname.match(
    /^\/devtools\/browser\/([A-Za-z0-9._-]{1,200})$/,
  );
  if (!match?.[1] || !ID_PATTERN.test(match[1])) {
    throw new CdpError("Rejected an invalid CDP browser identity URL");
  }
  return match[1];
}

/**
 * Page targets we are willing to inject into.
 * Production: app:// Codex renderers.
 * Tests: loopback http pages.
 */
export function isCandidatePageTarget(
  item: unknown,
  port: number,
  opts: PageTargetFilterOptions = {},
): item is CdpTargetInfo {
  if (!item || typeof item !== "object") return false;
  const t = item as CdpTargetInfo;
  if (t.type !== "page" || typeof t.id !== "string" || !ID_PATTERN.test(t.id)) {
    return false;
  }
  if (typeof t.webSocketDebuggerUrl !== "string") return false;
  const pageUrl = typeof t.url === "string" ? t.url : "";
  if (!isAllowedPageUrl(pageUrl, opts)) return false;
  try {
    const debuggerUrl = new URL(validatedDebuggerUrl(t, port));
    return debuggerUrl.pathname === `/devtools/page/${t.id}`;
  } catch {
    return false;
  }
}

export async function fetchCdpVersion(port: number): Promise<CdpVersionInfo> {
  const version = await readBoundedJson(
    `http://127.0.0.1:${port}/json/version`,
  );
  if (!version || typeof version !== "object" || Array.isArray(version)) {
    throw new CdpError("CDP /json/version returned an unexpected shape");
  }
  return version as CdpVersionInfo;
}

export async function fetchCdpTargetList(port: number): Promise<unknown[]> {
  const list = await readBoundedJson(`http://127.0.0.1:${port}/json/list`);
  if (!Array.isArray(list)) {
    throw new CdpError("CDP /json/list is not an array");
  }
  if (list.length > 500) {
    throw new CdpError("CDP /json/list exceeded target count safety cap");
  }
  return list;
}

export async function listPageTargets(
  port: number,
  expectedBrowserId: string | null = null,
  opts: PageTargetFilterOptions = {},
): Promise<CdpTargetInfo[]> {
  if (expectedBrowserId) {
    const version = await fetchCdpVersion(port);
    const actual = browserIdFromVersion(version, port);
    if (actual !== expectedBrowserId) {
      throw new CdpIdentityMismatchError(
        `CDP browser identity changed from ${expectedBrowserId} to ${actual}`,
      );
    }
  }
  const list = await fetchCdpTargetList(port);
  return list.filter((item): item is CdpTargetInfo =>
    isCandidatePageTarget(item, port, opts),
  );
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export interface CdpSessionOptions {
  openTimeoutMs?: number;
  commandTimeoutMs?: number;
  enableDomains?: boolean;
}

/**
 * Minimal CDP session over a page (or browser) WebSocket.
 * Node 22+ global WebSocket.
 */
export class CdpSession {
  readonly target: { webSocketDebuggerUrl?: string; id?: string; url?: string };
  readonly port: number;
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Array<(params: unknown) => void>>();
  closed = false;
  private readonly commandTimeoutMs: number;
  private readonly enableDomains: boolean;
  private readonly openTimeoutMs: number;

  constructor(
    target: { webSocketDebuggerUrl?: string; id?: string; url?: string },
    port: number,
    opts: CdpSessionOptions = {},
  ) {
    this.target = target;
    this.port = port;
    this.openTimeoutMs = opts.openTimeoutMs ?? 5_000;
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 10_000;
    this.enableDomains = opts.enableDomains ?? true;
    this.ws = new WebSocket(validatedDebuggerUrl(target, port));
  }

  async open(): Promise<this> {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        try {
          this.ws.close();
        } catch {
          /* ignore */
        }
        reject(new CdpError("CDP WebSocket open timed out"));
      }, this.openTimeoutMs);
      this.ws.addEventListener(
        "open",
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
      this.ws.addEventListener(
        "error",
        () => {
          clearTimeout(timeout);
          reject(new CdpError("CDP WebSocket open failed"));
        },
        { once: true },
      );
    });

    this.ws.addEventListener("message", (event) => this.onMessage(event));
    this.ws.addEventListener("error", () => this.close());
    this.ws.addEventListener("close", () => {
      this.closed = true;
      for (const waiter of this.pending.values()) {
        clearTimeout(waiter.timeout);
        waiter.reject(new CdpError("CDP socket closed"));
      }
      this.pending.clear();
    });

    if (this.enableDomains) {
      await this.send("Runtime.enable");
      await this.send("Page.enable");
    }
    return this;
  }

  private onMessage(event: MessageEvent): void {
    let message: { id?: number; error?: { message?: string; code?: number }; result?: unknown; method?: string; params?: unknown } | null;
    try {
      const raw = typeof event.data === "string" ? event.data : String(event.data);
      if (raw.length > MAX_CDP_JSON_BYTES) {
        this.close();
        return;
      }
      const parsed: unknown = JSON.parse(raw);
      message =
        parsed && typeof parsed === "object"
          ? (parsed as typeof message)
          : null;
    } catch {
      this.close();
      return;
    }
    if (!message) {
      this.close();
      return;
    }
    if (message.id) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      clearTimeout(waiter.timeout);
      this.pending.delete(message.id);
      if (message.error) {
        waiter.reject(
          new CdpError(
            `${message.error.message ?? "CDP error"} (${message.error.code ?? "?"})`,
            message.error.code,
          ),
        );
      } else {
        waiter.resolve(message.result);
      }
      return;
    }
    if (typeof message.method === "string") {
      for (const listener of this.listeners.get(message.method) ?? []) {
        listener(message.params ?? {});
      }
    }
  }

  on(method: string, listener: (params: unknown) => void): void {
    const list = this.listeners.get(method) ?? [];
    list.push(listener);
    this.listeners.set(method, list);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new CdpError("CDP session is closed"));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`CDP command timed out: ${method}`));
      }, this.commandTimeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new CdpError(String(error)));
      }
    });
  }

  async evaluate<T = unknown>(
    expression: string,
    opts: { userGesture?: boolean } = {},
  ): Promise<T> {
    const result = (await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      // true so muted video.play() is not blocked by autoplay policy
      // after CDP file-input attach (Dream Skin path).
      userGesture: opts.userGesture ?? true,
    })) as {
      exceptionDetails?: {
        text?: string;
        exception?: { description?: string };
      };
      result?: { value?: T };
    };
    if (result?.exceptionDetails) {
      const detail =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "unknown";
      throw new CdpError(`Renderer evaluation failed: ${detail}`);
    }
    return result?.result?.value as T;
  }

  close(): void {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(new CdpError("CDP session closed"));
    }
    this.pending.clear();
    if (!this.closed) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
    }
    this.closed = true;
  }
}

export async function connectPageTarget(
  target: CdpTargetInfo,
  port: number,
  opts?: CdpSessionOptions,
): Promise<CdpSession> {
  return new CdpSession(target, port, opts).open();
}
