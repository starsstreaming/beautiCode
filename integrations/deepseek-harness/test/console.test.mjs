import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

/**
 * Minimal DOM for console.js. The console no longer mounts anything in the
 * sidebar: it adds a nav cell to the DSH settings dialog and a section of its
 * own next to the React one, then swaps which of the two is visible. The dialog
 * only exists while it is open, so the fixture below builds it on demand and
 * the tests drive open / close / re-render by hand.
 *
 * Contract console.js relies on, mirrored here:
 *   div[role=dialog][aria-modal=true][aria-labelledby=<id>]
 *     ├── nav > (title#<id>, navList > button × N)
 *     └── content > options > div[data-slot="settings.section"]
 *
 * FakeNode limitations the console must respect: matches() handles a
 * comma-separated list of tag / tag[attr="v"] / [attr="v"] / [attr] / .class /
 * #id only (no descendant combinators), and innerHTML parsing is flat — nested
 * markup does not create a hierarchy, so structural claims are asserted against
 * the HTML string instead.
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
    return siblings[siblings.indexOf(this) - 1] ?? null;
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

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === "id") this.id = "";
    if (name === "class") this.className = "";
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

  addEventListener(name, handler, options) {
    const list = this.listeners.get(name) ?? [];
    list.push({ handler, capture: options === true || options?.capture === true });
    this.listeners.set(name, list);
  }

  /**
   * Dispatches a bubbling click up the ancestor chain, capture listeners
   * outermost-first, honouring stopPropagation(). The console hands control
   * back to React from a capture listener on the dialog, so the phase is real.
   */
  click() {
    this.clicks = (this.clicks ?? 0) + 1;
    const path = [];
    for (let node = this; node; node = node.parentElement) path.push(node);
    let stopped = false;
    const event = {
      target: this,
      stopPropagation() {
        stopped = true;
      },
      preventDefault() {},
    };
    const fire = (node, capture) => {
      if (stopped) return;
      for (const entry of node.listeners.get("click") ?? []) {
        if (entry.capture !== capture) continue;
        entry.handler(event);
      }
    };
    for (let i = path.length - 1; i >= 0; i -= 1) fire(path[i], true);
    for (const node of path) fire(node, false);
    return stopped;
  }

  contains(node) {
    for (let current = node; current; current = current.parentElement) {
      if (current === this) return true;
    }
    return false;
  }

  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if (node.matches(selector)) return node;
    }
    return null;
  }

  matches(selector) {
    return String(selector)
      .split(",")
      .some((part) => this.matchesOne(part.trim()));
  }

  matchesOne(selector) {
    if (!selector) return false;
    const attr = selector.match(/^(\w+)?\[([^=\]]+)=["']([^"']+)["']\]$/);
    if (attr) {
      const [, tag, name, value] = attr;
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      return this.getAttribute(name) === value;
    }
    const presence = selector.match(/^(\w+)?\[([^=\]]+)\]$/);
    if (presence) {
      const [, tag, name] = presence;
      if (tag && this.tagName !== tag.toUpperCase()) return false;
      return this.getAttribute(name) != null;
    }
    if (selector.startsWith(".")) {
      return this.className.split(/\s+/).includes(selector.slice(1));
    }
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    return this.tagName === selector.toUpperCase();
  }

  querySelectorAll(selector) {
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

function createConsoleDocument() {
  const listeners = new Map();
  const document = {
    createElement(tagName) {
      const node = new FakeNode(tagName, document);
      if (tagName === "input") node.type = "";
      return node;
    },
    addEventListener(name, handler) {
      const list = listeners.get(name) ?? [];
      list.push(handler);
      listeners.set(name, list);
    },
    /** Fires the document-level events the console listens for (fullscreenchange). */
    dispatch(name) {
      for (const handler of listeners.get(name) ?? []) handler({ type: name });
    },
  };
  const documentElement = new FakeNode("html", document);
  const head = new FakeNode("head", document);
  const body = new FakeNode("body", document);
  document.documentElement = documentElement;
  document.head = head;
  document.body = body;
  documentElement.append(head, body);
  document.querySelectorAll = (selector) => documentElement.querySelectorAll(selector);
  document.getElementById = (id) => documentElement.querySelector(`#${id}`);
  return document;
}

/**
 * The settings dialog as DSH renders it: present only while open. The nav title
 * carries the aria-labelledby id, which React useId makes something like ":r1:"
 * — an invalid CSS identifier, so console.js must never turn it into a selector.
 */
function mountSettingsDialog(document) {
  const overlay = document.createElement("div");
  const mask = document.createElement("div");
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", ":r1:");

  const nav = document.createElement("nav");
  const navTitle = document.createElement("div");
  navTitle.id = ":r1:";
  navTitle.className = "navTitle";
  const navList = document.createElement("div");
  const cells = ["通用", "模型"].map((label) => {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.textContent = label;
    navList.append(cell);
    return cell;
  });
  cells[0].setAttribute("aria-current", "true");
  nav.append(navTitle, navList);

  const content = document.createElement("div");
  const header = document.createElement("div");
  const options = document.createElement("div");
  const anchor = document.createElement("div");
  anchor.setAttribute("data-slot", "settings.section");
  anchor.style.display = "contents";
  const section = document.createElement("div");
  section.className = "fake-section";
  anchor.append(section);
  options.append(anchor);
  content.append(header, options);
  dialog.append(nav, content);
  overlay.append(mask, dialog);
  document.body.append(overlay);

  return {
    overlay,
    dialog,
    nav,
    navTitle,
    navList,
    cells,
    content,
    options,
    anchor,
    /** React re-renders the whole nav list when its items change. */
    rerenderNavList() {
      const fresh = document.createElement("div");
      const freshCells = ["通用", "模型", "插件"].map((label) => {
        const cell = document.createElement("button");
        cell.type = "button";
        cell.textContent = label;
        fresh.append(cell);
        return cell;
      });
      freshCells[0].setAttribute("aria-current", "true");
      navList.remove();
      nav.append(fresh);
      return { navList: fresh, cells: freshCells };
    },
    unmount() {
      overlay.remove();
    },
  };
}

const okJson = (body) => ({ ok: true, status: 200, json: async () => body });

function statusBody(extra = {}) {
  return {
    ok: true,
    atmosphere: "none",
    media: "none",
    sourceMode: "",
    muted: true,
    themes: [],
    ...extra,
  };
}

/** Routes by path so the status payload and the import routes can differ. */
function routedFetch(routes) {
  return async (path, init) => {
    const handler = routes[path];
    if (!handler) return okJson({ ok: false, error: `unrouted ${path}` });
    return handler(path, init);
  };
}

async function loadConsole(document, { fetch: fetchImpl } = {}) {
  const source = await fs.readFile(new URL("../console.js", import.meta.url), "utf8");
  const ticks = [];
  const observerCallbacks = [];
  const context = {
    window: null,
    document,
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback;
      }
      observe() {
        observerCallbacks.push(this.callback);
      }
    },
    addEventListener() {},
    setInterval: (fn) => {
      ticks.push(fn);
      return ticks.length;
    },
    // console.js request() builds a timeout guard on every call; without these
    // the guard throws and refresh() falls back to its error branch, so the
    // status payload never reaches renderStatus().
    AbortController,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    fetch: fetchImpl ?? (async () => ({ ok: false, json: async () => ({}) })),
  };
  context.window = context;
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return {
    source,
    context,
    /** The interval is the drift net console.js keeps for DOM churn. */
    tick() {
      for (const fn of ticks) fn();
    },
    /** Runs fn, then the MutationObserver callbacks, as a real mutation would. */
    mutate(fn) {
      fn();
      for (const callback of observerCallbacks) callback();
    },
  };
}

