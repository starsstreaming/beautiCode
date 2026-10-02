import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { HOSTS, parseCommand, resolveRoute, runHostCommand } from "../src/index.mjs";

test("per-host health commands are read-only", () => {
  assert.deepEqual(parseCommand(["codex", "health"]), { kind: "host", host: "codex", command: "health" });
  assert.deepEqual(parseCommand(["workbuddy", "health"]), { kind: "host", host: "workbuddy", command: "health" });
  assert.deepEqual(resolveRoute("codex", "health"), { host: "codex", command: "health", readOnly: true });
});

test("each host resolves install and uninstall to a package-local script", () => {
  const runtimeRoot = path.resolve("package", "runtime");
  for (const host of HOSTS) {
    for (const command of ["install", "uninstall"]) {
      const route = resolveRoute(host, command, { runtimeRoot });
      assert.equal(route.host, host);
      assert.equal(route.command, command);
      assert.equal(route.script.replaceAll("\\", "/").startsWith(runtimeRoot.replaceAll("\\", "/") + "/"), true);
      assert.equal(path.relative(runtimeRoot, route.script).split(path.sep).includes("desktop"), host === "cursor" || host === "doubao");
      assert.ok(Array.isArray(route.args));
      assert.equal(path.isAbsolute(route.script), true);
    }
  }
});

test("status has no child-process route", () => {
  assert.deepEqual(resolveRoute("workbuddy", "status", { runtimeRoot: "C:/package/runtime" }), {
    host: "workbuddy",
    command: "status",
    readOnly: true,
  });
});

test("install route is executable through an injected child-process seam", () => {
  let call;
  const result = runHostCommand("workbuddy", "install", {
    platform: "win32",
    runtimeRoot: "C:/package/runtime",
    env: { TEST_ENV: "1" },
    spawnSync(...args) {
      call = args;
      return { status: 0 };
    },
  });
  assert.deepEqual(result, { host: "workbuddy", command: "install", ok: true });
  assert.equal(call[0], process.execPath);
  assert.match(call[1][0].replaceAll("\\", "/"), /runtime\/workbuddy\/scripts\/wb-setup\.mjs$/);
  assert.deepEqual(call[1].slice(1), ["install"]);
  assert.equal(call[2].env.BEAUTICODE_PACKAGED_RUNTIME, "1");
});

test("non-Windows workspace installs and uninstalls fail before invoking any host script", () => {
  for (const host of HOSTS) {
    for (const command of ["install", "uninstall"]) {
      assert.throws(() => runHostCommand(host, command, {
        platform: "linux",
        spawnSync() { throw new Error("must not invoke a host installer"); },
      }), /仅支持 Windows/);
    }
  }
});
