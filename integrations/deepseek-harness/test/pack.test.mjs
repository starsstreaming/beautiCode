import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stageDshPlugin } from "../../../scripts/pack-dsh-plugin.mjs";
import { runCli } from "../cli.js";

const here = path.dirname(fileURLToPath(import.meta.url));

test("staged npm plugin is a self-contained DSH bundle with a vendored engine", async () => {
  const dest = path.join(os.tmpdir(), `bc-dsh-pack-${process.pid}`);
  await stageDshPlugin(dest, { build: false });
  const pkg = JSON.parse(await fs.readFile(path.join(dest, "package.json"), "utf8"));
  assert.equal(pkg.name, "@beauticode/dsh-plugin");
  assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml");
  assert.equal(pkg.bin["beauticode-dsh"], "bin/beauticode-dsh");
  assert.equal(await fs.readFile(path.join(dest, "cordis.patch.yml"), "utf8").then((text) => text.includes("beauticode-bridge")), true);
  const adapter = path.join(dest, "vendor", "adapter-dsh", "index.js");
  const canvas = path.join(dest, "themes", "internal-beyond", "bg-canvas-4k.png");
  await fs.access(adapter);
  await fs.access(canvas);
  const session = await import(pathToFileURL(adapter).href);
  assert.equal(typeof session.DshSession, "function");
  await fs.rm(dest, { recursive: true, force: true });
});

test("npx installer writes a DSH home patch without a web profile", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-dsh-npx-"));
  const dshHome = path.join(root, "dsh");
  const pluginHome = path.join(root, "plugin");
  await runCli(["--dsh-home", dshHome, "--plugin-home", pluginHome]);
  const patch = await fs.readFile(path.join(dshHome, "cordis.patch.yml"), "utf8");
  assert.match(patch, /id: beauticode-bridge/);
  assert.match(patch, /file:/);
  await fs.access(path.join(pluginHome, "index.mjs"));
  await fs.access(path.join(pluginHome, "vendor", "adapter-dsh", "index.js"));
  await runCli(["--remove", "--dsh-home", dshHome, "--plugin-home", pluginHome]);
  await assert.rejects(() => fs.access(pluginHome));
  await fs.rm(root, { recursive: true, force: true });
});
