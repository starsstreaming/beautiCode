import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { FakeDocument, FakeMutationObserver, element } from "./fixtures/fake-dom.mjs";

const source = await fs.readFile(new URL("../readability.js", import.meta.url), "utf8");

const KEYS = {
  page: "beauticode-page-material",
  pageBlur: "beauticode-page-blur",
  panel: "beauticode-readable-surfaces",
  alphaStep: "beauticode-material-alpha-step",
  blurStep: "beauticode-material-blur-step",
  maxBlur: "beauticode-material-max-blur",
  direction: "beauticode-material-direction",
};

function load({ initial = {}, active = true, denied = false, dom } = {}) {
  const document = dom ?? new FakeDocument({ active });
  const store = new Map(Object.entries(initial).map(([key, value]) => [key, String(value)]));
  const timers = [];
  const events = [];
  const listeners = new Map();
  const context = {
    document,
    localStorage: {
      getItem(key) {
        if (denied) throw new Error("storage unavailable");
        return store.has(key) ? store.get(key) : null;
      },
      setItem(key, value) {
        if (denied) throw new Error("storage unavailable");
        store.set(key, String(value));
      },
      removeItem(key) {
        if (denied) throw new Error("storage unavailable");
        store.delete(key);
      },
    },
    // readability coalesces observer rescans through rAF when available, else a
    // timer. The harness exposes a deterministic timer queue.
    setTimeout(callback) {
      timers.push(callback);
      return timers.length;
    },
    addEventListener(name, handler) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(handler);
    },
    dispatchEvent(event) {
      events.push(event?.type ?? String(event));
      return true;
    },
    CustomEvent: class {
      constructor(type) {
        this.type = type;
      }
    },
    MutationObserver: FakeMutationObserver,
  };
  vm.runInNewContext(source, context);
  const flush = () => {
    while (timers.length) timers.shift()();
  };
  const trigger = (name, event) => {
    for (const handler of listeners.get(name) ?? []) handler(event);
  };
  return { context, document, store, events, listeners, flush, trigger, api: context.BeauticodeReadableSurfaces };
}

const attr = (node, name) => node.getAttribute(name);
const cssVar = (node, name) => node.style.getPropertyValue(name);

/**
 * A page-mode DOM: the [data-global-panel] column, an independent body dialog,
 * the composer and the three pending-interaction cards, the shell.overlay
 * container (and a dialog inside it), and a no-role third-party popover.
 */
function buildPage(dom) {
  const page = element(dom, "div", { "data-global-panel": "" });
  page.id = "page";
  const plugin = element(dom, "section", { "data-plugin-panel": "" });
  const pageMenu = element(dom, "div", { role: "listbox" });
  page.append(plugin, pageMenu);

  const dialog = element(dom, "div", { role: "dialog" });
  const dialogList = element(dom, "div", { role: "listbox" });
  dialog.append(dialogList);

  const composer = element(dom, "div", { "data-composer-card": "" });
  const questionFrame = element(dom, "div", { "data-question-key": "q1" });
  const questionCard = element(dom, "section");
  questionFrame.append(questionCard);
  const planFrame = element(dom, "div", { "data-plan-review-key": "p1" });
  const planCard = element(dom, "section");
  planFrame.append(planCard);
  const approvalFrame = element(dom, "div", { "data-approval-key": "a1" });
  const approvalCard = element(dom, "div");
  approvalFrame.append(approvalCard);

  const overlay = element(dom, "div", { "data-shell-overlay": "" });
  const shellDialog = element(dom, "div", { role: "dialog" });
  overlay.append(shellDialog);
  const popover = element(dom, "div", { class: "third-party-popover" });

  dom.body.append(page, dialog, composer, questionFrame, planFrame, approvalFrame, overlay, popover);
  return {
    page, plugin, pageMenu, dialog, dialogList, composer,
    questionFrame, questionCard, planFrame, planCard, approvalFrame, approvalCard,
    overlay, shellDialog, popover,
  };
}