const flushAsync = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const navCell = (document) => document.querySelectorAll('[data-bc-nav="console"]')[0] ?? null;
const pageEl = (document) => document.getElementById("beauticode-console-page");
const filePicker = (document) => document.getElementById("beauticode-console-file");

test("console adds a 背景 cell and page to the settings dialog, inactive", async () => {
  const document = createConsoleDocument();
  const dialog = mountSettingsDialog(document);
  await loadConsole(document);

  const cell = navCell(document);
  const page = pageEl(document);
  assert.ok(cell, "the nav cell is injected");
  assert.ok(page, "the page is injected");
  assert.match(cell.innerHTML, /背景/);
  assert.equal(cell.getAttribute("aria-current"), null);
  assert.equal(dialog.navList.children[dialog.navList.children.length - 1], cell);
  assert.equal(page.parentElement, dialog.options);
  assert.equal(page.previousElementSibling, dialog.anchor);
  assert.equal(page.hidden, true);
  assert.equal(dialog.dialog.getAttribute("data-bc-page"), null);
  assert.ok(page.querySelector('[data-act="media"]'), "the import control is wired");
});

test("console injects nothing while no settings dialog is open", async () => {
  const document = createConsoleDocument();
  const runtime = await loadConsole(document);

  assert.equal(pageEl(document), null, "no page is parked in the document");
  assert.equal(navCell(document), null);
  assert.equal(document.querySelectorAll('[aria-haspopup="dialog"]').length, 0);
  assert.equal(document.querySelectorAll(".bc-trigger").length, 0);

  const dialog = mountSettingsDialog(document);
  runtime.tick();
  assert.ok(navCell(document), "and it appears once the dialog opens");
  assert.equal(pageEl(document).parentElement, dialog.options);
});

