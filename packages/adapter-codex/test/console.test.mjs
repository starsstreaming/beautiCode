import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

/**
 * Minimal DOM for console.js placement. Mirrors DSH 0.1.2-alpha.5 through
 * 0.1.5-rc.1: footArea > settingsArea > (optional display:contents slot) >
 * triggerRow (horizontal flex) > settings button. Putting #beauticode-console
 * inside triggerRow squeezes the settings button to zero width (Issue #37).
 * Counting the contents wrapper as a layout parent inserts into the collapsed
 * settingsArea row instead of footArea (Issue #39).
 */
class FakeNode {
  constructor(tagName, document) {
    this.tagName = String(tagName).toUpperCase();
    this.document = document;
    this.id = "";
    this.className = "";
    this.parentElement = null;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.hidden = false;
    this._innerHTML = "";
    this.textContent = "";
    this.listeners = new Map();
    this.classList = {
      toggle: (name, force) => {
        const names = new Set(this.className.split(/\s+/).filter(Boolean));
        const on = force === undefined ? !names.has(name) : Boolean(force);
        if (on) names.add(name);
        else names.delete(name);
        this.className = [...names].join(" ");
        return on;
      },
    };
  }

  get nextElementSibling() {
    if (!this.parentElement) return null;
    const siblings = this.parentElement.children;
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }

