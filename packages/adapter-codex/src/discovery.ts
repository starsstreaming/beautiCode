/** Hard cap for CDP discovery JSON (upstream #280 lesson). */
export const MAX_CDP_JSON_BYTES = 1_000_000;

export interface CdpEndpoint {
  browserUrl: string;
  webSocketDebuggerUrl?: string;
  browser?: string;
  browserId?: string;
}

export async function readBoundedJson(
  url: string,
  opts: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<unknown> {
  const maxBytes = opts.maxBytes ?? MAX_CDP_JSON_BYTES;
  const timeoutMs = opts.timeoutMs ?? 3_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "error",
    });
    if (!res.ok) {
      throw new Error(`CDP HTTP ${res.status} for ${url}`);
    }
    const declaredLength = Number(res.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new Error(
        `CDP response exceeded ${maxBytes} bytes (declared ${declaredLength}).`,
      );
    }
    if (!res.body) {
      throw new Error(`CDP response had no readable body for ${url}`);
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel("response exceeded safety cap").catch(() => {});
          throw new Error(
            `CDP response exceeded ${maxBytes} bytes while streaming.`,
          );
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const buf = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      buf.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8").decode(buf);
    return JSON.parse(text) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe a loopback CDP port. Fails closed if nothing healthy is there
 * (upstream #235 — host may drop --remote-debugging-port entirely).
 */
export async function probeCdp(
  port: number,
  host = "127.0.0.1",
  opts: { timeoutMs?: number } = {},
): Promise<CdpEndpoint> {
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error("CDP probe only allows loopback hosts.");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("CDP port must be an integer 1–65535.");
  }
  const browserUrl = `http://127.0.0.1:${port}`;
  const version = (await readBoundedJson(`${browserUrl}/json/version`, {
    timeoutMs: opts.timeoutMs ?? 3_000,
  })) as {
    webSocketDebuggerUrl?: string;
    Browser?: string;
  };
  if (!version || typeof version !== "object") {
    throw new Error("CDP /json/version returned an unexpected shape.");
  }
  const endpoint: CdpEndpoint = { browserUrl };
  if (typeof version.webSocketDebuggerUrl === "string") {
    endpoint.webSocketDebuggerUrl = version.webSocketDebuggerUrl;
  }
  if (typeof version.Browser === "string") {
    endpoint.browser = version.Browser;
  }
  return endpoint;
}