test("console hides the React section without removing it, and only when active", async () => {
  const document = createConsoleDocument();
  const dialog = mountSettingsDialog(document);
  await loadConsole(document);

  dialog.options.scrollTop = 500;
  navCell(document).click();

  assert.equal(dialog.dialog.getAttribute("data-bc-page"), "on");
  assert.equal(navCell(document).getAttribute("aria-current"), "true");
  assert.equal(pageEl(document).hidden, false);
  assert.equal(dialog.anchor.parentElement, dialog.options, "React still owns its section");
  assert.equal(dialog.options.children[0], dialog.anchor);
  assert.equal(dialog.options.scrollTop, 0, "a long React section must not leave us mid-scroll");
});

test("console hands control back when a React nav cell is clicked", async () => {
  const document = createConsoleDocument();
  const dialog = mountSettingsDialog(document);
  await loadConsole(document);

  navCell(document).click();
  assert.equal(pageEl(document).hidden, false);

  dialog.cells[1].click();
  assert.equal(dialog.dialog.getAttribute("data-bc-page"), null);
  assert.equal(navCell(document).getAttribute("aria-current"), null);
  assert.equal(pageEl(document).hidden, true);
});

test("console survives React replacing the whole nav list while active", async () => {
  const document = createConsoleDocument();
  const dialog = mountSettingsDialog(document);
  const runtime = await loadConsole(document);

  navCell(document).click();
  const fresh = dialog.rerenderNavList();
  runtime.mutate(() => {});
  await flushAsync();

  const cell = navCell(document);
  assert.equal(cell.parentElement, fresh.navList, "re-parented into the new list");
  assert.equal(fresh.navList.children[fresh.navList.children.length - 1], cell);
  assert.equal(cell.getAttribute("aria-current"), "true");
  assert.equal(dialog.dialog.getAttribute("data-bc-page"), "on");
  assert.equal(pageEl(document).hidden, false);

  fresh.cells[0].click();
  assert.equal(pageEl(document).hidden, true, "the new cells still take control back");
});

test("console resets to the React page when settings is closed and reopened", async () => {
  const document = createConsoleDocument();
  const first = mountSettingsDialog(document);
  const runtime = await loadConsole(document);

  navCell(document).click();
  assert.equal(pageEl(document).hidden, false);

  first.unmount();
  runtime.tick();
  assert.equal(pageEl(document), null, "teardown detaches our page");
  assert.equal(navCell(document), null);

  const second = mountSettingsDialog(document);
  runtime.tick();
  const cell = navCell(document);
  assert.equal(cell.parentElement, second.navList, "injected into the new dialog");
  assert.equal(pageEl(document).parentElement, second.options);
  assert.equal(cell.getAttribute("aria-current"), null);
  assert.equal(pageEl(document).hidden, true);
  assert.equal(second.dialog.getAttribute("data-bc-page"), null);
});

test("console page includes a dim slider and restore-default control", async () => {
  const document = createConsoleDocument();
  mountSettingsDialog(document);
  await loadConsole(document);

  const page = pageEl(document);
  assert.match(page.innerHTML, /class="bc-dim-slider"/);
  assert.match(page.innerHTML, /type="range"/);
  assert.match(page.innerHTML, /data-act="dim-reset"/);
  assert.ok(page.querySelector(".bc-dim-slider"));
  const reset = page.querySelector('[data-act="dim-reset"]');
  assert.ok(reset);
  // An arrow, not a word: the control is an icon button with a label for
  // assistive tech, and it is always there rather than appearing only once a
  // value has been stored.
  assert.equal(reset.getAttribute("aria-label"), "恢复默认");
  assert.equal(reset.getAttribute("hidden"), null);
  assert.equal(reset.textContent.trim(), "");
  const control = /<button type="button" class="bc-dim-reset"[^>]*>([\s\S]*?)<\/button>/.exec(
    page.innerHTML,
  );
  assert.ok(control, "the reset control is in the page markup");
  assert.match(control[1], /<svg/, "the control is an icon");
  assert.doesNotMatch(control[1], /[\u4e00-\u9fff]/, "and it carries no words");
  assert.match(control[0], /aria-label="恢复默认"/, "but it is labelled for assistive tech");
  assert.equal(page.querySelector(".bc-dim-value")?.textContent, "0%");
  assert.equal(
    page.querySelector(".bc-dim-slider")?.value,
    "0",
    "the background shadow ships at zero until someone moves the slider",
  );
});

