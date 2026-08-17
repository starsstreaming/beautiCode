import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const hostScript = path.resolve(here, "../../../apps/tray/session-host.mjs");
const CONTROL_TOKEN = "control-token-for-session-host-test-123456";

test("session-host starts in DSH mode without touching Codex", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "beauticode-dsh-host-"));
  const child = spawn(
    process.execPath,
    [
      hostScript,
      "--host",
      "dsh",
      "--dsh-url",
      "http://127.0.0.1:1",
      "--data-root",
      path.join(root, "data"),
      "--verify-ms",
      "20",
    ],
    {
      cwd: path.resolve(here, "../../.."),
      env: { ...process.env, BEAUTICODE_CONTROL_TOKEN: CONTROL_TOKEN },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  t.after(async () => {
    if (child.exitCode == null) child.kill();
    await fs.rm(root, { recursive: true, force: true });
  });

  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ready timeout: ${stderr}`)), 5_000);
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        const parsed = JSON.parse(line);
        if (parsed.ready) {
          clearTimeout(timer);
          lines.close();
          resolve(parsed);
        }
      } catch {
        /* ignore diagnostic lines */
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`session-host exited ${code}: ${stderr}`));
    });
  });
  assert.equal(ready.host, "dsh");
  assert.equal(ready.cdpPort, null);

  const headers = { Authorization: `Bearer ${CONTROL_TOKEN}` };
  const healthResponse = await fetch(`http://127.0.0.1:${ready.controlPort}/health`, { headers });
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.host.kind, "dsh");
  assert.equal(health.port, null);

  const controlFile = path.join(root, "data", "dsh-control.json");
  const advertised = JSON.parse(await fs.readFile(controlFile, "utf8"));
  assert.equal(advertised.schema, "beauticode.dsh-control/v1");
  assert.equal(advertised.host, "dsh");
  assert.equal(advertised.url, `http://127.0.0.1:${ready.controlPort}`);
  assert.equal(advertised.token, CONTROL_TOKEN);
  assert.equal(advertised.pid, child.pid);

  const shutdown = await fetch(`http://127.0.0.1:${ready.controlPort}/shutdown`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(shutdown.status, 200);
  await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(child.exitCode, 0, stderr);
  await assert.rejects(() => fs.readFile(controlFile), { code: "ENOENT" });
});
