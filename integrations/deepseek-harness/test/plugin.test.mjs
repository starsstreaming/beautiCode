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
  assert.match(once, /__beauticode\/atmosphere\.js/);
  assert.match(once, /__beauticode\/console\.js/);
  const atmosphere = await fetch(`${plugin.origin}/__beauticode/atmosphere.js`);
  assert.equal(atmosphere.status, 200);
  const atmosphereSource = await atmosphere.text();
  assert.doesNotThrow(() => new Function(atmosphereSource));
  const response = await fetch(`${plugin.origin}/__beauticode/client.js`);
  assert.equal(response.status, 200);
  const source = await response.text();
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
  assert.match(source, /await waitForPresentedFrame\(video, signal, remaining\(\)\)/);
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
  assert.match(source, /#beauticode-bg-stage::after\{background:rgba\(0,0,0,\.42\)\}/);
  assert.match(source, /\[class\*=\"_fade\"\]\{display:none!important\}/);
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
      "  function updateCommittedDom(payload) {",
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

  function updateCommittedDom(payload) {`,
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
    "  function updateCommittedDom(payload) {",
    `  globalThis.__testVideoSlotMatches = (slot, payload) => {
    currentSlot = slot;
    return slotMatchesPayload(slot, payload);
  };

  function updateCommittedDom(payload) {`,
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
    lastRenderError: null,
    visibleClients: 1,
    modeReadyClients: 0,
    blockedClients: 0,
    resolvedTone: null,
    modes: { fish: false, muted: true, tone: "auto" },
    playback: null,
  });
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