/**
 * 恢复默认 is a plain write of the default value. It used to clear the stored
 * value and leave the row in a separate "auto" state the slider could not show,
 * which is exactly how the row could report one number while the veil used
 * another.
 */
test("the reset arrow writes the default value instead of an auto state", async () => {
  const document = createConsoleDocument();
  mountSettingsDialog(document);
  const calls = [];
  const { context } = await loadConsole(document);
  let stored = 0.25;
  context.BeauticodeBackgroundDim = {
    get: () => stored,
    set: (value) => {
      calls.push(["set", value]);
      stored = value;
      return value;
    },
    clear: () => {
      calls.push(["clear"]);
      stored = null;
      return null;
    },
  };

  navCell(document).click();
  const page = pageEl(document);
  assert.equal(page.querySelector(".bc-dim-value")?.textContent, "25%");
  assert.equal(page.querySelector(".bc-dim-slider")?.value, "25");

  page.querySelector('[data-act="dim-reset"]').click();
  assert.deepEqual(calls, [["set", 0]], "reset writes 0% through and never clears");
  assert.equal(page.querySelector(".bc-dim-value")?.textContent, "0%");
  assert.equal(page.querySelector(".bc-dim-slider")?.value, "0");
});

/**
 * The reset arrows are <button> elements inside a flex control, so they carry no
 * user-agent affordance of their own: with no rule of their own they render as
 * raw UA buttons next to the styled pill controls. bc-dim-reset shipped that way
 * — the shadow row showed a grey box while the identical blur row below it
 * looked right.
 *
 * The check reads the class name out of the markup and then looks for a rule for
 * exactly that class, so a future control cannot ship unstyled either.
 */
test("every reset arrow in the page markup has a rule in the injected sheet", async () => {
  const document = createConsoleDocument();
  mountSettingsDialog(document);
  await loadConsole(document);

  const page = pageEl(document);
  const sheet = document.head.querySelector("style")?.textContent ?? "";
  assert.ok(sheet.includes("#beauticode-console-page"), "the console ships its own sheet");

  const classes = [...page.innerHTML.matchAll(/class="(bc-[\w-]*reset)"/g)].map((m) => m[1]);
  assert.deepEqual(
    classes.sort(),
    ["bc-blur-reset", "bc-dim-reset"],
    "both rows expose a reset arrow",
  );
  // The sheet writes the pair as a selector list (`.bc-dim-reset,.bc-blur-reset{…}`)
  // precisely so the two cannot drift, so locate the declaration block by finding
  // the class name and then reading forward to its braces: a regex anchored on
  // `\.name\{` would only accept the one-class-per-rule shape.
  const decl = (name, suffix = "") => {
    // Require a selector boundary after the name. A bare indexOf would accept
    // `.bc-dim-reset:hover` as the base rule for `.bc-dim-reset`, so dropping the
    // base rule while keeping the hover rule would still pass.
    const match = sheet.match(new RegExp(`\\.${name}${suffix}(?=\\s*[,{])`));
    if (!match) return undefined;
    const open = sheet.indexOf("{", match.index);
    const close = sheet.indexOf("}", open);
    if (open < 0 || close < 0) return undefined;
    return sheet.slice(open + 1, close);
  };
  for (const name of classes) {
    const base = decl(name);
    assert.ok(base, `${name} has a base rule`);
    assert.match(base, /cursor:pointer/, `${name} keeps the hand cursor`);
    assert.ok(decl(name, ":hover"), `${name} has a hover rule`);
  }
  // Same affordance, so the two must not drift apart again.
  assert.equal(
    decl("bc-dim-reset"),
    decl("bc-blur-reset"),
    "the reset arrows share one appearance",
  );
  assert.equal(decl("bc-dim-reset", ":hover"), decl("bc-blur-reset", ":hover"));
});