test("defaults are page 30 / panel 100 with the documented advanced steps", () => {
  const { api, document, events } = load();
  assert.equal(api.get(), 100);
  assert.equal(api.getPage(), 30);
  assert.equal(api.getPageBlur(), false);
  assert.deepEqual({ ...api.getMaterial() }, { alphaStep: 8, blurStep: 2, maxBlur: 8, direction: "up" });
  assert.deepEqual({ ...api.defaults }, { page: 30, pageBlur: false, panel: 100, alphaStep: 8, blurStep: 2, maxBlur: 8, direction: "up" });
  assert.equal(attr(document.documentElement, "data-bc-readable-surfaces"), "true");
  assert.equal(attr(document.documentElement, "data-bc-page-material"), "true");
  assert.equal(attr(document.documentElement, "data-bc-page-blur"), null);
  assert.equal(cssVar(document.documentElement, "--bc-readable-strength"), "100");
  assert.equal(cssVar(document.documentElement, "--bc-page-material-strength"), "30");
  assert.equal(cssVar(document.documentElement, "--bc-material-alpha-step"), "8");
  assert.equal(cssVar(document.documentElement, "--bc-material-blur-step"), "2");
  assert.equal(cssVar(document.documentElement, "--bc-material-max-blur"), "8");
  assert.equal(cssVar(document.documentElement, "--bc-material-direction"), "up");
  assert.deepEqual({ ...api.getBlur() }, { page: 0, panel: 2 }, "no page anchor; an independent panel would get the 2px step");
  assert.deepEqual(events, ["beauticode-material-change", "beauticode-readability-change"]);
});

test("legacy panel storage keeps true/false/number semantics; 0 still writes false", () => {
  for (const [stored, expected] of [
    ["true", 100], ["false", 0], ["40", 40], ["100", 100], ["101", 100], ["-5", 0],
    ["invalid", 100], ["null", 100], ["", 100],
  ]) {
    const { api, document } = load({ initial: { [KEYS.panel]: stored } });
    assert.equal(api.get(), expected, `stored ${JSON.stringify(stored)}`);
    assert.equal(attr(document.documentElement, "data-bc-readable-surfaces"), expected > 0 ? "true" : "false");
    assert.equal(cssVar(document.documentElement, "--bc-readable-strength"), expected > 0 ? String(expected) : "");
  }

  const { api, store, document } = load();
  assert.equal(api.set(false), 0);
  assert.equal(store.get(KEYS.panel), "false", "0 keeps the old spelling for rollback");
  assert.equal(api.set(true), 100);
  assert.equal(store.get(KEYS.panel), "100");
  assert.equal(api.set(35), 35);
  assert.equal(store.get(KEYS.panel), "35");
  assert.equal(attr(document.documentElement, "data-bc-readable-surfaces"), "true");
});

test("page storage defaults to 30, clamps, and writes 0 as the new key's zero", () => {
  for (const [stored, expected] of [["0", 0], ["45", 45], ["120", 100], ["-5", 0], ["invalid", 30], ["", 30]]) {
    const { api } = load({ initial: { [KEYS.page]: stored } });
    assert.equal(api.getPage(), expected, `stored ${JSON.stringify(stored)}`);
  }
  const { api, store, document } = load();
  assert.equal(api.setPage(0), 0);
  assert.equal(store.get(KEYS.page), "0");
  assert.equal(attr(document.documentElement, "data-bc-page-material"), null);
  assert.equal(cssVar(document.documentElement, "--bc-page-material-strength"), "0");
  assert.equal(api.setPage(30), 30);
  assert.equal(attr(document.documentElement, "data-bc-page-material"), "true");

  // Experimental page blur: boolean only, default false, any other spelling off.
  for (const [stored, expected] of [["true", true], ["false", false], ["1", false], ["yes", false], ["", false]]) {
    const { api: blurApi } = load({ initial: { [KEYS.pageBlur]: stored } });
    assert.equal(blurApi.getPageBlur(), expected, `stored page blur ${JSON.stringify(stored)}`);
  }
  const { api: blurApi, store: blurStore, document: blurDocument } = load();
  assert.equal(blurApi.getPageBlur(), false);
  assert.equal(blurApi.setPageBlur(true), true);
  assert.equal(blurStore.get(KEYS.pageBlur), "true");
  assert.equal(attr(blurDocument.documentElement, "data-bc-page-blur"), "true");
  assert.equal(blurApi.setPageBlur(false), false);
  assert.equal(blurStore.get(KEYS.pageBlur), "false");
  assert.equal(attr(blurDocument.documentElement, "data-bc-page-blur"), null);
  assert.equal(blurApi.setPageBlur("yes"), false, "only boolean true enables the experiment");

  const { api: pageZero, document: pageZeroDocument } = load({ initial: { [KEYS.page]: "0", [KEYS.pageBlur]: "true" } });
  assert.equal(pageZero.getPageBlur(), true);
  assert.equal(attr(pageZeroDocument.documentElement, "data-bc-page-blur"), null,
    "page 0% keeps the option but publishes no backplate flag");
});

