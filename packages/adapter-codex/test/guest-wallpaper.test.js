import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
const filename = new URL("../src/renderer/guest-wallpaper.js", import.meta.url);
const source = await fs.readFile(filename, "utf8").catch(e => { if (e.code !== "ENOENT")
    throw e; return "(() => null)"; });
const policySource = await fs.readFile(new URL("../src/renderer/guest-policy.js", import.meta.url), "utf8").catch(e => { if (e.code !== "ENOENT")
    throw e; return "(() => () => null)"; });
const tick = () => new Promise(r => setImmediate(r));
function fixture(t, { path = "/library", actual = path, partition = "persist:codex", delay = false, reject = false, timeout = false } = {}) {
    const installed = new Set(), removed = [], events = new Map(), observers = [], timers = new Set();
    let resolveInsert, insertions = 0;
    const w = {
        isConnected: true,
        getAttribute: k => ({ src: "about:blank?toUrl=" + encodeURIComponent(path), partition }[k] ?? null),
        getURL: () => "https://chatgpt.com" + actual,
        closest: s => s === "main" ? {} : null,
        addEventListener: (k, fn) => { const a = events.get(k) || new Set(); a.add(fn); events.set(k, a); },
        removeEventListener: (k, fn) => events.get(k)?.delete(fn),
        insertCSS: () => { insertions++; return new Promise((resolve, rejectFn) => { resolveInsert = () => { const key = "css-" + insertions; installed.add(key); resolve(key); }; if (reject)
            rejectFn(Error("private URL?account=SECRET"));
        else if (!delay)
            resolveInsert(); }); },
        removeInsertedCSS: async (key) => { installed.delete(key); removed.push(key); },
    };
    let nodes = [w], active = false;
    const document = { documentElement: { getAttribute: () => active ? "true" : null }, querySelectorAll: () => nodes };
    const diagnostics = [];
    const context = { document, window: {}, URL, console: { warn: (_prefix, data) => diagnostics.push(data) },
        setTimeout(fn, ms) { const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms); timers.add(timer); return timer; },
        clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
        MutationObserver: class {
            constructor(fn) { this.fn = fn; this.connected = false; observers.push(this); }
            observe() { this.connected = true; }
            disconnect() { this.connected = false; }
        } };
    const policy = vm.runInNewContext(policySource, context)();
    const create = vm.runInNewContext(source, context);
    const controller = create({ policy, timeoutMs: timeout ? 10 : 3000 });
    assert.ok(controller, "guest wallpaper controller must be available");
    t.after(() => controller.dispose());
    return { controller, w, installed, removed, observers, diagnostics, events, context, policy, create, timers,
        setNodes: value => { nodes=value; },
        start: () => { active = true; controller.setActive(true); },
        finish: () => resolveInsert?.(),
        count: () => insertions,
        emit: k => { for (const fn of events.get(k) || [])
            fn({ isMainFrame: true }); },
        remove: () => { w.isConnected = false; nodes = []; controller.sync(); },
    };
}
test("inactive and direct-clear do not inject or bind guest events", async (t) => {
    const f = fixture(t);
    f.controller.setActive(false);
    await tick();
    assert.equal(f.installed.size, 0);
    assert.equal(f.events.size, 0);
    assert.equal(f.observers.filter(o => o.connected).length, 0);
});
test("100 repeated synchronisations keep one style and one host observer", async (t) => {
    const f = fixture(t);
    f.start();
    await tick();
    for (let i = 0; i < 100; i++) {
        f.controller.setActive(true);
        f.controller.sync();
    }
    await tick();
    assert.equal(f.count(), 1);
    assert.equal(f.installed.size, 1);
    assert.equal(f.observers.filter(o => o.connected).length, 1);
    for (const listeners of f.events.values())
        assert.equal(listeners.size, 1);
});
test("clear restores a previously injected document and unbinds all resources", async (t) => {
    const f = fixture(t);
    f.start();
    await tick();
    f.controller.setActive(false);
    await tick();
    assert.equal(f.installed.size, 0);
    assert.equal(f.removed.length, 1);
    assert.equal(f.observers.filter(o => o.connected).length, 0);
    for (const listeners of f.events.values())
        assert.equal(listeners.size, 0);
});
test("late insertion after clear is removed instead of reviving transparency", async (t) => {
    const f = fixture(t, { delay: true });
    f.start();
    f.controller.setActive(false);
    f.finish();
    await tick();
    assert.equal(f.installed.size, 0);
});
test("removed webviews are cleaned from the registered resources", async (t) => {
    const f = fixture(t);
    f.start();
    await tick();
    f.remove();
    await tick();
    assert.equal(f.installed.size, 0);
    for (const listeners of f.events.values())
        assert.equal(listeners.size, 0);
});
test("destroy is idempotent and late completions remain revocable", async (t) => {
    const f = fixture(t, { delay: true });
    f.start();
    f.controller.dispose();
    f.controller.dispose();
    f.finish();
    await tick();
    assert.equal(f.installed.size, 0);
});
for (const path of ["/", "/checkout/web", "/pricing-plan", "/api/auth/session", "/admin", "/plugins/demo/app/tool", "/unknown"]) {
    test("unverified or transactional guest remains native: " + path, async (t) => {
        const f = fixture(t, { path });
        f.start();
        await tick();
        assert.equal(f.count(), 0);
    });
}
test("redirect to another path is not authorised by the intended source", async (t) => {
    const f = fixture(t, { actual: "/checkout/web" });
    f.start();
    await tick();
    assert.equal(f.count(), 0);
});
test("in-page navigation revalidates and removes an old style", async (t) => {
    const f = fixture(t);
    f.start();
    await tick();
    f.w.getURL = () => "https://chatgpt.com/checkout/web";
    f.emit("did-navigate-in-page");
    await tick();
    assert.equal(f.installed.size, 0);
});
test("insertion rejection is observable without leaking URL or account data", async (t) => {
    const f = fixture(t, { reject: true });
    f.start();
    await tick();
    assert.equal(f.installed.size, 0);
    assert.ok(f.diagnostics.length);
    assert.doesNotMatch(JSON.stringify(f.diagnostics), /SECRET|account=/);
});
test("timed-out insertion is still revoked when Electron eventually completes", async (t) => {
    const f = fixture(t, { delay: true, timeout: true });
    f.start();
    await new Promise(r => setTimeout(r, 25));
    f.finish();
    await tick();
    assert.equal(f.installed.size, 0);
    assert.ok(f.diagnostics.length);
});
test("new pending content binds readiness without injecting about:blank", async (t) => {
    const f = fixture(t);
    f.w.getURL = () => "about:blank";
    f.start();
    await tick();
    assert.equal(f.count(), 0);
    assert.ok(f.events.get("dom-ready")?.size, "pending allowed content must be observed");
    f.w.getURL = () => "https://chatgpt.com/library";
    f.emit("dom-ready");
    await tick();
    assert.equal(f.installed.size, 1);
});
test("100 complete payload owners reuse the document controller across handoff", async (t) => {
    const f = fixture(t);
    const ownerSource = await fs.readFile(new URL("../src/renderer/guest-install.js", import.meta.url), "utf8");
    const install = vm.runInNewContext(ownerSource, f.context);
    let owner;
    for (let i = 0; i < 100; i++) {
        owner = install({ createController: f.create, policy: f.policy });
        owner.setActive(true);
    }
    await tick();
    assert.equal(f.count(), 1);
    assert.equal(f.observers.filter(o => o.connected).length, 1);
    owner.dispose();
    await tick();
    assert.equal(f.installed.size, 0);
});
test("sandbox and cross-origin redirects never receive CSS", async (t) => {
    const f = fixture(t);
    f.w.getAttribute = k => k === "src" ? "codex-sandbox://example/" : null;
    f.start();
    await tick();
    assert.equal(f.count(), 0);
    f.controller.setActive(false);
    f.w.getAttribute = k => k === "src" ? "about:blank?toUrl=%2Flibrary" : null;
    f.w.getURL = () => "https://chatgpt.com.evil.example/library";
    f.controller.setActive(true);
    await tick();
    assert.equal(f.count(), 0);
});
test("navigation during insertion converges without requiring another host refresh", async (t) => {
    const f = fixture(t, { delay: true });
    f.start();
    f.emit("did-start-navigation");
    f.emit("dom-ready");
    f.w.insertCSS = async () => { f.installed.add("new-document"); return "new-document"; };
    f.finish();
    await tick();
    await tick();
    assert.deepEqual([...f.installed], ["new-document"]);
});
test("destroy cancels the timeout while retaining late completion cleanup", async (t) => {
    const f = fixture(t, { delay: true });
    f.start();
    assert.equal(f.timers.size, 1);
    f.controller.dispose();
    assert.equal(f.timers.size, 0);
    f.finish();
    await tick();
    assert.equal(f.installed.size, 0);
});
test("CSS removal failure is diagnosed without exposing page information", async (t) => {
    const f = fixture(t);
    f.start();
    await tick();
    f.w.removeInsertedCSS = async () => { throw Error("private account=SECRET"); };
    f.controller.setActive(false);
    await tick();
    assert.ok(f.diagnostics.some(d => d.stage === "remove"));
    assert.doesNotMatch(JSON.stringify(f.diagnostics), /SECRET|account=/);
});
test("new and removed webviews synchronise through host mutations without republishing media", async (t) => {
    const f=fixture(t);f.setNodes([]);f.start();await tick();
    f.setNodes([f.w]);
    const node={nodeType:1,tagName:"WEBVIEW"};
    f.observers[0].fn([{type:"childList",addedNodes:[node],removedNodes:[]}]);
    await tick();assert.equal(f.installed.size,1);
    f.setNodes([]);f.w.isConnected=false;
    f.observers[0].fn([{type:"childList",addedNodes:[],removedNodes:[node]}]);
    await tick();assert.equal(f.installed.size,0);
});
test("late CSS cleanup cannot remove the reactivated document's replacement style", async (t) => {
    const f=fixture(t,{delay:true});f.start();f.controller.setActive(false);
    f.w.insertCSS=async()=>{f.installed.add("replacement");return "replacement";};
    f.controller.setActive(true);await tick();f.finish();await tick();
    assert.deepEqual([...f.installed],["replacement"]);
});