/**
 * Fullscreen is the only thing a page may call to hide the browser's own chrome
 * (tab strip, address bar), and browsers only honour the request from inside the
 * user gesture — the same constraint the file picker has. Esc exits without ever
 * touching our button, so the label has to follow the browser's state rather
 * than what we last asked for.
 */
test("console toggles fullscreen and follows the browser's own state", async () => {
  const document = createConsoleDocument();
  mountSettingsDialog(document);
  const calls = [];
  let current = null;
  document.documentElement.requestFullscreen = () => {
    calls.push("enter");
    current = document.documentElement;
  };
  document.exitFullscreen = () => {
    calls.push("exit");
    current = null;
  };
  Object.defineProperty(document, "fullscreenElement", {
    get: () => current,
    configurable: true,
  });

  await loadConsole(document);
  const page = pageEl(document);
  const row = page.querySelector('[data-row="fullscreen"]');
  const button = page.querySelector('[data-act="fullscreen"]');
  assert.ok(button, "expected a fullscreen control");
  assert.equal(row.hidden, false, "the row is offered when the browser has the API");
  assert.equal(button.textContent, "进入全屏");
  assert.equal(button.getAttribute("aria-pressed"), "false");

  button.click();
  // No await: the request has to run in the same synchronous block as the gesture.
  assert.equal(calls.join(" "), "enter", "the request runs inside the click handler");
  document.dispatch("fullscreenchange");
  assert.equal(button.textContent, "退出全屏");
  assert.equal(button.getAttribute("aria-pressed"), "true");

  button.click();
  assert.equal(calls.join(" "), "enter exit");
  document.dispatch("fullscreenchange");
  assert.equal(button.textContent, "进入全屏");

  // Esc is the browser's business: it flips the real state and fires the event,
  // so a label driven by our own bookkeeping would go stale here.
  current = document.documentElement;
  assert.equal(button.textContent, "进入全屏", "nothing updates without the event");
  document.dispatch("fullscreenchange");
  assert.equal(button.textContent, "退出全屏");
});

test("console drops the fullscreen row when the browser has no such API", async () => {
  const document = createConsoleDocument();
  mountSettingsDialog(document);
  await loadConsole(document);

  assert.equal(pageEl(document).querySelector('[data-row="fullscreen"]').hidden, true);
});

test("console page follows the settings row recipe", async () => {
  const document = createConsoleDocument();
  mountSettingsDialog(document);
  const runtime = await loadConsole(document);

  const page = pageEl(document);
  const html = page.innerHTML;
  // innerHTML parsing is flat in this harness, so nesting is asserted textually.
  assert.ok(html.indexOf('class="bc-row-text"') < html.indexOf('data-act="media"'));
  // The import control belongs with the list of backgrounds it feeds: the
  // merged row sits immediately above the saved list, below the display rows.
  assert.ok(
    html.indexOf('data-act="media"') < html.indexOf("bc-themes"),
    "import is offered above the saved backgrounds",
  );
  const between = html.slice(html.indexOf('data-act="media"'), html.indexOf("bc-themes"));
  assert.doesNotMatch(
    between,
    /data-act="(?:fullscreen|sound|gallery|clear)"/,
    "no other control sits between them",
  );
  // 7 rows: fullscreen, dim, sound, background blur, import, gallery, clear.
  assert.equal(page.querySelectorAll(".bc-row-title").length, 7);
  assert.equal(page.querySelectorAll(".bc-row-desc").length, 7);
  assert.ok(page.querySelector('[data-act="sound"]'));
  assert.ok(page.querySelector('[data-act="clear"]'));
  assert.ok(page.querySelector('[data-act="gallery"]'));
  assert.ok(page.querySelector(".bc-themes"));
  assert.ok(runtime.source.includes("--dsw-alias-border-l2"), "rows use the shipped tokens");
});

/**
 * Safari (and WebKit generally) only opens a file picker when input.click()
 * runs synchronously inside the user-gesture handler; a click deferred past an
 * await silently does nothing. On every non-Windows platform /ui/pick can only
 * answer native_picker_unavailable, so asking it first put the fallback click
 * behind a round trip and the picker never appeared.
 */
