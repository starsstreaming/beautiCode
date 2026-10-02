import crypto from "node:crypto";

const SCRIPT_PATHS = [
  "/__beauticode/transport.js",
  "/__beauticode/atmosphere.js",
  "/__beauticode/client.js",
  "/__beauticode/console.js",
  "/__beauticode/gallery.js",
];

function parseLoopbackAuthority(value) {
  if (typeof value !== "string" || value.trim() !== value || /[\s,]/.test(value)) return null;
  const bracketed = /^\[([^\]]+)\](?::([0-9]{1,5}))?$/.exec(value);
  const plain = /^(127\.0\.0\.1|localhost)(?::([0-9]{1,5}))?$/i.exec(value);
  const hostname = bracketed ? `[${bracketed[1].toLowerCase()}]` : plain?.[1]?.toLowerCase();
  if (hostname !== "[::1]" && !/^(?:127\.0\.0\.1|localhost)$/i.test(hostname || "")) return null;
  const port = Number(bracketed?.[2] ?? plain?.[2] ?? "80");
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { key: `${hostname}:${port}` };
}

function parseLoopbackOrigin(value) {
  if (typeof value !== "string" || value === "null") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return parseLoopbackAuthority(url.host);
  } catch {
    return null;
  }
}

export function isAllowedLoopbackHost(value) {
  return Boolean(parseLoopbackAuthority(value));
}

/** The desktop shell forwards requests after removing browser Origin headers. */
export function createBrowserInjection() {
  const desktopKey = crypto.randomBytes(32).toString("hex");

  return {
    contribute(table) {
      table.push({ kind: "global", name: "__BEAUTICODE_DESKTOP_KEY__", value: desktopKey });
      for (const src of SCRIPT_PATHS) {
        table.push({ kind: "script-src", placement: "body", src });
      }
    },
    isSameOrigin(req) {
      const host = parseLoopbackAuthority(req?.headers?.host);
      if (!host) return false;
      const origin = req.headers.origin;
      if (typeof origin === "string") {
        const parsedOrigin = parseLoopbackOrigin(origin);
        return Boolean(parsedOrigin && parsedOrigin.key === host.key);
      }
      if (req.headers["sec-fetch-site"] === "same-origin") return true;
      const supplied = req.headers["x-beauticode-desktop-key"];
      if (typeof supplied !== "string" || !/^[a-f0-9]{64}$/.test(supplied)) return false;
      return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(desktopKey));
    },
  };
}
