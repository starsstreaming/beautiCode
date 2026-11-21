import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { queryWindowsInstallRecords, resolveRegisteredExecutable } from "../src/windows-host-install.mjs";

test("reads Chinese product names from Windows registry output as UTF-8", { skip: process.platform !== "win32" }, () => {
  const records = queryWindowsInstallRecords({
    platform: "win32",
    spawn: (file, args, options) => {
      const fixture = "function Get-ItemProperty { [pscustomobject]@{ DisplayName='豆包工作'; InstallLocation='D:\\豆包工作'; DisplayIcon='' } }; ";
      return spawnSync(file, [...args.slice(0, -1), fixture + args.at(-1)], options);
    },
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].DisplayName, "豆包工作");
  assert.equal(records[0].InstallLocation, "D:\\豆包工作");
});

test("discovers the real Doubao Work process from its registered icon directory", () => {
  const root = "D:\\豆包工作\\DoubaoWork\\Application";
  const app = `${root}\\app\\DoubaoWork.exe`;
  const launcher = `${root}\\DoubaoWork.exe`;
  const result = resolveRegisteredExecutable("doubaowork", {
    query: () => [{ DisplayName: "豆包工作", DisplayIcon: `"${root}\\icon.ico"` }],
    exists: (candidate) => candidate === app || candidate === launcher,
    realpath: (candidate) => candidate,
  });

  assert.equal(result, app);
});

test("discovers a custom Doubao Work installation from its registered directory", () => {
  const app = "D:\\豆包工作\\DoubaoWork\\app\\DoubaoWork.exe";
  const result = resolveRegisteredExecutable("doubaowork", {
    query: () => [{ DisplayName: "豆包工作", InstallLocation: "D:\\豆包工作\\DoubaoWork" }],
    exists: (candidate) => candidate === app,
    realpath: (candidate) => candidate,
  });

  assert.equal(result, app);
});

test("rejects foreign, relative and conflicting Doubao Work registrations", () => {
  const options = {
    exists: () => true,
    realpath: (candidate) => candidate,
  };
  const resolve = (records) => resolveRegisteredExecutable("doubaowork", {
    ...options,
    query: () => records,
  });

  assert.equal(resolve([{ DisplayName: "豆包", DisplayIcon: '"D:\\豆包\\icon.ico"' }]), null);
  assert.equal(resolve([{ DisplayName: "豆包工作", InstallLocation: "relative\\directory" }]), null);
  assert.equal(resolve([
    { DisplayName: "豆包工作", DisplayIcon: '"D:\\WorkA\\icon.ico"' },
    { DisplayName: "豆包工作", DisplayIcon: '"E:\\WorkB\\icon.ico"' },
  ]), null);
});

for (const [host, name, executable] of [["doubao", "豆包", "Doubao.exe"], ["doubaowork", "豆包工作", "DoubaoWork.exe"]]) {
  test(host + " requires a local drive before and after resolving its registered executable", () => {
    const networkRoot = "\\\\server\\share";
    const options = {
      query: () => [{ DisplayName: name, InstallLocation: networkRoot }],
      exists: () => assert.fail("unexpected network lookup"),
    };
    assert.equal(resolveRegisteredExecutable(host, options), null);
    assert.equal(resolveRegisteredExecutable(host, {
      query: () => [{ DisplayName: name, InstallLocation: "D:\\Apps" }],
      exists: () => true,
      realpath: () => path.win32.join(networkRoot, executable),
    }), null);
  });
}

test("does not probe a network path supplied by a Doubao Work registration", () => {
  let probed = false;
  const result = resolveRegisteredExecutable("doubaowork", {
    query: () => [{ DisplayName: "豆包工作", DisplayIcon: '"\\\\server\\share\\icon.ico"' }],
    exists: () => { probed = true; return true; },
    realpath: (candidate) => candidate,
  });

  assert.equal(result, null);
  assert.equal(probed, false);
});

test("rejects a registered path whose canonical executable has a different name", () => {
  const result = resolveRegisteredExecutable("doubaowork", {
    query: () => [{ DisplayName: "豆包工作", DisplayIcon: '"D:\\Work\\icon.ico"' }],
    exists: () => true,
    realpath: () => "D:\\Other\\Doubao.exe",
  });

  assert.equal(result, null);
});