test("console opens the file picker inside the click when managed upload is allowed", async () => {
  const document = createConsoleDocument();
  mountSettingsDialog(document);
  await loadConsole(document, {
    fetch: routedFetch({
      "/__beauticode/ui/status": () =>
        okJson(
          statusBody({ importPolicy: { nativeLocalRequired: false, managedUploadAllowed: true } }),
        ),
    }),
  });

  navCell(document).click();
  await flushAsync();

  pageEl(document).querySelector('[data-act="media"]').click();
  // No await between the click and these assertions: the picker must open in
  // the same synchronous block as the gesture, not after a round trip.
  const picker = filePicker(document);
  assert.equal(picker.clicks, 1, "file picker opens from the click handler");
  // macOS and Linux take this route, so the one dialog must offer both kinds.
  for (const type of [".jpg", ".png", ".webp", ".avif", ".mp4", "image/jpeg", "video/mp4"]) {
    assert.ok(picker.accept.includes(type), `the merged picker accepts ${type}`);
  }
  assert.equal(picker.dataset.compatibilityUpload, "true");
});

test("console asks the host for one media pick when the native picker is required", async () => {
  const document = createConsoleDocument();
  mountSettingsDialog(document);
  const picks = [];
  await loadConsole(document, {
    fetch: routedFetch({
      "/__beauticode/ui/status": () =>
        okJson(
          statusBody({ importPolicy: { nativeLocalRequired: true, managedUploadAllowed: false } }),
        ),
      "/__beauticode/ui/pick": (_path, init) => {
        picks.push(JSON.parse(init.body));
        return okJson({ ok: true, cancelled: true });
      },
    }),
  });

  navCell(document).click();
  await flushAsync();

  pageEl(document).querySelector('[data-act="media"]').click();
  assert.equal(filePicker(document).clicks ?? 0, 0, "the host picker path opens no browser picker");

  await flushAsync();
  assert.equal(filePicker(document).clicks ?? 0, 0, "and none appears once the round trip settles");
  assert.deepEqual(
    picks,
    [{ kind: "media" }],
    "Windows asks the host for one dialog that takes either kind",
  );
});

test("console keeps the picker closed until importPolicy arrives", async () => {
  const document = createConsoleDocument();
  mountSettingsDialog(document);
  const hits = [];
  await loadConsole(document, {
    fetch: async (path) => {
      hits.push(String(path));
      return { ok: false, json: async () => ({}) };
    },
  });

  navCell(document).click();
  const page = pageEl(document);
  const mediaButton = page.querySelector('[data-act="media"]');
  assert.equal(mediaButton.disabled, true, "import stays locked until /ui/status reports a policy");

  mediaButton.click();
  assert.equal(filePicker(document).clicks ?? 0, 0, "no browser picker before the policy is known");
  assert.equal(
    hits.some((path) => path.includes("/ui/pick")),
    false,
    "and /ui/pick is not used as a stand-in for the missing policy",
  );
  assert.match(page.querySelector(".bc-msg").textContent, /正在确认导入方式/);
});

test("console descriptions stay plain and free of host detail", async () => {
  const document = createConsoleDocument();
  mountSettingsDialog(document);
  await loadConsole(document);

  const markup = pageEl(document).innerHTML;
  for (const line of [
    "给 DSH 换一张背景图或视频。",
    "支持常见图片格式和 MP4 / MOV 视频",
    "隐藏浏览器标签页和地址栏，Esc 退出",
    "压暗背景，让内容更清楚",
    "播放视频背景的声音",
    "浏览并一键应用在线皮肤",
    "恢复 DSH 默认外观",
  ]) {
    assert.ok(markup.includes(line), `the page keeps the plain line: ${line}`);
  }
  for (const jargon of ["托管", "引用", "零复制", "复制后播放", "复制一份", "主媒体"]) {
    assert.equal(markup.includes(jargon), false, `no host detail leaks into the copy: ${jargon}`);
  }
});

test("console unlocks import once a managed-upload policy lands", async () => {
  const document = createConsoleDocument();
  mountSettingsDialog(document);
  await loadConsole(document, {
    fetch: routedFetch({
      "/__beauticode/ui/status": () =>
        okJson(
          statusBody({ importPolicy: { nativeLocalRequired: false, managedUploadAllowed: true } }),
        ),
    }),
  });

  navCell(document).click();
  await flushAsync();

  const page = pageEl(document);
  assert.equal(page.querySelector('[data-act="media"]').disabled, false);
  assert.equal(
    page.innerHTML.includes("托管"),
    false,
    "unlocking import must not reintroduce how the host stores the file",
  );
});

