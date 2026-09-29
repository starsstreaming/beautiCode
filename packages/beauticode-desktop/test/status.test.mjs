import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HOSTS, getHostStatus, statusText } from "../src/index.mjs";

test("status is read-only and reports missing package runtime without touching user state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-desktop-status-"));
  try {
    const before = await fs.readdir(root);
    const result = getHostStatus("cursor", {
      runtimeRoot: root,
      home: path.join(root, "fake-home"),
      env: {},
      platform: "win32",
    });
    assert.equal(result.host, "cursor");
    assert.equal(result.runtimeReady, false);
    assert.ok(result.missingRuntime.length > 0);
    assert.equal(result.installed, false);
    assert.deepEqual(await fs.readdir(root), before);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("status has an explicit read-only result for every supported host", () => {
  for (const host of HOSTS) {
    const result = getHostStatus(host, {
      runtimeRoot: "C:/package/runtime",
      home: "C:/Users/test",
      env: {},
      platform: "win32",
      exists: () => false,
    });
    assert.equal(result.host, host);
    assert.equal(result.installed, false);
    assert.equal(result.runtimeReady, false);
    assert.match(statusText(result), new RegExp(host));
  }
});

test("status uses the Windows Startup folder as the canonical runner marker", () => {
  const appData = "C:/Users/test/AppData/Roaming";
  const startup = path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  for (const host of ["workbuddy", "cursor", "doubao"]) {
    const marker = path.join(startup, `beauticode-${host === "workbuddy" ? "wb" : host}-runner.vbs`).replaceAll("\\", "/");
    const result = getHostStatus(host, {
      runtimeRoot: "C:/package/runtime",
      home: "C:/Users/test",
      env: { APPDATA: appData },
      platform: "win32",
      exists: (candidate) => candidate.replaceAll("\\", "/") === marker,
    });
    assert.equal(result.installed, true, host);
  }
});

test("status does not mistake the retired APPDATA-root marker for an install", () => {
  const appData = "C:/Users/test/AppData/Roaming";
  for (const host of ["workbuddy", "cursor", "doubao"]) {
    const legacy = path.join(appData, `beauticode-${host === "workbuddy" ? "wb" : host}-runner.vbs`).replaceAll("\\", "/");
    const result = getHostStatus(host, {
      runtimeRoot: "C:/package/runtime",
      home: "C:/Users/test",
      env: { APPDATA: appData },
      platform: "win32",
      exists: (candidate) => candidate.replaceAll("\\", "/") === legacy,
    });
    assert.equal(result.installed, false, host);
  }
});
