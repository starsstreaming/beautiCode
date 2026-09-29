import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as desktop from "../src/index.mjs";

const { detectHostAvailability, getAllStatus, runAllInstall } = desktop;

const home = "C:/Users/test";
const runtimeRoot = "C:/package/runtime";
const env = {
  LOCALAPPDATA: "C:/Users/test/AppData/Local",
  APPDATA: "C:/Users/test/AppData/Roaming",
  DSH_HOME: "C:/Users/test/.dsh",
  PATH: "C:/tools",
};

function fakeOptions(hostFiles, spawnSync) {
  const normalized = new Set(hostFiles.map((file) => path.normalize(file)));
  return {
    home,
    runtimeRoot,
    env,
    platform: "win32",
    exists: (file) => path.normalize(file).startsWith(path.normalize(runtimeRoot)) || normalized.has(path.normalize(file)),
    probeAppxCodex: () => false,
    queryRegistered: () => [],
    verifyHostInstall: () => ({ ready: true, state: "guardian-ready" }),
    installShortcut: (host) => ({ outcome: "created", path: `C:/Programs/beautiCode ${host}.lnk` }),
    spawnSync,
  };
}

test("all install skips missing hosts and updates detected hosts without launching them", () => {
  const invocations = [];
  const options = fakeOptions([
    "C:/tools/dsh.cmd",
    "C:/Users/test/AppData/Local/Programs/cursor/Cursor.exe",
  ], (_node, args) => {
    invocations.push(args[0]);
    return { status: 0 };
  });
  const result = runAllInstall(options);
  assert.deepEqual(result.results.map(({ host, outcome }) => [host, outcome]), [
    ["dsh", "installed"],
    ["codex", "skipped"],
    ["workbuddy", "skipped"],
    ["cursor", "installed"],
    ["doubao", "skipped"],
  ]);
  assert.equal(result.ok, true);
  assert.equal(invocations.length, 2);
});

test("all install continues after one host fails and returns an explicit failure", () => {
  const invocations = [];
  const options = fakeOptions([
    "C:/tools/dsh.cmd",
    "C:/Users/test/AppData/Local/Programs/cursor/Cursor.exe",
  ], (_node, args) => {
    invocations.push(args[0]);
    return { status: args[0].includes("dsh") ? 7 : 0 };
  });
  const result = runAllInstall(options);
  assert.equal(result.ok, false);
  assert.deepEqual(result.results.map(({ host, outcome }) => [host, outcome]).filter(([, outcome]) => outcome !== "skipped"), [
    ["dsh", "failed"],
    ["cursor", "installed"],
  ]);
  assert.equal(invocations.length, 2);
});

test("all install isolates a detection failure from later hosts", () => {
  const options = fakeOptions(["C:/Users/test/AppData/Local/Programs/cursor/Cursor.exe"], () => ({ status: 0 }));
  const result = runAllInstall({ ...options, probeAppxCodex: () => { throw new Error("probe unavailable"); } });
  assert.equal(result.results.find((entry) => entry.host === "codex")?.outcome, "failed");
  assert.equal(result.results.find((entry) => entry.host === "cursor")?.outcome, "installed");
});

test("all status and detection are read-only", () => {
  const options = fakeOptions([], () => { throw new Error("must not spawn"); });
  assert.equal(detectHostAvailability("cursor", options).available, false);
  const result = getAllStatus(options);
  assert.equal(result.hosts.length, 5);
  assert.ok(result.hosts.every((host) => host.runtimeReady && !host.installed));
  assert.equal(runAllInstall(options).ok, false);
});

test("all install detects a verified current-user Codex AppX install", () => {
  const options = fakeOptions([], () => { throw new Error("must not spawn"); });
  assert.equal(detectHostAvailability("codex", { ...options, probeAppxCodex: () => true }).available, true);
});

test("all install detects an npx-managed DSH home without a global command", () => {
  const options = fakeOptions(["C:/Users/test/.dsh"], () => { throw new Error("must not spawn"); });
  assert.equal(detectHostAvailability("dsh", options).available, true);
});

test("all install refuses unsupported platforms before invoking any setup", () => {
  const options = fakeOptions([], () => { throw new Error("must not spawn"); });
  assert.throws(() => runAllInstall({ ...options, platform: "linux" }), /仅支持 Windows/);
});

test("registered Cursor in a non-default directory is detected only after executable verification", () => {
  const options = fakeOptions(["D:/cursor/Cursor.exe"], () => ({ status: 0 }));
  const registered = {
    ...options,
    queryRegistered: () => [{ DisplayName: "Cursor", InstallLocation: "D:\\cursor", DisplayIcon: '"D:\\cursor\\Cursor.exe",0' }],
    realpath: (candidate) => candidate,
  };
  assert.equal(detectHostAvailability("cursor", registered).available, true);
  assert.equal(detectHostAvailability("cursor", { ...registered, queryRegistered: () => [{ DisplayName: "Other", DisplayIcon: '"D:\\cursor\\Cursor.exe",0' }] }).available, false);
});