test("console unlocks import under a native-picker-only policy too", async () => {
  const document = createConsoleDocument();
  mountSettingsDialog(document);
  await loadConsole(document, {
    fetch: routedFetch({
      "/__beauticode/ui/status": () =>
        okJson(
          statusBody({ importPolicy: { nativeLocalRequired: true, managedUploadAllowed: false } }),
        ),
    }),
  });

  navCell(document).click();
  await flushAsync();

  const page = pageEl(document);
  assert.equal(page.querySelector('[data-act="media"]').disabled, false);
  assert.equal(
    page.innerHTML.includes("引用"),
    false,
    "and the native-picker policy must not bring its own jargon back",
  );
});

/**
 * The page used to print the active background twice: a status row naming the
 * current theme, and the message under it reporting the last action. The row is
 * gone, so the message is the only place the page speaks - which means a status
 * failure has to land there rather than only in the removed row.
 */
test("the page reports the applied state in exactly one place", async () => {
  const document = createConsoleDocument();
  mountSettingsDialog(document);
  await loadConsole(document, {
    fetch: routedFetch({
      "/__beauticode/ui/status": () => okJson({ ok: false, error: "背景服务没有响应" }),
    }),
  });

  navCell(document).click();
  await flushAsync();

  const page = pageEl(document);
  assert.equal(
    page.innerHTML.includes("bc-status"),
    false,
    "no row repeats the active theme next to the message",
  );
  assert.match(page.querySelector(".bc-msg").textContent, /背景服务没有响应/);
});

/**
 * Saved backgrounds are listed the way Settings -> 模型 lists models: every entry
 * is a card wrapped in a rounded outline, the source sits in a bordered tag,
 * and the one in use carries the same small green state dot after its name.
 */
test("the saved list marks the background in use like a configured model", async () => {
  const document = createConsoleDocument();
  mountSettingsDialog(document);
  const runtime = await loadConsole(document, {
    fetch: routedFetch({
      "/__beauticode/ui/status": () =>
        okJson(
          statusBody({
            themeId: "t2",
            themes: [
              { id: "t1", name: "雨夜", type: "image", sourceMode: "local" },
              { id: "t2", name: "怪诞小镇", type: "image", sourceMode: "managed" },
            ],
          }),
        ),
    }),
  });

  navCell(document).click();
  await flushAsync();

  const list = pageEl(document).querySelector(".bc-theme-list");
  const markup = list.innerHTML;
  assert.match(markup, /<span class="bc-theme-name">怪诞小镇<\/span>/);
  assert.match(markup, /data-theme-id="t2"[^>]*aria-current="true"/);
  assert.equal(
    (markup.match(/bc-theme-dot/g) ?? []).length,
    1,
    "only the background in use carries the green dot",
  );
  assert.match(
    markup,
    /<span class="bc-theme-dot" role="img" aria-label="当前使用"/,
    "and it says what it means for assistive tech",
  );
  assert.doesNotMatch(markup, /bc-theme-check/, "the check mark is not the shipped pattern");
  // The card, the tag and the dot all take the shipped metrics.
  assert.match(
    runtime.source,
    /\.bc-theme-row\{[^}]*border:\.5px solid var\(--dsw-alias-border-l4\)[^}]*border-radius:16px/,
  );
  assert.match(runtime.source, /\.bc-source\{[^}]*border:\.5px solid var\(--dsw-alias-border-l3\)/);
  assert.match(
    runtime.source,
    /\.bc-theme-dot\{[^}]*width:8px;height:8px;background:var\(--dsw-alias-state-success-primary\)/,
  );
});

/**
 * The saved list is split by media kind, switched the way Settings -> 插件
 * switches between its two pages: a tab row on a hairline rule, the active tab
 * in label-primary with an underline, nothing else highlighted.
 */
