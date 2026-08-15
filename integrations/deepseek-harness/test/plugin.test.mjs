import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { apply } from "../index.mjs";

const TOKEN = "b".repeat(64);

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
  const port = server.address().port;
  return {
    webServer,
    origin: `http://127.0.0.1:${port}`,
    dispose: async () => {
      for (const effect of effects.reverse()) await effect?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function openEvents(origin, clientId) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      `${origin}/__beauticode/events?clientId=${clientId}`,
      { headers: { "Sec-Fetch-Site": "same-origin" } },
      (response) => {
        let data = "";
        response.on("data", (chunk) => {
          data += chunk;
          if (data.includes(": connected")) resolve({ request, response, read: () => data });
        });
      },
    );
    request.on("error", reject);
  });
}

test("plugin injects its client script exactly once", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-dsh-plugin-"));
  const tokenFile = path.join(root, "token");
  await fs.writeFile(tokenFile, TOKEN);
  const plugin = await createPluginServer(tokenFile);
  t.after(async () => {
    await plugin.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  const tap = plugin.webServer.taps[0];
  const once = tap("<html><body></body></html>");
  const twice = tap(once);
  assert.equal((twice.match(/data-beauticode-bridge/g) || []).length, 1);
  const response = await fetch(`${plugin.origin}/__beauticode/client.js`);
  assert.equal(response.status, 200);
  const source = await response.text();
  assert.doesNotThrow(() => new Function(source));
  assert.match(source, /:has\(#root \[data-phase="active"\]\)/);
  assert.match(source, /:has\(#root \[data-phase="settling"\]\)/);
  assert.doesNotMatch(source, /:has\(#root \[data-phase="hero"\]\)/);
  assert.match(source, /#beauticode-bg-stage::after\{background:rgba\(0,0,0,\.42\)\}/);
  assert.match(source, /data-bc-resolved-tone/);
  assert.match(source, /toggleAttribute\("data-ds-dark-theme"/);
  assert.match(source, /prefers-color-scheme: dark/);
  assert.match(source, /new MutationObserver\(scheduleDshThemeSync\)/);

  const version = await fetch(`${plugin.origin}/__beauticode/version`);
  assert.deepEqual(await version.json(), {
    ok: true,
    protocol: 4,
    revision: "source",
  });
  assert.equal(
    (await fetch(`${plugin.origin}/__beauticode/version`, { method: "HEAD" })).status,
    200,
  );
  assert.equal(
    (await fetch(`${plugin.origin}/__beauticode/version`, { method: "POST" })).status,
    405,
  );
});

test("browser client keeps the DSH palette synchronized with beautiCode tone", async () => {
  const source = await fs.readFile(new URL("../client.js", import.meta.url), "utf8");
  const attributes = new Set();
  const body = {
    hasAttribute: (name) => attributes.has(name),
    toggleAttribute(name, force) {
      if (force) attributes.add(name);
      else attributes.delete(name);
    },
    prepend() {},
  };
  const documentElement = {
    dataset: {},
    style: { colorScheme: "" },
    removeAttribute(name) {
      if (name === "data-bc-fish") delete this.dataset.bcFish;
    },
  };
  const media = {
    matches: false,
    listener: null,
    addEventListener(_name, listener) {
      this.listener = listener;
    },
  };
  let events;
  let observerCallback;
  const context = {
    crypto: { randomUUID: () => "client-theme-test" },
    document: {
      body,
      documentElement,
      head: { append() {} },
      createElement: () => ({ dataset: {}, style: {} }),
      getElementById: () => null,
      querySelector: () => null,
    },
    fetch: async () => ({ ok: true }),
    HTMLMediaElement: { HAVE_CURRENT_DATA: 2 },
    HTMLVideoElement: class {},
    Image: class {},
    matchMedia: () => media,
    MutationObserver: class {
      constructor(callback) {
        observerCallback = callback;
      }
      observe() {}
    },
    EventSource: class {
      constructor() {
        events = this;
      }
    },
    queueMicrotask: (callback) => callback(),
    setInterval: () => 0,
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context);

  const applyTone = async (tone) => {
    events.onmessage({
      data: JSON.stringify({ type: "mode", fish: false, muted: true, tone }),
    });
    await new Promise((resolve) => setImmediate(resolve));
  };

  await applyTone("light");
  assert.equal(documentElement.dataset.bcResolvedTone, "light");
  assert.equal(documentElement.style.colorScheme, "light");
  assert.equal(body.hasAttribute("data-ds-dark-theme"), false);

  await applyTone("dark");
  assert.equal(documentElement.dataset.bcResolvedTone, "dark");
  assert.equal(documentElement.style.colorScheme, "dark");
  assert.equal(body.hasAttribute("data-ds-dark-theme"), true);

  attributes.delete("data-ds-dark-theme");
  documentElement.style.colorScheme = "light";
  observerCallback();
  assert.equal(documentElement.style.colorScheme, "dark");
  assert.equal(body.hasAttribute("data-ds-dark-theme"), true);

  await applyTone("auto");
  assert.equal(documentElement.dataset.bcResolvedTone, "light");
  assert.equal(body.hasAttribute("data-ds-dark-theme"), false);
  media.matches = true;
  media.listener();
  assert.equal(documentElement.dataset.bcResolvedTone, "dark");
  assert.equal(documentElement.style.colorScheme, "dark");
  assert.equal(body.hasAttribute("data-ds-dark-theme"), true);
});

test("authenticated apply reaches SSE client and same-origin ack becomes ready", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-dsh-plugin-"));
  const tokenFile = path.join(root, "token");
  await fs.writeFile(tokenFile, TOKEN);
  const plugin = await createPluginServer(tokenFile);
  const events = await openEvents(plugin.origin, "client-test-01");
  t.after(async () => {
    events.request.destroy();
    events.response.destroy();
    await plugin.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  const payload = {
    generation: 9,
    media: "image",
    imageUrl: "http://127.0.0.1:45678/media/image?t=secret",
  };
  const applied = await fetch(`${plugin.origin}/__beauticode/apply`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(applied.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(events.read(), /"generation":9/);

  const acked = await fetch(`${plugin.origin}/__beauticode/ack`, {
    method: "POST",
    headers: { Origin: plugin.origin, "content-type": "application/json" },
    body: JSON.stringify({
      clientId: "client-test-01",
      kind: "render",
      generation: 9,
      media: "image",
      ok: true,
      visible: true,
    }),
  });
  assert.equal(acked.status, 200);

  const status = await fetch(`${plugin.origin}/__beauticode/status`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.deepEqual(await status.json(), {
    ok: true,
    connectedClients: 1,
    current: { ...payload, videoUrl: null, startAt: null },
    readyClients: 1,
    failedClients: 0,
    visibleClients: 1,
    modeReadyClients: 0,
    blockedClients: 0,
    resolvedTone: null,
    modes: { fish: false, muted: true, tone: "dark" },
    playback: null,
  });
});

test("video apply and display modes are broadcast and acknowledged", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-dsh-plugin-"));
  const tokenFile = path.join(root, "token");
  await fs.writeFile(tokenFile, TOKEN);
  const plugin = await createPluginServer(tokenFile);
  const events = await openEvents(plugin.origin, "client-video-01");
  t.after(async () => {
    events.request.destroy();
    events.response.destroy();
    await plugin.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  const payload = {
    generation: 12,
    media: "video",
    imageUrl: "http://127.0.0.1:45678/media/image?t=poster",
    videoUrl: "http://127.0.0.1:45678/media/video?t=movie",
    startAt: 4.25,
  };
  const applied = await fetch(`${plugin.origin}/__beauticode/apply`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(applied.status, 200);

  const mode = await fetch(`${plugin.origin}/__beauticode/mode`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ fish: true, muted: false, tone: "light" }),
  });
  assert.equal(mode.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(events.read(), /"media":"video"/);
  assert.match(events.read(), /"tone":"light"/);

  const headers = { Origin: plugin.origin, "content-type": "application/json" };
  assert.equal((await fetch(`${plugin.origin}/__beauticode/ack`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      clientId: "client-video-01",
      kind: "render",
      generation: 12,
      media: "video",
      ok: true,
      visible: true,
      playback: {
        currentTime: 4.8,
        duration: 20,
        hasVideo: true,
        muted: true,
        paused: false,
        blocked: true,
      },
    }),
  })).status, 200);
  assert.equal((await fetch(`${plugin.origin}/__beauticode/ack`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      clientId: "client-video-01",
      kind: "mode",
      fish: true,
      muted: true,
      tone: "light",
      resolvedTone: "light",
      themeSynced: true,
      blocked: true,
    }),
  })).status, 200);

  const status = await fetch(`${plugin.origin}/__beauticode/status`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const body = await status.json();
  assert.deepEqual(body.current, payload);
  assert.deepEqual(body.modes, { fish: true, muted: false, tone: "light" });
  assert.equal(body.readyClients, 1);
  assert.equal(body.modeReadyClients, 1);
  assert.equal(body.blockedClients, 1);
  assert.equal(body.resolvedTone, "light");
  assert.equal(body.playback.currentTime, 4.8);
});
