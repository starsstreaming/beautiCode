#!/usr/bin/env node
/**
 * beautiCode CLI
 *
 * Offline:
 *   apply-image | apply-video | clear | status
 * Live:
 *   discover | how-to-cdp | probe | watch | apply-* --port
 */
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

if (Number(process.versions.node.split(".", 1)[0]) < 22) {
  console.error("beautiCode requires Node.js 22 or newer");
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));

const coreEntry = pathToFileURL(
  path.resolve(here, "../packages/core/dist/index.js"),
).href;
const adapterEntry = pathToFileURL(
  path.resolve(here, "../packages/adapter-codex/dist/index.js"),
).href;

const {
  ApplyTransaction,
  BackgroundStore,
  MediaServerController,
  defaultDataRoot,
} = await import(coreEntry);

function finish(code) {
  process.exitCode = code;
}

function printUsage() {
  console.log(`beautiCode CLI

Setup / discovery (loopback only):
  npm run bc -- discover
  npm run bc -- how-to-cdp
  npm run bc -- probe --port <cdpPort>

Offline (atomic store + media validation only):
  npm run bc -- apply-image <image>
  npm run bc -- apply-video <video.mp4> [optional-poster]
  npm run bc -- clear
  npm run bc -- status

Live Codex CDP (inject + live verify + rollback):
  npm run bc -- apply-image <image> --port <cdpPort>
  npm run bc -- apply-video <video.mp4> [optional-poster] --port <cdpPort>
  npm run bc -- clear --port <cdpPort>
  npm run bc -- watch --port <cdpPort>
  npm run bc -- apply-image <image> --discover   # auto-pick best loopback CDP

Windows tray:
  npm run tray

Options:
  --port <n>           Loopback CDP port
  --discover           Auto-pick a healthy loopback Codex CDP port
  --data-root <path>   Override data directory (default: ${defaultDataRoot()})
  --verify-ms <n>      Live verify deadline in ms (default 30000)
  --url-prefix <s>     Prefer page targets with this URL prefix (default app://)
  --allow-http         Allow http://127.0.0.1 test pages (disables app: requirement)

Data root: ${defaultDataRoot()}
`);
}

function parseArgs(argv) {
  const positionals = [];
  const flags = {
    port: null,
    dataRoot: null,
    verifyMs: 30_000,
    urlPrefix: undefined,
    allowHttp: false,
    discover: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "-h" || a === "--help") return { help: true, positionals, flags };
    if (a === "--port") {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v < 1 || v > 65535) {
        throw new Error("--port must be an integer 1–65535");
      }
      flags.port = v;
      continue;
    }
    if (a === "--data-root") {
      const value = argv[++i];
      if (!value) throw new Error("--data-root requires a path");
      flags.dataRoot = path.resolve(value);
      continue;
    }
    if (a === "--verify-ms") {
      const v = Number(argv[++i]);
      if (!Number.isFinite(v) || v < 0 || v > 300_000) {
        throw new Error("--verify-ms must be between 0 and 300000");
      }
      flags.verifyMs = v;
      continue;
    }
    if (a === "--url-prefix") {
      const value = argv[++i];
      if (!value) throw new Error("--url-prefix requires a value");
      flags.urlPrefix = value;
      continue;
    }
    if (a === "--allow-http") {
      flags.allowHttp = true;
      continue;
    }
    if (a === "--discover") {
      flags.discover = true;
      continue;
    }
    if (a.startsWith("-")) {
      throw new Error(`Unknown flag: ${a}`);
    }
    positionals.push(a);
  }
  return { help: false, positionals, flags };
}