test("advanced storage falls back, clamps, and normalizes direction", () => {
  const { api } = load({
    initial: {
      [KEYS.alphaStep]: "99",
      [KEYS.blurStep]: "9",
      [KEYS.maxBlur]: "-2",
      [KEYS.direction]: "sideways",
    },
  });
  assert.deepEqual({ ...api.getMaterial() }, { alphaStep: 30, blurStep: 8, maxBlur: 0, direction: "up" });

  const { api: defaults } = load({
    initial: { [KEYS.alphaStep]: "x", [KEYS.blurStep]: "", [KEYS.maxBlur]: "x", [KEYS.direction]: "" },
  });
  assert.deepEqual({ ...defaults.getMaterial() }, { alphaStep: 8, blurStep: 2, maxBlur: 8, direction: "up" });

  const { api: setter, store } = load();
  assert.deepEqual({ ...setter.setMaterial({ alphaStep: -1, blurStep: 99, maxBlur: 20, direction: "down" }) },
    { alphaStep: 0, blurStep: 8, maxBlur: 16, direction: "down" });
  assert.equal(store.get(KEYS.alphaStep), "0");
  assert.equal(store.get(KEYS.blurStep), "8");
  assert.equal(store.get(KEYS.maxBlur), "16");
  assert.equal(store.get(KEYS.direction), "down");
  assert.deepEqual({ ...setter.setMaterial({ direction: "sideways" }) }, { alphaStep: 0, blurStep: 8, maxBlur: 16, direction: "up" });
  assert.deepEqual({ ...setter.setMaterial({ alphaStep: 1 }) }, { alphaStep: 1, blurStep: 8, maxBlur: 16, direction: "up" });
});

test("page mode: page 30% alpha-only by default, independent panel 100% + 3.69px", () => {
  const dom = new FakeDocument({ active: true });
  const nodes = buildPage(dom);
  const { api, document } = load({ dom });

  assert.equal(attr(nodes.page, "data-bc-material-root"), "page");
  assert.equal(attr(nodes.page, "data-bc-material-level"), "1");
  assert.equal(attr(nodes.page, "data-bc-material-depth"), "1");
  assert.equal(attr(nodes.page, "data-bc-material-layer"), null);
  assert.equal(attr(nodes.page, "data-bc-material-blur"), null, "page blur is opt-in and off by default");
  assert.equal(cssVar(nodes.page, "--bc-material-alpha"), "0.3");
  assert.equal(cssVar(nodes.page, "--bc-material-blur"), "");
  assert.equal(attr(document.documentElement, "data-bc-page-blur"), null);
  assert.equal(attr(nodes.plugin, "data-bc-material-root"), null, "the plugin page content is not painted");

  assert.equal(attr(nodes.pageMenu, "data-bc-material-layer"), "");
  assert.equal(attr(nodes.pageMenu, "data-bc-material-level"), "2");
  assert.equal(attr(nodes.pageMenu, "data-bc-material-depth"), "2");
  assert.equal(attr(nodes.pageMenu, "data-bc-material-blur"), null);
  assert.equal(cssVar(nodes.pageMenu, "--bc-material-alpha"), "0.38");
  assert.equal(cssVar(nodes.pageMenu, "--bc-material-blur"), "");

  assert.equal(attr(nodes.dialog, "data-bc-material-root"), "panel");
  assert.equal(attr(nodes.dialog, "data-bc-material-level"), "2");
  assert.equal(attr(nodes.dialog, "data-bc-material-depth"), "1");
  assert.equal(attr(nodes.dialog, "data-bc-material-blur"), "on");
  assert.equal(cssVar(nodes.dialog, "--bc-material-alpha"), "1");
  assert.equal(cssVar(nodes.dialog, "--bc-material-blur"), "3.69px");

  assert.equal(attr(nodes.dialogList, "data-bc-material-layer"), "");
  assert.equal(attr(nodes.dialogList, "data-bc-material-level"), "3");
  assert.equal(attr(nodes.dialogList, "data-bc-material-depth"), "2");
  assert.equal(attr(nodes.dialogList, "data-bc-material-blur"), null);
  assert.equal(cssVar(nodes.dialogList, "--bc-material-alpha"), "1", "panel alpha clamps at 100%");
  assert.equal(cssVar(nodes.dialogList, "--bc-material-blur"), "");

  for (const card of [nodes.composer, nodes.questionCard, nodes.planCard, nodes.approvalCard]) {
    assert.equal(attr(card, "data-bc-material-root"), "panel");
    assert.equal(cssVar(card, "--bc-material-alpha"), "1");
    assert.equal(cssVar(card, "--bc-material-blur"), "3.69px");
  }
  assert.equal(attr(nodes.overlay, "data-bc-material-root"), null, "shell.overlay is not a root");
  assert.equal(attr(nodes.overlay, "data-bc-material-layer"), null);
  assert.equal(attr(nodes.shellDialog, "data-bc-material-root"), "panel", "role children inside shell.overlay stay independent");
  assert.equal(attr(nodes.popover, "data-bc-material-root"), null, "no-role popovers are outside the contract");
  assert.deepEqual({ ...api.getBlur() }, { page: 0, panel: 3.69 }, "default page blur is not applied");

  // Opt-in experiment: it restores the page blur marker and keeps the same
  // panel radius; disabling it removes every trace again.
  assert.equal(api.setPageBlur(true), true);
  assert.equal(attr(document.documentElement, "data-bc-page-blur"), "true");
  assert.equal(attr(nodes.page, "data-bc-material-blur"), "on");
  assert.equal(cssVar(nodes.page, "--bc-material-blur"), "2.4px");
  assert.deepEqual({ ...api.getBlur() }, { page: 2.4, panel: 3.69 });
  assert.equal(api.setPageBlur(false), false);
  assert.equal(attr(document.documentElement, "data-bc-page-blur"), null);
  assert.equal(attr(nodes.page, "data-bc-material-blur"), null);
  assert.equal(cssVar(nodes.page, "--bc-material-blur"), "");
  assert.deepEqual({ ...api.getBlur() }, { page: 0, panel: 3.69 });
});

