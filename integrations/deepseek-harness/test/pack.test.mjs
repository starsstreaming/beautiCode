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
  assert.equal(pkg.name, "beauticode-dsh");
  assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml");
  assert.equal(pkg.bin["beauticode-dsh"], "bin/beauticode-dsh");
  assert.equal(await fs.readFile(path.join(dest, "cordis.patch.yml"), "utf8").then((text) => text.includes("beauticode-bridge")), true);
  const adapter = path.join(dest, "vendor", "adapter-dsh", "index.js");
  const canvas = path.join(dest, "themes", "internal-beyond", "bg-canvas-4k.png");
  const license = path.join(dest, "LICENSE");
  await fs.access(adapter);
  await fs.access(canvas);
  assert.match(await fs.readFile(license, "utf8"), /MIT License/);
  const session = await import(pathToFileURL(adapter).href);
  assert.equal(typeof session.DshSession, "function");
  await fs.rm(dest, { recursive: true, force: true });
});

test("staged DSH root export resolves its vendored core without a workspace", async () => {
  const dest = path.join(os.tmpdir(), `bc-dsh-root-export-${process.pid}`);
  try {
    await stageDshPlugin(dest, { build: false });
    const plugin = await import(pathToFileURL(path.join(dest, "index.mjs")).href);
    assert.equal(plugin.name, "beauticode-bridge");
    assert.equal(plugin.bridgeProtocol, 4);
    for (const name of ["gallery-host.mjs", "control-client.mjs"]) {
      assert.doesNotMatch(await fs.readFile(path.join(dest, name), "utf8"), /@beauticode\/core/);
    }
  } finally {
    await fs.rm(dest, { recursive: true, force: true });
  }
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

test("installer backs up and deduplicates its own duplicate loader entries", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bc-dsh-dedupe-"));
  try {
    const dshHome = path.join(root, "dsh");
    const web = path.join(dshHome, "profiles", "web");
    const pluginHome = path.join(root, "plugin");
    await fs.mkdir(web, { recursive: true });
    await fs.writeFile(path.join(web, "package.json"), JSON.stringify({ dependencies: {} }), "utf8");
    await fs.writeFile(path.join(web, "cordis.patch.yml"), [
      "- insert:",
      "    - id: unrelated-plugin",
      "      name: unrelated",
      "    - id: beauticode-bridge",
      "      name: old-a",
      "      inject: [webServer]",
      "- insert:",
      "    - id: beauticode-bridge",
      "      name: old-b",
      "      inject: [webServer]",
      "",
    ].join("\n"), "utf8");
    await runCli(["--dsh-home", dshHome, "--plugin-home", pluginHome]);
    const patch = await fs.readFile(path.join(web, "cordis.patch.yml"), "utf8");
    // The plugin package carries the canonical loader. The profile must not
    // retain a second managed loader, but unrelated profile entries survive.
    assert.equal((patch.match(/id:\s*beauticode-bridge/g) || []).length, 0);
    assert.match(patch, /id:\s*unrelated-plugin/);
    const pluginPatch = await fs.readFile(path.join(pluginHome, "cordis.patch.yml"), "utf8");
    assert.equal((pluginPatch.match(/id:\s*beauticode-bridge/g) || []).length, 1);
    const backups = (await fs.readdir(web)).filter((name) => name.includes("beauticode-backup"));
    assert.equal(backups.length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
