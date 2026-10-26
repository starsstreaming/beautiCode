import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
const waiterSource = await fs.readFile(new URL("../src/renderer/runtime-media-wait.js", import.meta.url), "utf8");
const source = await fs.readFile(new URL("../src/renderer/runtime-image.js", import.meta.url), "utf8");
test("disposing a pending image attach cancels readiness and cannot update the next generation", async () => {
    let current = true, changes = 0, revoked = 0;
    const timers = new Set(), listeners = new Map(), attributes = new Map();
    const img = {
        complete: false, naturalWidth: 0,
        addEventListener(name, fn) { const a = listeners.get(name) || new Set(); a.add(fn); listeners.set(name, a); },
        removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
        getAttribute: name => attributes.get(name),
        set src(value) { attributes.set("src", value); },
    };
    const context = {
        document: { getElementById: () => ({ files: [{}] }) },
        URL: { createObjectURL: () => "blob:synthetic" },
        setTimeout(fn) { timers.add(fn); return fn; },
        clearTimeout(fn) { timers.delete(fn); },
    };
    context.createMediaWaiter = vm.runInNewContext(waiterSource, context);
    const create = vm.runInNewContext(source, context);
    const image = create({ isCurrent: () => current, ensureStage: () => ({ querySelector: () => img }),
        setAttrs: () => changes++, dataImageUrl: null, remoteImageUrl: null,
        sources: { revoke() { revoked++; }, fetchAsObjectUrl() { throw Error("unexpected remote media"); } } });
    const attaching = image.attach();
    current = false;
    image.dispose();
    // Simulate a late native load/timeout even after resources are cancelled.
    for (const fn of [...listeners.get("load") || []])
        fn();
    for (const fn of [...timers])
        fn();
    assert.equal(await attaching, false);
    assert.equal(changes, 0);
    assert.equal(timers.size, 0);
    assert.equal(revoked, 1);
    for (const a of listeners.values())
        assert.equal(a.size, 0);
});
