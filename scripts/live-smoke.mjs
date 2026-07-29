#!/usr/bin/env node
/**
 * Live Codex smoke (stability/security oriented).
 *
 * - Uses an isolated --data-root (never touches the default user profile store
 *   unless you pass --data-root yourself).
 * - Clears the host background at the end (best-effort).
 * - Fails closed on missing CDP, dual-lock, bad media, verify failure.
 *
 * Usage:
 *   node scripts/live-smoke.mjs --port 9335
 *   node scripts/live-smoke.mjs --port 9335 --keep   # leave last image applied
 *   node scripts/live-smoke.mjs --port 9335 --skip-video
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

if (Number(process.versions.node.split(".", 1)[0]) < 22) {
  throw new Error("Live smoke requires Node.js 22 or newer");
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const adapterEntry = pathToFileURL(
  path.resolve(root, "packages/adapter-codex/dist/index.js"),
).href;
const coreEntry = pathToFileURL(
  path.resolve(root, "packages/core/dist/index.js"),
).href;

function parseArgs(argv) {
  const flags = {
    port: null,
    dataRoot: null,
    keep: false,
    skipVideo: false,
    verifyMs: 45_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--port") flags.port = Number(argv[++i]);
    else if (a === "--data-root") {
      const value = argv[++i];
      if (!value) throw new Error("--data-root requires a path");
      flags.dataRoot = path.resolve(value);
    }
    else if (a === "--keep") flags.keep = true;
    else if (a === "--skip-video") flags.skipVideo = true;
    else if (a === "--verify-ms") flags.verifyMs = Number(argv[++i]);
    else if (a === "-h" || a === "--help") flags.help = true;
    else throw new Error(`Unknown arg: ${a}`);
  }
  return flags;
}

function finish(code) {
  process.exitCode = code;
}

function log(step, msg) {
  console.log(`[smoke:${step}] ${msg}`);
}

function fail(step, msg) {
  console.error(`[smoke:${step}] FAIL: ${msg}`);
  throw new Error(`${step}: ${msg}`);
}

async function getClosedLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (!Number.isInteger(port) || port < 1) {
    throw new Error("Could not reserve a closed loopback test port");
  }
  return port;
}

async function ensureFixtures(dir) {
  await fs.mkdir(dir, { recursive: true });
  const pngPath = path.join(dir, "poster.png");
  const mp4Path = path.join(dir, "loop.mp4");
  const junkPath = path.join(dir, "junk.mp4");

  // 1x1 PNG (valid magic)
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5W2fQAAAAASUVORK5CYII=",
    "base64",
  );
  await fs.writeFile(pngPath, png);

  // Invalid "mp4" for rejection path
  await fs.writeFile(junkPath, Buffer.from("not-an-mp4-file"));

  // Tiny real MP4 via ffmpeg when available
  let hasVideo = false;
  const ff = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "color=c=0x1a4d8c:s=320x180:d=1",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      mp4Path,
    ],
    { encoding: "utf8" },
  );
  if (ff.status === 0) {
    hasVideo = true;
  } else {
    log("fixtures", `ffmpeg unavailable or failed; video steps will skip (${ff.stderr?.split("\n").pop() ?? "no stderr"})`);
  }

  return { pngPath, mp4Path, junkPath, hasVideo };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help || flags.port == null) {
    console.log(`Usage: node scripts/live-smoke.mjs --port <cdpPort> [--data-root <dir>] [--keep] [--skip-video]`);
    finish(flags.help ? 0 : 1);
    return;
  }
  if (!Number.isInteger(flags.port) || flags.port < 1 || flags.port > 65535) {
    throw new Error("--port must be 1–65535");
  }
  if (
    !Number.isFinite(flags.verifyMs) ||
    flags.verifyMs < 0 ||
    flags.verifyMs > 300_000
  ) {
    throw new Error("--verify-ms must be between 0 and 300000");
  }

  const dataRoot =
    flags.dataRoot ??
    path.join(os.tmpdir(), `beauticode-smoke-${process.pid}-${Date.now()}`);
  const fixtureDir = path.join(
    os.tmpdir(),
    `beauticode-smoke-fixtures-${process.pid}-${Date.now()}`,
  );
  await fs.mkdir(dataRoot, { recursive: true });

  log("init", `port=${flags.port} dataRoot=${dataRoot}`);

  const {
    probeCdp,
    listPageTargets,
    fetchCdpVersion,
    browserIdFromVersion,
    runApplyOnce,
    acquireInjectorLock,
    CodexHostApplier,
    SNAPSHOT_EXPRESSION,
  } = await import(adapterEntry);
  const { BackgroundStore } = await import(coreEntry);

  const autoDataRoot = flags.dataRoot == null;
  let hostTouched = false;
  let completed = false;
  try {
    const fixtures = await ensureFixtures(fixtureDir);
    const results = [];

  // 1) Probe + page shape
  log("probe", "CDP /json/version + page list");
  const endpoint = await probeCdp(flags.port);
  const version = await fetchCdpVersion(flags.port);
  const browserId = browserIdFromVersion(version, flags.port);
  const pages = await listPageTargets(flags.port, browserId);
  if (pages.length === 0) fail("probe", "no candidate page targets");
  const mainPages = pages.filter(
    (p) =>
      String(p.url ?? "").startsWith("app://") &&
      !/avatar-overlay/i.test(String(p.url ?? "")),
  );
  if (mainPages.length === 0) {
    fail("probe", `no primary app:// shell (pages=${JSON.stringify(pages.map((p) => p.url))})`);
  }
  log(
    "probe",
    `ok browser=${version.Browser} id=${browserId} pages=${pages.length} primary=${mainPages.length}`,
  );
  results.push({ step: "probe", ok: true });

  // 2) Dual-lock fail-closed
  log("lock", "dual injector lock");
  const releaseA = await acquireInjectorLock(dataRoot, flags.port);
  let locked = false;
  let releaseB = null;
  try {
    releaseB = await acquireInjectorLock(dataRoot, flags.port);
  } catch (err) {
    locked = /Another beautiCode injector is running/i.test(
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    if (releaseB) await releaseB();
    await releaseA();
  }
  if (!locked) {
    fail("lock", "second acquire was not rejected");
  }
  log("lock", "second acquire rejected — ok");
  results.push({ step: "lock", ok: true });

  // 3) Bad media rejected (offline path of transaction still validates)
  log("reject", "invalid mp4 must fail closed");
  const bad = await runApplyOnce({
    port: flags.port,
    dataRoot,
    verifyDeadlineMs: flags.verifyMs,
    input: {
      type: "video",
      imagePath: fixtures.pngPath,
      videoPath: fixtures.junkPath,
    },
  });
  if (bad.ok) fail("reject", "junk mp4 was accepted");
  log("reject", `ok error=${bad.error ?? "n/a"} rolledBack=${bad.rolledBack}`);
  results.push({ step: "reject-bad-mp4", ok: true, error: bad.error });

  // 4) Apply image + live snapshot audit
  log("image", "apply-image + snapshot audit");
  const imgResult = await runApplyOnce({
    port: flags.port,
    dataRoot,
    verifyDeadlineMs: flags.verifyMs,
    input: { type: "image", imagePath: fixtures.pngPath },
  });
  if (!imgResult.ok) fail("image", JSON.stringify(imgResult));
  hostTouched = true;
  const store = new BackgroundStore({ root: dataRoot });
  await store.init();
  const manifestAfterImg = await store.readActiveManifest();
  if (!manifestAfterImg.background || manifestAfterImg.background.type !== "image") {
    fail("image", "manifest not image after apply");
  }

  const host = new CodexHostApplier({ port: flags.port });
  try {
    await host.connect();
    if (host.activeSessionCount < 1) fail("image", "no sessions after connect");
    // Prefer single primary shell (overlay filtered).
    const snap = await host.verify(
      { generation: manifestAfterImg.generation, media: "image" },
      { deadlineMs: 10_000 },
    );
    if (snap.status !== "pass") fail("image", `verify ${snap.status}: ${snap.reason}`);

    // Direct runtime audit for security/stability invariants.
    const sessions = await host.reconcileSessions();
    const raw = await sessions[0].session.evaluate(SNAPSHOT_EXPRESSION);
    const checks = [];
    if (raw?.stagePointerEvents && raw.stagePointerEvents !== "none") {
      checks.push(`pointer-events=${raw.stagePointerEvents}`);
    }
    if (raw?.horizontalOverflow) checks.push("horizontalOverflow");
    if (raw?.generation !== manifestAfterImg.generation) {
      checks.push(`generation page=${raw?.generation} expected=${manifestAfterImg.generation}`);
    }
    if (!raw?.hasStage || !raw?.hasImage) checks.push("missing stage/image");
    if (raw?.media !== "image") checks.push(`media=${raw?.media}`);
    // Ensure we did not land only on overlay.
    const urls = sessions.map((s) => s.target.url ?? "");
    if (urls.every((u) => /avatar-overlay/i.test(u))) {
      checks.push("only avatar-overlay sessions");
    }
    if (checks.length) fail("image-audit", checks.join("; "));
    log(
      "image",
      `ok gen=${manifestAfterImg.generation} sessions=${sessions.length} urls=${JSON.stringify(urls)}`,
    );
    results.push({ step: "apply-image", ok: true, generation: manifestAfterImg.generation });
  } finally {
    host.close();
  }

  // 5) Video path
  if (!flags.skipVideo && fixtures.hasVideo) {
    log("video", "apply-video + verify");
    const vidResult = await runApplyOnce({
      port: flags.port,
      dataRoot,
      verifyDeadlineMs: flags.verifyMs,
      input: {
        type: "video",
        imagePath: fixtures.pngPath,
        videoPath: fixtures.mp4Path,
      },
    });
    if (!vidResult.ok) fail("video", JSON.stringify(vidResult));
    const m = await store.readActiveManifest();
    if (m.background?.type !== "video") fail("video", "manifest not video");
    log(
      "video",
      `ok gen=${m.generation} mode=${vidResult.mode ?? "video"} rolledBack=${vidResult.rolledBack ?? false}`,
    );
    results.push({
      step: "apply-video",
      ok: true,
      generation: m.generation,
      mode: vidResult.mode ?? null,
    });
  } else {
    log("video", "skipped");
    results.push({ step: "apply-video", ok: true, skipped: true });
  }

  // 6) Clear (unless --keep)
  if (!flags.keep) {
    log("clear", "clear background");
    const clearResult = await runApplyOnce({
      port: flags.port,
      dataRoot,
      verifyDeadlineMs: flags.verifyMs,
      input: { type: "clear" },
    });
    if (!clearResult.ok) fail("clear", JSON.stringify(clearResult));
    hostTouched = false;
    const m = await store.readActiveManifest();
    if (m.background) fail("clear", "manifest still has background");
    log("clear", "ok");
    results.push({ step: "clear", ok: true });
  } else {
    log("clear", "skipped (--keep)");
    results.push({ step: "clear", ok: true, skipped: true });
  }

  // 7) Missing-port fail closed (quick check against a freshly closed port)
  log("failclosed", "probe dead port");
  const deadPort = await getClosedLoopbackPort();
  let deadOk = false;
  try {
    await probeCdp(deadPort);
  } catch {
    deadOk = true;
  }
  if (!deadOk) fail("failclosed", "probe on port 1 should fail");
  results.push({ step: "failclosed-dead-port", ok: true });

  console.log("\n=== live smoke PASS ===");
  console.log(JSON.stringify({ port: flags.port, dataRoot, endpoint, results }, null, 2));
  completed = true;
  finish(0);
  } finally {
    if (hostTouched && (!flags.keep || !completed)) {
      try {
        log("cleanup", "best-effort clear after interrupted smoke");
        await runApplyOnce({
          port: flags.port,
          dataRoot,
          verifyDeadlineMs: Math.min(flags.verifyMs, 10_000),
          input: { type: "clear" },
        });
      } catch (error) {
        console.error(
          `[smoke:cleanup] clear failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (autoDataRoot && (!flags.keep || !completed)) {
      await fs.rm(dataRoot, { recursive: true, force: true }).catch(() => {});
    }
    await fs.rm(fixtureDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error("\n=== live smoke FAIL ===");
  console.error(err instanceof Error ? err.message : err);
  finish(1);
});
