import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await fs.readFile(new URL("../readability.js", import.meta.url), "utf8");
const key = "beauticode-readable-surfaces";

function load(initial, denied = false) {
  const store = new Map(initial === undefined ? [] : [[key, initial]]);
  const styles = [];
  const listeners = new Map();
  const context = {
    document: {
      documentElement: { dataset: {} },
      createElement: () => ({ dataset: {} }),
      head: { append: (style) => styles.push(style) },
    },
    localStorage: {
      getItem(name) {
        if (denied) throw new Error("storage unavailable");
        return store.get(name) ?? null;
      },
      setItem(name, value) {
        if (denied) throw new Error("storage unavailable");
        store.set(name, value);
      },
    },
    addEventListener: (name, handler) => listeners.set(name, handler),
  };
  vm.runInNewContext(source, context);
  return { context, store, styles, listeners, api: context.BeauticodeReadableSurfaces };
}

test("functional surfaces are protected on first use and with invalid preferences", () => {
  for (const initial of [undefined, "true", "0", "invalid", "null"]) {
    const { context, api } = load(initial);
    assert.equal(api.get(), true);
    assert.equal(context.document.documentElement.dataset.bcReadableSurfaces, "true");
  }
});

test("a boolean opt-out persists and restores independently of background settings", () => {
  const { api, store, context } = load();
  assert.equal(api.set(false), false);
  assert.equal(store.get(key), "false");
  assert.equal(context.document.documentElement.dataset.bcReadableSurfaces, "false");
  assert.equal(load(store.get(key)).api.get(), false);
  for (const value of ["true", 1, null, {}]) assert.equal(api.set(value), false);
  assert.equal(api.set(true), true);
  assert.equal(store.get(key), "true");
});

test("storage failure preserves the user's selection for the current page", () => {
  const { api, context } = load(undefined, true);
  assert.equal(api.get(), true);
  assert.equal(api.set(false), false);
  assert.equal(context.document.documentElement.dataset.bcReadableSurfaces, "false");
});

test("preference changes in another page synchronize and clearing restores protection", () => {
  const { api, store, listeners } = load();
  store.set(key, "false");
  listeners.get("storage")({ key: "beauticode-dim" });
  assert.equal(api.get(), true);
  listeners.get("storage")({ key });
  assert.equal(api.get(), false);
  store.clear();
  listeners.get("storage")({ key: null });
  assert.equal(api.get(), true);
});

test("reloading the client does not duplicate styles or reset an opt-out", () => {
  const { context, api, styles } = load();
  api.set(false);
  vm.runInNewContext(source, context);
  assert.equal(styles.length, 1);
  assert.equal(context.BeauticodeReadableSurfaces, api);
  assert.equal(api.get(), false);
});

test("pending-interaction panels are protected by their frame's semantic key", () => {
  const { styles } = load();
  const [style] = styles;
  // The selector must name each panel's inner card, never the wrapper: the
  // wrapper owns the frame's side padding and must stay transparent.
  for (const [frame, card] of [
    ["data-question-key", "[data-question-key] > section"],
    ["data-plan-review-key", "[data-plan-review-key] > section"],
    ["data-approval-key", "[data-approval-key] > div"],
  ]) {
    assert.ok(style.textContent.includes(card), `missing protection for ${frame}`);
    assert.ok(!style.textContent.includes(`:is([${frame}])`), `${frame} frame itself must not be painted`);
  }
  // These panels carry no dialog role, which is why role protection missed them.
  assert.ok(style.textContent.includes("--dsw-specific-input-major:var(--bc-readable-fill)"),
    "panels must repaint the same token the composer uses");
});
