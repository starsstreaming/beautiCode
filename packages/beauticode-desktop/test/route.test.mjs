import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { HOSTS, resolveRoute, runHostCommand } from "../src/index.mjs";

test("each host resolves install and uninstall to a package-local script", () => {
  // runtimeRoot 用平台原生绝对路径：硬编码 "C:/..." 在 Linux 上
  // path.isAbsolute 为 false，断言必挂。
  const runtimeRoot = path.join(path.sep, "package", "runtime");
  const runtimeRootFwd = runtimeRoot.replaceAll("\\", "/");
  for (const host of HOSTS) {
    for (const command of ["install", "uninstall"]) {
      const route = resolveRoute(host, command, { runtimeRoot });
      assert.equal(route.host, host);
      assert.equal(route.command, command);
      assert.equal(route.script.replaceAll("\\", "/").startsWith(`${runtimeRootFwd}/`), true);
      assert.equal(route.script.includes("desktop"), host === "cursor" || host === "doubao");
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
