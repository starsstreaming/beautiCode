import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

test("desktop aggregate manifest is a public test package with one CLI", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.equal(manifest.name, "beauticode-desktop");
  assert.equal(manifest.version, "0.1.0-test.2");
  assert.equal(manifest.private, false);
  // 包是纯 JS 聚合器，不声明 os 限制（声明会让 ubuntu CI 的 npm ci
  // 直接 EBADPLATFORM）；Windows-only 的分发语义由 runtime 产物承担。
  assert.equal(manifest.os, undefined);
  assert.equal(manifest.bin["beauticode-desktop"], "./bin/beauticode-desktop.mjs");
  assert.ok(manifest.files.includes("runtime"));
});

test("CLI help exposes all supported hosts and lifecycle commands", () => {
  const cli = path.join(root, "bin", "beauticode-desktop.mjs");
  const result = spawnSync(process.execPath, [cli, "--help"], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  for (const host of ["dsh", "codex", "workbuddy", "cursor", "doubao"]) {
    assert.match(result.stdout, new RegExp(`\\b${host}\\b`));
  }
  for (const command of ["install", "status", "uninstall"]) {
    assert.match(result.stdout, new RegExp(`\\b${command}\\b`));
  }
});

test("public route parser accepts only the five hosts and three lifecycle commands", async () => {
  const { HOSTS, parseCommand } = await import(pathToFileURL(path.join(root, "src", "index.mjs")).href);
  assert.deepEqual(HOSTS, ["dsh", "codex", "workbuddy", "cursor", "doubao"]);
  assert.deepEqual(parseCommand(["--help"]), { kind: "help" });
  assert.deepEqual(parseCommand(["cursor", "status"]), { kind: "host", host: "cursor", command: "status" });
  assert.deepEqual(parseCommand(["dsh", "install"]), { kind: "host", host: "dsh", command: "install" });
  assert.throws(() => parseCommand(["unknown", "status"]), /宿主/);
  assert.throws(() => parseCommand(["codex", "restart"]), /命令/);
});