function friendlyError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (
    /fetch failed|ECONNREFUSED|aborted|CDP HTTP|Timed out waiting for a CDP|No healthy loopback/i.test(
      msg,
    )
  ) {
    return [
      msg,
      "",
      "CDP is missing or unreachable (fail closed).",
      "Run: npm run bc -- discover",
      "Or:  npm run bc -- how-to-cdp",
    ].join("\n");
  }
  if (/Another beautiCode injector is running/i.test(msg)) {
    return [
      msg,
      "",
      "Only one injector may own a host at a time.",
      "Stop the other process and retry. Dead-pid locks are reclaimed automatically.",
    ].join("\n");
  }
  if (/identity changed|CdpIdentityMismatch/i.test(msg)) {
    return [
      msg,
      "",
      "The Chromium browser identity behind the CDP port changed (host relaunch).",
      "Re-run probe/apply; watch/tray reconnects automatically.",
    ].join("\n");
  }
  return msg;
}

async function resolvePort(flags, adapter) {
  if (flags.port != null) return flags.port;
  if (!flags.discover) return null;
  const best = await adapter.findBestCdpPort({ requirePages: true });
  if (!best) {
    throw new Error(
      "No healthy loopback Codex CDP endpoint found (discover failed closed).",
    );
  }
  console.error(
    `[discover] using :${best.port} browser=${best.browser ?? "?"} primaryPages=${best.primaryPages}`,
  );
  return best.port;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(friendlyError(err));
    finish(1);
    return;
  }

  if (parsed.help || parsed.positionals.length === 0) {
    printUsage();
    finish(parsed.help ? 0 : 1);
    return;
  }

  const [cmd, a, b] = parsed.positionals;
  const { flags } = parsed;
  const dataRoot = flags.dataRoot ?? defaultDataRoot();
  const adapter = await import(adapterEntry);

  if (cmd === "how-to-cdp" || cmd === "howto" || cmd === "cdp-help") {
    const g = adapter.getCodexLaunchGuidance();
    console.log(g.summary);
    console.log("");
    for (const n of g.notes) console.log(`- ${n}`);
    console.log("");
    console.log("Preferred flags (loopback only):");
    for (const f of g.preferredFlags) console.log(`  ${f}`);
    console.log("");
    console.log(`Observed field default port: ${g.observedDefaultPort}`);
    if (g.appxAppId) console.log(`Windows AppX AppId: ${g.appxAppId}`);
    finish(0);
    return;
  }

  if (cmd === "discover") {
    const endpoints = await adapter.discoverCdpEndpoints({ requirePages: true });
    const guidance = adapter.getCodexLaunchGuidance();
    console.log(
      JSON.stringify(
        {
          ok: endpoints.length > 0,
          count: endpoints.length,
          endpoints: endpoints.map((e) => ({
            port: e.port,
            browser: e.browser,
            browserId: e.browserId,
            primaryPages: e.primaryPages,
            source: e.source,
            processEvidence: e.processEvidence ?? null,
            pages: e.pages,
          })),
          guidance: {
            summary: guidance.summary,
            preferredFlags: guidance.preferredFlags,
            observedDefaultPort: guidance.observedDefaultPort,
          },
        },
        null,
        2,
      ),
    );
    finish(endpoints.length > 0 ? 0 : 2);
    return;
  }

  if (cmd === "status") {
    const store = new BackgroundStore({ root: dataRoot });
    await store.init();
    const m = await store.readActiveManifest();
    console.log(JSON.stringify(m, null, 2));
    finish(0);
    return;
  }

  if (cmd === "probe") {
    let port = flags.port;
    if (port == null && flags.discover) {
      port = await resolvePort(flags, adapter);
    }
    if (port == null) {
      console.error("probe requires --port <cdpPort> or --discover");
      finish(1);
      return;
    }
    const endpoint = await adapter.probeCdp(port);
    const version = await adapter.fetchCdpVersion(port);
    const browserId = adapter.browserIdFromVersion(version, port);
    const pages = await adapter.listPageTargets(port, browserId);
    console.log(
      JSON.stringify(
        {
          ok: true,
          port,
          browserId,
          browser: version.Browser ?? null,
          endpoint,
          pages: pages.map((p) => ({
            id: p.id,
            title: p.title ?? null,
            url: p.url ?? null,
          })),
        },
        null,
        2,
      ),
    );
    finish(0);
    return;
  }

  if (cmd === "watch") {
    let port = flags.port;
    if (port == null) port = await resolvePort({ ...flags, discover: flags.discover || flags.port == null }, adapter);
    if (port == null) {
      console.error("watch requires --port <cdpPort> or --discover");
      finish(1);
      return;
    }
    const ac = new AbortController();
    const onSignal = () => ac.abort();
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    console.error(`watching CDP :${port} (dataRoot=${dataRoot}); Ctrl+C to stop`);
    await adapter.runWatch({
      port,
      dataRoot,
      requireAppProtocol: !flags.allowHttp,
      ...(flags.urlPrefix !== undefined ? { urlPrefix: flags.urlPrefix } : {}),
      signal: ac.signal,
      onTick: ({ sessions }) => {
        if (process.env.BEAUTICODE_VERBOSE === "1") {
          console.error(`[watch] sessions=${sessions}`);
        }
      },
      onError: (err) => {
        console.error(`[watch] ${err.message}`);
      },
    });
    finish(0);
    return;
  }

  let input;
  if (cmd === "apply-image") {
    if (!a) {
      printUsage();
      finish(1);
      return;
    }
    input = { type: "image", imagePath: path.resolve(a) };
  } else if (cmd === "apply-video") {
    if (!a) {
      printUsage();
      finish(1);
      return;
    }
    // Dream-Skin style: video-only is enough. Optional poster as 2nd arg.
    // Legacy form `apply-video <image> <video.mp4>` still works when the first
    // arg is an image and the second is .mp4.
    const aPath = path.resolve(a);
    const bPath = b ? path.resolve(b) : null;
    const aIsMp4 = path.extname(aPath).toLowerCase() === ".mp4";
    const bIsMp4 = bPath
      ? path.extname(bPath).toLowerCase() === ".mp4"
      : false;
    if (aIsMp4 && !bIsMp4) {
      input = { type: "video", videoPath: aPath };
      if (bPath) input.imagePath = bPath;
    } else if (bIsMp4) {
      input = {
        type: "video",
        imagePath: aPath,
        videoPath: bPath,
      };
    } else if (aIsMp4) {
      input = { type: "video", videoPath: aPath };
    } else {
      console.error(
        "apply-video expects <video.mp4> [poster] (or legacy <poster> <video.mp4>)",
      );
      finish(1);
      return;
    }
  } else if (cmd === "clear") {
    input = { type: "clear" };
  } else {
    printUsage();
    finish(1);
    return;
  }

  let port = flags.port;
  if (port == null && flags.discover) {
    port = await resolvePort(flags, adapter);
  }

  if (port != null) {
    const result = await adapter.runApplyOnce({
      port,
      input,
      dataRoot,
      verifyDeadlineMs: flags.verifyMs,
      requireAppProtocol: !flags.allowHttp,
      ...(flags.urlPrefix !== undefined ? { urlPrefix: flags.urlPrefix } : {}),
    });
    console.log(JSON.stringify(result, null, 2));
    finish(result.ok ? 0 : 2);
    return;
  }

  const store = new BackgroundStore({ root: dataRoot });
  const media = new MediaServerController({ enabled: false });
  const tx = new ApplyTransaction({ store, media, offline: true });
  try {
    const result = await tx.run(input);
    console.log(JSON.stringify(result, null, 2));
    if (media.active) {
      console.log("mediaServer:", media.active.url);
      console.log(
        "(offline mode — media server closed on exit; use --port/--discover for live inject)",
      );
    }
    await media.close();
    finish(result.ok ? 0 : 2);
  } catch (err) {
    await media.close().catch(() => {});
    throw err;
  }
}

try {
  await main();
} catch (err) {
  console.error(friendlyError(err));
  finish(1);
}
