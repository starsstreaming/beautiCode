import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { probeCdp } from "./discovery.js";
import {
  browserIdFromVersion,
  listPageTargets,
  type CdpTargetInfo,
} from "./cdp.js";

const execFileAsync = promisify(execFile);

/** Ports we are willing to probe on loopback only. Bounded — never scan the whole range. */
export const DEFAULT_CDP_CANDIDATE_PORTS: readonly number[] = Object.freeze([
  9335, // observed Codex Desktop (Windows package) default in the field
  9222,
  9223,
  9229,
  9230,
  9240,
  9250,
  9300,
  9310,
  9320,
  9340,
  9350,
]);

export interface DiscoveredCdpEndpoint {
  port: number;
  browserUrl: string;
  webSocketDebuggerUrl?: string;
  browserId: string | null;
  browser: string | null;
  pages: Array<{ id: string; title: string | null; url: string | null }>;
  primaryPages: number;
  source: "probe" | "process";
  /** Process command-line evidence when source=process */
  processEvidence?: {
    pid: number;
    name: string;
    debuggingAddress: string | null;
  };
}

export interface DiscoverCdpOptions {
  /** Extra candidate ports (still loopback-only). */
  ports?: number[];
  /** Also parse local process command lines for --remote-debugging-port (Windows). Default true on win32. */
  scanProcesses?: boolean;
  /** Per-port probe timeout. */
  timeoutMs?: number;
  /** Require at least one exact app://-/ page target. Default true. */
  requirePages?: boolean;
}

export interface CodexLaunchGuidance {
  summary: string;
  notes: string[];
  /** Example flags only — Store/AppX packages may ignore custom args. */
  preferredFlags: string[];
  appxAppId: string | null;
  observedDefaultPort: number;
}

const LOOPBACK_ADDRS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Parse Chromium-style remote debugging flags from a process command line.
 * Rejects non-loopback debugging addresses (fail closed).
 */
