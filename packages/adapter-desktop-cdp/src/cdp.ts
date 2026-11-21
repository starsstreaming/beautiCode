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

function sameChatPath(spec: DesktopCdpHostSpec, target: DesktopTarget): boolean {
  let parsed: URL;
  let expected: URL;
  try {
    parsed = new URL(target.url);
    expected = new URL(spec.targetUrl);
  } catch {
    return false;
  }
  if (parsed.protocol.toLowerCase() !== expected.protocol.toLowerCase()) return false;
  if (parsed.username || parsed.password || parsed.port) return false;
  const allowed = new Set([
    expected.hostname.toLowerCase(),
    ...(spec.targetHostnames ?? []).map((host) => host.toLowerCase()),
  ]);
  if (!allowed.has(parsed.hostname.toLowerCase())) return false;
  const pathOf = (value: string) => {
    const path = decodeURIComponent(value).replaceAll("\\", "/").replace(/\/+$/, "");
    return (path || "/").toLowerCase();
  };
  try {
    const actual = pathOf(parsed.pathname);
    const expectedPath = pathOf(expected.pathname);
    // The shell navigates to sub-routes (for example /chat/drive/home/). Keep
    // matching those; an unrelated prefix such as /chat-other must not match.
    return actual === expectedPath || actual.startsWith(`${expectedPath}/`);
  } catch {
    return false;
  }
}

/** Prefer the page with the largest measured area. Ties keep the earlier page. */
export function chooseDesktopTarget(
  matches: readonly DesktopTarget[],
  areas: readonly number[],
): DesktopTarget | null {
  if (!matches.length) return null;
  let best = 0;
  for (let index = 1; index < matches.length; index += 1) {
    if ((areas[index] ?? 0) > (areas[best] ?? 0)) best = index;
  }
  return matches[best] ?? null;
}

export function isDesktopTarget(
  spec: DesktopCdpHostSpec,
  target: DesktopTarget,
  browser = "",
): boolean {
  if (target.type !== "page") return false;
  const identity = spec.targetIdentity;
  if (!identity) {
    const route = spec.targetUrl.replace(/\/$/, "");
    return target.url === route || target.url === route + "/" ||
      (!!spec.targetHostnames?.length && sameChatPath(spec, target));
  }
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

function targetPriority(spec: DesktopCdpHostSpec, target: DesktopTarget): number {
  try {
    const actual = new URL(target.url);
    const expected = new URL(spec.targetUrl);
    const actualPath = decodeURIComponent(actual.pathname).replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase() || "/";
    const expectedPath = decodeURIComponent(expected.pathname).replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase() || "/";
    const primaryHost = actual.hostname.toLowerCase() === expected.hostname.toLowerCase();
    if (primaryHost && actualPath === expectedPath) return 3;
    if (primaryHost && actualPath.startsWith(`${expectedPath}/`)) return 2;
    if (!primaryHost && actualPath === expectedPath) return 1;
    return 0;
  } catch {
    return 0;
  }
}

export function pickDesktopTarget(
  spec: DesktopCdpHostSpec,
  targets: readonly DesktopTarget[],
  browser = "",
): DesktopTarget | null {
  // Several windows can render the same shell. Prefer the primary host's exact
  // chat route, then its sub-routes, and only then an extra hostname such as the
  // launcher. A stale launcher must never win over the window the user is in.
  let best: DesktopTarget | null = null;
  let bestPriority = -1;
  for (const target of targets) {
    if (!isDesktopTarget(spec, target, browser)) continue;
    const priority = spec.targetHostnames?.length ? targetPriority(spec, target) : 0;
    if (priority > bestPriority) {
      best = target;
      bestPriority = priority;
    }
  }
  return best;
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
  if (parsed.protocol !== "ws:" || !LOOPBACK_HOSTS.has(host) || parsed.username || parsed.password || parsed.hash) {
    throw new Error("Rejected a CDP WebSocket outside loopback.");
  }
  if (Number(parsed.port || 80) !== port) {
    throw new Error("CDP WebSocket port does not match the probed port.");
  }
  return rawUrl;
}

const MAX_MEASURED_PAGES = 8;

async function pageArea(spec: DesktopCdpHostSpec, target: DesktopTarget): Promise<number> {
  const ws = new WebSocket(target.webSocketDebuggerUrl!);
  try {
    return await new Promise<number>((resolve) => {
      const timer = setTimeout(() => resolve(0), 850);
      const finish = (area: number) => { clearTimeout(timer); resolve(area); };
      ws.addEventListener("close", () => finish(0), { once: true });
      ws.addEventListener("error", () => finish(0), { once: true });
      ws.addEventListener("message", event => {
        if (typeof event.data !== "string" || event.data.length > 4096) { finish(0); return; }
        try {
          const reply = JSON.parse(event.data) as { id?: number; result?: { result?: { value?: unknown } } };
          if (reply.id !== 1) return;
          const area = reply.result?.result?.value;
          finish(typeof area === "number" && Number.isFinite(area) && area > 0 ? area : 0);
        } catch { finish(0); }
      });
      ws.addEventListener("open", () => {
        try {
          ws.send(JSON.stringify({
            id: 1,
            method: "Runtime.evaluate",
            params: {
              returnByValue: true,
              expression: `document.visibilityState === 'visible' &&
                document.querySelector(${JSON.stringify(spec.anchorSelector)}) ? innerWidth * innerHeight : 0`,
            },
          }));
        } catch { finish(0); }
      }, { once: true });
    });
  } finally {
    ws.close();
  }
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
  options?: { preferredTargetId?: string },
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
    const matches = targets.filter(candidate => {
      if (!candidate.webSocketDebuggerUrl || !isDesktopTarget(spec, candidate, browser)) return false;
      try { assertLoopbackDebuggerUrl(candidate.webSocketDebuggerUrl, port); return true; }
      catch { return false; }
    });
    let target = pickDesktopTarget(spec, matches, browser);
    if (spec.targetHostnames?.length && (matches.length > 1 || options?.preferredTargetId)) {
      const preferred = matches.find(candidate => candidate.id === options?.preferredTargetId);
      const ordered = [...matches].sort((a, b) => targetPriority(spec, b) - targetPriority(spec, a));
      if (preferred) ordered.splice(ordered.indexOf(preferred), 1);
      if (preferred) ordered.unshift(preferred);
      const measured = ordered.slice(0, MAX_MEASURED_PAGES);
      const areas = await Promise.all(measured.map(candidate => pageArea(spec, candidate)));
      if (areas.some(area => area > 0)) target = chooseDesktopTarget(measured, areas);
      else if (options?.preferredTargetId) return null;
    }
    if (!target) return null;
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
