import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { apply } from "../index.mjs";
import {
  buildWindowsPickerScript,
  createWindowsMediaPicker,
  parseImportFilename,
  parseImportThemeName,
} from "../ui-host.mjs";
import {
  writeDshControlFile,
} from "../control-client.mjs";

const TOKEN = "b".repeat(64);
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

class FakeWebServer {
  routes = new Map();
  taps = [];

  register(route) {
    this.routes.set(route.path, route.handler);
    return () => this.routes.delete(route.path);
  }

  tapIndex(tap) {
    this.taps.push(tap);
    return () => this.taps.splice(this.taps.indexOf(tap), 1);
  }
}

async function createPluginServer(tokenFile, config = {}) {
  const webServer = new FakeWebServer();
  const effects = [];
  apply(
    {
      webServer,
      effect(factory) {
        effects.push(factory());
      },
    },
    { tokenFile, ...config },
  );
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url || "/", "http://x").pathname;
    const handler = webServer.routes.get(pathname);
    if (!handler) return res.writeHead(404).end();
    try {
      await handler(req, res);
    } catch (error) {
      res.writeHead(error.statusCode || 500).end(String(error.message || error));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    dispose: async () => {
      for (const effect of effects.reverse()) await effect?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("parseImportFilename accepts images and mp4 only", () => {
  assert.equal(parseImportFilename("雨夜.png").kind, "image");
  assert.equal(parseImportFilename("C:\\\\films\\\\clip.MP4").kind, "video");
  assert.equal(parseImportFilename("..\\\\evil.txt").ok, false);
  assert.match(parseImportFilename("").error, /缺少文件名/);
});

test("plugin injects a compact sidebar console script", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-ui-"));
  const tokenFile = path.join(root, "token");
  await fs.writeFile(tokenFile, TOKEN);
  const plugin = await createPluginServer(tokenFile, { allowManagedUpload: true });
  t.after(async () => {
    await plugin.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  const tap = new FakeWebServer();
  apply({ webServer: tap, effect(factory) { factory(); } }, { tokenFile });
  const injected = tap.taps[0]("<html><body></body></html>");
  assert.match(injected, /__beauticode\/client\.js/);
  assert.match(injected, /__beauticode\/console\.js/);

  const response = await fetch(`${plugin.origin}/__beauticode/console.js`);
  assert.equal(response.status, 200);
  const source = await response.text();
  assert.doesNotThrow(() => new Function(source));
  assert.match(source, /beauticode-console/);
  assert.match(source, /button\[aria-haspopup="dialog"\]/);
  assert.doesNotMatch(source, /摸鱼/);
  assert.doesNotMatch(source, /<select/);
  assert.match(source, /display:contents/);
  assert.match(source, /bc-theme-list/);
  assert.match(source, /beauticode-name-dialog/);
  assert.match(source, /ui\/import-selected/);
  assert.match(source, /native_picker_unavailable/);
  assert.match(source, /本地引用，未复制主媒体/);
  assert.match(source, /托管副本/);
  assert.match(source, /兼容模式会复制媒体文件/);
  assert.match(source, /45_000/);
  assert.match(source, /背景操作超时，控件已恢复/);
  assert.match(source, /\{ timeoutMs: 0 \}/);
  assert.doesNotMatch(source, /ui\/browse/);
  assert.doesNotMatch(source, /data-act="internal"/);
  assert.doesNotMatch(source, /data-act="infernal"/);
  assert.match(source, /data-act="gallery"/);
  assert.match(source, /builtin-gallery/);
  assert.match(source, /insertBefore/);
  assert.match(source, /fileInput\.type = "file"/);
  assert.doesNotMatch(source, /#beauticode-console\{[^}]*color-scheme/);
});

test("console UI routes require same-origin and reject bad files", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-ui-"));
  const tokenFile = path.join(root, "token");
  await fs.writeFile(tokenFile, TOKEN);
  const plugin = await createPluginServer(tokenFile, { allowManagedUpload: true });
  t.after(async () => {
    await plugin.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  assert.equal((await fetch(`${plugin.origin}/__beauticode/ui/preset`, { method: "POST" })).status, 403);
  const badPreset = await fetch(`${plugin.origin}/__beauticode/ui/preset`, {
    method: "POST",
    headers: { Origin: plugin.origin, "content-type": "application/json" },
    body: JSON.stringify({ id: "night" }),
  });
  assert.equal(badPreset.status, 400);

  assert.equal((await fetch(`${plugin.origin}/__beauticode/ui/status`)).status, 403);
  const status = await fetch(`${plugin.origin}/__beauticode/ui/status`, {
    headers: { Origin: plugin.origin },
  });
  assert.equal(status.status, 200);
  const body = await status.json();
  assert.equal(typeof body.ok, "boolean");
  if (body.ok) {
    assert.ok(["local", "managed", "clear"].includes(body.sourceMode));
    assert.equal(typeof body.importPolicy.nativeLocalRequired, "boolean");
  }

  assert.equal(
    (
      await fetch(`${plugin.origin}/__beauticode/ui/import`, {
        method: "POST",
        body: PNG_1X1,
      })
    ).status,
    403,
  );
  const badName = await fetch(`${plugin.origin}/__beauticode/ui/import`, {
    method: "POST",
    headers: {
      Origin: plugin.origin,
      "x-beauticode-filename": "notes.txt",
    },
    body: "nope",
  });
  assert.equal(badName.status, 400);
  assert.match((await badName.json()).error, /只支持/);

  const port = Number(new URL(plugin.origin).port);
  const tooLarge = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/__beauticode/ui/import",
        method: "POST",
        headers: {
          Origin: plugin.origin,
          "x-beauticode-filename": "poster.png",
          "x-beauticode-theme-name": encodeURIComponent("大图测试"),
          "content-length": String(20 * 1024 * 1024),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"),
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
  assert.equal(tooLarge.status, 413);
  assert.match(tooLarge.body.error, /过大/);

  assert.equal(
    (await fetch(`${plugin.origin}/__beauticode/ui/browse`, {
      method: "POST",
      headers: { Origin: plugin.origin },
    })).status,
    404,
  );
  assert.equal(
    (await fetch(`${plugin.origin}/__beauticode/ui/import-local`, {
      method: "POST",
      headers: { Origin: plugin.origin },
    })).status,
    404,
  );
});

test("Windows picker uses a foreground owner and a parent watchdog", () => {
  const script = buildWindowsPickerScript("video", { parentPid: 4242, timeoutMs: 9000 });
  assert.match(script, /\$owner\.TopMost = \$true/);
  assert.match(script, /\$owner\.ShowInTaskbar = \$false/);
  assert.match(script, /\$owner\.Show\(\).*\$owner\.Hide\(\).*\$owner\.Show\(\)/);
  assert.match(script, /\$dialog\.ShowDialog\(\$owner\)/);
  assert.match(script, /\$dshPid = 4242/);
  assert.match(script, /Get-Process -Id \$dshPid/);
  assert.match(script, /AddMilliseconds\(9000\)/);
  assert.doesNotMatch(script, /\$dialog\.ShowDialog\(\)/);
});

test("Windows picker encodes the script and kills its child on abort", async () => {
  class FakeChild extends EventEmitter {
    stdout = new PassThrough();
    stderr = new PassThrough();
    killed = false;
    signals = [];

    kill(signal) {
      this.killed = true;
      this.signals.push(signal);
      return true;
    }
  }
  const child = new FakeChild();
  const parent = new EventEmitter();
  let spawnCall;
  const picker = createWindowsMediaPicker({
    platform: "win32",
    parentProcess: parent,
    parentPid: 4242,
    timeoutMs: 1000,
    spawnProcess(command, args, options) {
      spawnCall = { command, args, options };
      return child;
    },
  });
  const controller = new AbortController();
  const picking = picker("image", { signal: controller.signal });
  controller.abort();
  await assert.rejects(picking, (error) => error.code === "picker_request_aborted");
  assert.equal(spawnCall.command, "powershell.exe");
  assert.equal(spawnCall.options.windowsHide, true);
  assert.ok(spawnCall.args.includes("-STA"));
  const encodedIndex = spawnCall.args.indexOf("-EncodedCommand");
  assert.ok(encodedIndex >= 0);
  const script = Buffer.from(spawnCall.args[encodedIndex + 1], "base64").toString("utf16le");
  assert.match(script, /ShowDialog\(\$owner\)/);
  assert.deepEqual(child.signals, ["SIGKILL"]);
  assert.equal(parent.listenerCount("exit"), 0);
});

test("Windows policy refuses managed upload and requires the native local picker", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-local-contract-"));
  const tokenFile = path.join(root, "token");
  await fs.writeFile(tokenFile, TOKEN);
  const plugin = await createPluginServer(tokenFile, {
    allowManagedUpload: false,
    pickMedia: async () => {
      const error = new Error("PowerShell unavailable");
      error.code = "native_picker_unavailable";
      throw error;
    },
  });
  t.after(async () => {
    await plugin.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  const upload = await fetch(`${plugin.origin}/__beauticode/ui/import`, {
    method: "POST",
    headers: {
      Origin: plugin.origin,
      "x-beauticode-filename": "poster.png",
      "x-beauticode-theme-name": encodeURIComponent("不应上传"),
    },
    body: PNG_1X1,
  });
  assert.equal(upload.status, 409);
  assert.equal((await upload.json()).code, "local_import_required");

  const pick = await fetch(`${plugin.origin}/__beauticode/ui/pick`, {
    method: "POST",
    headers: { Origin: plugin.origin, "content-type": "application/json" },
    body: JSON.stringify({ kind: "image" }),
  });
  assert.equal(pick.status, 501);
  assert.equal((await pick.json()).code, "native_picker_required");
});

test("native picker cancellation, errors, and token expiry are explicit", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-picker-"));
  const tokenFile = path.join(root, "token");
  const selectedImage = path.join(root, "selected.png");
  await fs.writeFile(tokenFile, TOKEN);
  await fs.writeFile(selectedImage, PNG_1X1);
  let clock = 1_000;
  let mode = "cancel";
  const plugin = await createPluginServer(tokenFile, {
    allowManagedUpload: true,
    now: () => clock,
    selectionTtlMs: 100,
    pickMedia: async (kind) => {
      if (mode === "cancel") return { ok: true, cancelled: true };
      if (mode === "unavailable") {
        const error = new Error("PowerShell unavailable");
        error.code = "native_picker_unavailable";
        throw error;
      }
      if (mode === "error") throw new Error("picker failed");
      return { ok: true, kind, path: selectedImage, name: "selected.png" };
    },
  });
  t.after(async () => {
    await plugin.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  const pick = () => fetch(`${plugin.origin}/__beauticode/ui/pick`, {
    method: "POST",
    headers: { Origin: plugin.origin, "content-type": "application/json" },
    body: JSON.stringify({ kind: "image" }),
  });

  const cancelled = await pick();
  const cancelledBody = await cancelled.json();
  assert.equal(cancelledBody.ok, true);
  assert.equal(cancelledBody.cancelled, true);
  assert.equal(typeof cancelledBody.pickerMs, "number");

  mode = "error";
  const failed = await pick();
  assert.equal(failed.status, 422);
  assert.equal("code" in (await failed.json()), false);

  mode = "unavailable";
  const unavailable = await pick();
  assert.equal(unavailable.status, 501);
  assert.equal((await unavailable.json()).code, "native_picker_unavailable");

  mode = "select";
  const selection = await (await pick()).json();
  clock += 101;
  const expired = await fetch(`${plugin.origin}/__beauticode/ui/import-selected`, {
    method: "POST",
    headers: { Origin: plugin.origin, "content-type": "application/json" },
    body: JSON.stringify({ selectionId: selection.selectionId, themeName: "过期" }),
  });
  assert.equal(expired.status, 410);
});

test("native picker permits only one dialog at a time", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-picker-busy-"));
  const tokenFile = path.join(root, "token");
  await fs.writeFile(tokenFile, TOKEN);
  let releasePicker;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const plugin = await createPluginServer(tokenFile, {
    pickMedia: async () => {
      markStarted();
      await new Promise((resolve) => { releasePicker = resolve; });
      return { ok: true, cancelled: true };
    },
  });
  t.after(async () => {
    await plugin.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  const request = () => fetch(`${plugin.origin}/__beauticode/ui/pick`, {
    method: "POST",
    headers: { Origin: plugin.origin, "content-type": "application/json" },
    body: JSON.stringify({ kind: "video" }),
  });

  const first = request();
  await started;
  const second = await request();
  assert.equal(second.status, 409);
  releasePicker();
  assert.equal((await first).status, 200);
});

test("native picker is cancelled and unlocked when its page disconnects", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-picker-abort-"));
  const tokenFile = path.join(root, "token");
  await fs.writeFile(tokenFile, TOKEN);
  let calls = 0;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const plugin = await createPluginServer(tokenFile, {
    pickMedia: async (_kind, { signal }) => {
      calls += 1;
      if (calls > 1) return { ok: true, cancelled: true };
      markStarted();
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          const error = new Error("request aborted");
          error.code = "picker_request_aborted";
          reject(error);
        }, { once: true });
      });
    },
  });
  t.after(async () => {
    await plugin.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  const controller = new AbortController();
  const first = fetch(`${plugin.origin}/__beauticode/ui/pick`, {
    method: "POST",
    headers: { Origin: plugin.origin, "content-type": "application/json" },
    body: JSON.stringify({ kind: "video" }),
    signal: controller.signal,
  });
  await started;
  controller.abort();
  await assert.rejects(first, (error) => error.name === "AbortError");

  const deadline = Date.now() + 1_000;
  let second;
  do {
    second = await fetch(`${plugin.origin}/__beauticode/ui/pick`, {
      method: "POST",
      headers: { Origin: plugin.origin, "content-type": "application/json" },
      body: JSON.stringify({ kind: "video" }),
    });
    if (second.status !== 409) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.equal(second.status, 200);
  assert.equal((await second.json()).cancelled, true);
});

test("disposing the plugin aborts and closes an active picker request", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-picker-dispose-"));
  const tokenFile = path.join(root, "token");
  await fs.writeFile(tokenFile, TOKEN);
  let markStarted;
  let aborted = false;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const plugin = await createPluginServer(tokenFile, {
    pickMedia: async (_kind, { signal }) => {
      markStarted();
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          const error = new Error("disposed");
          error.code = "picker_request_aborted";
          reject(error);
        }, { once: true });
      });
    },
  });
  const request = fetch(`${plugin.origin}/__beauticode/ui/pick`, {
    method: "POST",
    headers: { Origin: plugin.origin, "content-type": "application/json" },
    body: JSON.stringify({ kind: "video" }),
  });
  await started;
  await plugin.dispose();
  await assert.rejects(request);
  assert.equal(aborted, true);
  await fs.rm(root, { recursive: true, force: true });
});

test("console import reuses a live tray control plane", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-ui-"));
  const tokenFile = path.join(root, "token");
  const selectedImage = path.join(root, "selected.png");
  await fs.writeFile(tokenFile, TOKEN);
  await fs.writeFile(selectedImage, PNG_1X1);
  const received = [];
  const tray = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({
      url: req.url,
      method: req.method,
      authorization: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"),
    });
    if (received.at(-1).url === "/theme/apply" && received.at(-1).body.name === "失败测试") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: false,
        error: "renderer failed",
        sourceMode: "local",
        timings: { totalMs: 1400, phases: { rendererVerify: 1200, rollback: 30 } },
      }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        generation: 3,
        mode: "image",
        sourceMode: received.at(-1)?.body?.input?.source ?? "managed",
        timings: { totalMs: 12, phases: { rendererVerify: 3 } },
        theme: { id: "theme-test", name: "测试图片", type: "image" },
      }),
    );
  });
  await new Promise((resolve) => tray.listen(0, "127.0.0.1", resolve));
  const trayUrl = `http://127.0.0.1:${tray.address().port}`;
  await writeDshControlFile({
    dataRoot: root,
    url: trayUrl,
    token: TOKEN,
    pid: process.pid,
  });
  const plugin = await createPluginServer(tokenFile, {
    allowManagedUpload: true,
    pickMedia: async (kind) => ({
      ok: true,
      kind,
      path: selectedImage,
      name: "selected.png",
    }),
  });
  t.after(async () => {
    await plugin.dispose();
    await new Promise((resolve) => tray.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });

  const imported = await fetch(`${plugin.origin}/__beauticode/ui/import`, {
    method: "POST",
    headers: {
      Origin: plugin.origin,
      "x-beauticode-filename": "poster.png",
      "x-beauticode-theme-name": encodeURIComponent("测试图片"),
    },
    body: PNG_1X1,
  });
  assert.equal(imported.status, 200);
  assert.equal((await imported.json()).ok, true);
  const applied = received.find((item) => item.url === "/theme/apply");
  assert.ok(applied);
  assert.equal(applied.authorization, `Bearer ${TOKEN}`);
  assert.match(applied.body.input.imagePath, /\.png$/);
  assert.equal(applied.body.input.source, "managed");

  const picked = await fetch(`${plugin.origin}/__beauticode/ui/pick`, {
    method: "POST",
    headers: { Origin: plugin.origin, "content-type": "application/json" },
    body: JSON.stringify({ kind: "image" }),
  });
  assert.equal(picked.status, 200);
  const selection = await picked.json();
  assert.equal(selection.name, "selected.png");
  assert.equal(selection.suggestedThemeName, "selected");
  assert.equal(typeof selection.selectionId, "string");
  assert.equal("path" in selection, false);
  assert.equal(JSON.stringify(selection).includes(selectedImage), false);

  const selected = await fetch(`${plugin.origin}/__beauticode/ui/import-selected`, {
    method: "POST",
    headers: { Origin: plugin.origin, "content-type": "application/json" },
    body: JSON.stringify({
      selectionId: selection.selectionId,
      themeName: "本地图片",
    }),
  });
  assert.equal(selected.status, 200);
  const selectedBody = await selected.json();
  assert.equal(selectedBody.sourceMode, "local");
  assert.equal(typeof selectedBody.importTimings.applyAndSaveMs, "number");
  assert.equal(selectedBody.importTimings.core.phases.rendererVerify, 3);
  const localApplied = received.at(-1);
  assert.equal(localApplied.url, "/theme/apply");
  assert.equal(localApplied.body.name, "本地图片");
  assert.equal(localApplied.body.input.source, "local");
  assert.equal(localApplied.body.input.imagePath, selectedImage);
  const timingLog = await fs.readFile(path.join(root, "logs", "import-timing.jsonl"), "utf8");
  assert.match(timingLog, /"route":"native-local"/);
  assert.match(timingLog, /"sourceMode":"local"/);

  const reused = await fetch(`${plugin.origin}/__beauticode/ui/import-selected`, {
    method: "POST",
    headers: { Origin: plugin.origin, "content-type": "application/json" },
    body: JSON.stringify({
      selectionId: selection.selectionId,
      themeName: "重复",
    }),
  });
  assert.equal(reused.status, 410);

  const failedPick = await fetch(`${plugin.origin}/__beauticode/ui/pick`, {
    method: "POST",
    headers: { Origin: plugin.origin, "content-type": "application/json" },
    body: JSON.stringify({ kind: "image" }),
  });
  const failedSelection = await failedPick.json();
  const failedImport = await fetch(`${plugin.origin}/__beauticode/ui/import-selected`, {
    method: "POST",
    headers: { Origin: plugin.origin, "content-type": "application/json" },
    body: JSON.stringify({
      selectionId: failedSelection.selectionId,
      themeName: "失败测试",
    }),
  });
  assert.equal(failedImport.status, 422);
  const failedBody = await failedImport.json();
  assert.equal(failedBody.sourceMode, "local");
  assert.equal(failedBody.timings.phases.rendererVerify, 1200);
  const timingLines = (await fs.readFile(
    path.join(root, "logs", "import-timing.jsonl"),
    "utf8",
  )).trim().split("\n").map((line) => JSON.parse(line));
  const failedTiming = timingLines.at(-1);
  assert.equal(failedTiming.ok, false);
  assert.equal(failedTiming.sourceMode, "local");
  assert.equal(failedTiming.core.phases.rendererVerify, 1200);
  assert.equal(failedTiming.core.phases.rollback, 30);
});

test("theme names keep the existing length and illegal-character rules", () => {
  assert.deepEqual(parseImportThemeName("  雨夜  "), { ok: true, name: "雨夜" });
  assert.equal(parseImportThemeName("").ok, false);
  assert.equal(parseImportThemeName("a".repeat(81)).ok, false);
  assert.equal(parseImportThemeName("坏/名字").ok, false);
});


