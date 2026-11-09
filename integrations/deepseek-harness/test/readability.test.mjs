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
  const vars = new Map();
  const documentElement = {
    dataset: {},
    style: {
      setProperty: (name, value) => vars.set(name, value),
      removeProperty: (name) => vars.delete(name),
    },
  };
  const context = {
    document: {
      documentElement,
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
  return { context, store, styles, listeners, vars, api: context.BeauticodeReadableSurfaces };
}

test("full protection is the default and survives invalid preferences", () => {
  for (const initial of [undefined, "true", "invalid", "101", "null", ""]) {
    const { context, api, vars } = load(initial);
    assert.equal(api.get(), 100);
    assert.equal(context.document.documentElement.dataset.bcReadableSurfaces, "true");
    assert.equal(vars.get("--bc-readable-strength"), "100");
  }
});

test("the legacy boolean opt-out reads as 0% and the numeric strength persists", () => {
  for (const initial of ["false", "0"]) {
    const { api, vars } = load(initial);
    assert.equal(api.get(), 0);
    assert.equal(vars.has("--bc-readable-strength"), false);
  }

  const { api, store, context, vars } = load();
  assert.equal(api.set(false), 0);
  assert.equal(store.get(key), "false", "0 keeps the old spelling for rollback");
  assert.equal(context.document.documentElement.dataset.bcReadableSurfaces, "false");
  assert.equal(vars.has("--bc-readable-strength"), false);
  assert.equal(load(store.get(key)).api.get(), 0);

  assert.equal(api.set(35), 35);
  assert.equal(store.get(key), "35");
  assert.equal(context.document.documentElement.dataset.bcReadableSurfaces, "true");
  assert.equal(vars.get("--bc-readable-strength"), "35");
  assert.equal(load(store.get(key)).api.get(), 35);

  // Boolean True is the old "on" state and means the original opaque plate.
  assert.equal(api.set(true), 100);
  assert.equal(store.get(key), "100");
  assert.equal(vars.get("--bc-readable-strength"), "100");
});

test("numeric values are clamped and invalid input keeps the current strength", () => {
  const { api, store, context, vars } = load();
  assert.equal(api.set(101), 100);
  assert.equal(api.set(-5), 0);
  assert.equal(context.document.documentElement.dataset.bcReadableSurfaces, "false");
  assert.equal(vars.has("--bc-readable-strength"), false);

  assert.equal(api.set(40.6), 41);
  assert.equal(store.get(key), "41");
  for (const value of [null, "", {}, "abc", NaN]) assert.equal(api.set(value), 41);
  assert.equal(api.set("55"), 55, "numeric strings are accepted");
});

test("storage failure preserves the user's selection for the current page", () => {
  const { api, context } = load(undefined, true);
  assert.equal(api.get(), 100);
  assert.equal(api.set(false), 0);
  assert.equal(context.document.documentElement.dataset.bcReadableSurfaces, "false");
});

test("preference changes in another page synchronize and clearing restores full protection", () => {
  const { api, store, listeners } = load();
  store.set(key, "false");
  listeners.get("storage")({ key: "beauticode-dim" });
  assert.equal(api.get(), 100);
  listeners.get("storage")({ key });
  assert.equal(api.get(), 0);
  store.set(key, "40");
  listeners.get("storage")({ key });
  assert.equal(api.get(), 40);
  store.delete(key);
  listeners.get("storage")({ key: null });
  assert.equal(api.get(), 100);
});

test("reloading the client does not duplicate styles or reset the strength", () => {
  const { context, api, styles } = load();
  api.set(30);
  vm.runInNewContext(source, context);
  assert.equal(styles.length, 1);
  assert.equal(context.BeauticodeReadableSurfaces, api);
  assert.equal(api.get(), 30);
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

test("the plate's alpha is driven by the strength token, never a literal", () => {
  const { styles } = load();
  const [style] = styles;
  assert.match(
    style.textContent,
    /--bc-readable-fill:color-mix\(in srgb,var\(--dsw-static-neutral-bluish-800,#232833\) calc\(var\(--bc-readable-strength,100\) \* 1%\),transparent\)/,
    "dark plate is the palette color at the strength alpha",
  );
  assert.match(
    style.textContent,
    /--bc-readable-fill:color-mix\(in srgb,var\(--dsw-static-neutral-bluish-00,#fff\) calc\(var\(--bc-readable-strength,100\) \* 1%\),transparent\)/,
    "light plate uses the light palette color and the same alpha",
  );
});

test("the plugin page keeps the wallpaper and ships only non-covering legibility aids", () => {
  const { styles } = load();
  const [style] = styles;
  // The plugin page is a page, not a panel: it must stay on the translucent
  // surfaces client.js publishes, so no plate selector may reappear in the
  // opaque surface list (that is what made issue #92 a black slab).
  const opaque = style.textContent.match(/:is\(([\s\S]*?)\)\{/);
  assert.ok(opaque, "the opaque surface rule must exist");
  assert.ok(!opaque[1].includes("[data-plugin-panel]"),
    "the plugin page must not be painted opaque");
  assert.ok(!style.textContent.includes("[data-plugin-panel] :is([data-plugin-package],[data-plugin-item]):hover"),
    "the plugin page must not re-declare hover on top of the host's translucent hover");
  // Legibility aids that do not cover the wallpaper: a tone-aware halo and one
  // caption tier.
  assert.ok(style.textContent.includes("--bc-text-halo:#000"), "dark tone halo color");
  assert.ok(style.textContent.includes("--bc-text-halo:#fff"), "light tone halo color");
  assert.ok(/\[data-plugin-panel\]\{[\s\S]*?text-shadow:0 1px 2px color-mix\(in srgb, var\(--bc-text-halo\) 45%, transparent\);/
    .test(style.textContent), "the plugin page must paint the text halo");
  assert.ok(style.textContent.includes("--dsw-alias-label-tertiary:var(--dsw-alias-label-secondary)"),
    "descriptions must be lifted one tier");
  assert.ok(style.textContent.includes("--dsw-alias-label-caption:var(--dsw-alias-label-secondary)"),
    "counts and captions must be lifted one tier");
});