test("main conversation: no page anchor means the panel's own blur is the blur step", () => {
  const dom = new FakeDocument({ active: true });
  const dialog = element(dom, "div", { role: "dialog" });
  const composer = element(dom, "div", { "data-composer-card": "" });
  const root = element(dom, "div", { id: "root" }, [composer]);
  dom.body.append(root, dialog);
  const { api } = load({ dom });

  assert.equal(dom.querySelectorAll("[data-global-panel]").length, 0);
  assert.equal(attr(dialog, "data-bc-material-root"), "panel");
  assert.equal(cssVar(dialog, "--bc-material-blur"), "2px");
  assert.equal(attr(composer, "data-bc-material-root"), "panel");
  assert.equal(cssVar(composer, "--bc-material-blur"), "2px");
  assert.deepEqual({ ...api.getBlur() }, { page: 0, panel: 2 });
});

test("page 0% removes only the page channel; panels then use I = 0", () => {
  const dom = new FakeDocument({ active: true });
  const nodes = buildPage(dom);
  const { api, document, events } = load({ dom });
  events.length = 0;

  api.setPage(0);
  assert.equal(attr(nodes.page, "data-bc-material-root"), null);
  assert.equal(attr(nodes.page, "data-bc-material-blur"), null);
  assert.equal(cssVar(nodes.page, "--bc-material-alpha"), "");
  assert.equal(attr(document.documentElement, "data-bc-page-material"), null);
  assert.equal(attr(nodes.dialog, "data-bc-material-root"), "panel", "panel channel is independent");
  assert.equal(cssVar(nodes.dialog, "--bc-material-blur"), "2px");
  assert.equal(attr(nodes.pageMenu, "data-bc-material-layer"), null, "no page root, no page nested layers");
  assert.deepEqual(events, ["beauticode-material-change"], "page changes do not fire the legacy panel event");
});

test("panel 0% removes only the panel channel; the page keeps its 30% plate", () => {
  const dom = new FakeDocument({ active: true });
  const nodes = buildPage(dom);
  const { api, document } = load({ dom });

  api.set(0);
  assert.equal(attr(document.documentElement, "data-bc-readable-surfaces"), "false");
  assert.equal(cssVar(document.documentElement, "--bc-readable-strength"), "");
  assert.equal(attr(nodes.dialog, "data-bc-material-root"), null);
  assert.equal(attr(nodes.composer, "data-bc-material-root"), null);
  assert.equal(attr(nodes.dialogList, "data-bc-material-layer"), null);
  assert.equal(attr(nodes.page, "data-bc-material-root"), "page");
  assert.equal(cssVar(nodes.page, "--bc-material-alpha"), "0.3");
  assert.equal(cssVar(nodes.page, "--bc-material-blur"), "", "the page stays alpha-only at panel 0%");
  assert.deepEqual({ ...api.getBlur() }, { page: 0, panel: 3.69 }, "the panel radius is still reported for the next enable");

  api.set(100);
  assert.equal(attr(nodes.dialog, "data-bc-material-root"), "panel");
});

