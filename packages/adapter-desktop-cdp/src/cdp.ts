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
  if (!response.ok) throw new Error(`CDP HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error("CDP response exceeded the safety limit.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new Error("CDP response exceeded the safety limit.");
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

export function isDesktopTarget(
  spec: DesktopCdpHostSpec,
  target: DesktopTarget,
): boolean {
  if (target.type !== "page") return false;
  const url = String(target.url);
  if (spec.kind === "cursor") {
    // Cursor 的 workbench 页 URL 内嵌实际安装路径（每台机器不同），
    // 严格等值会让所有非作者安装位置的用户 100% 静默失效。改为结构
    // 匹配：锚定 scheme 前缀（targetRuntimeUrl）+ 固定的 workbench
    // 后缀，路径段允许任意安装位置；失败关闭语义不变（不命中即拒绝）。
    return (
      url.startsWith(spec.targetRuntimeUrl) &&
      /\/out\/vs\/code\/electron-sandbox\/workbench\/workbench\.html$/i.test(
        url,
      )
    );
  }
  return url === spec.targetUrl;
}

export function pickDesktopTarget(
  spec: DesktopCdpHostSpec,
  targets: readonly DesktopTarget[],
): DesktopTarget | null {
  return targets.find((target) => isDesktopTarget(spec, target)) ?? null;
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
    const target = pickDesktopTarget(spec, targets);
    if (!target?.webSocketDebuggerUrl) return null;
    assertLoopbackDebuggerUrl(target.webSocketDebuggerUrl, port);
    return {
      port,
      browserUrl,
      browser: typeof version.Browser === "string" ? version.Browser : null,
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
  for (const port of [...new Set(ports)]) {
    const endpoint = await probeDesktopCdp(spec, port);
    if (endpoint) return endpoint;
  }
  return null;
}
