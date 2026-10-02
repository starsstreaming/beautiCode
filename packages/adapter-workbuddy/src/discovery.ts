import { pickWorkBuddyTarget, type WorkBuddyTarget } from "./target.js";

/** Hard cap for CDP discovery JSON (same bound as Codex / upstream #280). */
export const MAX_CDP_JSON_BYTES = 1_000_000;

export const WORKBUDDY_CDP_ENV_KEY = "WORKBUDDY_REMOTE_DEBUGGING_PORT";

export const DEFAULT_WORKBUDDY_CDP_PORT = 9335;

/** Bounded loopback candidates — never scan the whole range. */
export const DEFAULT_WORKBUDDY_CDP_PORTS: readonly number[] = Object.freeze([
  9335,
  9222,
  9223,
  9229,
  9230,
  9300,
  9310,
  9320,
  9340,
  9350,
]);

export interface DiscoveredWorkBuddyCdp {
  port: number;
  browserUrl: string;
  webSocketDebuggerUrl?: string;
  browser?: string;
  source: "probe" | "process";
}

const LOOPBACK_ADDRS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function parseRemoteDebuggingFlags(commandLine: string): {
  port: number | null;
  address: string | null;
  safe: boolean;
} {
  if (typeof commandLine !== "string" || !commandLine) {
    return { port: null, address: null, safe: false };
  }
  const portMatch = commandLine.match(
    /--remote-debugging-port\s*=\s*(?:"(\d{1,5})"|'(\d{1,5})'|(\d{1,5})\b)/i,
  );
  const addrMatch = commandLine.match(
    /--remote-debugging-address\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"']+))/i,
  );
  const portValue = portMatch?.[1] ?? portMatch?.[2] ?? portMatch?.[3];
  const addressValue = addrMatch?.[1] ?? addrMatch?.[2] ?? addrMatch?.[3];
  const port = portValue ? Number(portValue) : null;
  const address = addressValue ? String(addressValue).trim() : null;
  if (port == null || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { port: null, address, safe: false };
  }
  if (address && !LOOPBACK_ADDRS.has(address.toLowerCase())) {
    return { port, address, safe: false };
  }
  return { port, address, safe: true };
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
    const res = await fetch(url, { signal: ctrl.signal, redirect: "error" });
    if (!res.ok) throw new Error(`CDP HTTP ${res.status} for ${url}`);
    const declaredLength = Number(res.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new Error(
        `CDP response exceeded ${maxBytes} bytes (declared ${declaredLength}).`,
      );
    }
    if (!res.body) throw new Error(`CDP response had no readable body for ${url}`);
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
          throw new Error(`CDP response exceeded ${maxBytes} bytes while streaming.`);
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
    return JSON.parse(new TextDecoder("utf-8").decode(buf)) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

export async function probeCdpPort(
  port: number,
  opts: { timeoutMs?: number } = {},
): Promise<{
  browserUrl: string;
  webSocketDebuggerUrl?: string;
  browser?: string;
} | null> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const browserUrl = `http://127.0.0.1:${port}`;
  try {
    const version = (await readBoundedJson(`${browserUrl}/json/version`, {
      timeoutMs: opts.timeoutMs ?? 450,
    })) as { webSocketDebuggerUrl?: string; Browser?: string };
    if (!version || typeof version !== "object") return null;
    const endpoint: {
      browserUrl: string;
      webSocketDebuggerUrl?: string;
      browser?: string;
    } = { browserUrl };
    if (typeof version.webSocketDebuggerUrl === "string") {
      endpoint.webSocketDebuggerUrl = version.webSocketDebuggerUrl;
    }
    if (typeof version.Browser === "string") endpoint.browser = version.Browser;
    return endpoint;
  } catch {
    return null;
  }
}

async function listTargets(port: number, timeoutMs: number): Promise<WorkBuddyTarget[]> {
  const raw = await readBoundedJson(`http://127.0.0.1:${port}/json/list`, {
    timeoutMs,
  });
  if (!Array.isArray(raw) || raw.length > 500) return [];
  const out: WorkBuddyTarget[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const rec = row as Record<string, unknown>;
    if (typeof rec.id !== "string" || typeof rec.type !== "string") continue;
    const target: WorkBuddyTarget = {
      id: rec.id,
      type: rec.type,
      url: typeof rec.url === "string" ? rec.url : "",
    };
    if (typeof rec.title === "string") target.title = rec.title;
    if (typeof rec.webSocketDebuggerUrl === "string") {
      target.webSocketDebuggerUrl = rec.webSocketDebuggerUrl;
    }
    out.push(target);
  }
  return out;
}

/**
 * Probe a loopback port and keep it only when the page identity is WorkBuddy.
 * Codex often sits on 9335 too — attaching to the wrong host is fail-closed.
 */
export async function probeWorkBuddyCdp(
  port: number,
  opts: { timeoutMs?: number } = {},
): Promise<DiscoveredWorkBuddyCdp | null> {
  const timeoutMs = opts.timeoutMs ?? 450;
  const endpoint = await probeCdpPort(port, { timeoutMs });
  if (!endpoint) return null;
  let targets: WorkBuddyTarget[] = [];
  try {
    targets = await listTargets(port, timeoutMs);
  } catch {
    return null;
  }
  if (!pickWorkBuddyTarget(targets)) return null;
  const found: DiscoveredWorkBuddyCdp = {
    port,
    browserUrl: endpoint.browserUrl,
    source: "probe",
  };
  if (endpoint.webSocketDebuggerUrl) {
    found.webSocketDebuggerUrl = endpoint.webSocketDebuggerUrl;
  }
  if (endpoint.browser) found.browser = endpoint.browser;
  return found;
}

export async function discoverWorkBuddyCdp(
  opts: { ports?: number[]; timeoutMs?: number } = {},
): Promise<DiscoveredWorkBuddyCdp | null> {
  const timeoutMs = opts.timeoutMs ?? 450;
  const portSet = new Set<number>();
  for (const p of opts.ports ?? DEFAULT_WORKBUDDY_CDP_PORTS) {
    if (Number.isInteger(p) && p >= 1 && p <= 65535) portSet.add(p);
  }
  for (const port of portSet) {
    const hit = await probeWorkBuddyCdp(port, { timeoutMs });
    if (hit) return hit;
  }
  return null;
}
