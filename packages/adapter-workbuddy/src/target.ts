/**
 * WorkBuddy target identity.
 *
 * Measured (see docs/host-adapter-workbuddy.md §3.3):
 *   file:///Applications/WorkBuddy.app/Contents/Resources/app.asar/renderer/index.html?locale=zh-CN&accountSnapshot=...
 *
 * Two rules matter:
 *  1. The URL carries a query string, so matching must ignore it.
 *  2. That query contains an account snapshot (uid / nickname), so the full URL
 *     must never reach logs, errors, or UI. Only origin + pathname may be shown.
 */

/** Path fragment every WorkBuddy main-window page carries. */
export const WORKBUDDY_RENDERER_PATH_FRAGMENT = "/app.asar/renderer/index.html";

export interface WorkBuddyTarget {
  id: string;
  type: string;
  url: string;
  title?: string;
  webSocketDebuggerUrl?: string;
}

/**
 * True only for a `file:` page whose path ends with the bundled renderer entry.
 *
 * Deliberately suffix-based rather than bundle-path-based: the install location
 * differs per platform (macOS `WorkBuddy.app/Contents/Resources/…`, Windows
 * `…\Programs\WorkBuddy\resources\…`), while `app.asar/renderer/index.html` is
 * the stable identity. Scheme and path are queried-free; the host may add or
 * drop query parameters.
 */
export function isWorkBuddyPageUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "file:") return false;
  let path: string;
  try {
    path = decodeURIComponent(parsed.pathname);
  } catch {
    return false;
  }
  return path.endsWith(WORKBUDDY_RENDERER_PATH_FRAGMENT);
}

/** Pick the main window target, ignoring iframes and devtools pages. */
export function pickWorkBuddyTarget(
  targets: readonly WorkBuddyTarget[],
): WorkBuddyTarget | null {
  const pages = targets.filter((t) => t.type === "page");
  return pages.find((t) => isWorkBuddyPageUrl(t.url)) ?? null;
}

/**
 * Privacy-safe label for logs. Never returns the query string, because it holds
 * an account snapshot.
 */
export function safeTargetLabel(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.protocol}//${parsed.host}${decodeURIComponent(parsed.pathname)}`;
  } catch {
    return "(unparseable target url)";
  }
}

/**
 * Reject a CDP WebSocket URL that is not loopback — same rule the Codex adapter
 * enforces (upstream lesson: never follow a CDP-advertised ws:// off-box).
 */
export function assertLoopbackDebuggerUrl(rawUrl: string, port: number): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("CDP debugger url is not a valid URL.");
  }
  if (parsed.protocol !== "ws:") {
    throw new Error("CDP debugger url must use ws:// on loopback.");
  }
  const host = parsed.hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") {
    throw new Error("Rejected a CDP WebSocket url outside loopback.");
  }
  if (parsed.port && Number(parsed.port) !== port) {
    throw new Error("CDP debugger url port does not match the requested port.");
  }
  return rawUrl;
}