test("registered executable rejects a wrong basename, missing file and conflicting locations", () => {
  const options = {
    query: () => [{ DisplayName: "Cursor", DisplayIcon: '"D:\\cursor\\Cursor.exe",0' }],
    exists: (candidate) => candidate.toLowerCase() === "d:\\cursor\\cursor.exe",
    realpath: (candidate) => candidate,
  };
  assert.equal(typeof desktop.resolveRegisteredExecutable, "function");
  assert.equal(desktop.resolveRegisteredExecutable("cursor", options), "D:\\cursor\\Cursor.exe");
  assert.equal(desktop.resolveRegisteredExecutable("cursor", { ...options, query: () => [{ DisplayName: "Cursor", DisplayIcon: '"D:\\cursor\\Other.exe",0' }] }), null);
  assert.equal(desktop.resolveRegisteredExecutable("cursor", { ...options, exists: () => false }), null);
  assert.equal(desktop.resolveRegisteredExecutable("cursor", { ...options, query: () => [
    { DisplayName: "Cursor", DisplayIcon: '"D:\\cursor\\Cursor.exe",0' },
    { DisplayName: "Cursor", DisplayIcon: '"E:\\cursor\\Cursor.exe",0' },
  ], exists: () => true }), null);
});

test("installer writes only a verified owner-tagged executable record", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bc-registered-host-"));
  try {
    assert.equal(typeof desktop.writeVerifiedExecutableRecord, "function");
    const file = await desktop.writeVerifiedExecutableRecord("cursor", dir, {
      query: () => [{ DisplayName: "Cursor (User)", InstallLocation: "D:\\cursor" }],
      exists: (candidate) => candidate === "D:\\cursor\\Cursor.exe",
      realpath: (candidate) => candidate,
    });
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), {
      schema: "beauticode.host-executable/v1", host: "cursor", path: "D:\\cursor\\Cursor.exe",
    });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("all install rejects a successful child exit when its guardian is absent", () => {
  const options = fakeOptions(["C:/Users/test/AppData/Local/Programs/cursor/Cursor.exe"], () => ({ status: 0 }));
  const result = runAllInstall({ ...options, verifyHostInstall: () => ({ ready: false, reason: "guardian-not-ready" }) });
  assert.equal(result.results.find((row) => row.host === "cursor")?.outcome, "failed");
  assert.equal(result.ok, false);
});

test("a foreign DSH Junction is a conflict and does not prevent later hosts", () => {
  const link = path.normalize("C:/Users/test/.dsh/profiles/web/node_modules/beauticode-dsh");
  const options = fakeOptions(["C:/Users/test/.dsh", "C:/Users/test/AppData/Local/Programs/cursor/Cursor.exe"], () => ({ status: 0 }));
  const result = runAllInstall({
    ...options,
    lstat: (candidate) => path.normalize(candidate) === link
      ? { isSymbolicLink: () => true }
      : (() => { const error = new Error("missing"); error.code = "ENOENT"; throw error; })(),
    realpath: (candidate) => path.normalize(candidate) === link ? "C:/third-party/beauticode-dsh" : path.normalize(candidate),
  });
  assert.equal(result.results.find((row) => row.host === "dsh")?.outcome, "conflict");
  assert.equal(result.results.find((row) => row.host === "dsh")?.reason, "foreign-dsh-junction");
  assert.equal(result.results.find((row) => row.host === "cursor")?.outcome, "installed");
  assert.equal(result.ok, false);
});

test("an installer-owned DSH Junction remains ready and can be reinstalled", () => {
  const link = path.normalize("C:/Users/test/.dsh/profiles/web/node_modules/beauticode-dsh");
  const managed = path.normalize("C:/Users/test/.dsh/plugins/beauticode-dsh");
  const options = fakeOptions(["C:/Users/test/.dsh", "C:/Users/test/.dsh/plugins/beauticode-dsh"], () => ({ status: 0 }));
  const linkedOptions = {
    ...options,
    lstat: (candidate) => path.normalize(candidate) === link
      ? { isSymbolicLink: () => true }
      : (() => { const error = new Error("missing"); error.code = "ENOENT"; throw error; })(),
    realpath: (candidate) => path.normalize(candidate) === link ? managed : path.normalize(candidate),
  };

  assert.equal(getAllStatus(linkedOptions).hosts.find((row) => row.host === "dsh")?.readiness, "plugin-ready");
  const result = runAllInstall(linkedOptions);
  assert.equal(result.results.find((row) => row.host === "dsh")?.outcome, "installed");
  assert.equal(result.ok, true);
});