test("both channels at 0% clear every mark, inline variable and filter flag", () => {
  const dom = new FakeDocument({ active: true });
  const nodes = buildPage(dom);
  const { api, document } = load({ dom });

  api.setPageBlur(true);
  assert.equal(attr(document.documentElement, "data-bc-page-blur"), "true");
  assert.equal(attr(nodes.page, "data-bc-material-blur"), "on");

  api.set(0);
  api.setPage(0);
  assert.equal(attr(document.documentElement, "data-bc-page-blur"), null, "page 0% removes the opt-in flag");
  for (const node of [nodes.page, nodes.pageMenu, nodes.dialog, nodes.dialogList, nodes.composer]) {
    for (const name of ["data-bc-material-root", "data-bc-material-layer", "data-bc-material-level", "data-bc-material-depth", "data-bc-material-blur"]) {
      assert.equal(attr(node, name), null, `${name} must be cleared`);
    }
    assert.equal(cssVar(node, "--bc-material-alpha"), "");
    assert.equal(cssVar(node, "--bc-material-blur"), "");
  }

  api.setPage(30);
  api.set(100);
  assert.equal(attr(nodes.page, "data-bc-material-root"), "page");
  assert.equal(attr(nodes.page, "data-bc-material-blur"), "on", "the experiment is still on");
  assert.equal(attr(nodes.dialog, "data-bc-material-root"), "panel");
  api.setPageBlur(false);
});

test("alpha step applies to depth, only inside a root, and clamps at 0/1", () => {
  const dom = new FakeDocument({ active: true });
  const page = element(dom, "div", { "data-global-panel": "" });
  const pageList = element(dom, "div", { role: "listbox" });
  const pageMenu = element(dom, "div", { role: "menu" });
  page.append(pageList, pageMenu);
  pageList.append(pageMenu);
  const dialog = element(dom, "div", { role: "dialog" });
  const dialogList = element(dom, "div", { role: "listbox" });
  dialog.append(dialogList);
  dom.body.append(page, dialog);
  const { api } = load({ dom });

  assert.equal(attr(pageList, "data-bc-material-depth"), "2");
  assert.equal(cssVar(pageList, "--bc-material-alpha"), "0.38");
  assert.equal(attr(pageMenu, "data-bc-material-depth"), "3", "depth is 2 + candidate ancestors");
  assert.equal(cssVar(pageMenu, "--bc-material-alpha"), "0.46");

  api.setMaterial({ direction: "down" });
  assert.equal(cssVar(pageList, "--bc-material-alpha"), "0.22", "0.30 - 0.08");
  assert.equal(cssVar(pageMenu, "--bc-material-alpha"), "0.14", "0.30 - 0.16");
  assert.equal(cssVar(dialogList, "--bc-material-alpha"), "0.92", "1.00 - 0.08");

  api.setMaterial({ direction: "up", alphaStep: 0 });
  assert.equal(cssVar(pageList, "--bc-material-alpha"), "0.3");
  assert.equal(cssVar(dialogList, "--bc-material-alpha"), "1");
});

test("blur follows the sqrt model: page 30/50/100, blur step 0, max blur 0", () => {
  const dom = new FakeDocument({ active: true });
  const nodes = buildPage(dom);
  const { api } = load({ dom });

  // Default: alpha-only page, panel radius still uses the page-strength scale I.
  assert.equal(attr(nodes.page, "data-bc-material-blur"), null);
  assert.equal(cssVar(nodes.page, "--bc-material-blur"), "");
  assert.equal(cssVar(nodes.dialog, "--bc-material-blur"), "3.69px");
  assert.deepEqual({ ...api.getBlur() }, { page: 0, panel: 3.69 });

  api.setPage(50); // I = 4, T2 = 6, s2 = sqrt(36 - 16) = 4.47
  assert.equal(cssVar(nodes.dialog, "--bc-material-blur"), "4.47px");
  assert.deepEqual({ ...api.getBlur() }, { page: 0, panel: 4.47 });

  api.setPage(100); // I = 8 = M, nothing left for the panel
  assert.equal(attr(nodes.dialog, "data-bc-material-blur"), null);
  assert.equal(cssVar(nodes.dialog, "--bc-material-blur"), "");
  assert.deepEqual({ ...api.getBlur() }, { page: 0, panel: 0 });

  // Opt-in experiment: the page radius becomes actual and follows the same I.
  api.setPage(30);
  api.setPageBlur(true);
  assert.equal(attr(nodes.page, "data-bc-material-blur"), "on");
  assert.equal(cssVar(nodes.page, "--bc-material-blur"), "2.4px");
  assert.deepEqual({ ...api.getBlur() }, { page: 2.4, panel: 3.69 });

  api.setPage(50);
  assert.equal(cssVar(nodes.page, "--bc-material-blur"), "4px");
  assert.equal(cssVar(nodes.dialog, "--bc-material-blur"), "4.47px");
  assert.deepEqual({ ...api.getBlur() }, { page: 4, panel: 4.47 });

  api.setPage(100);
  assert.equal(cssVar(nodes.page, "--bc-material-blur"), "8px");
  assert.equal(attr(nodes.dialog, "data-bc-material-blur"), null);
  assert.deepEqual({ ...api.getBlur() }, { page: 8, panel: 0 });

  api.setPage(30);
  api.setMaterial({ blurStep: 0 });
  assert.equal(cssVar(nodes.page, "--bc-material-blur"), "2.4px");
  assert.equal(attr(nodes.dialog, "data-bc-material-blur"), null);
  assert.equal(cssVar(nodes.dialog, "--bc-material-blur"), "");

  api.setMaterial({ blurStep: 2, maxBlur: 0 });
  assert.equal(attr(nodes.page, "data-bc-material-blur"), null, "blur(0px) must not appear");
  assert.equal(cssVar(nodes.page, "--bc-material-blur"), "");
  assert.equal(attr(nodes.dialog, "data-bc-material-blur"), null);
  assert.deepEqual({ ...api.getBlur() }, { page: 0, panel: 0 });
  assert.equal(cssVar(nodes.page, "--bc-material-alpha"), "0.3", "alpha survives maxBlur 0");

  api.setMaterial({ maxBlur: 8 });
  api.setPageBlur(false);
  assert.equal(attr(nodes.page, "data-bc-material-blur"), null);
  assert.equal(cssVar(nodes.page, "--bc-material-blur"), "");
  assert.deepEqual({ ...api.getBlur() }, { page: 0, panel: 3.69 });
});

