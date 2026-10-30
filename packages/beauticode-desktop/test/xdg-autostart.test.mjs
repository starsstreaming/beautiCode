import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { renderXdgDesktopEntry } from "../../../scripts/portable-runtime.mjs";
import { withDesktopWiringRollback } from "../../../scripts/desktop-runner-identity.mjs";

const wiring = await import("../../../scripts/xdg-autostart.mjs").catch(() => ({}));

test("Cursor startup preserves foreign entries on both install and uninstall", async () => {
  assert.equal(typeof wiring.createXdgAutostartAdapter, "function");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bc-cursor-autostart-"));
  const file = path.join(dir, "cursor.desktop");
  const launcher = "/home/alice/beautiCode/runtime/cursor/launcher.sh";
  const args = ["--host", "cursor", "--watchdog", "--pid-file", "/home/alice/runner.pid"];
  const adapter = wiring.createXdgAutostartAdapter(launcher, { file, args });
  const owned = renderXdgDesktopEntry({ name: "Cursor", launcher, args });
  const foreignEntries = [
    "[Desktop Entry]\nExec=/bin/other-program\n",
    owned.replace(launcher, "/home/other/beautiCode/runtime/cursor/launcher.sh"),
    owned.replace('"--host" "cursor"', '"--host" "other"'),
  ];
  try {
    for (const foreign of foreignEntries) {
      await fs.writeFile(file, foreign);
      assert.throws(() => adapter.write(owned), /not owned/);
      assert.throws(() => adapter.removeOwned(), /not owned/);
      assert.equal(await fs.readFile(file, "utf8"), foreign);
    }
    await fs.unlink(file);
    adapter.write(owned);
    adapter.write(owned);
    assert.equal(adapter.isOwned(), true);
    adapter.removeOwned();
    await assert.rejects(fs.access(file), { code: "ENOENT" });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

for (const command of ["install", "uninstall"]) {
test(`Cursor ${command} refuses foreign autostart before touching the guardian`, { skip: process.platform !== "linux" }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bc-cursor-uninstall-"));
  const config = path.join(dir, "config");
  const file = path.join(config, "autostart", "beauticode-cursor-runner.desktop");
  const foreign = "[Desktop Entry]\nExec=/bin/other-program\n";
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, foreign);
    const result = spawnSync(process.execPath, ["scripts/desktop-cdp-setup.mjs", "--host", "cursor", command], {
      cwd: new URL("../../../", import.meta.url), encoding: "utf8", timeout: 10_000,
      env: { ...process.env, HOME: dir, XDG_CONFIG_HOME: config, XDG_DATA_HOME: path.join(dir, "data"), LOCALAPPDATA: "" },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not owned/);
    assert.equal(await fs.readFile(file, "utf8"), foreign);
    await assert.rejects(fs.access(path.join(dir, "data")), { code: "ENOENT" });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
}

test("failed activation rollback keeps a foreign replacement of its startup file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bc-autostart-rollback-"));
  const startupVbs = path.join(dir, "cursor.desktop");
  const pointerPath = path.join(dir, "current.json");
  const launcher = "/home/alice/beautiCode/cursor/launcher.sh";
  const owned = renderXdgDesktopEntry({ name: "Cursor", launcher });
  const adapter = wiring.createXdgAutostartAdapter(launcher, { file: startupVbs });
  const foreign = "[Desktop Entry]\nExec=/bin/other-program\n";
  try {
    await fs.writeFile(pointerPath, "old pointer");
    await assert.rejects(withDesktopWiringRollback({
      pointerPath, startupVbs,
      restoreStartup: (previous) => adapter.restore(previous),
      run: async () => {
        adapter.write(owned);
        await fs.writeFile(pointerPath, "new pointer");
        await fs.writeFile(startupVbs, foreign);
        throw new Error("guardian-not-ready");
      },
    }), /not owned/);
    assert.equal(await fs.readFile(startupVbs, "utf8"), foreign);
    assert.equal(await fs.readFile(pointerPath, "utf8"), "old pointer");
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
