import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import {
  MIN_NODE_MAJOR,
  discardStableRuntime,
  hostRuntimeRoot,
  renderCodexStarter,
  renderRuntimeLauncherPs1,
  renderWindowsStartupVbs,
  resolveNodeExecutable,
  syncStableRuntime,
} from "../../../scripts/portable-runtime.mjs";

const execFileAsync = promisify(execFile);

test("startup command renders only the stable runtime launcher", () => {
  const stableRoot = "C:/Users/test/AppData/Local/beautiCode/runtime";
  const launcher = path.join(stableRoot, "cursor", "launcher.mjs");
  const vbs = renderWindowsStartupVbs({ node: "C:/Program Files/nodejs/node.exe", launcher, args: ["--host", "cursor", "--watchdog"] });
  assert.match(vbs, /launcher\.mjs/);
  assert.doesNotMatch(vbs, /npx|node_modules|packages[\\/].*desktop-cdp-runner/);
  assert.equal(vbs.includes(process.execPath), false);
});

test("Codex starter also points at stable launcher and not process.execPath", () => {
  const stableRoot = "C:/Users/test/AppData/Local/beautiCode/codex-plugin";
  const starter = renderCodexStarter({ node: "C:/Program Files/nodejs/node.exe", launcher: path.join(stableRoot, "launcher.mjs") });
  assert.match(starter, /launcher\.mjs/);
  assert.match(starter, /exit \$LASTEXITCODE/);
  assert.doesNotMatch(starter, /node_modules|npx|process\.execPath/);
  assert.equal(starter.includes(process.execPath), false);
});

test("stable launcher can discover an absolute Node from PATH at login", () => {
  const launcher = renderRuntimeLauncherPs1({ host: "cursor" });
  assert.match(launcher, /where\.exe node\.exe/);
  assert.match(launcher, /IsPathRooted/);
  assert.match(launcher, /workbuddy\.\*sandbox/);
});

test("runtime sync survives package directory removal and leaves a pointer", async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-runtime-sync-"));
  try {
    const source = path.join(profile, "npx-cache", "package");
    const stable = path.join(profile, "AppData", "Local", "beautiCode", "runtime");
    await fs.mkdir(path.join(source, "vendor"), { recursive: true });
    await fs.writeFile(path.join(source, "runner.mjs"), "export const source = true;\n");
    await fs.writeFile(path.join(source, "vendor", "adapter.js"), "export const adapter = true;\n");
    const result = await syncStableRuntime({ sourceRoot: source, stableRoot: stable, host: "cursor" });
    await fs.rm(source, { recursive: true, force: true });
    assert.equal(await fs.readFile(path.join(result.activeRoot, "runner.mjs"), "utf8"), "export const source = true;\n");
    assert.equal((await fs.readFile(path.join(result.activeRoot, "vendor", "adapter.js"), "utf8")).includes("adapter"), true);
    assert.equal((await fs.stat(result.pointerPath)).isFile(), true);
    assert.equal((await fs.stat(path.join(hostRuntimeRoot(stable, "cursor"), "launcher.ps1"))).isFile(), true);
  } finally {
    await fs.rm(profile, { recursive: true, force: true });
  }
});

test("node resolver rejects old or sandbox-only candidates and copies a verified sandbox node", async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-node-resolve-"));
  try {
    const sandbox = path.join(profile, "WorkBuddy", "sandbox", "node.exe");
    const stable = path.join(profile, "stable-runtime");
    await fs.mkdir(path.dirname(sandbox), { recursive: true });
    await fs.copyFile(process.execPath, sandbox);
    const resolved = await resolveNodeExecutable({
      stableRoot: stable,
      candidates: [sandbox],
      probeVersion: () => ({ major: MIN_NODE_MAJOR, version: `${MIN_NODE_MAJOR}.1.0` }),
      copyFile: async (from, to) => fs.copyFile(from, to),
      writeFile: async (file, data) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, data); },
    });
    assert.equal(resolved.source, "sandbox-copy");
    assert.equal(resolved.major, MIN_NODE_MAJOR);
    assert.equal((await fs.stat(resolved.path)).isFile(), true);
    assert.match(await fs.readFile(resolved.sourceRecord, "utf8"), /sandbox/);
  } finally {
    await fs.rm(profile, { recursive: true, force: true });
  }
});

test("node resolver skips a retired Node source and selects the current absolute Node", async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-node-upgrade-"));
  try {
    const oldNode = path.join(profile, "node-v20.exe");
    const currentNode = path.join(profile, "node-v22.exe");
    await fs.writeFile(oldNode, "old");
    await fs.writeFile(currentNode, "current");
    const versions = new Map([[oldNode, { major: 20, version: "20.19.0" }], [currentNode, { major: 22, version: "22.14.0" }]]);
    const result = await resolveNodeExecutable({
      stableRoot: path.join(profile, "stable"),
      candidates: [oldNode, currentNode],
      probeVersion: (candidate) => versions.get(candidate) || null,
    });
    assert.equal(result.path, currentNode);
    assert.equal(result.version, "22.14.0");
    assert.equal(result.source, "absolute");
  } finally {
    await fs.rm(profile, { recursive: true, force: true });
  }
});