test("only visually covering roots get the filter flag", () => {
  const dom = new FakeDocument({ active: true });
  const nodes = buildPage(dom);
  nodes.page.setRect(0, 0);
  nodes.dialog.setRect(0, 0);
  const { api } = load({ dom });

  assert.equal(attr(nodes.page, "data-bc-material-root"), null, "a hidden page anchor is not marked");
  assert.equal(attr(nodes.dialog, "data-bc-material-root"), "panel", "the overlay keeps its material");
  assert.equal(attr(nodes.dialog, "data-bc-material-blur"), null, "but gets no containing block");
  assert.equal(cssVar(nodes.dialog, "--bc-material-blur"), "");
  assert.deepEqual({ ...api.getBlur() }, { page: 0, panel: 2 });
});

test("inactive background clears marks but keeps preferences for the next apply", () => {
  const dom = new FakeDocument({ active: true });
  const nodes = buildPage(dom);
  const { api } = load({ dom });
  assert.equal(attr(nodes.page, "data-bc-material-root"), "page");

  delete dom.documentElement.dataset.bcActive;
  api.refresh();
  assert.equal(attr(nodes.page, "data-bc-material-root"), null);
  assert.equal(attr(nodes.dialog, "data-bc-material-root"), null);
  assert.equal(api.getPage(), 30, "the preference is untouched");
  assert.equal(api.get(), 100);

  dom.documentElement.dataset.bcActive = "true";
  api.refresh();
  assert.equal(attr(nodes.page, "data-bc-material-root"), "page");
});

test("MutationObserver marks added dialogs, clears removed ones and is idempotent", () => {
  const dom = new FakeDocument({ active: true });
  const a = element(dom, "div", { role: "dialog" });
  dom.body.append(a);
  const { api, flush } = load({ dom });
  assert.equal(attr(a, "data-bc-material-root"), "panel");

  const b = element(dom, "div", { role: "menu" });
  dom.body.append(b);
  assert.equal(attr(b, "data-bc-material-root"), null, "nothing happens until the observer flush");
  dom.flushObservers();
  flush();
  assert.equal(attr(b, "data-bc-material-root"), "panel");

  b.remove();
  dom.flushObservers();
  flush();
  assert.equal(attr(a, "data-bc-material-root"), "panel", "unrelated marks stay");

  const stylesOf = (node) => node.style.writes.length;
  const before = [a, dom.documentElement].map(stylesOf);
  api.refresh();
  assert.deepEqual([a, dom.documentElement].map(stylesOf), before, "a no-op rescan must not rewrite inline variables");

  const page = element(dom, "div", { "data-global-panel": "" });
  dom.body.append(page);
  dom.flushObservers();
  flush();
  assert.equal(attr(page, "data-bc-material-root"), "page");
  page.remove();
  dom.flushObservers();
  flush();
  assert.equal(dom.querySelectorAll("[data-bc-material-root]").length, 1, "only the dialog root remains");
});