  get previousElementSibling() {
    if (!this.parentElement) return null;
    const siblings = this.parentElement.children;
    const index = siblings.indexOf(this);
    return index > 0 ? siblings[index - 1] ?? null : null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "id") this.id = String(value);
    if (name === "class") this.className = String(value);
    if (name.startsWith("data-")) {
      const key = name
        .slice(5)
        .replace(/-([a-z])/g, (_all, ch) => ch.toUpperCase());
      this.dataset[key] = String(value);
    }
  }

  getAttribute(name) {
    if (name === "id") return this.id || null;
    if (name === "class") return this.className || null;
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name) {
    return this.getAttribute(name) != null;
  }

  set innerHTML(html) {
    this._innerHTML = String(html);
    for (const child of [...this.children]) child.remove();
    const re = /<([a-z0-9]+)([^>]*)>/gi;
    let match;
    while ((match = re.exec(this._innerHTML))) {
      const tag = match[1].toLowerCase();
      if (["svg", "path", "rect", "circle", "strong", "small", "h2"].includes(tag)) {
        continue;
      }
      const attrs = match[2];
      const classMatch = attrs.match(/class="([^"]*)"/);
      if (tag === "span" && !classMatch) continue;
      const child = this.document.createElement(tag);
      if (classMatch) child.className = classMatch[1];
      for (const attr of attrs.matchAll(/([a-z0-9:-]+)="([^"]*)"/gi)) {
        if (attr[1] === "class") continue;
        child.setAttribute(attr[1], attr[2]);
      }
      this.append(child);
    }
  }

  get innerHTML() {
    return this._innerHTML;
  }

  append(...nodes) {
    for (const node of nodes) {
      node.remove();
      node.parentElement = this;
      this.children.push(node);
    }
  }

  insertBefore(node, ref) {
    node.remove();
    node.parentElement = this;
    const index = ref ? this.children.indexOf(ref) : -1;
    if (index >= 0) this.children.splice(index, 0, node);
    else this.children.push(node);
    return node;
  }

  remove() {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children;
    const index = siblings.indexOf(this);
    if (index >= 0) siblings.splice(index, 1);
    this.parentElement = null;
  }

  addEventListener(name, handler) {
    const list = this.listeners.get(name) ?? [];
    list.push(handler);
    this.listeners.set(name, list);
  }

  contains(node) {
    for (let current = node; current; current = current.parentElement) {
      if (current === this) return true;
    }
    return false;
  }

  matches(selector) {
    const attr = selector.match(/^(\w+)?\[([^=\]]+)=["']([^"']+)["']\]$/);
    if (attr) {
      const [, tag, name, value] = attr;
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      return this.getAttribute(name) === value;
    }
    if (selector.startsWith(".")) {
      return this.className.split(/\s+/).includes(selector.slice(1));
    }
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    return this.tagName === selector.toUpperCase();
  }

  querySelectorAll(selector) {
    const parts = selector.split(",").map((part) => part.trim()).filter(Boolean);
    if (parts.length > 1) {
      const seen = new Set();
      const matches = [];
      for (const part of parts) {
        for (const node of this.querySelectorAll(part)) {
          if (!seen.has(node)) {
            seen.add(node);
            matches.push(node);
          }
        }
      }
      return matches;
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

  getBoundingClientRect() {
    if (this._rect) return this._rect;
    if (this.getAttribute("aria-haspopup") !== "dialog") {
      return { width: 36, height: 36, left: 8, top: 724, bottom: 760 };
    }
    const squeezed = this.parentElement?.children.some(
      (child) => child.id === "beauticode-console",
    );
    if (squeezed) {
      return { width: 0, height: 0, left: 8, top: 0, bottom: 0 };
    }
    return { width: 36, height: 36, left: 8, top: 724, bottom: 760 };
  }
}

function createConsoleDocument() {
  const document = {
    createElement(tagName) {
      const node = new FakeNode(tagName, document);
      if (tagName === "input") node.type = "";
      return node;
    },
    addEventListener() {},
  };
  const documentElement = new FakeNode("html", document);
  const head = new FakeNode("head", document);
  const body = new FakeNode("body", document);
  document.documentElement = documentElement;
  document.head = head;
  document.body = body;
  documentElement.append(head, body);
  document.querySelectorAll = (selector) => documentElement.querySelectorAll(selector);
  document.querySelector = (selector) => documentElement.querySelector(selector);
  document.getElementById = (id) => documentElement.querySelector(`#${id}`);
  return document;
}

function mountCodexSidebar(document) {
  const nav = document.createElement("nav");
  nav.id = "codex-rail";
  for (const label of ["新对话", "Pull Request", "定时任务", "插件", "探索"]) {
    const button = document.createElement("button");
    button.id = `item-${label}`;
    button.textContent = label;
    nav.append(button);
  }
  document.body.append(nav);
  return { nav, explore: nav.querySelectorAll("button")[4] };
}

async function loadConsole(document, initialState = {}) {
  const source = await fs.readFile(
    new URL("../src/renderer/console.js", import.meta.url),
    "utf8",
  );
  const ticks = [];
  const pending = new Map();
  const context = {
    window: null,
    document,
    crypto: { randomUUID: () => "test-id" },
    MutationObserver: class {
      observe() {}
    },
    addEventListener() {},
    innerHeight: 800,
    setInterval: (fn) => {
      ticks.push(fn);
      return ticks.length;
    },
    getComputedStyle: (el) => ({ display: el?.style?.display || "block", color: el?._testColor || "" }),
  };
  context.window = context;
  context.globalThis = context;
  Object.assign(context, initialState);
  context.window.__beauticodeBridgePending = pending;
  vm.runInNewContext(source, context);
  return {
    tick() {
      for (const fn of ticks) fn();
    },
    context,
  };
}

test("a previous console revision is replaced on reinjection after Codex UI upgrade", async () => {
  const document = createConsoleDocument();
  const { nav, explore } = mountCodexSidebar(document);
  let stalePlacementCalls = 0;
  const runtime = await loadConsole(document, {
    __beauticodeConsoleLoaded: true,
    __beauticodeConsoleRev: 4,
    __beauticodeConsolePlace: () => { stalePlacementCalls += 1; },
  });
  runtime.tick();
  assert.equal(stalePlacementCalls, 0);
  assert.equal(document.getElementById("beauticode-console")?.parentElement?.id, nav.id);
  assert.equal(document.getElementById("beauticode-console")?.previousElementSibling?.id, explore.id);
});

test("a superseded console instance is disposed on reinjection", async () => {
  const document = createConsoleDocument();
  mountCodexSidebar(document);
  let disposed = 0;
  const runtime = await loadConsole(document, {
    __beauticodeConsoleRev: 4,
    __beauticodeConsoleDispose: () => { disposed += 1; },
  });
  assert.equal(disposed, 1, "the previous instance must be released before remounting");
  assert.equal(typeof runtime.context.__beauticodeConsoleDispose, "function", "a disposer is left for the next upgrade");
});

test("an older instance without a disposer cannot add a second console to the rail", async () => {
  const document = createConsoleDocument();
  mountCodexSidebar(document);
  const first = await loadConsole(document);
  first.tick();
  const mounted = document.getElementById("beauticode-console");
  assert.ok(mounted, "first instance mounts a console");
  // The upgrade runs in the same page: the mounted instance is older, has no
  // disposer, and keeps re-asserting whatever host it mounted.
  const second = await loadConsole(document, {
    __beauticodeConsoleRev: 1,
    __beauticodeConsolePlace: () => {
      const stale = document.getElementById("beauticode-console");
      if (stale) document.body.append(stale);
    },
  });
  second.tick();
  const hosts = document.documentElement.querySelectorAll("#beauticode-console");
  assert.equal(hosts.length, 1, "two consoles in one rail fight through their observers and wedge the renderer");
  assert.equal(hosts[0], mounted, "the new instance adopts the mounted shell instead of replacing it");
});

test("console mounts below 探索 in the Codex rail", async () => {  const document = createConsoleDocument();
  const { nav, explore } = mountCodexSidebar(document);
  const runtime = await loadConsole(document);

  for (let i = 0; i < 4; i += 1) runtime.tick();

  const host = document.getElementById("beauticode-console");
  assert.equal(host?.parentElement?.id, "codex-rail");
  assert.equal(host?.previousElementSibling, explore);
  assert.equal(nav.children.map((child) => child.id || child.textContent).join(","), "item-新对话,item-Pull Request,item-定时任务,item-插件,item-探索,beauticode-console");
});

test("new Codex rail mounts 背景 after the icon-only Explore dots, not a content action", async () => {
  const document = createConsoleDocument();
  const contentAction = document.createElement("button");
  contentAction.textContent = "探索";
  contentAction._rect = { width: 90, height: 36, left: 700, top: 250, bottom: 286 };
  document.body.append(contentAction);

  const rail = document.createElement("nav");
  rail.id = "codex-rail";
  const home = document.createElement("button");
  home.textContent = "主页";
  rail.append(home);
  const dots = document.createElement("button");
  dots.id = "sidebar-more";
  dots.className = "sidebar-item";
  dots.textContent = "探索"; // New icon-only button exposes this via sr-only text.
  dots._rect = { width: 36, height: 36, left: 32, top: 580, bottom: 616 };
  dots._testColor = "rgba(255, 255, 255, 0.498)";
  rail.append(dots);
  document.body.append(rail);

  const runtime = await loadConsole(document);
  runtime.tick();
  const host = document.getElementById("beauticode-console");
  assert.equal(host?.parentElement?.id, "codex-rail");
  assert.equal(host?.previousElementSibling?.id, "sidebar-more");
  assert.equal(rail.children.filter((node) => node.id === "beauticode-console").length, 1);
  assert.equal(host.querySelector(".bc-trigger").style.color, dots._testColor);
  dots._testColor = "rgba(20, 20, 20, 0.55)";
  runtime.tick();
  assert.equal(host.querySelector(".bc-trigger").style.color, dots._testColor);
});

test("console remounts after the rail wipes the 背景 entry", async () => {
  const document = createConsoleDocument();
  const { nav, explore } = mountCodexSidebar(document);
  const source = await fs.readFile(
    new URL("../src/renderer/console.js", import.meta.url),
    "utf8",
  );
  const ticks = [];
  const context = {
    window: null,
    document,
    crypto: { randomUUID: () => "test-id" },
    MutationObserver: class {
      observe() {}
    },
    addEventListener() {},
    innerHeight: 800,
    setInterval: (fn) => {
      ticks.push(fn);
      return ticks.length;
    },
    getComputedStyle: (el) => ({ display: el?.style?.display || "block" }),
  };
  context.window = context;
  context.globalThis = context;
  context.window.__beauticodeBridgePending = new Map();
  vm.runInNewContext(source, context);
  for (const fn of ticks) fn();
  const first = document.getElementById("beauticode-console");
  assert.equal(first?.previousElementSibling, explore);
  first.remove();
  assert.equal(document.getElementById("beauticode-console"), null);
  vm.runInNewContext(source, context);
  for (const fn of ticks) fn();
  const again = document.getElementById("beauticode-console");
  assert.equal(again?.parentElement?.id, "codex-rail");
  assert.equal(again?.previousElementSibling, explore);
  assert.equal(
    nav.children.map((child) => child.id || child.textContent).join(","),
    "item-新对话,item-Pull Request,item-定时任务,item-插件,item-探索,beauticode-console",
  );
});

test("console pop keeps DSH 背景清单 controls", async () => {
  const document = createConsoleDocument();
  mountCodexSidebar(document);
  await loadConsole(document);

  const pop = document.getElementById("beauticode-console-pop");
  assert.match(pop.innerHTML, /背景清单/);
  assert.match(pop.innerHTML, /导入图片/);
  assert.match(pop.innerHTML, /导入视频/);
  assert.match(pop.innerHTML, /打开皮肤中心/);
  assert.match(pop.innerHTML, /class="bc-dim-slider"/);
  assert.match(pop.innerHTML, /恢复默认/);
  assert.equal(pop.querySelector(".bc-dim-value")?.textContent, "自动");
  assert.match(pop.innerHTML, /class="bc-dim-slider bc-blur-slider"/);
  assert.equal(pop.querySelector(".bc-blur-value")?.textContent, "关");
  // The panel control is gone: reading chrome stays transparent by design.
  assert.doesNotMatch(pop.innerHTML, /bc-surface-slider/);
  assert.equal(pop.querySelectorAll(".bc-dim").length, 2, "only brightness and blur remain");
});

test("console wires dim API and opens gallery overlay", async () => {
  const consoleSource = await fs.readFile(
    new URL("../src/renderer/console.js", import.meta.url),
    "utf8",
  );
  const gallerySource = await fs.readFile(
    new URL("../src/renderer/gallery.js", import.meta.url),
    "utf8",
  );
  assert.match(consoleSource, /BeauticodeBackgroundDim/);
  assert.match(consoleSource, /BeauticodeBackgroundBlur/);
  assert.doesNotMatch(consoleSource, /BeauticodeBackgroundSurface/);
  assert.match(consoleSource, /--bc-bg-blur/);
  // The brightness row renames itself with host appearance: white veil in light,
  // shadow in dark.
  assert.match(consoleSource, /isLightTone\(\) \? "亮度" : "阴影"/);
  // place() must stay bounded: it runs per childList mutation and forces layout.
  assert.match(consoleSource, /PLACE_MAX_INSERTS/);
  assert.match(consoleSource, /if \(disposed\) return;/);
  assert.match(consoleSource, /data-bc-ui/);
  assert.match(gallerySource, /data-bc-ui/);
  assert.match(consoleSource, /BeauticodeGallery\.open/);
  assert.doesNotMatch(consoleSource, /Codex 无法打开远程皮肤中心/);
  assert.match(gallerySource, /window\.BeauticodeGallery = \{ open, close \}/);
  assert.match(gallerySource, /\/__beauticode\/ui\/gallery\/catalog/);
});
