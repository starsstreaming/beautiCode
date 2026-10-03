import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

// This fixture exercises media-client startup only. The settings console has
// its own DOM fixture and tests for explicit fullscreen actions.
for (const method of ["requestFullscreen", "webkitRequestFullscreen"]) {
  test(`browser client preserves window mode through ordinary gestures (${method})`, async () => {
    const source = await fs.readFile(new URL("../client.js", import.meta.url), "utf8");
    const listeners = new Map();
    let requested = 0;
    const documentElement = {
      dataset: {},
      style: { setProperty() {}, removeProperty() {}, removeAttribute() {} },
      removeAttribute() {},
      [method]() {
        requested += 1;
        return Promise.resolve();
      },
    };
    const document = {
      body: { hasAttribute: () => false, prepend() {} },
      documentElement,
      fullscreenElement: null,
      webkitFullscreenElement: null,
      head: { append() {} },
      createElement: () => ({ dataset: {}, style: {} }),
      getElementById: () => null,
      querySelector: () => null,
      addEventListener(name, handler) {
        const handlers = listeners.get(name) ?? new Set();
        handlers.add(handler);
        listeners.set(name, handlers);
      },
      removeEventListener(name, handler) {
        listeners.get(name)?.delete(handler);
      },
      dispatch(event) {
        for (const handler of listeners.get(event.type) ?? []) handler(event);
      },
    };
    const context = {
      crypto: { randomUUID: () => "client-fullscreen-test" },
      Promise,
      document,
      fetch: async () => ({ ok: true }),
      HTMLMediaElement: { HAVE_CURRENT_DATA: 2 },
      HTMLVideoElement: class {},
      Image: class {},
      matchMedia: () => ({ matches: false, addEventListener() {} }),
      MutationObserver: class { observe() {} },
      EventSource: class {},
      queueMicrotask: (callback) => callback(),
      setInterval: () => 0,
    };
    context.window = context;
    context.globalThis = context;
    vm.runInNewContext(source, context);

    assert.equal(requested, 0, "loading the plugin preserves the host window mode");
    for (const tagName of ["BUTTON", "DIV", "TEXTAREA"]) {
      document.dispatch({ type: "pointerdown", button: 0, target: { tagName } });
      await Promise.resolve();
      assert.equal(requested, 0, `clicking ${tagName} does not request fullscreen`);
    }
    document.dispatch({ type: "keydown", key: "Enter", target: { tagName: "TEXTAREA" } });
    assert.equal(requested, 0, "typing in the composer preserves the host window mode");
  });
}