test("role changes are rescanned and stale marks are removed", () => {
  const dom = new FakeDocument({ active: true });
  const node = element(dom, "div", { role: "dialog" });
  dom.body.append(node);
  const { flush } = load({ dom });
  assert.equal(attr(node, "data-bc-material-root"), "panel");

  node.setAttribute("role", "presentation");
  dom.flushObservers();
  flush();
  assert.equal(attr(node, "data-bc-material-root"), null, "leaving the candidate set clears the root");
  assert.equal(cssVar(node, "--bc-material-alpha"), "");

  node.setAttribute("role", "tooltip");
  dom.flushObservers();
  flush();
  assert.equal(attr(node, "data-bc-material-root"), "panel");
});

test("pending-interaction cards are matched by their inner card, never the frame", () => {
  const dom = new FakeDocument({ active: true });
  const nodes = buildPage(dom);
  load({ dom });
  for (const [frame, card] of [
    [nodes.questionFrame, nodes.questionCard],
    [nodes.planFrame, nodes.planCard],
    [nodes.approvalFrame, nodes.approvalCard],
  ]) {
    assert.equal(attr(frame, "data-bc-material-root"), null, "the frame owns the side padding");
    assert.equal(attr(card, "data-bc-material-root"), "panel");
  }
});

test("events: material-change fires for every channel, readability-change only for panels", () => {
  const { api, events } = load();
  events.length = 0;
  api.set(40);
  assert.deepEqual(events, ["beauticode-material-change", "beauticode-readability-change"]);
  events.length = 0;
  api.setPage(10);
  assert.deepEqual(events, ["beauticode-material-change"]);
  events.length = 0;
  api.setMaterial({ maxBlur: 6 });
  assert.deepEqual(events, ["beauticode-material-change"]);
});

test("cross-window storage sync re-reads only known keys and ignores unrelated ones", () => {
  const { api, store, trigger, events } = load();
  events.length = 0;
  store.set(KEYS.panel, "40");
  trigger("storage", { key: KEYS.panel });
  assert.equal(api.get(), 40);
  assert.deepEqual(events, ["beauticode-material-change", "beauticode-readability-change"]);

  store.set(KEYS.page, "0");
  trigger("storage", { key: KEYS.page });
  assert.equal(api.getPage(), 0);

  store.set(KEYS.pageBlur, "true");
  trigger("storage", { key: KEYS.pageBlur });
  assert.equal(api.getPageBlur(), true);

  events.length = 0;
  trigger("storage", { key: "beauticode-dim" });
  assert.equal(api.get(), 40);
  assert.deepEqual(events, []);

  store.delete(KEYS.panel);
  store.delete(KEYS.page);
  store.delete(KEYS.pageBlur);
  trigger("storage", { key: null });
  assert.equal(api.get(), 100);
  assert.equal(api.getPage(), 30);
  assert.equal(api.getPageBlur(), false);
});

test("storage denial keeps the in-memory selection for this page", () => {
  const { api, document } = load({ denied: true });
  assert.equal(api.get(), 100);
  assert.equal(api.getPage(), 30);
  assert.equal(api.set(false), 0);
  assert.equal(api.setPage(0), 0);
  assert.equal(attr(document.documentElement, "data-bc-readable-surfaces"), "false");
  assert.equal(attr(document.documentElement, "data-bc-page-material"), null);
});

test("a second evaluation does not duplicate the stylesheet or reset preferences", () => {
  const { context, document, api } = load();
  api.set(30);
  api.setPage(10);
  const styles = document.querySelectorAll("style").length;
  vm.runInNewContext(source, context);
  assert.equal(document.querySelectorAll("style").length, styles);
  assert.equal(context.BeauticodeReadableSurfaces, api);
  assert.equal(api.get(), 30);
  assert.equal(api.getPage(), 10);
});

