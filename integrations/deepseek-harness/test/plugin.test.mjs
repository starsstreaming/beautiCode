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
  injections = [];

  register(route) {
    this.routes.set(route.path, route.handler);
    return () => this.routes.delete(route.path);
  }

  collectIndexInjections() {
    const rows = [];
    for (const contribute of this.injections) contribute(rows);
    return rows;
  }
}

async function createPluginServer(tokenFile) {
  const webServer = new FakeWebServer();
  const effects = [];
  apply(
    {
      webServer,
      on(event, contribute) {
        assert.equal(event, "webserver/index-inject");
        webServer.injections.push(contribute);
        return () => webServer.injections.splice(webServer.injections.indexOf(contribute), 1);
      },
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

function openEvents(origin, clientId, headers = { "Sec-Fetch-Site": "same-origin" }) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      `${origin}/__beauticode/events?clientId=${clientId}`,
      { headers },
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

function rawHttp(origin, pathname, { method = "GET", headers = {}, body = "" } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(new URL(pathname, origin), {
      method,
      headers: {
        ...(body ? { "content-length": Buffer.byteLength(body) } : {}),
        ...headers,
      },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve({ status: response.statusCode }));
    });
    request.once("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

test("Desktop page key admits proxied UI and event requests", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-dsh-desktop-"));
  const tokenFile = path.join(root, "token");
  await fs.writeFile(tokenFile, TOKEN);
  const plugin = await createPluginServer(tokenFile);
  t.after(async () => {
    await plugin.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  const key = plugin.webServer.collectIndexInjections()[0].value;
  const denied = await fetch(`${plugin.origin}/__beauticode/ui/status`);
  assert.equal(denied.status, 403);
  const allowed = await fetch(`${plugin.origin}/__beauticode/ui/status`, {
    headers: { "X-Beauticode-Desktop-Key": key },
  });
  assert.equal(allowed.status, 200);
  const stream = await openEvents(plugin.origin, "desktop-client", {
    "X-Beauticode-Desktop-Key": key,
  });
  stream.request.destroy();
});

test("plugin publishes one ordered browser injection table for Web and Desktop", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-dsh-plugin-"));
  const tokenFile = path.join(root, "token");
  await fs.writeFile(tokenFile, TOKEN);
  const plugin = await createPluginServer(tokenFile);
  t.after(async () => {
    await plugin.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  const rows = plugin.webServer.collectIndexInjections();
  assert.deepEqual(rows.map((row) => row.kind), ["global", ...Array(5).fill("script-src")]);
  assert.deepEqual(rows.slice(1).map((row) => row.src), [
    "/__beauticode/transport.js",
    "/__beauticode/atmosphere.js",
    "/__beauticode/client.js",
    "/__beauticode/console.js",
    "/__beauticode/gallery.js",
  ]);
  assert.match(rows[0].value, /^[a-f0-9]{64}$/);
  const transport = await fetch(`${plugin.origin}/__beauticode/transport.js`);
  assert.equal(transport.status, 200);
  const transportSource = await transport.text();
  assert.doesNotThrow(() => new Function(transportSource));
  const atmosphere = await fetch(`${plugin.origin}/__beauticode/atmosphere.js`);
  assert.equal(atmosphere.status, 200);
  const atmosphereSource = await atmosphere.text();
  assert.doesNotThrow(() => new Function(atmosphereSource));
  const response = await fetch(`${plugin.origin}/__beauticode/client.js`);
  assert.equal(response.status, 200);
  const source = await response.text();
  assert.ok(source.indexOf("BeauticodeReadableSurfaces") < source.indexOf("__beauticodeBridgeLoaded"),
    "surface protection initializes before the media bridge");
  assert.doesNotThrow(() => new Function(source));
  assert.match(source, /waitForStablePlayback/);
  assert.match(
    source,
    /if \(reusable && payload\.media === "video"\)[\s\S]*?await waitForStablePlayback\(reusableVideo, signal, Math\.min\(750, remaining\(\)\)\)/,
  );
  const playWithPreferenceSource = source.match(
    /async function playWithPreference\([\s\S]*?\n  \}/,
  )?.[0];
  assert.ok(playWithPreferenceSource);
  assert.doesNotMatch(playWithPreferenceSource, /playbackBlocked = blocked/);
  assert.match(playWithPreferenceSource, /return blocked/);
  assert.match(source, /playbackBlocked = await playWithPreference\(video\)/);
  assert.match(
    source,
    /remainingMs\(\) > CROSSFADE_MS \+ FRAME_FALLBACK_MS \* 2 \+ 250/,
  );
  assert.match(source, /renderPhase = "pending"/);
  assert.match(source, /renderPhase === "ready"/);
  assert.doesNotMatch(source, /acknowledgeRender\(activePayload, video\.readyState >= 2/);
  assert.match(source, /requestVideoFrameCallback/);
  assert.match(source, /VIDEO_FIRST_FRAME_PROGRESS_SEC = 0\.03/);
  assert.match(source, /VIDEO_STABLE_FRAMES = 3/);
  assert.match(source, /VIDEO_STABLE_PROGRESS_SEC = 0\.18/);
  assert.match(source, /VIDEO_PROBE_TIMEOUT_MS = 2_000/);
  assert.match(source, /Range: "bytes=0-1"/);
  assert.match(source, /视频媒体不可达或被 CORS 拒绝/);
  assert.match(
    source,
    /video\.load\(\);[\s\S]*?const sourceProbe = probeVideoSource\([\s\S]*?await Promise\.all\(\[\s*sourceProbe,/,
  );
  // Poster-first commit: the phase-one gate no longer awaits a presented frame;
  // the settle phase owns it with its own long budget and can never roll back.
  assert.match(
    source,
    /startCandidatePlayback\(video, signal, Math\.min\(PLAY_ACCEPT_TIMEOUT_MS, remaining\(\)\)\)/,
  );
  assert.match(source, /acknowledgeRender\(payload, true, true, null, \{ videoReady: false \}\)/);
  assert.match(source, /settleCommittedVideo\(video, candidate, payload\);/);
  assert.match(
    source,
    /await waitForPresentedFrame\(video, controller\.signal, VIDEO_SETTLE_TIMEOUT_MS\)/,
  );
  assert.match(source, /VIDEO_SETTLE_TIMEOUT_MS = 60_000/);
  assert.match(source, /视频预热未完成（已保留封面）/);
  assert.match(source, /const nextStartAt = seekVideo\(reusableVideo, normalizedStartAt\)/);
  assert.match(source, /currentSlot\.dataset\.bcImageUrl = payload\.imageUrl/);
  assert.match(source, /img\{z-index:2;opacity:1\}/);
  assert.match(source, /video\{z-index:1;opacity:1\}/);
  assert.doesNotMatch(source, /video\{z-index:1;opacity:\.001\}/);
  assert.match(source, /addEventListener\("canplay"/);
  assert.match(source, /addEventListener\("playing"/);
  assert.match(source, /addEventListener\("waiting"/);
  assert.match(source, /addEventListener\("stalled"/);
  assert.match(source, /addEventListener\("pause", resetStableWindow\)/);
  assert.match(source, /addEventListener\("seeking", resetStableWindow\)/);
  assert.match(source, /data-bc-transitioning/);
  assert.match(source, /function disposeVideo\(/);
  assert.match(source, /new AbortController\(\)/);
  assert.doesNotMatch(source, /replaceChildren\(image, video\)/);
  assert.match(source, /MEDIA_ERR_DECODE/);
  assert.match(source, /:has\(#root \[data-phase="active"\]\)/);
  assert.match(source, /:has\(#root \[data-phase="settling"\]\)/);
  assert.doesNotMatch(source, /:has\(#root \[data-phase="hero"\]\)/);
  assert.match(
    source,
    /#beauticode-bg-stage::after\{background:rgba\(0,0,0,0\)\}/,
    "the background shadow defaults to zero",
  );
  const dimUserStage = source.indexOf(
    'html[data-bc-dim-user="true"][data-bc-active="true"] #beauticode-bg-stage::after{background:rgba(0,0,0,var(--bc-dim))!important}',
  );
  const fishStage = source.indexOf(
    'html[data-bc-fish="true"] #beauticode-bg-stage::after{background:transparent!important}',
  );
  assert.ok(dimUserStage > 0, "user dim veil must exist");
  assert.ok(fishStage > dimUserStage, "fish veil must stay after user dim");
  assert.match(
    source,
    /html\[data-bc-resolved-tone="light"\]\[data-bc-dim-user="true"\]\[data-bc-active="true"\] #beauticode-bg-stage::after\{background:rgba\(255,255,255,var\(--bc-dim\)\)!important\}/,
  );
  assert.match(source, /BeauticodeBackgroundDim/);
  assert.match(source, /data-bc-resolved-tone/);
  assert.match(source, /data-ds-dark-theme/);
  assert.doesNotMatch(source, /toggleAttribute\("data-ds-dark-theme"/);
  assert.match(source, /prefers-color-scheme: dark/);
  assert.match(source, /new MutationObserver\(scheduleDshThemeSync\)/);
  assert.match(source, /function dshStructureIssue\(\)/);
  assert.match(source, /CLIENT_APPLY_DEADLINE_MS = 8_000/);
  assert.match(source, /DSH_STRUCTURE_TIMEOUT_MS = CLIENT_APPLY_DEADLINE_MS/);
  assert.match(source, /function waitForDshStructure\(/);
  assert.match(source, /function syncGallery\(/);
  assert.match(source, /preset === "gallery"/);
  assert.match(source, /未找到 #root/);
  const hostApplySource = await fs.readFile(
    new URL("../host-apply.mjs", import.meta.url),
    "utf8",
  );
  assert.match(hostApplySource, /const DSH_VERIFY_DEADLINE_MS = 10_000/);
  assert.match(hostApplySource, /verifyDeadlineMs: DSH_VERIFY_DEADLINE_MS/);

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

test("HTTP routes reject DNS-rebinding Host and cross-origin authorities", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-host-guard-"));
  const tokenFile = path.join(root, "token");
  await fs.writeFile(tokenFile, TOKEN);
  const plugin = await createPluginServer(tokenFile);
  t.after(async () => {
    await plugin.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  const port = new URL(plugin.origin).port;
  const sameOrigin = { Origin: plugin.origin };
  assert.equal(
    (await fetch(`${plugin.origin}/__beauticode/ui/status`, { headers: sameOrigin })).status,
    200,
  );
  assert.equal(
    (
      await fetch(`${plugin.origin}/__beauticode/ui/status`, {
        headers: { Host: `evil.example:${port}`, Origin: `http://evil.example:${port}` },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${plugin.origin}/__beauticode/ui/status`, {
        headers: { Host: `127.0.0.1:${port}`, Origin: `http://evil.example:${port}` },
      })
    ).status,
    403,
  );
  assert.equal(
    (await rawHttp(plugin.origin, "/__beauticode/version", {
      headers: { Host: `evil.example:${port}` },
    })).status,
    403,
  );
  const apply = await rawHttp(plugin.origin, "/__beauticode/apply", {
    method: "POST",
    headers: {
      Host: `evil.example:${port}`,
      Authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      generation: 1,
      media: "clear",
    }),
  });
  assert.equal(apply.status, 401);
});

test("browser client follows DSH appearance and does not overwrite it", async () => {
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
    style: { colorScheme: "light" },
    removeAttribute(name) {
      if (name === "data-bc-fish") delete this.dataset.bcFish;
    },
  };
  const media = {
    matches: true,
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

  assert.equal(documentElement.dataset.bcResolvedTone, "light");
  assert.equal(documentElement.style.colorScheme, "light");
  assert.equal(body.hasAttribute("data-ds-dark-theme"), false);

  attributes.add("data-ds-dark-theme");
  documentElement.style.colorScheme = "dark";
  observerCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(documentElement.dataset.bcResolvedTone, "dark");
  assert.equal(documentElement.style.colorScheme, "dark");
  assert.equal(body.hasAttribute("data-ds-dark-theme"), true);

  attributes.delete("data-ds-dark-theme");
  documentElement.style.colorScheme = "light";
  events.onmessage({
    data: JSON.stringify({ type: "mode", fish: false, muted: true, tone: "dark" }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(documentElement.dataset.bcResolvedTone, "light");
  assert.equal(documentElement.style.colorScheme, "light");
  assert.equal(body.hasAttribute("data-ds-dark-theme"), false);
});

test("composer input surfaces inherit the sidebar translucency", async () => {
  const source = await fs.readFile(new URL("../client.js", import.meta.url), "utf8");
  const style = source.slice(
    source.indexOf("style.textContent = `"),
    source.indexOf("#beauticode-bg-stage{"),
  );
  assert.match(
    style,
    /--dsw-specific-sidebar-fill:color-mix\(in srgb,var\(--dsw-static-neutral-bluish-900\) var\(--bc-surface-mix\),transparent\)/,
    "the sidebar fill is the surface palette color at the surface tier",
  );
  assert.match(
    style,
    /--dsw-specific-input-major:var\(--dsw-specific-sidebar-fill\)/,
    "the composer card aliases the sidebar fill instead of shipping a second color",
  );
  assert.doesNotMatch(
    style,
    /--dsw-specific-input-major:rgba\(/,
    "the input surface must not hardcode its own translucent color",
  );
});

test("opaque DSH surfaces are re-expressed on the translucency tiers", async () => {
  const source = await fs.readFile(new URL("../client.js", import.meta.url), "utf8");
  const style = source.slice(
    source.indexOf("style.textContent = `"),
    source.indexOf("#beauticode-bg-stage{"),
  );
  const declared = new Map();
  for (const match of style.matchAll(/(--dsw-[a-z0-9-]+):([^;}]+)/g)) {
    if (!declared.has(match[1])) declared.set(match[1], match[2].trim());
  }
  const content = [
    "--dsw-specific-bubble",
    "--dsw-specific-bubble-highlight",
    "--dsw-alias-state-warn-tertiary",
    "--dsw-alias-state-success-tertiary",
    "--dsw-alias-state-business-tertiary",
    "--dsw-alias-markdown-code-block",
    "--dsw-alias-markdown-code-block-banner",
    "--dsw-alias-markdown-inline-code",
    "--dsw-alias-markdown-tag",
    "--dsw-alias-markdown-citation",
    "--dsw-alias-markdown-placeholder",
    "--dsw-alias-markdown-code-segment-selected",
    "--dsw-alias-markdown-code-segment-unselected",
  ];
  const chrome = [
    "--dsw-alias-bg-layer-3",
    "--dsw-specific-tip",
    "--dsw-alias-bg-module-platform",
    "--dsw-specific-selector",
    "--dsw-alias-interactive-bg-hover-solid",
    "--dsw-alias-tooltip-bg",
    "--dsw-alias-toast-bg",
    "--dsw-alias-button-floating-fill",
  ];
  const tiered =
    /^color-mix\(in srgb,var\(--dsw-static-[a-z0-9-]+\) var\(--bc-(surface|content)-mix\),transparent\)$/;
  for (const token of [...content, ...chrome]) {
    assert.match(
      declared.get(token) ?? "",
      tiered,
      `${token} is a palette color at an alpha tier, not an opaque literal`,
    );
  }
  for (const token of content) {
    assert.match(declared.get(token), /var\(--bc-content-mix\)/, `${token} follows the content tier`);
  }
  for (const token of chrome) {
    assert.match(declared.get(token), /var\(--bc-surface-mix\)/, `${token} follows the surface tier`);
  }
  // The deliverables cards read a module-local fill pair instead of an alias
  // token, so they have to be re-pointed on the card element itself.
  assert.match(
    style,
    /\[data-presented-file\]\{[^}]*--deliverable-fill:color-mix\(in srgb,var\(--dsw-static-neutral-850\) var\(--bc-content-mix\),transparent\)/,
    "the cards listed under 本轮文件改动 are translucent too",
  );
});

test("browser client restores user dim from localStorage and can clear it", async () => {
  const source = await fs.readFile(new URL("../client.js", import.meta.url), "utf8");
  const store = new Map();
  const localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
  const styleProps = { colorScheme: "light" };
  const documentElement = {
    dataset: {},
    style: {
      get colorScheme() {
        return styleProps.colorScheme;
      },
      set colorScheme(value) {
        styleProps.colorScheme = value;
      },
      setProperty(name, value) {
        styleProps[name] = String(value);
      },
      removeProperty(name) {
        delete styleProps[name];
      },
    },
    removeAttribute(name) {
      if (name === "data-bc-fish") delete this.dataset.bcFish;
      if (name === "data-bc-dim-user") delete this.dataset.bcDimUser;
    },
  };
  const context = {
    crypto: { randomUUID: () => "client-dim-test" },
    document: {
      body: { hasAttribute: () => false, prepend() {} },
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
    localStorage,
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    MutationObserver: class {
      observe() {}
    },
    EventSource: class {},
    queueMicrotask: (callback) => callback(),
    setInterval: () => 0,
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context);

  assert.equal(context.BeauticodeBackgroundDim.get(), null);
  assert.equal(documentElement.dataset.bcDimUser, undefined);
  assert.equal(styleProps["--bc-dim"], undefined);

  assert.equal(context.BeauticodeBackgroundDim.set(0.3), 0.3);
  assert.equal(documentElement.dataset.bcDimUser, "true");
  assert.equal(styleProps["--bc-dim"], "0.3");
  assert.equal(store.get("beauticode-dim"), "0.3");

  assert.equal(context.BeauticodeBackgroundDim.clear(), null);
  assert.equal(context.BeauticodeBackgroundDim.get(), null);
  assert.equal(documentElement.dataset.bcDimUser, undefined);
  assert.equal(styleProps["--bc-dim"], undefined);
  assert.equal(store.has("beauticode-dim"), false);
});

test("browser client probes video Range access and explains CORS failures", async () => {
  const originalSource = await fs.readFile(new URL("../client.js", import.meta.url), "utf8");
  const source = originalSource.replace(
    "  function describeVideoState(video, phase) {",
    `  globalThis.__testProbeVideoSource = probeVideoSource;

  function describeVideoState(video, phase) {`,
  );
  assert.notEqual(source, originalSource, "test must expose the video probe");

  const body = { hasAttribute: () => false, prepend() {} };
  const documentElement = { dataset: {}, style: { colorScheme: "light" } };
  let fetchImpl = null;
  const calls = [];
  const context = {
    AbortController,
    DOMException,
    TypeError,
    URL,
    crypto: { randomUUID: () => "client-video-probe-test" },
    document: {
      body,
      documentElement,
      head: { append() {} },
      visibilityState: "visible",
      createElement: () => ({ dataset: {}, style: {} }),
      getElementById: () => null,
    },
    fetch: async (url, options) => {
      calls.push({ url, options });
      return fetchImpl(url, options);
    },
    HTMLMediaElement: { HAVE_CURRENT_DATA: 2 },
    HTMLVideoElement: class {},
    Image: class {},
    location: { href: "http://localhost:3080/" },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    MutationObserver: class { observe() {} },
    EventSource: class {},
    queueMicrotask,
    setInterval: () => 0,
    setTimeout,
    clearTimeout,
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context);

  fetchImpl = async () => ({
    status: 206,
    arrayBuffer: async () => new Uint8Array([0, 0]).buffer,
    body: { cancel: async () => {} },
  });
  const controller = new AbortController();
  await context.__testProbeVideoSource(
    "http://127.0.0.1:45678/media/token?t=token",
    controller.signal,
    100,
  );
  assert.equal(calls[0].options.headers.Range, "bytes=0-1");
  assert.equal(calls[0].options.mode, "cors");
  assert.equal(calls[0].options.credentials, "omit");

  fetchImpl = async () => {
    throw new TypeError("Failed to fetch");
  };
  await assert.rejects(
    () =>
      context.__testProbeVideoSource(
        "http://127.0.0.1:45678/media/token?t=token",
        controller.signal,
        100,
      ),
    /视频媒体不可达或被 CORS 拒绝；页面Origin=http:\/\/localhost:3080；媒体Origin=http:\/\/127\.0\.0\.1:45678/,
  );
});

test("browser client retries a mounted image candidate after a silent first attempt", async () => {
  const originalSource = await fs.readFile(new URL("../client.js", import.meta.url), "utf8");
  const source = originalSource
    .replace("const CLIENT_APPLY_DEADLINE_MS = 8_000;", "const CLIENT_APPLY_DEADLINE_MS = 250;")
    .replace("const IMAGE_ATTEMPT_TIMEOUT_MS = 3_000;", "const IMAGE_ATTEMPT_TIMEOUT_MS = 15;");
  assert.notEqual(source, originalSource, "test must shorten the client image timeouts");

  const dataKey = (attribute) =>
    attribute
      .slice(5)
      .replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
  let documentElement;

  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.children = [];
      this.parentElement = null;
      this.dataset = {};
      this.style = {};
      this.className = "";
      this.id = "";
      this.attributes = new Map();
    }

    get isConnected() {
      let node = this;
      while (node.parentElement) node = node.parentElement;
      return node === documentElement;
    }

    append(...nodes) {
      for (const node of nodes) {
        node.remove();
        node.parentElement = this;
        this.children.push(node);
      }
    }

    prepend(...nodes) {
      for (const node of [...nodes].reverse()) {
        node.remove();
        node.parentElement = this;
        this.children.unshift(node);
      }
    }

    remove() {
      if (!this.parentElement) return;
      const siblings = this.parentElement.children;
      const index = siblings.indexOf(this);
      if (index >= 0) siblings.splice(index, 1);
      this.parentElement = null;
    }

    removeAttribute(name) {
      if (name.startsWith("data-")) delete this.dataset[dataKey(name)];
      else this.attributes.delete(name);
    }

    hasAttribute(name) {
      if (name.startsWith("data-")) return dataKey(name) in this.dataset;
      return this.attributes.has(name);
    }

    addEventListener() {}
    removeEventListener() {}

    matches(selector) {
      if (selector === "img" || selector === "video") {
        return this.tagName === selector.toUpperCase();
      }
      const match = selector.match(
        /^\.([^[]+)\[data-bc-role=["']([^"']+)["']\]$/,
      );
      return Boolean(
        match &&
          this.className.split(/\s+/).includes(match[1]) &&
          this.dataset.bcRole === match[2],
      );
    }

    querySelectorAll(selector) {
      const parts = selector.trim().split(/\s+/);
      if (parts.length > 1) {
        const rest = parts.slice(1).join(" ");
        return this.querySelectorAll(parts[0]).flatMap((node) =>
          node.querySelectorAll(rest),
        );
      }
      const matches = [];
      for (const child of this.children) {
        if (child.matches(selector)) matches.push(child);
        matches.push(...child.querySelectorAll(selector));
      }
      return matches;
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] ?? null;
    }
  }

  documentElement = new FakeElement("html");
  documentElement.style.colorScheme = "light";
  const head = new FakeElement("head");
  const body = new FakeElement("body");
  const root = new FakeElement("div");
  root.id = "root";
  documentElement.append(head, body);
  body.append(root);

  const findById = (node, id) => {
    if (node.id === id) return node;
    for (const child of node.children) {
      const match = findById(child, id);
      if (match) return match;
    }
    return null;
  };

  const images = [];
  const sourceAssignments = [];
  let slowFirstAliveWhenRetryStarted = false;
  class FakeImage extends FakeElement {
    constructor() {
      super("img");
      this.complete = false;
      this.naturalWidth = 0;
      this.naturalHeight = 0;
      this.loadDispatches = 0;
      this.srcCleared = false;
      this._src = "";
      images.push(this);
    }

    set src(value) {
      this._src = value;
      const attemptNumber = images.length;
      sourceAssignments.push({
        image: this,
        url: value,
        slot: this.parentElement,
        role: this.parentElement?.dataset.bcRole,
        stage: this.parentElement?.parentElement,
      });
      if (attemptNumber === 4) {
        const slowFirst = images[2];
        slowFirstAliveWhenRetryStarted =
          slowFirst.isConnected && !slowFirst.srcCleared && slowFirst.src !== "";
      }
      if (attemptNumber !== 2 && attemptNumber !== 3) return;
      const finishLoad = () => {
        this.complete = true;
        this.naturalWidth = 3840;
        this.naturalHeight = 2160;
        this.loadDispatches += 1;
        this.onload?.();
      };
      if (attemptNumber === 2) queueMicrotask(finishLoad);
      else setTimeout(finishLoad, 45);
    }

    get src() {
      return this._src;
    }

    removeAttribute(name) {
      if (name !== "src") return super.removeAttribute(name);
      this._src = "";
      this.srcCleared = true;
    }

    decode() {
      return Promise.resolve();
    }
  }

  class FakeVideo extends FakeElement {
    constructor() {
      super("video");
    }
  }

  let events;
  let renderHeartbeat;
  const acknowledgements = [];
  let resolveReadyAck;
  let resolveFailedAck;
  const readyAck = new Promise((resolve) => {
    resolveReadyAck = resolve;
  });
  const context = {
    AbortController,
    DOMException,
    URL,
    crypto: { randomUUID: () => "client-image-retry-test" },
    document: {
      body,
      documentElement,
      head,
      visibilityState: "visible",
      createElement(tagName) {
        return tagName === "video" ? new FakeVideo() : new FakeElement(tagName);
      },
      getElementById: (id) => findById(documentElement, id),
    },
    fetch: async (_url, options = {}) => {
      const body = JSON.parse(options.body);
      acknowledgements.push(body);
      if (body.kind === "render" && body.ok === true) resolveReadyAck(body);
      if (body.kind === "render" && body.ok === false) resolveFailedAck?.(body);
      return { ok: true };
    },
    HTMLMediaElement: { HAVE_CURRENT_DATA: 2, HAVE_FUTURE_DATA: 3 },
    HTMLVideoElement: FakeVideo,
    Image: FakeImage,
    location: { href: "http://127.0.0.1:45678/" },
    matchMedia: (query) => ({
      matches: query.includes("prefers-reduced-motion"),
      addEventListener() {},
    }),
    MutationObserver: class {
      observe() {}
    },
    navigator: { onLine: true },
    performance: { now: () => Date.now() },
    EventSource: class {
      constructor() {
        events = this;
      }
    },
    clearInterval,
    clearTimeout,
    queueMicrotask,
    setInterval: (callback, delay) => {
      if (delay === 1_000) renderHeartbeat = callback;
      return 0;
    },
    setTimeout,
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context);

  const imageUrl = "http://127.0.0.1:45678/media/image?t=retry-source";
  events.onmessage({
    data: JSON.stringify({
      type: "apply",
      generation: 611,
      media: "image",
      imageUrl,
    }),
  });

  const timeout = setTimeout(
    () => resolveReadyAck(new Error("timed out waiting for image ready ack")),
    1_000,
  );
  const ack = await readyAck;
  clearTimeout(timeout);
  if (ack instanceof Error) throw ack;

  assert.equal(images.length, 2);
  assert.equal(sourceAssignments.length, 2);
  const [first, second] = images;
  const [firstAttempt, retryAttempt] = sourceAssignments;
  const stage = context.document.getElementById("beauticode-bg-stage");
  assert.equal(firstAttempt.url, imageUrl);
  assert.equal(firstAttempt.role, "candidate");
  assert.equal(firstAttempt.stage, stage);
  assert.equal(first.loadDispatches, 0, "the first request must be a silent timeout");
  assert.equal(first.srcCleared, true);
  assert.equal(first.src, "");
  assert.equal(first.parentElement, null);
  assert.equal(first.isConnected, false);

  const retriedUrl = new URL(retryAttempt.url);
  assert.equal(retriedUrl.searchParams.get("t"), "retry-source");
  assert.match(retriedUrl.searchParams.get("bcImageRetry"), /^client-image-retry-test-1-/);
  assert.equal(retryAttempt.slot, firstAttempt.slot);
  assert.equal(retryAttempt.role, "candidate");
  assert.equal(retryAttempt.stage, stage);
  assert.equal(second.complete, true);
  assert.equal(second.naturalWidth, 3840);
  assert.equal(second.naturalHeight, 2160);
  assert.equal(second.loadDispatches, 1);

  assert.deepEqual(ack, {
    clientId: "client-image-retry-test",
    kind: "render",
    generation: 611,
    media: "image",
    ok: true,
    visible: true,
    error: null,
    playback: null,
  });
  assert.equal(
    acknowledgements.filter((body) => body.kind === "render").length,
    1,
  );
  assert.equal(stage.children.length, 1);
  assert.equal(stage.children[0], retryAttempt.slot);
  assert.equal(stage.children[0].dataset.bcRole, "current");
  assert.equal(second.parentElement, stage.children[0]);
  assert.equal(documentElement.dataset.bcGeneration, "611");

  let resolveSlowReadyAck;
  const slowReadyAck = new Promise((resolve) => {
    resolveSlowReadyAck = resolve;
  });
  resolveReadyAck = resolveSlowReadyAck;
  const slowImageUrl = "http://127.0.0.1:45678/media/image?t=slow-first";
  events.onmessage({
    data: JSON.stringify({
      type: "apply",
      generation: 612,
      media: "image",
      imageUrl: slowImageUrl,
    }),
  });
  // Reconnecting EventSource clients may replay the current generation. The
  // duplicate must join the in-flight transaction instead of aborting its
  // healthy cold request and resetting the deadline.
  events.onmessage({
    data: JSON.stringify({
      type: "apply",
      generation: 612,
      media: "image",
      imageUrl: slowImageUrl,
    }),
  });
  const slowTimeout = setTimeout(
    () => resolveSlowReadyAck(new Error("timed out waiting for slow first image ack")),
    1_000,
  );
  const slowAck = await slowReadyAck;
  clearTimeout(slowTimeout);
  if (slowAck instanceof Error) throw slowAck;

  assert.equal(images.length, 4, "the retry window must start a parallel request");
  const slowFirst = images[2];
  const silentRetry = images[3];
  assert.equal(slowFirstAliveWhenRetryStarted, true);
  assert.equal(slowFirst.loadDispatches, 1);
  assert.equal(slowFirst.srcCleared, false);
  assert.equal(slowFirst.src, slowImageUrl);
  assert.equal(slowFirst.isConnected, true);
  assert.equal(silentRetry.loadDispatches, 0);
  assert.equal(silentRetry.srcCleared, true);
  assert.equal(silentRetry.parentElement, null);
  assert.equal(slowAck.generation, 612);
  assert.equal(slowAck.ok, true);
  assert.equal(documentElement.dataset.bcGeneration, "612");
  const renderAckCount = acknowledgements.filter((body) => body.kind === "render").length;
  renderHeartbeat();
  await new Promise((resolve) => setImmediate(resolve));
  const heartbeatAcks = acknowledgements.filter((body) => body.kind === "render");
  assert.equal(heartbeatAcks.length, renderAckCount + 1);
  assert.equal(heartbeatAcks.at(-1).generation, 612);
  assert.equal(heartbeatAcks.at(-1).ok, true);

  const preservedSlot = stage.children[0];
  const failedAckPromise = new Promise((resolve) => {
    resolveFailedAck = resolve;
  });
  events.onmessage({
    data: JSON.stringify({
      type: "apply",
      generation: 613,
      media: "image",
      imageUrl: "http://127.0.0.1:45678/media/image?t=both-attempts-time-out",
    }),
  });
  const failedAck = await Promise.race([
    failedAckPromise,
    new Promise((resolve) =>
      setTimeout(() => resolve(new Error("timed out waiting for image failure ack")), 1_000),
    ),
  ]);
  if (failedAck instanceof Error) throw failedAck;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(failedAck.generation, 613);
  assert.equal(failedAck.ok, false);
  assert.equal(failedAck.visible, true);
  assert.match(failedAck.error, /等待图片加载超时/);
  assert.equal(stage.children.length, 1);
  assert.equal(stage.children[0], preservedSlot);
  assert.equal(preservedSlot.dataset.bcRole, "current");
  assert.equal(preservedSlot.isConnected, true);
  assert.equal(documentElement.dataset.bcGeneration, "612");
});

test("browser client separates first-frame acceptance from stable playback", async () => {
  const originalSource = await fs.readFile(new URL("../client.js", import.meta.url), "utf8");
  const source = originalSource
    .replace("const CLIENT_APPLY_DEADLINE_MS = 8_000;", "const CLIENT_APPLY_DEADLINE_MS = 120;")
    .replace(
      "  function updateCommittedDom(payload, videoReady = true) {",
      `  globalThis.__testSeedCommittedSlot = (slot, payload) => {
    const node = stage();
    slot.dataset.bcRole = "current";
    node.append(slot);
    currentSlot = slot;
    committedPayload = payload;
    activePayload = payload;
    renderPhase = "ready";
    updateCommittedDom(payload);
  };
  globalThis.__testVerifyVideo = async (video, slot, payload, mode = "stable") => {
    const controller = new AbortController();
    activePayload = payload;
    renderPhase = "pending";
    slot.dataset.bcRole = "candidate";
    stage().append(slot);
    try {
      const verify = mode === "first-frame" ? waitForPresentedFrame : waitForStablePlayback;
      await verify(video, controller.signal, CLIENT_APPLY_DEADLINE_MS);
      slot.dataset.bcVideoReady = "true";
      await commitCandidate(payload, slot, controller.signal);
      await acknowledgeRender(payload, true, true);
    } catch (error) {
      disposeSlot(slot);
      restoreCommittedDom();
      await acknowledgeRender(
        payload,
        false,
        Boolean(mountedCurrentSlot()),
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  function updateCommittedDom(payload, videoReady = true) {`,
    );
  assert.notEqual(source, originalSource, "test must shorten the client deadline and add hooks");

  async function runScenario(frameSteps, mode = "stable", configure = null) {
    const dataKey = (attribute) =>
      attribute
        .slice(5)
        .replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    let documentElement;

    class FakeElement {
      constructor(tagName) {
        this.tagName = tagName.toUpperCase();
        this.children = [];
        this.parentElement = null;
        this.dataset = {};
        this.style = {};
        this.className = "";
        this.id = "";
        this.attributes = new Map();
      }

      get isConnected() {
        let node = this;
        while (node.parentElement) node = node.parentElement;
        return node === documentElement;
      }

      append(...nodes) {
        for (const node of nodes) {
          node.remove();
          node.parentElement = this;
          this.children.push(node);
        }
      }

      prepend(...nodes) {
        for (const node of [...nodes].reverse()) {
          node.remove();
          node.parentElement = this;
          this.children.unshift(node);
        }
      }

      remove() {
        if (!this.parentElement) return;
        const siblings = this.parentElement.children;
        const index = siblings.indexOf(this);
        if (index >= 0) siblings.splice(index, 1);
        this.parentElement = null;
      }

      setAttribute(name, value) {
        this.attributes.set(name, String(value));
      }

      hasAttribute(name) {
        return this.attributes.has(name);
      }

      removeAttribute(name) {
        if (name.startsWith("data-")) delete this.dataset[dataKey(name)];
        else this.attributes.delete(name);
      }

      querySelectorAll(selector) {
        const tagName = selector.toUpperCase();
        const matches = [];
        for (const child of this.children) {
          if (child.tagName === tagName) matches.push(child);
          matches.push(...child.querySelectorAll(selector));
        }
        return matches;
      }

      querySelector(selector) {
        return this.querySelectorAll(selector)[0] ?? null;
      }

      addEventListener() {}
      removeEventListener() {}
    }

    class FakeVideo extends FakeElement {
      constructor(steps) {
        super("video");
        this.steps = [...steps];
        this.listeners = new Map();
        this.frameTimers = new Map();
        this.nextFrameId = 0;
        this.currentTime = 0;
        this.duration = 60;
        this.error = null;
        this.ended = false;
        this.muted = true;
        this.paused = false;
        this.readyState = 2;
        this.networkState = 1;
        this.dataset.bcPlaybackBlocked = "false";
      }

      addEventListener(name, listener) {
        const listeners = this.listeners.get(name) ?? new Set();
        listeners.add(listener);
        this.listeners.set(name, listeners);
      }

      removeEventListener(name, listener) {
        this.listeners.get(name)?.delete(listener);
      }

      emit(name) {
        for (const listener of [...(this.listeners.get(name) ?? [])]) listener({ type: name });
      }

      requestVideoFrameCallback(callback) {
        const id = ++this.nextFrameId;
        const step = this.steps.shift();
        if (!step) return id;
        const timer = setTimeout(() => {
          this.frameTimers.delete(id);
          this.currentTime = step.time;
          callback(Date.now(), { mediaTime: step.time });
          if (step.pauseAfter) {
            this.paused = true;
            this.emit("pause");
            setTimeout(() => {
              this.paused = false;
              this.emit("playing");
            }, 2);
          }
        }, 1);
        this.frameTimers.set(id, timer);
        return id;
      }

      cancelVideoFrameCallback(id) {
        const timer = this.frameTimers.get(id);
        if (timer) clearTimeout(timer);
        this.frameTimers.delete(id);
      }

      pause() {
        this.paused = true;
        this.emit("pause");
      }

      load() {}
    }

    documentElement = new FakeElement("html");
    documentElement.style.colorScheme = "light";
    const head = new FakeElement("head");
    const body = new FakeElement("body");
    const root = new FakeElement("div");
    root.id = "root";
    documentElement.append(head, body);
    body.append(root);
    const findById = (node, id) => {
      if (node.id === id) return node;
      for (const child of node.children) {
        const match = findById(child, id);
        if (match) return match;
      }
      return null;
    };
    const acknowledgements = [];
    const context = {
      AbortController,
      DOMException,
      URL,
      crypto: { randomUUID: () => "client-video-stability-test" },
      document: {
        body,
        documentElement,
        head,
        visibilityState: "visible",
        createElement: (tagName) => new FakeElement(tagName),
        getElementById: (id) => findById(documentElement, id),
      },
      fetch: async (_url, options = {}) => {
        acknowledgements.push(JSON.parse(options.body));
        return { ok: true };
      },
      HTMLMediaElement: { HAVE_CURRENT_DATA: 2, HAVE_FUTURE_DATA: 3 },
      HTMLVideoElement: FakeVideo,
      Image: class {},
      location: { href: "http://127.0.0.1:45678/" },
      matchMedia: (query) => ({
        matches: query.includes("prefers-reduced-motion"),
        addEventListener() {},
      }),
      MutationObserver: class {
        observe() {}
      },
      navigator: { onLine: true },
      performance: { now: () => Date.now() },
      EventSource: class {},
      clearInterval,
      clearTimeout,
      queueMicrotask,
      setInterval: (callback, delay) => (delay === 1_000 ? 0 : setInterval(callback, 5)),
      setTimeout,
    };
    context.window = context;
    context.globalThis = context;
    vm.runInNewContext(source, context);

    const oldPayload = {
      generation: 700,
      media: "image",
      imageUrl: "http://127.0.0.1:45678/media/image?t=old",
    };
    const oldSlot = new FakeElement("div");
    oldSlot.dataset.bcMedia = "image";
    oldSlot.dataset.bcGeneration = "700";
    oldSlot.dataset.bcImageUrl = oldPayload.imageUrl;
    context.__testSeedCommittedSlot(oldSlot, oldPayload);

    const payload = {
      generation: 701,
      media: "video",
      imageUrl: "http://127.0.0.1:45678/media/image?t=poster",
      videoUrl: "http://127.0.0.1:45678/media/video?t=movie",
      startAt: 0,
    };
    const candidate = new FakeElement("div");
    candidate.dataset.bcMedia = "video";
    candidate.dataset.bcGeneration = "701";
    candidate.dataset.bcImageUrl = payload.imageUrl;
    candidate.dataset.bcVideoUrl = payload.videoUrl;
    candidate.dataset.bcStartAt = "0";
    const video = new FakeVideo(frameSteps);
    configure?.(video);
    candidate.append(video);
    await context.__testVerifyVideo(video, candidate, payload, mode);

    return {
      acknowledgements,
      candidate,
      documentElement,
      oldSlot,
      stage: context.document.getElementById("beauticode-bg-stage"),
    };
  }

  const frozen = await runScenario([]);
  assert.equal(frozen.acknowledgements.at(-1).ok, false);
  assert.equal(frozen.acknowledgements.at(-1).visible, true);
  assert.match(frozen.acknowledgements.at(-1).error, /稳定窗口/);
  assert.equal(frozen.stage.children[0], frozen.oldSlot);
  assert.equal(frozen.candidate.isConnected, false);
  assert.equal(frozen.documentElement.dataset.bcGeneration, "700");

  const twoFrames = await runScenario([{ time: 0.1 }, { time: 0.2 }]);
  assert.equal(twoFrames.acknowledgements.at(-1).ok, false);
  assert.equal(twoFrames.stage.children[0], twoFrames.oldSlot);

  const stable = await runScenario([{ time: 0.07 }, { time: 0.14 }, { time: 0.21 }]);
  assert.equal(stable.acknowledgements.at(-1).ok, true);
  assert.equal(stable.stage.children[0], stable.candidate);
  assert.equal(stable.candidate.dataset.bcRole, "current");
  assert.equal(stable.documentElement.dataset.bcGeneration, "701");

  const firstFrame = await runScenario([{ time: 0.01 }], "first-frame");
  assert.equal(firstFrame.acknowledgements.at(-1).ok, true);
  assert.equal(firstFrame.stage.children[0], firstFrame.candidate);

  const coldFirstFrame = await runScenario([{ time: 0.01 }], "first-frame", (video) => {
    video.readyState = 0;
    video.networkState = 2;
    setTimeout(() => {
      video.readyState = 2;
      video.networkState = 1;
      video.emit("loadeddata");
    }, 30);
  });
  assert.equal(coldFirstFrame.acknowledgements.at(-1).ok, true);
  assert.equal(coldFirstFrame.stage.children[0], coldFirstFrame.candidate);

  const decodeFailure = await runScenario([], "first-frame", (video) => {
    video.error = { code: 3 };
  });
  assert.equal(decodeFailure.acknowledgements.at(-1).ok, false);
  assert.match(decodeFailure.acknowledgements.at(-1).error, /MEDIA_ERR_DECODE/);
  assert.equal(decodeFailure.stage.children[0], decodeFailure.oldSlot);

  const paused = await runScenario([
    { time: 0.08 },
    { time: 0.16, pauseAfter: true },
    { time: 0.24 },
  ]);
  assert.equal(paused.acknowledgements.at(-1).ok, false, "pause must reset the stable window");
  assert.equal(paused.stage.children[0], paused.oldSlot);
});

test("same-url video fast path ignores poster churn and permits an in-place reseek", async () => {
  const originalSource = await fs.readFile(new URL("../client.js", import.meta.url), "utf8");
  const source = originalSource.replace(
    "  function updateCommittedDom(payload, videoReady = true) {",
    `  globalThis.__testVideoSlotMatches = (slot, payload) => {
    currentSlot = slot;
    return slotMatchesPayload(slot, payload);
  };

  function updateCommittedDom(payload, videoReady = true) {`,
  );
  assert.notEqual(source, originalSource, "test hook must expose the real fast-path predicate");

  class FakeVideo {}
  const stage = {};
  const video = new FakeVideo();
  Object.assign(video, {
    error: null,
    ended: false,
    paused: false,
    seeking: false,
    readyState: 2,
  });
  const slot = {
    isConnected: true,
    parentElement: stage,
    dataset: {
      bcRole: "current",
      bcMedia: "video",
      bcImageUrl: "http://127.0.0.1/poster.jpg",
      bcVideoUrl: "http://127.0.0.1/movie.mp4",
      bcStartAt: "4",
    },
    querySelector: (selector) => (selector === "video" ? video : null),
  };
  const documentElement = {
    dataset: {},
    style: { colorScheme: "light" },
    removeAttribute() {},
  };
  const context = {
    crypto: { randomUUID: () => "client-video-fast-path-test" },
    document: {
      body: { hasAttribute: () => false },
      documentElement,
      head: { append() {} },
      createElement: () => ({ dataset: {}, style: {} }),
      getElementById: (id) => (id === "beauticode-bg-stage" ? stage : null),
    },
    fetch: async () => ({ ok: true }),
    HTMLMediaElement: { HAVE_CURRENT_DATA: 2, HAVE_FUTURE_DATA: 3 },
    HTMLVideoElement: FakeVideo,
    Image: class {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    MutationObserver: class {
      observe() {}
    },
    EventSource: class {},
    queueMicrotask,
    setInterval: () => 0,
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context);

  const payload = {
    media: "video",
    imageUrl: slot.dataset.bcImageUrl,
    videoUrl: slot.dataset.bcVideoUrl,
    startAt: 4,
  };
  assert.equal(context.__testVideoSlotMatches(slot, payload), true);
  assert.equal(
    context.__testVideoSlotMatches(slot, {
      ...payload,
      imageUrl: "http://127.0.0.1/new-poster.jpg",
    }),
    true,
  );

  video.paused = true;
  assert.equal(context.__testVideoSlotMatches(slot, payload), false);
  video.paused = false;
  video.seeking = true;
  assert.equal(context.__testVideoSlotMatches(slot, payload), false);
  video.seeking = false;
  video.readyState = 1;
  assert.equal(context.__testVideoSlotMatches(slot, payload), false);
  video.readyState = 2;
  assert.equal(context.__testVideoSlotMatches(slot, { ...payload, startAt: 8 }), true);
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
    videoReadyClients: 1,
    videoPendingClients: 0,
    lastVideoError: null,
    lastRenderError: null,
    visibleClients: 1,
    modeReadyClients: 0,
    blockedClients: 0,
    resolvedTone: null,
    modes: { fish: false, muted: true, tone: "auto" },
    playback: null,
  });
});

test("ack endpoint enforces same-origin, method, and live-session binding without Authorization", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-dsh-plugin-"));
  const tokenFile = path.join(root, "token");
  await fs.writeFile(tokenFile, TOKEN);
  const plugin = await createPluginServer(tokenFile);
  const events = await openEvents(plugin.origin, "ack-guard-client-01");
  t.after(async () => {
    events.request.destroy();
    events.response.destroy();
    await plugin.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  const applied = await fetch(`${plugin.origin}/__beauticode/apply`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ generation: 0, media: "image", imageUrl: "http://127.0.0.1:45678/media/image?t=1" }),
  });
  assert.equal(applied.status, 200);

  const basicRenderAck = {
    clientId: "ack-guard-client-01",
    kind: "render",
    generation: 0,
    media: "image",
    ok: true,
    visible: true,
  };

  const missingOrigin = await fetch(`${plugin.origin}/__beauticode/ack`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(basicRenderAck),
  });
  assert.equal(missingOrigin.status, 403);

  const crossOrigin = await fetch(`${plugin.origin}/__beauticode/ack`, {
    method: "POST",
    headers: { Origin: "http://evil.example", "content-type": "application/json" },
    body: JSON.stringify(basicRenderAck),
  });
  assert.equal(crossOrigin.status, 403);

  const wrongMethod = await fetch(`${plugin.origin}/__beauticode/ack`, {
    method: "GET",
    headers: { Origin: plugin.origin },
  });
  assert.equal(wrongMethod.status, 405);

  const noSession = await fetch(`${plugin.origin}/__beauticode/ack`, {
    method: "POST",
    headers: { Origin: plugin.origin, "content-type": "application/json" },
    body: JSON.stringify({ ...basicRenderAck, clientId: "no-such-client-id" }),
  });
  assert.equal(noSession.status, 400);
  assert.equal((await noSession.json()).ok, false);

  const happyPath = await fetch(`${plugin.origin}/__beauticode/ack`, {
    method: "POST",
    headers: { Origin: plugin.origin, "content-type": "application/json" },
    body: JSON.stringify(basicRenderAck),
  });
  assert.equal(happyPath.status, 200);
  assert.deepEqual(await happyPath.json(), { ok: true });
});

test("apply payload can carry Internal atmosphere to the browser client", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-dsh-plugin-"));
  const tokenFile = path.join(root, "token");
  await fs.writeFile(tokenFile, TOKEN);
  const plugin = await createPluginServer(tokenFile);
  const events = await openEvents(plugin.origin, "client-atmosphere-01");
  t.after(async () => {
    events.request.destroy();
    events.response.destroy();
    await plugin.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  const payload = {
    generation: 21,
    media: "image",
    imageUrl: "http://127.0.0.1:45678/media/image?t=internal",
    atmosphere: { preset: "internal", rain: true, overlay: true, water: true },
  };
  const applied = await fetch(`${plugin.origin}/__beauticode/apply`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(applied.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(events.read(), /"preset":"internal"/);

  const gallery = await fetch(`${plugin.origin}/__beauticode/apply`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      generation: 23,
      media: "image",
      imageUrl: "http://127.0.0.1:45678/media/image?t=gallery",
      atmosphere: { preset: "gallery", rain: true, overlay: true, water: true },
    }),
  });
  assert.equal(gallery.status, 200);

  const rejected = await fetch(`${plugin.origin}/__beauticode/apply`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      generation: 22,
      media: "image",
      imageUrl: "http://127.0.0.1:45678/media/image?t=internal",
      atmosphere: { preset: "night" },
    }),
  });
  assert.equal(rejected.status, 400);
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

test("transient video heartbeat is pending until an explicit renderer verdict", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-dsh-plugin-"));
  const tokenFile = path.join(root, "token");
  await fs.writeFile(tokenFile, TOKEN);
  const plugin = await createPluginServer(tokenFile);
  const events = await openEvents(plugin.origin, "client-video-pending-01");
  t.after(async () => {
    events.request.destroy();
    events.response.destroy();
    await plugin.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  const payload = {
    generation: 120,
    media: "video",
    imageUrl: "http://127.0.0.1:45678/media/image?t=poster",
    videoUrl: "http://127.0.0.1:45678/media/video?t=movie",
    startAt: 0,
  };
  assert.equal((await fetch(`${plugin.origin}/__beauticode/apply`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  })).status, 200);

  const headers = { Origin: plugin.origin, "content-type": "application/json" };
  assert.equal((await fetch(`${plugin.origin}/__beauticode/ack`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      clientId: "client-video-pending-01",
      kind: "render",
      generation: 120,
      media: "video",
      ok: false,
      visible: true,
      error: null,
    }),
  })).status, 200);

  let status = await (await fetch(`${plugin.origin}/__beauticode/status`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })).json();
  assert.equal(status.readyClients, 0);
  assert.equal(status.failedClients, 0);
  assert.equal(status.lastRenderError, null);

  const decodeError = "视频解码器报告失败；mediaError=MEDIA_ERR_DECODE";
  assert.equal((await fetch(`${plugin.origin}/__beauticode/ack`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      clientId: "client-video-pending-01",
      kind: "render",
      generation: 120,
      media: "video",
      ok: false,
      visible: false,
      error: decodeError,
    }),
  })).status, 200);
  status = await (await fetch(`${plugin.origin}/__beauticode/status`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })).json();
  assert.equal(status.failedClients, 1);
  assert.equal(status.lastRenderError, decodeError);
});

test("browser client warms the media stack on init and reports media-event diagnostics", async () => {
  const source = await fs.readFile(new URL("../client.js", import.meta.url), "utf8");

  const dataKey = (name) =>
    name
      .replace(/^data-/, "")
      .replace(/-([a-z])/g, (_all, ch) => ch.toUpperCase());

  class FakeElement {
    constructor(tagName) {
      this.tagName = String(tagName).toUpperCase();
      this.className = "";
      this.dataset = {};
      this.style = new Proxy(
        { cssText: "" },
        {
          set(target, key, value) {
            if (key === "cssText") target.cssText = value;
            return true;
          },
          get(target, key) {
            return key === "cssText" ? target.cssText : "";
          },
        },
      );
      this.attributes = new Map();
      this.children = [];
      this.parentElement = null;
      this.listeners = new Map();
    }

    setAttribute(name, value) {
      if (name.startsWith("data-")) this.dataset[dataKey(name)] = value;
      else this.attributes.set(name, value);
    }

    removeAttribute(name) {
      if (name.startsWith("data-")) delete this.dataset[dataKey(name)];
      else this.attributes.delete(name);
    }

    hasAttribute(name) {
      if (name.startsWith("data-")) return dataKey(name) in this.dataset;
      return this.attributes.has(name);
    }

    toggleAttribute(name, force) {
      const next = force === undefined ? !this.hasAttribute(name) : force;
      if (next) this.setAttribute(name, "");
      else this.removeAttribute(name);
    }

    append(...nodes) {
      for (const node of nodes) {
        node.remove();
        node.parentElement = this;
        this.children.push(node);
      }
    }

    prepend(...nodes) {
      for (const node of [...nodes].reverse()) {
        node.remove();
        node.parentElement = this;
        this.children.unshift(node);
      }
    }

    remove() {
      if (!this.parentElement) return;
      const siblings = this.parentElement.children;
      const index = siblings.indexOf(this);
      if (index >= 0) siblings.splice(index, 1);
      this.parentElement = null;
    }

    get isConnected() {
      let node = this;
      while (node.parentElement) node = node.parentElement;
      return node === documentElement;
    }

    addEventListener(name, handler) {
      const list = this.listeners.get(name) ?? [];
      list.push(handler);
      this.listeners.set(name, list);
    }

    removeEventListener() {}

    dispatch(name) {
      for (const handler of this.listeners.get(name) ?? []) {
        handler({ target: this, type: name });
      }
    }

    matches(selector) {
      if (selector === "img" || selector === "video") {
        return this.tagName === selector.toUpperCase();
      }
      const match = selector.match(
        /^\.([^[]+)\[data-bc-role=["']([^"']+)["']\]$/,
      );
      return Boolean(
        match &&
          this.className.split(/\s+/).includes(match[1]) &&
          this.dataset.bcRole === match[2],
      );
    }

    querySelectorAll(selector) {
      const parts = selector.trim().split(/\s+/);
      if (parts.length > 1) {
        return this.querySelectorAll(parts[0]).flatMap((node) =>
          node.querySelectorAll(parts.slice(1).join(" ")),
        );
      }
      const matches = [];
      for (const child of this.children) {
        if (child.matches(selector)) matches.push(child);
        matches.push(...child.querySelectorAll(selector));
      }
      return matches;
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] ?? null;
    }
  }

  const createdVideos = [];
  class FakeVideo extends FakeElement {
    constructor() {
      super("video");
      this.readyState = 0;
      this.networkState = 0;
      this.paused = true;
      this.ended = false;
      this.seeking = false;
      this.error = null;
      this.currentTime = 0;
      this._src = "";
      createdVideos.push(this);
    }

    set src(value) {
      this._src = value;
      if (typeof value === "string" && value.startsWith("data:video/mp4")) {
        // The bundled warmup frame "decodes" instantly in the fake DOM.
        queueMicrotask(() => this.dispatch("loadeddata"));
      }
    }

    get src() {
      return this._src;
    }

    play() {
      this.paused = false;
      return Promise.resolve();
    }

    load() {}
  }

  class FakeImage extends FakeElement {
    constructor() {
      super("img");
      this.complete = false;
      this.naturalWidth = 0;
      this.naturalHeight = 0;
    }

    set src(value) {
      queueMicrotask(() => {
        this.complete = true;
        this.naturalWidth = 1920;
        this.naturalHeight = 1080;
        this.onload?.();
      });
    }

    decode() {
      return Promise.resolve();
    }
  }

  const documentElement = new FakeElement("html");
  documentElement.style.colorScheme = "light";
  const head = new FakeElement("head");
  const body = new FakeElement("body");
  const root = new FakeElement("div");
  root.id = "root";
  documentElement.append(head, body);
  body.append(root);

  const findById = (node, id) => {
    if (node.id === id) return node;
    for (const child of node.children) {
      const match = findById(child, id);
      if (match) return match;
    }
    return null;
  };

  let events;
  const acknowledgements = [];
  const ackWaiters = [];
  const waitForAck = (predicate, timeoutMs = 2_000, label = "ack") =>
    new Promise((resolve, reject) => {
      const existing = acknowledgements.find(predicate);
      if (existing) return resolve(existing);
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for ${label} ack`)),
        timeoutMs,
      );
      ackWaiters.push({ predicate, resolve, timer });
    });
  const context = {
    AbortController,
    DOMException,
    URL,
    WeakMap,
    crypto: { randomUUID: () => "client-warmup-diag-test" },
    document: {
      body,
      documentElement,
      head,
      visibilityState: "visible",
      createElement(tagName) {
        if (tagName === "video") return new FakeVideo();
        if (tagName === "img") return new FakeImage();
        return new FakeElement(tagName);
      },
      getElementById: (id) => findById(documentElement, id),
    },
    fetch: async (_url, options = {}) => {
      if (options.body) {
        const body = JSON.parse(options.body);
        acknowledgements.push(body);
        for (const waiter of [...ackWaiters]) {
          if (waiter.predicate(body)) {
            clearTimeout(waiter.timer);
            ackWaiters.splice(ackWaiters.indexOf(waiter), 1);
            waiter.resolve(body);
          }
        }
        return { ok: true };
      }
      return {
        status: 206,
        arrayBuffer: async () => new ArrayBuffer(2),
      };
    },
    HTMLMediaElement: { HAVE_CURRENT_DATA: 2, HAVE_FUTURE_DATA: 3 },
    HTMLVideoElement: FakeVideo,
    Image: FakeImage,
    location: { href: "http://127.0.0.1:3080/" },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    MutationObserver: class {
      observe() {}
    },
    navigator: { onLine: true },
    performance: { now: () => Date.now() },
    EventSource: class {
      constructor() {
        events = this;
      }
    },
    clearInterval,
    clearTimeout,
    queueMicrotask,
    setInterval: () => 0,
    setTimeout,
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context);

  // Warmup ran on init: a tiny muted video mounted under the page root with
  // the bundled black-frame data URI.
  const warmup = createdVideos[0];
  assert.ok(warmup, "init must create a warmup video");
  assert.match(warmup.src, /^data:video\/mp4;base64,/);
  assert.equal(warmup.parentElement, documentElement);
  assert.equal(warmup.muted, true);
  assert.equal(documentElement.dataset.bcMediaWarmup, "running");
  warmup.dispatch("ended");
  assert.equal(warmup.parentElement, null, "warmup video must be removed after ending");
  assert.equal(documentElement.dataset.bcMediaWarmup, "done");

  // First real apply succeeds through the poster-first candidate path: the
  // commit ack arrives with the poster still covering, then the first
  // presented frame upgrades the committed slot in place.
  const videoUrl1 = "http://127.0.0.1:3080/media/video?t=diag-one";
  events.onmessage({
    data: JSON.stringify({
      type: "apply",
      generation: 701,
      media: "video",
      imageUrl: "http://127.0.0.1:3080/media/image?t=diag-one",
      videoUrl: videoUrl1,
      startAt: 0,
    }),
  });
  const applyVideo = await new Promise((resolve) => {
    const started = Date.now();
    const poll = () => {
      const found = createdVideos.find((video) => video.src === videoUrl1);
      if (found) resolve(found);
      else if (Date.now() - started > 1_000) resolve(null);
      else setTimeout(poll, 5);
    };
    poll();
  });
  assert.ok(applyVideo, "the apply must create its own candidate video");
  const posterAck = await waitForAck(
    (body) => body.kind === "render" && body.generation === 701 && body.ok === true,
    2_000,
    "poster",
  );
  assert.equal(posterAck.videoReady, false, "commit ack must be poster-only");
  assert.equal(posterAck.playback, null);
  const committedSlot = applyVideo.parentElement;
  assert.equal(committedSlot.dataset.bcRole, "current");
  assert.equal(
    documentElement.dataset.bcVideoReady,
    "false",
    "poster stays the committed visual until the first frame",
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  applyVideo.readyState = 2;
  applyVideo.dispatch("loadeddata");
  await new Promise((resolve) => setTimeout(resolve, 20));
  applyVideo.currentTime = 0.5;
  applyVideo.dispatch("playing");
  const upgradeAck = await waitForAck(
    (body) => body.kind === "render" && body.generation === 701 && body.videoReady === true,
    2_000,
    "upgrade",
  );
  assert.equal(upgradeAck.ok, true);
  assert.equal(upgradeAck.playback?.hasVideo, true);
  assert.equal(committedSlot.dataset.bcVideoReady, "true");
  assert.equal(documentElement.dataset.bcVideoReady, "true");

  // Second apply stalls mid-load; the poster commit must survive and the
  // downgrade ack must carry the media-event timeline so field reports show
  // which stage stalled — a cold decoder can never roll the apply back.
  const videoUrl2 = "http://127.0.0.1:3080/media/video?t=diag-two";
  events.onmessage({
    data: JSON.stringify({
      type: "apply",
      generation: 702,
      media: "video",
      imageUrl: "http://127.0.0.1:3080/media/image?t=diag-two",
      videoUrl: videoUrl2,
      startAt: 0,
    }),
  });
  const failingVideo = await new Promise((resolve) => {
    const started = Date.now();
    const poll = () => {
      const found = createdVideos.find((video) => video.src === videoUrl2);
      if (found) resolve(found);
      else if (Date.now() - started > 1_000) resolve(null);
      else setTimeout(poll, 5);
    };
    poll();
  });
  assert.ok(failingVideo, "the failing apply must create a candidate video");
  failingVideo.dispatch("loadstart");
  failingVideo.dispatch("progress");
  failingVideo.readyState = 1;
  await new Promise((resolve) => setTimeout(resolve, 10));
  failingVideo.error = { code: 3 };
  failingVideo.dispatch("error");
  const failure = await waitForAck(
    (body) =>
      body.kind === "render" &&
      body.generation === 702 &&
      body.videoReady === false &&
      typeof body.error === "string",
    2_000,
    "downgrade",
  );
  assert.equal(failure.ok, true, "a settle failure must never roll back the poster");
  assert.equal(failure.visible, true);
  assert.match(failure.error, /视频预热未完成（已保留封面）：视频加载或解码失败/);
  assert.match(failure.error, /媒体事件=loadstart@\d+ms/);
  assert.match(failure.error, /，progress@\d+ms/);
  assert.match(failure.error, /，error@\d+ms/);
  assert.equal(failingVideo.parentElement, null, "the stalled decoder must be dropped");
  assert.equal(documentElement.dataset.bcVideoReady, "false");
  const stageNode = context.document.getElementById("beauticode-bg-stage");
  assert.equal(stageNode.children[0].dataset.bcRole, "current");
  assert.equal(stageNode.children[0].querySelector("img").isConnected, true);
});

test("frozen cold-start video commits the poster and downgrades without rollback", async () => {
  const originalSource = await fs.readFile(new URL("../client.js", import.meta.url), "utf8");
  // Simulate the worst new-host case: the media request starts but the
  // decoder never produces data or events within any apply deadline.
  const source = originalSource.replace(
    "const VIDEO_SETTLE_TIMEOUT_MS = 60_000;",
    "const VIDEO_SETTLE_TIMEOUT_MS = 120;",
  );
  assert.notEqual(source, originalSource, "test must shorten the settle budget");

  const dataKey = (name) =>
    name.replace(/^data-/, "").replace(/-([a-z])/g, (_all, ch) => ch.toUpperCase());

  class FakeElement {
    constructor(tagName) {
      this.tagName = String(tagName).toUpperCase();
      this.className = "";
      this.dataset = {};
      this.style = {};
      this.attributes = new Map();
      this.children = [];
      this.parentElement = null;
      this.listeners = new Map();
    }
    setAttribute(name, value) {
      if (name.startsWith("data-")) this.dataset[dataKey(name)] = value;
      else this.attributes.set(name, value);
    }
    removeAttribute(name) {
      if (name.startsWith("data-")) delete this.dataset[dataKey(name)];
      else this.attributes.delete(name);
    }
    hasAttribute(name) {
      if (name.startsWith("data-")) return dataKey(name) in this.dataset;
      return this.attributes.has(name);
    }
    append(...nodes) {
      for (const node of nodes) {
        node.remove();
        node.parentElement = this;
        this.children.push(node);
      }
    }
    prepend(...nodes) {
      for (const node of [...nodes].reverse()) {
        node.remove();
        node.parentElement = this;
        this.children.unshift(node);
      }
    }
    remove() {
      if (!this.parentElement) return;
      const siblings = this.parentElement.children;
      const index = siblings.indexOf(this);
      if (index >= 0) siblings.splice(index, 1);
      this.parentElement = null;
    }
    get isConnected() {
      let node = this;
      while (node.parentElement) node = node.parentElement;
      return node === documentElement;
    }
    addEventListener(name, handler) {
      const list = this.listeners.get(name) ?? [];
      list.push(handler);
      this.listeners.set(name, list);
    }
    removeEventListener() {}
    dispatch(name) {
      for (const handler of this.listeners.get(name) ?? []) handler({ type: name });
    }
    matches(selector) {
      return selector === "img" || selector === "video"
        ? this.tagName === selector.toUpperCase()
        : selector.startsWith(".") && this.className.split(/\s+/).includes(selector.slice(1));
    }
    querySelectorAll(selector) {
      const parts = selector.trim().split(/\s+/);
      if (parts.length > 1) {
        return this.querySelectorAll(parts[0]).flatMap((node) =>
          node.querySelectorAll(parts.slice(1).join(" ")),
        );
      }
      const matches = [];
      for (const child of this.children) {
        if (child.matches(selector)) matches.push(child);
        matches.push(...child.querySelectorAll(selector));
      }
      return matches;
    }
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] ?? null;
    }
  }

  const createdVideos = [];
  class FakeVideo extends FakeElement {
    constructor() {
      super("video");
      this.readyState = 0;
      this.networkState = 0;
      this.paused = true;
      this.ended = false;
      this.seeking = false;
      this.error = null;
      this.currentTime = 0;
      this.duration = 30;
      this.muted = true;
      this._src = "";
      createdVideos.push(this);
    }
    set src(value) {
      this._src = value;
    }
    get src() {
      return this._src;
    }
    play() {
      this.paused = false;
      return Promise.resolve();
    }
    load() {}
  }

  class FakeImage extends FakeElement {
    constructor() {
      super("img");
      this.complete = false;
      this.naturalWidth = 0;
      this.naturalHeight = 0;
    }
    set src(value) {
      queueMicrotask(() => {
        this.complete = true;
        this.naturalWidth = 1920;
        this.naturalHeight = 1080;
        this.onload?.();
      });
    }
  }

  const documentElement = new FakeElement("html");
  documentElement.style.colorScheme = "light";
  const head = new FakeElement("head");
  const body = new FakeElement("body");
  const root = new FakeElement("div");
  root.id = "root";
  documentElement.append(head, body);
  body.append(root);
  const findById = (node, id) => {
    if (node.id === id) return node;
    for (const child of node.children) {
      const match = findById(child, id);
      if (match) return match;
    }
    return null;
  };

  let events;
  const acknowledgements = [];
  const context = {
    AbortController,
    DOMException,
    URL,
    WeakMap,
    crypto: { randomUUID: () => "client-frozen-cold-start-test" },
    document: {
      body,
      documentElement,
      head,
      visibilityState: "visible",
      createElement(tagName) {
        if (tagName === "video") return new FakeVideo();
        if (tagName === "img") return new FakeImage();
        return new FakeElement(tagName);
      },
      getElementById: (id) => findById(documentElement, id),
    },
    fetch: async (_url, options = {}) => {
      if (options.body) {
        acknowledgements.push(JSON.parse(options.body));
        return { ok: true };
      }
      return { status: 206, arrayBuffer: async () => new ArrayBuffer(2) };
    },
    HTMLMediaElement: { HAVE_CURRENT_DATA: 2, HAVE_FUTURE_DATA: 3 },
    HTMLVideoElement: FakeVideo,
    Image: FakeImage,
    location: { href: "http://127.0.0.1:3080/" },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    MutationObserver: class {
      observe() {}
    },
    navigator: { onLine: true },
    performance: { now: () => Date.now() },
    EventSource: class {
      constructor() {
        events = this;
      }
    },
    clearInterval,
    clearTimeout,
    queueMicrotask,
    setInterval: () => 0,
    setTimeout,
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context);

  events.onmessage({
    data: JSON.stringify({
      type: "apply",
      generation: 801,
      media: "video",
      imageUrl: "http://127.0.0.1:3080/media/image?t=frozen",
      videoUrl: "http://127.0.0.1:3080/media/video?t=frozen",
      startAt: 0,
    }),
  });

  // No media event ever fires. The poster must still commit and ack ok.
  const posterAck = await new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const ack = acknowledgements.find(
        (body) => body.kind === "render" && body.generation === 801 && body.ok === true,
      );
      if (ack) resolve(ack);
      else if (Date.now() - started > 1_000) reject(new Error("poster ack never arrived"));
      else setTimeout(poll, 5);
    };
    poll();
  });
  assert.equal(posterAck.videoReady, false);
  assert.equal(posterAck.playback, null);

  // The settle window expires without a single media event; the downgrade
  // keeps the poster committed instead of failing the transaction.
  const downgrade = await new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const ack = acknowledgements.find(
        (body) =>
          body.kind === "render" &&
          body.generation === 801 &&
          body.ok === true &&
          body.videoReady === false &&
          typeof body.error === "string",
      );
      if (ack) resolve(ack);
      else if (Date.now() - started > 2_000) reject(new Error("downgrade ack never arrived"));
      else setTimeout(poll, 5);
    };
    poll();
  });
  assert.match(downgrade.error, /视频预热未完成（已保留封面）：等待视频首帧超时/);
  assert.match(downgrade.error, /媒体事件=无/);
  assert.equal(downgrade.visible, true);

  const stageNode = context.document.getElementById("beauticode-bg-stage");
  assert.equal(stageNode.children.length, 1);
  assert.equal(stageNode.children[0].dataset.bcRole, "current");
  assert.equal(stageNode.children[0].querySelector("video"), null, "stalled decoder dropped");
  assert.equal(stageNode.children[0].querySelector("img").isConnected, true);
  assert.equal(documentElement.dataset.bcMedia, "video");
  assert.equal(documentElement.dataset.bcVideoReady, "false");
  assert.equal(documentElement.dataset.bcGeneration, "801");

  // No renderer verdict ever reported failure.
  assert.equal(
    acknowledgements.some((body) => body.kind === "render" && body.ok === false),
    false,
  );
});

test("poster-first video acks stay ready and surface settle notes in status", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-dsh-plugin-"));
  const tokenFile = path.join(root, "token");
  await fs.writeFile(tokenFile, TOKEN);
  const plugin = await createPluginServer(tokenFile);
  const events = await openEvents(plugin.origin, "client-video-warm-01");
  t.after(async () => {
    events.request.destroy();
    events.response.destroy();
    await plugin.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  const payload = {
    generation: 31,
    media: "video",
    imageUrl: "http://127.0.0.1:45678/media/image?t=poster",
    videoUrl: "http://127.0.0.1:45678/media/video?t=movie",
    startAt: 0,
  };
  assert.equal((await fetch(`${plugin.origin}/__beauticode/apply`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  })).status, 200);

  const headers = { Origin: plugin.origin, "content-type": "application/json" };
  const ack = (body) =>
    fetch(`${plugin.origin}/__beauticode/ack`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientId: "client-video-warm-01", ...body }),
    });

  // Poster-phase ack: ok and visible, but the first frame has not presented.
  assert.equal((await ack({
    kind: "render",
    generation: 31,
    media: "video",
    ok: true,
    visible: true,
    videoReady: false,
  })).status, 200);
  let status = await (await fetch(`${plugin.origin}/__beauticode/status`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })).json();
  assert.equal(status.readyClients, 1);
  assert.equal(status.failedClients, 0);
  assert.equal(status.videoReadyClients, 0);
  assert.equal(status.videoPendingClients, 1);
  assert.equal(status.lastVideoError, null);
  assert.equal(status.playback, null);

  // A settle downgrade note rides along without failing the client.
  assert.equal((await ack({
    kind: "render",
    generation: 31,
    media: "video",
    ok: true,
    visible: true,
    videoReady: false,
    error: "视频预热未完成（已保留封面）：等待视频首帧超时",
  })).status, 200);
  status = await (await fetch(`${plugin.origin}/__beauticode/status`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })).json();
  assert.equal(status.readyClients, 1);
  assert.equal(status.failedClients, 0, "a settle note must not become a renderer failure");
  assert.equal(status.videoPendingClients, 1);
  assert.match(status.lastVideoError, /保留封面/);

  // The in-place upgrade flips the client to video-ready with playback.
  assert.equal((await ack({
    kind: "render",
    generation: 31,
    media: "video",
    ok: true,
    visible: true,
    videoReady: true,
    playback: {
      currentTime: 1.25,
      duration: 20,
      hasVideo: true,
      muted: true,
      paused: false,
      blocked: false,
    },
  })).status, 200);
  status = await (await fetch(`${plugin.origin}/__beauticode/status`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })).json();
  assert.equal(status.videoReadyClients, 1);
  assert.equal(status.videoPendingClients, 0);
  assert.equal(status.lastVideoError, null);
  assert.equal(status.playback.currentTime, 1.25);

  // Legacy clients that never send videoReady still count as ready.
  assert.equal((await ack({
    kind: "render",
    generation: 31,
    media: "video",
    ok: true,
    visible: true,
    playback: {
      currentTime: 2,
      duration: 20,
      hasVideo: true,
      muted: true,
      paused: false,
      blocked: false,
    },
  })).status, 200);
  status = await (await fetch(`${plugin.origin}/__beauticode/status`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  })).json();
  assert.equal(status.videoReadyClients, 1);
  assert.equal(status.videoPendingClients, 0);
});
