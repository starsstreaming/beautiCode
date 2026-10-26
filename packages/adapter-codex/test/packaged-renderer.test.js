import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import test from "node:test";
import { stageCodexPlugin } from "../../../scripts/pack-codex-plugin.mjs";
test("staged Codex payload loads and compiles every private renderer module", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-renderer-package-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await stageCodexPlugin(root, { build: false });
    const { loadRendererSource, buildInjectionExpression } = await import(pathToFileURL(path.join(root, "vendor/adapter-codex/payload.js")).href);
    const source = await loadRendererSource();
    assert.doesNotThrow(() => new vm.Script(buildInjectionExpression(source.runtimeIife, {
        generation: 1, media: "clear", imageDataUrl: null, video: null,
    }, source.cssText)));
    assert.equal(source.consoleSource.includes("beauticode-dim"), true);
    assert.doesNotMatch(source.cssText, /border-radius:\s*0\s*!important/);
});