test("a DSH Junction into another directory remains a conflict", () => {
  const link = path.normalize("C:/Users/test/.dsh/profiles/web/node_modules/beauticode-dsh");
  const options = fakeOptions(["C:/Users/test/.dsh"], () => ({ status: 0 }));
  const status = getAllStatus({
    ...options,
    lstat: (candidate) => path.normalize(candidate) === link
      ? { isSymbolicLink: () => true }
      : (() => { const error = new Error("missing"); error.code = "ENOENT"; throw error; })(),
    realpath: (candidate) => path.normalize(candidate) === link ? "C:/third-party/beauticode-dsh" : path.normalize(candidate),
  }).hosts.find((row) => row.host === "dsh");

  assert.equal(status?.readiness, "conflict");
  assert.equal(status?.reason, "foreign-dsh-junction");
});

test("an installer-managed DSH target is compared exactly, not by path prefix", () => {
  const link = path.normalize("C:/Users/test/.dsh/profiles/web/node_modules/beauticode-dsh");
  const options = fakeOptions(["C:/Users/test/.dsh"], () => ({ status: 0 }));
  const status = getAllStatus({
    ...options,
    lstat: (candidate) => path.normalize(candidate) === link
      ? { isSymbolicLink: () => true }
      : (() => { const error = new Error("missing"); error.code = "ENOENT"; throw error; })(),
    realpath: (candidate) => path.normalize(candidate) === link
      ? "C:/Users/test/.dsh/plugins/beauticode-dsh/unexpected-child"
      : path.normalize(candidate),
  }).hosts.find((row) => row.host === "dsh");

  assert.equal(status?.readiness, "conflict");
  assert.equal(status?.reason, "foreign-dsh-junction");
});

test("a dangling DSH Junction fails closed as a conflict", () => {
  const link = path.normalize("C:/Users/test/.dsh/profiles/web/node_modules/beauticode-dsh");
  const options = fakeOptions(["C:/Users/test/.dsh"], () => ({ status: 0 }));
  const status = getAllStatus({
    ...options,
    lstat: (candidate) => path.normalize(candidate) === link
      ? { isSymbolicLink: () => true }
      : (() => { const error = new Error("missing"); error.code = "ENOENT"; throw error; })(),
    realpath: () => { const error = new Error("dangling link"); error.code = "ENOENT"; throw error; },
  }).hosts.find((row) => row.host === "dsh");

  assert.equal(status?.readiness, "conflict");
  assert.equal(status?.reason, "dsh-link-target-unresolved");
});

test("a normal DSH plugin directory is not treated as a foreign link", () => {
  const options = fakeOptions(["C:/Users/test/.dsh", "C:/Users/test/.dsh/plugins/beauticode-dsh"], () => ({ status: 0 }));
  const status = getAllStatus({
    ...options,
    lstat: () => ({ isSymbolicLink: () => false, isDirectory: () => true }),
  }).hosts.find((row) => row.host === "dsh");

  assert.equal(status?.readiness, "plugin-ready");
});

test("a DSH link that cannot be inspected fails closed as a conflict", () => {
  const options = fakeOptions(["C:/Users/test/.dsh"], () => ({ status: 0 }));
  const status = getAllStatus({
    ...options,
    lstat: () => { const error = new Error("access denied"); error.code = "EACCES"; throw error; },
  }).hosts.find((row) => row.host === "dsh");

  assert.equal(status?.readiness, "conflict");
  assert.equal(status?.reason, "dsh-link-inspection-failed");
});

test("aggregate waits for a delayed WorkBuddy guardian acknowledgement", () => {
  let probes = 0;
  const options = fakeOptions(["C:/Users/test/AppData/Local/Programs/WorkBuddy/WorkBuddy.exe"], (_node, args) => {
    if (args.includes("--machine-status")) {
      probes++;
      return { status: 0, stdout: JSON.stringify({ installed: true, running: probes >= 2 }) };
    }
    return { status: 0 };
  });
  const result = runAllInstall({ ...options, verifyHostInstall: undefined });
  assert.equal(result.results.find((row) => row.host === "workbuddy")?.outcome, "installed");
  assert.equal(probes, 2);
});

test("DSH all-status reports plugin readiness without inventing a guardian", () => {
  const options = fakeOptions(["C:/Users/test/.dsh/plugins/beauticode-dsh"], () => ({ status: 0 }));
  const dsh = getAllStatus(options).hosts.find((row) => row.host === "dsh");
  assert.equal(dsh.installed, true);
  assert.equal(dsh.guardian, "not-applicable");
  assert.equal(dsh.readiness, "plugin-ready");
});
