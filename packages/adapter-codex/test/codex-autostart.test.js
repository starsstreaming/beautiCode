import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexAutostartAdapter, isOwnedCodexAutostart } from "../../../integrations/codex-desktop/task-wiring.mjs";
import { renderXdgDesktopEntry } from "../../../scripts/portable-runtime.mjs";

for (const user of ["alice", "100%user", "$user", 'a"b', "a\\b", "中文 user"]) {
  test(`Codex startup can be reinstalled and removed under ${JSON.stringify(user)}`, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bc-autostart-"));
    const file = path.join(dir, "codex.desktop");
    const launcher = `/home/${user}/.local/share/beautiCode/codex-plugin/launcher.sh`;
    const adapter = createCodexAutostartAdapter(launcher, { file });
    const content = renderXdgDesktopEntry({ name: "Codex", launcher });
    try {
      adapter.write(content);
      assert.equal(adapter.isOwned(), true);
      adapter.write(content);
      assert.equal(await fs.readFile(file, "utf8"), content);
      adapter.removeOwned();
      await assert.rejects(fs.access(file), { code: "ENOENT" });
      adapter.removeOwned();
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
}

test("a launcher path mentioned as an argument does not prove startup ownership", () => {
  const launcher = "/home/alice/beautiCode/launcher.sh";
  const content = `[Desktop Entry]\nExec=/bin/other-program "${launcher}"\nX-BeautiCode-Managed=true\n`;
  assert.equal(isOwnedCodexAutostart(content, launcher), false);
});