test("sandbox fallback does not reuse an invalid stable node copy", async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-node-corrupt-"));
  try {
    const sandbox = path.join(profile, "WorkBuddy", "sandbox", "node.exe");
    const stable = path.join(profile, "stable");
    const target = path.join(stable, "node-v22.14.0.exe");
    await fs.mkdir(path.dirname(sandbox), { recursive: true });
    await fs.mkdir(stable, { recursive: true });
    await fs.copyFile(process.execPath, sandbox);
    await fs.writeFile(target, "corrupt");
    const resolved = await resolveNodeExecutable({
      stableRoot: stable,
      candidates: [sandbox],
      probeVersion: (candidate) => candidate === target ? null : ({ major: MIN_NODE_MAJOR, version: "22.14.0" }),
    });
    assert.notEqual(resolved.path, target);
    const version = (await execFileAsync(resolved.path, ["--version"])).stdout.trim();
    assert.match(version, /^v?\d+\.\d+\.\d+$/);
  } finally {
    await fs.rm(profile, { recursive: true, force: true });
  }
});

test("failed Node verification does not change an existing runtime pointer", async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-runtime-preserve-"));
  try {
    const source = path.join(profile, "source");
    const stable = path.join(profile, "stable");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "runner.mjs"), "console.log('old');\n");
    const first = await syncStableRuntime({ sourceRoot: source, stableRoot: stable, host: "cursor" });
    const before = await fs.readFile(first.pointerPath, "utf8");
    await assert.rejects(() => resolveNodeExecutable({
      stableRoot: first.hostRoot,
      candidates: [path.join(profile, "WorkBuddy", "sandbox", "node.exe")],
      exists: () => true,
      probeVersion: () => null,
    }), /Node\.js/);
    assert.equal(await fs.readFile(first.pointerPath, "utf8"), before);
  } finally {
    await fs.rm(profile, { recursive: true, force: true });
  }
});

test("staged runtime keeps the old pointer when Node preflight fails", async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-runtime-preflight-"));
  try {
    const source = path.join(profile, "package");
    const stable = path.join(profile, "stable");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "runner.mjs"), "export const runner = true;\n");
    const current = await syncStableRuntime({ sourceRoot: source, stableRoot: stable, host: "cursor" });
    const before = await fs.readFile(current.pointerPath, "utf8");
    const staged = await syncStableRuntime({ sourceRoot: source, stableRoot: stable, host: "cursor", activate: false });
    await assert.rejects(resolveNodeExecutable({
      stableRoot: staged.hostRoot,
      candidates: [path.join(profile, "missing-node.exe")],
      probeVersion: () => null,
    }));
    await discardStableRuntime(staged);
    assert.equal(await fs.readFile(current.pointerPath, "utf8"), before);
  } finally {
    await fs.rm(profile, { recursive: true, force: true });
  }
});

test("copied sandbox Node executes a stable runner after the package moves", { skip: process.platform !== "win32" }, async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-runtime-e2e-"));
  try {
    const source = path.join(profile, "npx-cache", "package");
    const sandbox = path.join(profile, "WorkBuddy", "sandbox", "node.exe");
    const stable = path.join(profile, "AppData", "Local", "beautiCode", "runtime");
    await fs.mkdir(path.join(source, "vendor"), { recursive: true });
    await fs.mkdir(path.dirname(sandbox), { recursive: true });
    await fs.copyFile(process.execPath, sandbox);
    await fs.writeFile(path.join(source, "runner.mjs"), "import './vendor/adapter.mjs'; console.log('stable-runner-ok');\n");
    await fs.writeFile(path.join(source, "vendor", "adapter.mjs"), "export const loaded = true;\n");
    const runtime = await syncStableRuntime({ sourceRoot: source, stableRoot: stable, host: "workbuddy" });
    await resolveNodeExecutable({ stableRoot: runtime.hostRoot, candidates: [sandbox] });
    await fs.rm(source, { recursive: true, force: true });
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", runtime.launcher, "--probe",
    ], { windowsHide: true, timeout: 10_000 });
    assert.match(stdout, /stable-runner-ok/);
    const nodeRecord = JSON.parse(await fs.readFile(path.join(runtime.hostRoot, "node-source.json"), "utf8"));
    const version = await execFileAsync(nodeRecord.path, ["--version"], { windowsHide: true, timeout: 5_000 });
    assert.match(version.stdout, /^v?2[2-9]\./);
  } finally {
    await fs.rm(profile, { recursive: true, force: true });
  }
});
