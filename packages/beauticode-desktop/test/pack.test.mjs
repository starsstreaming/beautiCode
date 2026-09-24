import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HOST_RUNTIME } from "../src/index.mjs";
import { stageDesktopAggregate } from "../../../scripts/pack-desktop-aggregate.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
// 版本断言以源 package.json 为准：升级版本号时不再需要同步改测试
const sourcePkg = JSON.parse(
  await fs.readFile(path.join(here, "..", "package.json"), "utf8"),
);

test("staging produces one self-contained runtime for all five hosts", async () => {
  const dest = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-desktop-pack-"));
  try {
    await stageDesktopAggregate(dest, { build: false });
    const pkg = JSON.parse(await fs.readFile(path.join(dest, "package.json"), "utf8"));
    assert.equal(pkg.name, "beauticode-desktop");
    assert.equal(pkg.version, sourcePkg.version);
    assert.equal(pkg.private, false);
    assert.equal(pkg.bin["beauticode-desktop"], "./bin/beauticode-desktop.mjs");
    for (const [host, config] of Object.entries(HOST_RUNTIME)) {
      for (const relative of config.required) {
        await fs.access(path.join(dest, "runtime", relative));
      }
      assert.ok(host);
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