test("the saved list switches between image and video backgrounds", async () => {
  const document = createConsoleDocument();
  mountSettingsDialog(document);
  // Any path answers with the same status here: what this test exercises is the
  // tab row, not the request routing.
  await loadConsole(document, {
    fetch: async () =>
      okJson(
        statusBody({
          themeId: "i1",
          themes: [
            { id: "i1", name: "雨夜", type: "image", sourceMode: "local" },
            { id: "v1", name: "海浪", type: "video", sourceMode: "managed" },
          ],
        }),
      ),
  });

  navCell(document).click();
  await flushAsync();

  const page = pageEl(document);
  // The harness parses innerHTML flat and keeps no text, so the copy is
  // asserted on the markup and the state on the elements.
  assert.match(page.innerHTML, /<h3 class="bc-theme-title">已保存的背景<\/h3>/);
  const tabs = page.querySelectorAll(".bc-tab");
  assert.equal(tabs.length, 2);
  assert.deepEqual(
    tabs.map((tab) => tab.getAttribute("data-category")),
    ["image", "video"],
  );
  assert.match(page.innerHTML, />图片<\/button>/);
  assert.match(page.innerHTML, />视频<\/button>/);

  const [imageTab, videoTab] = tabs;
  assert.equal(
    imageTab.getAttribute("data-active"),
    "true",
    "opens on the category of the background in use",
  );
  assert.equal(imageTab.getAttribute("aria-selected"), "true");
  assert.equal(videoTab.getAttribute("data-active"), null);
  const list = page.querySelector(".bc-theme-list");
  assert.match(list.innerHTML, /data-theme-id="i1"/);
  assert.doesNotMatch(list.innerHTML, /data-theme-id="v1"/);

  videoTab.click();
  assert.equal(videoTab.getAttribute("data-active"), "true");
  assert.equal(videoTab.getAttribute("aria-selected"), "true");
  assert.equal(imageTab.getAttribute("data-active"), null, "only one tab is highlighted");
  assert.equal(imageTab.getAttribute("aria-selected"), "false");
  assert.match(list.innerHTML, /data-theme-id="v1"/);
  assert.doesNotMatch(list.innerHTML, /data-theme-id="i1"/);
  assert.equal(page.querySelector(".bc-theme-count").textContent, "1");
});

test("an empty category says so instead of showing nothing", async () => {
  const document = createConsoleDocument();
  mountSettingsDialog(document);
  await loadConsole(document, {
    fetch: routedFetch({
      "/__beauticode/ui/status": () =>
        okJson(
          statusBody({
            themeId: "i1",
            themes: [{ id: "i1", name: "雨夜", type: "image", sourceMode: "local" }],
          }),
        ),
    }),
  });

  navCell(document).click();
  await flushAsync();

  const page = pageEl(document);
  page.querySelectorAll(".bc-tab")[1].click();

  const empty = page.querySelector(".bc-empty");
  assert.equal(empty.hidden, false);
  assert.match(empty.textContent, /还没有保存的视频背景/);
  assert.equal(page.querySelector(".bc-theme-list").innerHTML, "");
  assert.equal(
    page.querySelector(".bc-theme-count").textContent,
    "0",
    "the heading counts what is actually listed",
  );
});

test("the saved list stays expanded: showing it is not a setting", async () => {
  const document = createConsoleDocument();
  mountSettingsDialog(document);
  await loadConsole(document, {
    fetch: routedFetch({
      "/__beauticode/ui/status": () =>
        okJson(
          statusBody({
            themeId: "i1",
            themes: [{ id: "i1", name: "雨夜", type: "image", sourceMode: "local" }],
          }),
        ),
    }),
  });

  navCell(document).click();
  await flushAsync();

  const page = pageEl(document);
  assert.equal(page.querySelector(".bc-theme-toggle"), null, "the show/hide control is gone");
  assert.equal(page.querySelector(".bc-theme-list").hidden, false);
  assert.equal(
    page.innerHTML.includes("SAVED"),
    false,
    "and its SAVED / NN label went with it",
  );
});

test("console disables its controls and reports progress while busy", async () => {
  const document = createConsoleDocument();
  mountSettingsDialog(document);
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await loadConsole(document, {
    fetch: routedFetch({
      "/__beauticode/ui/status": () =>
        okJson(
          statusBody({ importPolicy: { nativeLocalRequired: false, managedUploadAllowed: true } }),
        ),
      "/__beauticode/ui/clear": async () => {
        await gate;
        return okJson({ ok: true, message: "已清除" });
      },
    }),
  });

  const page = pageEl(document);
  page.querySelector('[data-act="clear"]').click();

  assert.equal(page.dataset.busy, "true");
  assert.equal(
    page.querySelectorAll(".bc-btn").every((button) => button.disabled === true),
    true,
    "every control is disabled while the request is in flight",
  );
  assert.match(page.querySelector(".bc-msg").textContent, /正在处理/);

  release();
  await flushAsync();
  assert.equal(page.dataset.busy, undefined);
  assert.equal(
    page.querySelectorAll(".bc-btn").some((button) => button.disabled === true),
    false,
  );
});