test("stylesheet: the old global alias-token rule is gone, the material-root rules replace it", () => {
  const { document } = load();
  const [style] = document.querySelectorAll("style");
  const css = style.textContent;

  // The ADR removes the everywhere-on :is(role...) plate: no CSS rule may name
  // a role or the plugin page as a painted surface any more.
  assert.doesNotMatch(css, /:is\(/);
  assert.doesNotMatch(css, /\[role=/);
  assert.doesNotMatch(css, /--bc-readable-fill/);
  assert.doesNotMatch(css, /--bc-readable-strength/);

  const pageRoot = css.match(/html\[data-bc-active="true"\] \[data-bc-material-root="page"\]\{([^}]*)\}/);
  assert.ok(pageRoot, "page root rule");
  assert.match(pageRoot[1], /--bc-material-alpha:\.3/);
  assert.doesNotMatch(pageRoot[1], /--dsw-alias-bg/, "the page root must not repaint the surface tokens");

  const panelRoot = css.match(/html\[data-bc-active="true"\] \[data-bc-material-root="panel"\]\{([^}]*)\}/);
  assert.ok(panelRoot, "panel root rule");
  assert.match(panelRoot[1], /--bc-material-alpha:1/);

  assert.match(css, /\[data-bc-material-root\],\s*html\[data-bc-active="true"\] \[data-bc-material-layer\]\{[^}]*--bc-material-fill:color-mix\(in srgb,var\(--bc-material-base,#232833\) calc\(var\(--bc-material-alpha,1\) \* 100%\),transparent\)[^}]*background-color:var\(--bc-material-fill\)/);

  const tokens = css.match(/html\[data-bc-active="true"\] \[data-bc-material-root="panel"\],\s*html\[data-bc-active="true"\] \[data-bc-material-layer\]\{([^}]*)\}/);
  assert.ok(tokens, "panel token rule");
  for (const token of [
    "--dsw-alias-bg-base", "--dsw-alias-bg-layer-1", "--dsw-alias-bg-layer-2",
    "--dsw-alias-bg-layer-3", "--dsw-alias-bg-overlay", "--dsw-specific-input-major",
    "--dsw-specific-menu", "--dsw-alias-tooltip-bg",
  ]) {
    assert.ok(tokens[1].includes(`${token}:var(--bc-material-fill)`), `${token} shares the fill`);
  }

  const blur = css.match(/html\[data-bc-active="true"\] \[data-bc-material-root\]\[data-bc-material-blur="on"\]\{([^}]*)\}/);
  assert.ok(blur, "the blur is scoped to an independent root");
  assert.match(blur[1], /backdrop-filter:blur\(var\(--bc-material-blur,0px\)\)/);
  assert.match(blur[1], /-webkit-backdrop-filter:blur\(var\(--bc-material-blur,0px\)\)/);
  assert.doesNotMatch(blur[1], /data-bc-material-layer/);

  // The page root always clears the generic filter; the experimental backplate
  // is opt-in behind [data-bc-page-blur="true"] and must not leak by default.
  assert.match(css, /html\[data-bc-active="true"\] \[data-bc-material-root="page"\]\[data-bc-material-blur="on"\]\{[^}]*backdrop-filter:none/);
  assert.match(css, /html\[data-bc-active="true"\]\[data-bc-page-blur="true"\] \[data-bc-material-root="page"\]\[data-bc-material-blur="on"\]\{[^}]*position:relative[^}]*isolation:isolate/);
  const optIn = css.match(/html\[data-bc-active="true"\]\[data-bc-page-blur="true"\] \[data-bc-material-root="page"\]\[data-bc-material-blur="on"\]::before\{([^}]*)\}/);
  assert.ok(optIn, "the opt-in page backplate rule");
  assert.match(optIn[1], /content:""/);
  assert.match(optIn[1], /position:absolute/);
  assert.match(optIn[1], /inset:0/);
  assert.match(optIn[1], /z-index:-1/);
  assert.match(optIn[1], /pointer-events:none/);
  assert.match(optIn[1], /backdrop-filter:blur\(var\(--bc-material-blur,0px\)\)/);
  // No unconditional page position/isolation rule may exist.
  assert.doesNotMatch(css, /html\[data-bc-active="true"\] \[data-bc-material-root="page"\]\{[^}]*position/);

  const pageAid = css.match(/html\[data-bc-active="true"\]\[data-bc-page-material="true"\] \[data-plugin-panel\]\{([^}]*)\}/);
  assert.ok(pageAid, "plugin-page aids are gated by the page channel");
  assert.match(pageAid[1], /--dsw-alias-label-tertiary:var\(--dsw-alias-label-secondary\)/);
  assert.match(pageAid[1], /--dsw-alias-label-caption:var\(--dsw-alias-label-secondary\)/);
  assert.match(pageAid[1], /text-shadow:0 1px 2px color-mix\(in srgb, var\(--bc-text-halo\) 45%, transparent\)/);
  assert.doesNotMatch(pageAid[1], /background|--bc-material-fill/, "the page must not be painted as a slab");

  assert.ok(css.includes("--bc-material-base:var(--dsw-static-neutral-bluish-800,#232833)"));
  assert.ok(css.includes("--bc-material-base:var(--dsw-static-neutral-bluish-00,#fff)"));
  assert.ok(css.includes("--bc-text-halo:#000"));
  assert.ok(css.includes("--bc-text-halo:#fff"));
});
