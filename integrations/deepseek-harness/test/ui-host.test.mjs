import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { apply } from "../index.mjs";
import { parseImportFilename } from "../ui-host.mjs";
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

async function createPluginServer(tokenFile) {
  const webServer = new FakeWebServer();
  const effects = [];
  apply(
    {
      webServer,
      effect(factory) {
        effects.push(factory());
      },
    },
    { tokenFile },
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
  const plugin = await createPluginServer(tokenFile);
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
  assert.doesNotMatch(source, /data-act="internal"/);
  assert.doesNotMatch(source, /data-act="infernal"/);
  assert.doesNotMatch(source, /data-act="gallery"/);
  assert.match(source, /builtin-gallery/);
  assert.match(source, /insertBefore/);
  assert.match(source, /fileInput\.type = "file"/);
  assert.doesNotMatch(source, /#beauticode-console\{[^}]*color-scheme/);
});

test("console UI routes require same-origin and reject bad files", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-ui-"));
  const tokenFile = path.join(root, "token");
  await fs.writeFile(tokenFile, TOKEN);
  const plugin = await createPluginServer(tokenFile);
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
});

test("console import reuses a live tray control plane", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-ui-"));
  const tokenFile = path.join(root, "token");
  await fs.writeFile(tokenFile, TOKEN);
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
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, generation: 3, mode: "image" }));
  });
  await new Promise((resolve) => tray.listen(0, "127.0.0.1", resolve));
  const trayUrl = `http://127.0.0.1:${tray.address().port}`;
  await writeDshControlFile({
    dataRoot: root,
    url: trayUrl,
    token: TOKEN,
    pid: process.pid,
  });
  const plugin = await createPluginServer(tokenFile);
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
    },
    body: PNG_1X1,
  });
  assert.equal(imported.status, 200);
  assert.equal((await imported.json()).ok, true);
  const applied = received.find((item) => item.url === "/apply/image");
  assert.ok(applied);
  assert.equal(applied.authorization, `Bearer ${TOKEN}`);
  assert.match(applied.body.imagePath, /\.png$/);
});


