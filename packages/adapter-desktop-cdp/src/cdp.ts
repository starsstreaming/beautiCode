import type {
  DesktopCdpEndpoint,
  DesktopCdpHostSpec,
  DesktopTarget,
} from "./types.js";

export const MAX_DESKTOP_CDP_JSON_BYTES = 1_000_000;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function parseRemoteDebuggingFlags(commandLine: string): {
  port: number | null;
  address: string | null;
  safe: boolean;
} {
  const portMatch = String(commandLine).match(
    /--remote-debugging-port\s*=\s*(?:"(\d{1,5})"|'(\d{1,5})'|(\d{1,5})\b)/i,
  );
  const addressMatch = String(commandLine).match(
    /--remote-debugging-address\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"']+))/i,
  );
  const rawPort = portMatch?.[1] ?? portMatch?.[2] ?? portMatch?.[3];
  const address =
    addressMatch?.[1] ?? addressMatch?.[2] ?? addressMatch?.[3] ?? null;
  const port = rawPort ? Number(rawPort) : null;
  const safePort =
    port != null && Number.isInteger(port) && port >= 1 && port <= 65535;
  const safeAddress =
    !address || LOOPBACK_HOSTS.has(address.replace(/^\[|\]$/g, "").toLowerCase());
  return { port: safePort ? port : null, address, safe: safePort && safeAddress };
}

export async function readBoundedJson(
  url: string,
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? 700;
  const maxBytes = opts.maxBytes ?? MAX_DESKTOP_CDP_JSON_BYTES;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`CDP HTTP ${response.status}`);
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error("CDP response exceeded the safety limit.");
  }
  if (!response.body) throw new Error("CDP response had no readable body.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("CDP response exceeded the safety limit.");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

export function isDesktopTarget(
  spec: DesktopCdpHostSpec,
  target: DesktopTarget,
  browser = "",
): boolean {
  if (target.type !== "page") return false;
  const identity = spec.targetIdentity;
  if (!identity) return target.url === spec.targetUrl;
  let parsed: URL;
  try {
    parsed = new URL(target.url);
  } catch {
    return false;
  }
  if (
    parsed.protocol.toLowerCase() !== identity.protocol.toLowerCase() ||
    parsed.hostname.toLowerCase() !== identity.hostname.toLowerCase()
  ) {
    return false;
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(parsed.pathname).replaceAll("\\", "/").toLowerCase();
  } catch {
    return false;
  }
  const suffix = identity.pathSuffix.replaceAll("\\", "/").toLowerCase();
  if (!suffix || !pathname.endsWith(suffix)) return false;
  const evidence = identity.hostEvidence;
  if (!evidence) return true;
  const hasMarker = (value: string, markers: readonly string[] | undefined) =>
    !!markers?.length && markers.some((marker) => value.includes(String(marker).toLowerCase()));
  return (
    hasMarker(pathname, evidence.path) ||
    hasMarker(String(target.title || "").toLowerCase(), evidence.targetText) ||
    hasMarker(String(browser || "").toLowerCase(), evidence.browser)
  );
}

export function pickDesktopTarget(
  spec: DesktopCdpHostSpec,
  targets: readonly DesktopTarget[],
  browser = "",
): DesktopTarget | null {
  return targets.find((target) => isDesktopTarget(spec, target, browser)) ?? null;
}

export function safeTargetLabel(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.protocol}//${parsed.host}${decodeURIComponent(parsed.pathname)}`;
  } catch {
    return "(unparseable target url)";
  }
}

export function assertLoopbackDebuggerUrl(rawUrl: string, port: number): string {
  const parsed = new URL(rawUrl);
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (parsed.protocol !== "ws:" || !LOOPBACK_HOSTS.has(host)) {
    throw new Error("Rejected a CDP WebSocket outside loopback.");
  }
  if (Number(parsed.port || 80) !== port) {
    throw new Error("CDP WebSocket port does not match the probed port.");
  }
  return rawUrl;
}

function targetRows(value: unknown): DesktopTarget[] {
  if (!Array.isArray(value) || value.length > 500) return [];
  const rows: DesktopTarget[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      typeof row.type !== "string" ||
      typeof row.url !== "string"
    ) {
      continue;
    }
    const target: DesktopTarget = {
      id: row.id,
      type: row.type,
      url: row.url,
    };
    if (typeof row.title === "string") target.title = row.title;
    if (typeof row.webSocketDebuggerUrl === "string") {
      target.webSocketDebuggerUrl = row.webSocketDebuggerUrl;
    }
    rows.push(target);
  }
  return rows;
}

export async function probeDesktopCdp(
  spec: DesktopCdpHostSpec,
  port: number,
  timeoutMs = 700,
): Promise<DesktopCdpEndpoint | null> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const browserUrl = `http://127.0.0.1:${port}`;
  try {
    const version = (await readBoundedJson(`${browserUrl}/json/version`, {
      timeoutMs,
    })) as Record<string, unknown>;
    const targets = targetRows(
      await readBoundedJson(`${browserUrl}/json/list`, { timeoutMs }),
    );
    const browser = typeof version.Browser === "string" ? version.Browser : "";
    const target = pickDesktopTarget(spec, targets, browser);
    if (!target?.webSocketDebuggerUrl) return null;
    assertLoopbackDebuggerUrl(target.webSocketDebuggerUrl, port);
    return {
      port,
      browserUrl,
      browser: browser || null,
      target,
    };
  } catch {
    return null;
  }
}

export async function discoverDesktopCdp(
  spec: DesktopCdpHostSpec,
  ports: readonly number[] = [spec.defaultPort, ...spec.candidatePorts],
): Promise<DesktopCdpEndpoint | null> {
  const candidates = [...new Set(ports)].filter(
    (port) => Number.isInteger(port) && port >= 1 && port <= 65535,
  );
  // A dead loopback port may consume the per-request timeout. Probe the small,
  // explicit host allowlist concurrently, then preserve configured priority.
  // This keeps startup latency bounded by one endpoint probe, not N probes.
  const endpoints = await Promise.all(
    candidates.map((port) => probeDesktopCdp(spec, port)),
  );
  return endpoints.find((endpoint) => endpoint !== null) ?? null;
}