export function parseRemoteDebuggingFlags(commandLine: string): {
  port: number | null;
  address: string | null;
  safe: boolean;
} {
  if (typeof commandLine !== "string" || !commandLine) {
    return { port: null, address: null, safe: false };
  }
  const portMatch = commandLine.match(
    /--remote-debugging-port\s*=\s*(\d{1,5})\b/i,
  );
  const addrMatch = commandLine.match(
    /--remote-debugging-address\s*=\s*([^\s"']+)/i,
  );
  const port = portMatch ? Number(portMatch[1]) : null;
  const address = addrMatch ? String(addrMatch[1]).trim() : null;
  if (port == null || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { port: null, address, safe: false };
  }
  // If address is omitted, Chromium historically may bind broader interfaces.
  // We only treat explicit loopback as safe evidence; the subsequent probe still
  // connects exclusively to 127.0.0.1.
  if (!address || !LOOPBACK_ADDRS.has(address.toLowerCase())) {
    return { port, address, safe: false };
  }
  return { port, address, safe: true };
}

async function probePortDetailed(
  port: number,
  source: "probe" | "process",
  processEvidence?: DiscoveredCdpEndpoint["processEvidence"],
  timeoutMs = 450,
): Promise<DiscoveredCdpEndpoint | null> {
  try {
    // Single /json/version round-trip (probeCdp + enrich from same payload).
    const endpoint = await probeCdp(port, "127.0.0.1", { timeoutMs });
    let browserId: string | null = null;
    try {
      const version: {
        Browser?: string;
        webSocketDebuggerUrl?: string;
      } = {};
      if (endpoint.browser) version.Browser = endpoint.browser;
      if (endpoint.webSocketDebuggerUrl) {
        version.webSocketDebuggerUrl = endpoint.webSocketDebuggerUrl;
      }
      browserId = browserIdFromVersion(version, port);
    } catch {
      browserId = null;
    }
    // A page socket without a valid, same-port browser identity is not a
    // trustworthy discovery result. The live host connector enforces the same
    // invariant, so discovery must not select an endpoint it cannot open.
    if (!browserId) return null;
    let pages: CdpTargetInfo[] = [];
    try {
      pages = await listPageTargets(port, browserId);
    } catch {
      pages = [];
    }
    const mapped = pages.map((p) => ({
      id: p.id,
      title: p.title ?? null,
      url: p.url ?? null,
    }));
    const primaryPages = mapped.filter(
      (p) =>
        String(p.url ?? "").startsWith("app://") &&
        !/avatar-overlay|titlebar|utility-overlay/i.test(String(p.url ?? "")),
    ).length;
    const out: DiscoveredCdpEndpoint = {
      port,
      browserUrl: endpoint.browserUrl,
      source,
      browserId,
      browser: endpoint.browser ?? null,
      pages: mapped,
      primaryPages,
    };
    if (endpoint.webSocketDebuggerUrl) {
      out.webSocketDebuggerUrl = endpoint.webSocketDebuggerUrl;
    }
    if (processEvidence) out.processEvidence = processEvidence;
    return out;
  } catch {
    return null;
  }
}

/**
 * Windows: read Win32_Process command lines for debugging ports.
 * No elevated rights required for same-user processes.
 */
export async function scanWindowsDebuggingPorts(): Promise<
  Array<{
    pid: number;
    name: string;
    port: number;
    address: string | null;
  }>
> {
  if (process.platform !== "win32") return [];
  // One statement per line with explicit semicolons — the script is joined into a
  // single powershell -Command string (newlines become spaces).
  const script = [
    "$ErrorActionPreference='SilentlyContinue';",
    "Get-CimInstance Win32_Process | ForEach-Object {",
    "$cmd=$_.CommandLine;",
    "if(-not $cmd){return};",
    "if($cmd -notmatch 'remote-debugging-port'){return};",
    "if($cmd -match '\\s--type='){return};",
    "$o=@{pid=$_.ProcessId;name=$_.Name;cmd=$cmd};",
    "($o | ConvertTo-Json -Compress -Depth 3)",
    "}",
  ].join(" ");

  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ],
      {
        windowsHide: true,
        timeout: 12_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const text = String(stdout ?? "").trim();
    if (!text) return [];
    const found: Array<{
      pid: number;
      name: string;
      port: number;
      address: string | null;
    }> = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      let row: { pid?: unknown; name?: unknown; cmd?: unknown };
      try {
        row = JSON.parse(trimmed) as typeof row;
      } catch {
        continue;
      }
      const cmd = typeof row.cmd === "string" ? row.cmd : "";
      const flags = parseRemoteDebuggingFlags(cmd);
      if (!flags.safe || flags.port == null) continue;
      found.push({
        pid: Number(row.pid) || 0,
        name: typeof row.name === "string" ? row.name : "unknown",
        port: flags.port,
        address: flags.address,
      });
    }
    return found;
  } catch {
    return [];
  }
}

/**
 * Discover healthy loopback CDP endpoints.
 * Never probes non-loopback hosts. Caps candidate set size.
 */
