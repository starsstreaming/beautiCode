import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { apply } from "../index.mjs";
import {
  createBeauticodeActions,
  registerAgentSurfaces,
  runBgCommand,
} from "../agent.mjs";
import { resolveApplyBackend, stopInProcessSession } from "../host-apply.mjs";
import {
  CONTROL_FILE,
  CONTROL_SCHEMA,
  TRAY_MISSING_MESSAGE,
  TRAY_STARTING_MESSAGE,
  callDshControl,
  inspectLocalMedia,
  isLoopbackControlUrl,
  matchSavedTheme,
  readDshControlFile,
  readSessionHostFile,
  readTrayClaim,
  removeDshControlFile,
  removeSessionHostFile,
  removeTrayClaim,
  stripPathQuotes,
  writeDshControlFile,
  writeSessionHostFile,
  writeTrayClaim,
} from "../control-client.mjs";

const TOKEN = "control-token-for-agent-tests-123456";
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function mp4Fixture() {
  const fileTypeBox = Buffer.alloc(24);
  fileTypeBox.writeUInt32BE(24, 0);
  fileTypeBox.write("ftyp", 4, "ascii");
  fileTypeBox.write("isom", 8, "ascii");
  return fileTypeBox;
}

async function createTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "beauticode-agent-"));
}

async function writeControl(root, url, token = TOKEN) {
  await writeDshControlFile({
    dataRoot: root,
    url,
    token,
    pid: process.pid,
  });
}

