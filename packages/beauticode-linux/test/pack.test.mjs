import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stageLinuxPackage, stageDesktopAggregate } from "../../../scripts/pack-desktop-aggregate.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const REQUIRED = [
  "bin/beauticode-linux.mjs",
  "bin/postinstall.mjs",
  "src/index.mjs",
  "README.md",
  "runtime/codex/cli.js",
  "runtime/codex/vendor/adapter-codex/native-picker.js",
  "runtime/codex/vendor/core/linux-process.js",
  "runtime/desktop/scripts/desktop-cdp-runner.mjs",
  "runtime/desktop/packages/adapter-cursor/dist/spec.js",
  "runtime/workbuddy/scripts/wb-cdp-runner.mjs",
  "runtime/workbuddy/packages/adapter-workbuddy/dist/launch.js",
];

test("beauticode-linux stages as its own Linux-only x64 package", async () => {
  const dest = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-linux-pack-"));
  try {
    await stageLinuxPackage(dest, { build: false });
    const pkg = JSON.parse(await fs.readFile(path.join(dest, "package.json"), "utf8"));
    const source = JSON.parse(await fs.readFile(path.join(here, "..", "package.json"), "utf8"));
    assert.equal(pkg.name, "beauticode-linux");
    assert.equal(pkg.version, source.version);
    assert.equal(pkg.private, false);
    assert.deepEqual(pkg.os, ["linux"]);
    assert.deepEqual(pkg.cpu, ["x64"]);
    assert.equal(pkg.engines.node, ">=22");
    assert.deepEqual(pkg.bin, { "beauticode-linux": "./bin/beauticode-linux.mjs" });
    assert.equal(pkg.scripts.test, undefined);
    for (const relative of REQUIRED) await fs.access(path.join(dest, relative));
    await assert.rejects(fs.access(path.join(dest, "bin", "beauticode-desktop.mjs")), { code: "ENOENT" });
    assert.match(await fs.readFile(path.join(dest, "README.md"), "utf8"), /^# beauticode-linux/);
  } finally { await fs.rm(dest, { recursive: true, force: true }); }
});

test("beauticode-desktop staging stays Windows-only", async () => {
  const dest = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-desktop-os-"));
  try {
    await stageDesktopAggregate(dest, { build: false });
    const pkg = JSON.parse(await fs.readFile(path.join(dest, "package.json"), "utf8"));
    assert.equal(pkg.name, "beauticode-desktop");
    assert.deepEqual(pkg.os, ["win32"]);
    assert.equal(pkg.cpu, undefined);
  } finally { await fs.rm(dest, { recursive: true, force: true }); }
});

test("beauticode-linux --help names its own command", { skip: process.platform !== "linux" }, () => {
  const bin = path.join(here, "..", "bin", "beauticode-linux.mjs");
  const result = spawnSync(process.execPath, [bin, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /用法：beauticode-linux /);
  assert.doesNotMatch(result.stdout, /beauticode-desktop/);
  assert.match(result.stdout, /Linux：/);
});