export async function discoverCdpEndpoints(
  opts: DiscoverCdpOptions = {},
): Promise<DiscoveredCdpEndpoint[]> {
  const requirePages = opts.requirePages ?? true;
  // Process scan shells out to PowerShell+Cim — often 1–3s. Default off for
  // hot start; call sites that need it can pass scanProcesses:true.
  const explicitPorts = Array.isArray(opts.ports);
  const scanProcesses =
    opts.scanProcesses ?? (process.platform === "win32" && !explicitPorts);
  const timeoutMs = opts.timeoutMs ?? 450;

  const portSet = new Set<number>();
  for (const p of opts.ports ?? DEFAULT_CDP_CANDIDATE_PORTS) {
    if (Number.isInteger(p) && p >= 1 && p <= 65535) portSet.add(p);
  }

  const processByPort = new Map<
    number,
    { pid: number; name: string; debuggingAddress: string | null }
  >();

  // Keep common startup fast: process command-line discovery is fallback only.
  if (!explicitPorts && portSet.has(9335)) {
    const quick = await probePortDetailed(9335, "probe", undefined, timeoutMs);
    if (
      quick &&
      (!requirePages || quick.primaryPages >= 1 || quick.pages.length >= 1)
    ) {
      return [quick];
    }
  }

  if (scanProcesses) {
    const procs = await scanWindowsDebuggingPorts();
    for (const p of procs) {
      portSet.add(p.port);
      // First main-process wins as evidence.
      if (!processByPort.has(p.port)) {
        processByPort.set(p.port, {
          pid: p.pid,
          name: p.name,
          debuggingAddress: p.address,
        });
      }
    }
  }

  // Hard cap candidate count (safety against huge custom lists).
  // When the caller supplies an explicit ports list, honor it as-is (tests and
  // targeted probes). Only prefer :9335 when using the default candidate set.
  const ordered = explicitPorts
    ? [...portSet]
    : [
        9335,
        ...[...portSet].filter((p) => p !== 9335).sort((a, b) => a - b),
      ].filter((p, i, arr) => arr.indexOf(p) === i);
  const ports = ordered.slice(0, 32);

  const settled = await Promise.all(
    ports.map(async (port) => {
      const evidence = processByPort.get(port);
      const source = evidence ? "process" : "probe";
      return probePortDetailed(
        port,
        source,
        evidence
          ? {
              pid: evidence.pid,
              name: evidence.name,
              debuggingAddress: evidence.debuggingAddress,
            }
          : undefined,
        timeoutMs,
      );
    }),
  );

  const results: DiscoveredCdpEndpoint[] = [];
  for (const hit of settled) {
    if (!hit) continue;
    if (requirePages && hit.primaryPages < 1 && hit.pages.length < 1) continue;
    results.push(hit);
  }

  // Prefer endpoints with a primary Codex shell, then process-sourced, then port.
  results.sort((a, b) => {
    if (b.primaryPages !== a.primaryPages) return b.primaryPages - a.primaryPages;
    if (a.source !== b.source) return a.source === "process" ? -1 : 1;
    return a.port - b.port;
  });
  return results;
}

/** Pick the best discovered endpoint or null. */
export async function findBestCdpPort(
  opts: DiscoverCdpOptions = {},
): Promise<DiscoveredCdpEndpoint | null> {
  const all = await discoverCdpEndpoints(opts);
  return all[0] ?? null;
}

/**
 * User-facing guidance for enabling / locating Codex CDP.
 * Does not launch or patch the host binary.
 */
export function getCodexLaunchGuidance(): CodexLaunchGuidance {
  return {
    summary:
      "beautiCode never patches Codex. It only attaches to a loopback CDP port the host already exposes.",
    notes: [
      "Open Codex Desktop (Windows package may appear as ChatGPT.exe / OpenAI.Codex).",
      "Recent builds often self-enable --remote-debugging-address=127.0.0.1 with a fixed port (commonly 9335).",
      "Run: npm run bc -- discover   to find a healthy loopback endpoint.",
      "Run: npm run bc -- probe --port <n>   to inspect pages before apply.",
      "If discover finds nothing, the host build may have dropped remote debugging (fail closed) — beautiCode will not claim success from disk alone.",
      "Never pass --remote-debugging-address=0.0.0.0. Loopback only.",
      "Microsoft Store / AppX launches may ignore custom CLI args; prefer the host's own loopback CDP when present.",
      "Only one beautiCode injector may own a host (injector.lock).",
    ],
    preferredFlags: [
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=9335",
    ],
    appxAppId: "OpenAI.Codex_2p2nqsd0c76g0!App",
    observedDefaultPort: 9335,
  };
}