function json(res, status, body) {
  const encoded = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(encoded);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function startFakeTray(handler) {
  const received = [];
  const server = http.createServer(async (req, res) => {
    const authorization = String(req.headers.authorization || "");
    if (authorization !== `Bearer ${TOKEN}`) {
      json(res, 401, { ok: false, error: "请求未授权。" });
      return;
    }
    const url = req.url?.split("?")[0] ?? "";
    let body = {};
    if (req.method !== "GET") body = await readBody(req);
    received.push({ method: req.method, url, body });
    try {
      await handler({ method: req.method, url, body }, res);
    } catch (error) {
      json(res, 500, { ok: false, error: String(error.message || error) });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    received,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("loopback control URLs are accepted and others are rejected", () => {
  assert.equal(isLoopbackControlUrl("http://127.0.0.1:4123"), true);
  assert.equal(isLoopbackControlUrl("http://localhost:4123"), true);
  assert.equal(isLoopbackControlUrl("http://[::1]:4123"), true);
  assert.equal(isLoopbackControlUrl("http://192.168.1.8:4123"), false);
  assert.equal(isLoopbackControlUrl("https://127.0.0.1:4123"), false);
  assert.equal(isLoopbackControlUrl("http://127.0.0.1:4123/apply"), false);
});

test("path quotes and theme matching", () => {
  assert.equal(stripPathQuotes('  "D:\\\\a b.mp4"  '), "D:\\\\a b.mp4");
  assert.equal(stripPathQuotes("'C:\\\\x.png'"), "C:\\\\x.png");
  const themes = [
    { id: "aaa", name: "雨夜写代码" },
    { id: "bbb", name: "海边下午" },
  ];
  assert.equal(matchSavedTheme(themes, "aaa").theme.id, "aaa");
  assert.equal(matchSavedTheme(themes, "海边下午").theme.id, "bbb");
  assert.equal(matchSavedTheme(themes, "雨夜").theme.id, "aaa");
  assert.match(matchSavedTheme(themes, "不存在").error, /未找到主题/);
  assert.match(matchSavedTheme(themes, "").error, /必须提供/);
});

test("inspectLocalMedia requires an absolute regular file", async (t) => {
  const root = await createTempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const image = path.join(root, "poster.png");
  const video = path.join(root, "clip.mp4");
  await fs.writeFile(image, PNG_1X1);
  await fs.writeFile(video, mp4Fixture());
  await fs.writeFile(path.join(root, "notes.txt"), "nope");

  assert.equal((await inspectLocalMedia("relative.mp4")).ok, false);
  assert.equal((await inspectLocalMedia(image)).kind, "image");
  assert.equal((await inspectLocalMedia(`"${video}"`)).kind, "video");
  assert.match((await inspectLocalMedia(path.join(root, "missing.mp4"))).error, /找不到文件/);
  assert.match((await inspectLocalMedia(path.join(root, "notes.txt"))).error ?? "", /只支持/);
});

test("control file is written atomically and ignored when the pid is dead", async (t) => {
  const root = await createTempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = await writeDshControlFile({
    dataRoot: root,
    url: "http://127.0.0.1:34567",
    token: TOKEN,
    pid: process.pid,
  });
  assert.equal(path.basename(file), CONTROL_FILE);
  const live = await readDshControlFile(root);
  assert.equal(live.schema, CONTROL_SCHEMA);
  assert.equal(live.url, "http://127.0.0.1:34567");
  assert.equal(live.token, TOKEN);

  await writeDshControlFile({
    dataRoot: root,
    url: "http://127.0.0.1:34567",
    token: TOKEN,
    pid: 2_147_483_647,
  });
  assert.equal(await readDshControlFile(root), null);
  const dead = await readDshControlFile(root, { allowDead: true });
  assert.equal(dead.pid, 2_147_483_647);

  assert.equal(await removeDshControlFile({ dataRoot: root, pid: process.pid }), false);
  assert.equal(await removeDshControlFile({ dataRoot: root, pid: 2_147_483_647 }), true);
});

test("callDshControl requires a live tray and rejects non-loopback files", async (t) => {
  const root = await createTempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(
    () => callDshControl(root, { method: "GET", path: "/status" }),
    (error) => error.message === TRAY_MISSING_MESSAGE,
  );
  await fs.writeFile(
    path.join(root, CONTROL_FILE),
    JSON.stringify({
      schema: CONTROL_SCHEMA,
      host: "dsh",
      pid: process.pid,
      url: "http://192.168.1.8:9",
      token: TOKEN,
    }),
  );
  assert.equal(await readDshControlFile(root), null);
});

test("tools and slash commands reuse the tray apply routes", async (t) => {
  const root = await createTempRoot();
  const image = path.join(root, "wall.png");
  const video = path.join(root, "bg.mp4");
  await fs.writeFile(image, PNG_1X1);
  await fs.writeFile(video, mp4Fixture());
  const themes = [{ id: "theme-rain", name: "雨夜写代码", type: "video" }];
  const tray = await startFakeTray(({ url, body }, res) => {
    if (url === "/health") {
      json(res, 200, { ok: true, open: true, hostReady: true });
      return;
    }
    if (url === "/apply/image") {
      json(res, 200, { ok: true, generation: 4, mode: "image" });
      return;
    }
    if (url === "/apply/video") {
      json(res, 200, { ok: true, generation: 5, mode: "video" });
      return;
    }
    if (url === "/theme/apply") {
      const type = body.input.type;
      json(res, 200, {
        ok: true,
        generation: type === "video" ? 5 : 4,
        mode: type,
        theme: {
          id: `theme-${type}`,
          name: body.name,
          type,
        },
      });
      return;
    }
    if (url === "/apply/clear") {
      json(res, 200, { ok: true, generation: 6, mode: "clear" });
      return;
    }
    if (url === "/status") {
      json(res, 200, {
        ok: true,
        hostReady: true,
        sessions: 1,
        fish: false,
        muted: true,
        tone: "dark",
        manifest: { background: { type: "video" } },
      });
      return;
    }
    if (url === "/theme/list") {
      json(res, 200, { ok: true, themes });
      return;
    }
    if (url === "/theme/use") {
      json(res, 200, { ok: true, generation: 7, mode: "video" });
      return;
    }
    if (url === "/mode/fish") {
      json(res, 200, { ok: true, fish: body.enabled === true });
      return;
    }
    json(res, 404, { ok: false, error: "未找到请求的资源。" });
  });
  t.after(async () => {
    await tray.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await writeControl(root, tray.url);

  const actions = createBeauticodeActions(root);
  assert.equal((await actions.applyImage(image)).message, "已将「wall」设为背景。");
  assert.equal((await actions.applyVideo({ path: video, startAt: 12 })).ok, true);
  assert.equal((await actions.useTheme("雨夜")).theme.id, "theme-rain");
  assert.equal((await actions.setFish(true)).fish, true);
  assert.match(await runBgCommand(root, ""), /背景：视频/);
  assert.equal(await runBgCommand(root, `"${image}"`), "已将「wall」设为背景。");

  const videoApply = tray.received.find(
    (item) => item.url === "/theme/apply" && item.body.input.type === "video",
  );
  assert.equal(videoApply.body.name, "bg");
  assert.equal(videoApply.body.input.videoPath, video);
  assert.equal(videoApply.body.input.startAt, 12);
  assert.equal(videoApply.body.input.source, "local");
  const themeUse = tray.received.find((item) => item.url === "/theme/use");
  assert.equal(themeUse.body.id, "theme-rain");

  await assert.rejects(
    () => actions.applyVideo({ path: image }),
    /只接受 \.mp4/,
  );
});

test("failed apply preserves source mode and phase timings for diagnostics", async (t) => {
  const root = await createTempRoot();
  const image = path.join(root, "wall.png");
  await fs.writeFile(image, PNG_1X1);
  const tray = await startFakeTray(({ url }, res) => {
    if (url === "/health") {
      json(res, 200, { ok: true, open: true, hostReady: true });
      return;
    }
    if (url === "/theme/apply") {
      json(res, 200, {
        ok: false,
        error: "renderer failed",
        sourceMode: "local",
        timings: { totalMs: 1400, phases: { rendererVerify: 1200, rollback: 30 } },
      });
      return;
    }
    json(res, 404, { ok: false, error: "not found" });
  });
  t.after(async () => {
    await tray.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await writeControl(root, tray.url);

  await assert.rejects(
    () => createBeauticodeActions(root).applyImage(image),
    (error) => {
      assert.equal(error.sourceMode, "local");
      assert.equal(error.timings.phases.rendererVerify, 1200);
      assert.equal(error.timings.phases.rollback, 30);
      return true;
    },
  );
});

test("plugin registers tools and commands through optional inject", async (t) => {
  const root = await createTempRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tools = [];
  const commands = [];
  const injected = [];
  const ctx = {
    inject(deps, callback) {
      injected.push(deps);
      callback({
        tools: {
          register(definition) {
            tools.push(definition);
            return () => {};
          },
        },
        commands: {
          register(definition) {
            commands.push(definition);
            return () => {};
          },
        },
        get() {
          return undefined;
        },
      });
    },
  };
  registerAgentSurfaces(ctx, { dataRoot: root });
  assert.deepEqual(injected, [["tools"], ["commands"]]);
  assert.ok(tools.some((tool) => tool.name === "beauticode_apply_video"));
  assert.ok(tools.some((tool) => tool.name === "beauticode_theme_use"));
  assert.deepEqual(
    commands.map((command) => command.name),
    ["bg", "bg-theme", "bg-clear"],
  );
  assert.equal(typeof tools[0].output.render, "function");
  assert.ok(Number.isFinite(tools[0].timeoutMs));
});

test("empty /bg works without a tray by starting the in-process session", async (t) => {
  const root = await createTempRoot();
  const options = { dataRoot: root, baseUrl: "http://127.0.0.1:1" };
  t.after(async () => {
    await stopInProcessSession(root);
    await fs.rm(root, { recursive: true, force: true });
  });
  const text = await runBgCommand(options, "   ");
  assert.match(text, /背景：无/);
  assert.match(text, /\/bg-theme/);
});

test("in-process apply imports a video without the tray", async (t) => {
  const root = await createTempRoot();
  const dataRoot = path.join(root, "data");
  const image = path.join(root, "wall.png");
  const video = path.join(root, "bg.mp4");
  await fs.writeFile(image, PNG_1X1);
  await fs.writeFile(video, mp4Fixture());

  let current = null;
  let modes = { fish: false, muted: true, tone: "dark" };
  const server = http.createServer(async (req, res) => {
    const authorization = String(req.headers.authorization || "");
    if (!/^Bearer [a-f0-9]{64}$/.test(authorization)) {
      json(res, 401, { ok: false, error: "unauthorized" });
      return;
    }
    if (req.url === "/__beauticode/apply" && req.method === "POST") {
      current = await readBody(req);
      json(res, 200, { ok: true });
      return;
    }
    if (req.url === "/__beauticode/mode" && req.method === "POST") {
      modes = { ...modes, ...(await readBody(req)) };
      json(res, 200, { ok: true, modes });
      return;
    }
    if (req.url === "/__beauticode/status" && req.method === "GET") {
      json(res, 200, {
        ok: true,
        connectedClients: 1,
        current,
        readyClients: current ? 1 : 0,
        failedClients: 0,
        visibleClients: current && current.media !== "clear" ? 1 : 0,
        modeReadyClients: 1,
        blockedClients: 0,
        resolvedTone: "dark",
        modes,
        playback: null,
      });
      return;
    }
    json(res, 404, { ok: false });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await stopInProcessSession(dataRoot);
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });

  const actions = createBeauticodeActions({ dataRoot, baseUrl });
  const applied = await actions.applyVideo({ path: video, poster: image });
  assert.equal(applied.ok, true);
  assert.equal(applied.mode, "video");
  assert.equal(current.media, "video");
  assert.match(String(current.videoUrl), /^http:\/\/127\.0\.0\.1:\d+\//);
  const status = await actions.status();
  assert.equal(status.background?.type, "video");
  assert.equal(status.background?.source?.kind, "local");
  assert.equal(status.background?.video, undefined);
  assert.deepEqual((await fs.readdir(path.join(dataRoot, "active"))).sort(), [
    "background.json",
    "poster.png",
  ]);
});

test("prompt section failure does not prevent tool registration", () => {
  const tools = [];
  registerAgentSurfaces(
    {
      inject(deps, callback) {
        if (!deps.includes("tools")) return;
        callback({
          tools: {
            register(definition) {
              tools.push(definition);
              return () => {};
            },
          },
          get() {
            throw new Error("systemPrompt unavailable");
          },
        });
      },
    },
    { dataRoot: os.tmpdir() },
  );
  assert.ok(tools.some((tool) => tool.name === "beauticode_apply_video"));
});

test("page bridge still loads when inject is absent", async (t) => {
  const root = await createTempRoot();
  const tokenFile = path.join(root, "token");
  await fs.writeFile(tokenFile, "b".repeat(64));
  const routes = new Map();
  apply(
    {
      webServer: {
        register(route) {
          routes.set(route.path, route.handler);
          return () => routes.delete(route.path);
        },
        tapIndex() {
          return () => {};
        },
      },
      effect(factory) {
        return factory();
      },
    },
    { tokenFile },
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.ok(routes.has("/__beauticode/apply"));
  assert.ok(routes.has("/__beauticode/version"));
});

test("tray claim and session-host files ignore dead pids", async (t) => {
  const root = await createTempRoot();
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  await writeTrayClaim({ dataRoot: root, pid: process.pid });
  const liveClaim = await readTrayClaim(root);
  assert.equal(liveClaim.pid, process.pid);
  await writeSessionHostFile({
    dataRoot: root,
    host: "dsh",
    url: "http://127.0.0.1:9",
    token: TOKEN,
    pid: process.pid,
  });
  const liveHost = await readSessionHostFile(root);
  assert.equal(liveHost.host, "dsh");
  assert.equal(liveHost.pid, process.pid);
  assert.equal(await removeTrayClaim({ dataRoot: root, pid: process.pid }), true);
  assert.equal(await readTrayClaim(root), null);
  assert.equal(await removeSessionHostFile({ dataRoot: root, pid: process.pid }), true);
  assert.equal(await readSessionHostFile(root), null);
});

test("resolveApplyBackend waits for a tray claim to become a live tray", async (t) => {
  const root = await createTempRoot();
  const tray = await startFakeTray(async ({ url }, res) => {
    if (url === "/health") {
      json(res, 200, { ok: true });
      return;
    }
    json(res, 404, { ok: false });
  });
  t.after(async () => {
    await tray.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await writeTrayClaim({ dataRoot: root, pid: process.pid });
  setTimeout(() => {
    void writeControl(root, tray.url);
  }, 150);
  const backend = await resolveApplyBackend({
    dataRoot: root,
    baseUrl: "http://127.0.0.1:1",
  });
  assert.equal(backend.kind, "tray");
});

test("resolveApplyBackend refuses in-process start while a live tray claim remains", async (t) => {
  const root = await createTempRoot();
  t.after(async () => {
    await stopInProcessSession(root);
    await fs.rm(root, { recursive: true, force: true });
  });
  await writeTrayClaim({ dataRoot: root, pid: process.pid });
  await assert.rejects(
    () => resolveApplyBackend({ dataRoot: root, baseUrl: "http://127.0.0.1:1" }),
    (error) => error.message === TRAY_STARTING_MESSAGE && error.code === "TRAY_CLAIMED",
  );
});
