import crypto from "node:crypto";

const SCRIPT_PATHS = [
  "/__beauticode/transport.js",
  "/__beauticode/atmosphere.js",
  "/__beauticode/client.js",
  "/__beauticode/console.js",
  "/__beauticode/gallery.js",
];

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
      const origin = req.headers.origin;
      if (typeof origin === "string") return origin === `http://${req.headers.host}`;
      if (req.headers["sec-fetch-site"] === "same-origin") return true;
      const supplied = req.headers["x-beauticode-desktop-key"];
      if (typeof supplied !== "string" || !/^[a-f0-9]{64}$/.test(supplied)) return false;
      return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(desktopKey));
    },
  };
}
