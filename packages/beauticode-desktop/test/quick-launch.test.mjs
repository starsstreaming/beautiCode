import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import test from "node:test";
import path from "node:path";
import { renderRuntimeLauncherPs1 } from "../../../scripts/portable-runtime.mjs";

test("quick launch starts a closed desktop host and does not restart a blind running host", async () => {
  const { decideDesktopQuickLaunch } = await import("../../../scripts/quick-launch.mjs").catch(() => ({}));
  assert.equal(typeof decideDesktopQuickLaunch, "function");
  assert.equal(decideDesktopQuickLaunch([]), "launch");
  assert.equal(decideDesktopQuickLaunch([{ pid: 12, port: null }]), "already-running-blind");
  assert.equal(decideDesktopQuickLaunch([{ pid: 12, port: 9341 }]), "already-running-cdp");
  assert.equal(decideDesktopQuickLaunch([{ pid: 12, port: null }, { pid: 13, port: null }]), "ambiguous");
});

test("quick-launch diagnostics never persist exception text", async () => {
  const { quickLaunchFailureCode } = await import("../../../scripts/quick-launch.mjs");
  assert.equal(quickLaunchFailureCode(new Error("cdp-target-unavailable")), "cdp-target-unavailable");
  assert.equal(quickLaunchFailureCode(new Error("private token https://example.test/path")), "unexpected-error");
});

test("stable launcher resolves a quick-launch entry from its active runtime", () => {
  const script = renderRuntimeLauncherPs1({ host: "cursor" });
  assert.match(script, /--quick-launch/);
  assert.match(script, /scripts[\\/]quick-launch\.mjs/);
  assert.match(script, /\$pointer\.entrypoint/);
});

test("Windows shortcut launcher executes the active quick entry", { skip: process.platform !== "win32" }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "beauticode-quick-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const active = path.join(root, "versions", "v-test");
  fs.mkdirSync(path.join(active, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "current.json"), JSON.stringify({ schema: "beauticode.runtime/v1", host: "cursor", version: "v-test", entrypoint: "scripts/runner.mjs" }));
  fs.writeFileSync(path.join(active, "scripts", "runner.mjs"), 'process.stdout.write("guardian\\n");\n');
  fs.writeFileSync(path.join(active, "scripts", "quick-launch.mjs"), 'process.stdout.write(process.argv.slice(2).join(",") + "\\n");\n');
  const launcher = path.join(root, "launcher.ps1");
  fs.writeFileSync(launcher, renderRuntimeLauncherPs1({ host: "cursor" }));
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcher, "--quick-launch"], {
    encoding: "utf8", timeout: 10_000, env: { ...process.env, BEAUTICODE_NODE_PATH: process.execPath },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "cursor");
});
