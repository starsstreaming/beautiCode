import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HOST_RUNTIME } from "../src/index.mjs";
import { stageDesktopAggregate } from "../../../scripts/pack-desktop-aggregate.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

test("packed Codex and WorkBuddy runtimes include new recovery modules", async () => {
  const dest = await fs.mkdtemp(path.join(os.tmpdir(), "bc-recovery-pack-"));
  try {
    await stageDesktopAggregate(dest, { build: false });
    for (const relative of [
      "codex/task-wiring.mjs", "codex/health.mjs",
      "desktop/packages/beauticode-desktop/src/windows-host-install.mjs",
      "desktop/scripts/desktop-runner-identity.mjs",
      "workbuddy/scripts/wb-startup-media.mjs",
      "workbuddy/scripts/wb-runner-log.mjs",
      "workbuddy/scripts/wb-theme-name-diagnostic.mjs",
      "workbuddy/packages/adapter-workbuddy/dist/background-stage.js",
    ]) await fs.access(path.join(dest, "runtime", relative));
  } finally { await fs.rm(dest, { recursive: true, force: true }); }
});

test("staging produces one self-contained runtime for all five hosts", async () => {
  const dest = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-desktop-pack-"));
  try {
    await stageDesktopAggregate(dest, { build: false });
    const pkg = JSON.parse(await fs.readFile(path.join(dest, "package.json"), "utf8"));
    assert.equal(pkg.name, "beauticode-desktop");
    assert.equal(pkg.version, "0.1.0-test.12");
    assert.equal(pkg.private, false);
    assert.equal(pkg.bin["beauticode-desktop"], "./bin/beauticode-desktop.mjs");
    for (const [host, config] of Object.entries(HOST_RUNTIME)) {
      for (const relative of config.required) {
        await fs.access(path.join(dest, "runtime", relative));
      }
      assert.ok(host);
    }
    for (const hostRoot of ["dsh/themes/internal-beyond", "workbuddy/assets/themes/internal-beyond"]) {
      const themeDir = path.join(dest, "runtime", hostRoot);
      const webp = await fs.readFile(path.join(themeDir, "bg-canvas-4k.webp"));
      assert.equal(webp.toString("ascii", 0, 4), "RIFF");
      assert.equal(webp.toString("ascii", 8, 12), "WEBP");
      await assert.rejects(fs.access(path.join(themeDir, "bg-canvas-4k.png")), { code: "ENOENT" });
    }

    const sourceFiles = [];
    async function visit(dir) {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) await visit(file);
        else if (/\.(?:js|mjs|json)$/.test(entry.name)) sourceFiles.push(file);
      }
    }
    await visit(path.join(dest, "runtime"));
    for (const file of sourceFiles) {
      const text = await fs.readFile(file, "utf8");
      assert.doesNotMatch(text, /(?:from|import\s*\()\s*["']@beauticode\//, file);
      assert.doesNotMatch(text, /Users[\\/]/i, file);
    }
  } finally {
    await fs.rm(dest, { recursive: true, force: true });
  }
});

test("staged host runtime entrypoints import without workspace resolution", async () => {
  const dest = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-desktop-import-"));
  try {
    await stageDesktopAggregate(dest, { build: false });
    for (const relative of [
      "runtime/dsh/index.mjs",
      "runtime/codex/cli.js",
      "runtime/workbuddy/packages/adapter-workbuddy/dist/index.js",
      "runtime/desktop/packages/adapter-desktop-cdp/dist/index.js",
      "runtime/desktop/packages/adapter-cursor/dist/index.js",
      "runtime/desktop/packages/adapter-doubao/dist/index.js",
    ]) {
      await import(pathToFileURL(path.join(dest, relative)).href);
    }
  } finally {
    await fs.rm(dest, { recursive: true, force: true });
  }
});
