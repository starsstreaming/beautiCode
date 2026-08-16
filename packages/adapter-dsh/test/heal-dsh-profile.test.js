import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const healScript = path.resolve(here, "../../../scripts/heal-dsh-profile.mjs");
const heal = await import(pathToFileURL(healScript).href);

function writePackage(dir, name) {
  return fs.mkdir(dir, { recursive: true }).then(() =>
    fs.writeFile(
      path.join(dir, "package.json"),
      `${JSON.stringify({ name, version: "1.0.0", main: "index.js" })}\n`,
    ),
  ).then(() => fs.writeFile(path.join(dir, "index.js"), "export default true;\n"));
}

async function makeInstall(root) {
  const modules = path.join(root, "node_modules");
  const dshDir = path.join(modules, "@deepseek-ai", "dsh");
  await writePackage(dshDir, "@deepseek-ai/dsh");
  await writePackage(path.join(modules, "@deepseek-ai", "cordis-plugin-timer"), "@deepseek-ai/cordis-plugin-timer");
  await writePackage(path.join(modules, "@deepseek-ai", "dsh-base"), "@deepseek-ai/dsh-base");
  await writePackage(path.join(modules, "@deepseek-ai", "dsh-web-app"), "@deepseek-ai/dsh-web-app");
  await writePackage(path.join(modules, "left-pad-like"), "left-pad-like");
  return {
    installAnchor: path.join(dshDir, "package.json"),
    modules,
  };
}

test("samePath treats Windows path variants as equal", () => {
  assert.equal(heal.samePath("C:\\Foo\\Bar", "c:/foo/bar"), true);
  assert.equal(heal.samePath("C:\\Foo\\Bar\\", "C:\\Foo\\Bar"), true);
  assert.equal(heal.samePath("C:\\Foo\\Bar", "C:\\Foo\\Baz"), false);
});

test("heal links the install tree and verifies web-profile resolution", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-heal-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const install = await makeInstall(path.join(root, "install"));
  const dshHome = path.join(root, "home");

  const result = heal.healDshProfile({
    dshHome,
    installAnchor: install.installAnchor,
  });
  assert.ok(result.linked >= 4);
  assert.equal(result.removedShadow, false);
  assert.match(result.resolved["@deepseek-ai/cordis-plugin-timer"], /cordis-plugin-timer/);

  const timerLink = path.join(dshHome, "profiles", "node_modules", "@deepseek-ai", "cordis-plugin-timer");
  const stat = await fs.lstat(timerLink);
  assert.equal(stat.isSymbolicLink(), true);
});

test("heal removes a shadowing web/node_modules that would hide parent junctions", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-heal-shadow-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const install = await makeInstall(path.join(root, "install"));
  const dshHome = path.join(root, "home");
  const shadow = path.join(dshHome, "profiles", "web", "node_modules", "@deepseek-ai");
  await fs.mkdir(shadow, { recursive: true });

  const result = heal.healDshProfile({
    dshHome,
    installAnchor: install.installAnchor,
  });
  assert.equal(result.removedShadow, true);
  await assert.rejects(() => fs.access(path.join(dshHome, "profiles", "web", "node_modules")));
  assert.match(result.resolved["@deepseek-ai/dsh-base"], /dsh-base/);
});

test("heal replaces a blocking real directory with a junction", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-heal-block-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const install = await makeInstall(path.join(root, "install"));
  const dshHome = path.join(root, "home");
  const blocking = path.join(dshHome, "profiles", "node_modules", "@deepseek-ai", "dsh-base");
  await fs.mkdir(blocking, { recursive: true });
  await fs.writeFile(path.join(blocking, "stale.txt"), "nope");

  heal.healDshProfile({
    dshHome,
    installAnchor: install.installAnchor,
  });
  const stat = await fs.lstat(blocking);
  assert.equal(stat.isSymbolicLink(), true);
});

test("heal does not delete the install when dest node_modules is a junction", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-heal-passthrough-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const install = await makeInstall(path.join(root, "install"));
  const dshHome = path.join(root, "home");
  await fs.mkdir(path.join(dshHome, "profiles"), { recursive: true });
  await fs.symlink(install.modules, path.join(dshHome, "profiles", "node_modules"), "junction");

  const result = heal.healDshProfile({
    dshHome,
    installAnchor: install.installAnchor,
  });
  assert.ok(result.resolved["@deepseek-ai/dsh"]);
  await fs.access(path.join(install.modules, "@deepseek-ai", "dsh", "package.json"));
});

test("heal does not delete the install when dest @deepseek-ai is a junction", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-heal-scope-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const install = await makeInstall(path.join(root, "install"));
  const dshHome = path.join(root, "home");
  const destScope = path.join(dshHome, "profiles", "node_modules", "@deepseek-ai");
  await fs.mkdir(path.dirname(destScope), { recursive: true });
  await fs.symlink(path.join(install.modules, "@deepseek-ai"), destScope, "junction");

  heal.healDshProfile({
    dshHome,
    installAnchor: install.installAnchor,
  });
  await fs.access(path.join(install.modules, "@deepseek-ai", "dsh", "package.json"));
  await fs.access(path.join(dshHome, "profiles", "node_modules", "@deepseek-ai", "dsh", "package.json"));
});

test("heal replaces a dead junction that still names the install path", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-heal-dead-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const install = await makeInstall(path.join(root, "install"));
  const dshHome = path.join(root, "home");
  const dest = path.join(dshHome, "profiles", "node_modules", "@deepseek-ai", "dsh");
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const vanished = path.join(root, "vanished-dsh");
  await writePackage(vanished, "@deepseek-ai/dsh");
  await fs.symlink(vanished, dest, "junction");
  await fs.rm(vanished, { recursive: true, force: true });

  heal.healDshProfile({
    dshHome,
    installAnchor: install.installAnchor,
  });
  const stat = await fs.lstat(dest);
  assert.equal(stat.isSymbolicLink(), true);
  await fs.access(path.join(dest, "package.json"));
});

test("heal-dsh-profile CLI prints JSON on success", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-heal-cli-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const install = await makeInstall(path.join(root, "install"));
  const result = spawnSync(
    process.execPath,
    [
      healScript,
      "--dsh-home",
      path.join(root, "home"),
      "--install-anchor",
      install.installAnchor,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.linked > 0);
  assert.ok(parsed.resolved["@deepseek-ai/dsh"]);
});
