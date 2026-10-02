import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createCodexRunKeyAdapter, uninstallCodexWiring } from "../../../integrations/codex-desktop/task-wiring.mjs";
import * as taskWiring from "../../../integrations/codex-desktop/task-wiring.mjs";

test("Codex guardian registration uses the current account name for Scheduler identities", async () => {
  assert.equal(typeof taskWiring.createCodexTaskAdapter, "function");
  const scripts = [];
  const adapter = taskWiring.createCodexTaskAdapter("C:\\bc\\start-watch.ps1", {
    taskName: "beautiCode Codex Guardian test",
    runPowerShell(script) {
      scripts.push(script);
      return JSON.stringify({ sid: "S-1-5-21-100", name: "MACHINE\\scott" });
    },
  });

  await adapter.register();

  const registration = scripts.at(-1);
  assert.ok(registration.includes("-AtLogOn -User 'MACHINE\\scott'"));
  assert.ok(registration.includes("-UserId 'MACHINE\\scott' -LogonType Interactive"));
  assert.ok(!registration.includes("-User 'S-1-5-21-100'"));
});

test("Codex task ownership rejects a matching account name when the recorded SID differs", async () => {
  assert.equal(typeof taskWiring.createCodexTaskAdapter, "function");
  const adapter = taskWiring.createCodexTaskAdapter("C:\\bc\\start-watch.ps1", {
    taskName: "beautiCode Codex Guardian test",
    runPowerShell(script) {
      if (script.includes("WindowsIdentity")) {
        return JSON.stringify({ sid: "S-1-5-21-100", name: "MACHINE\\scott" });
      }
      return JSON.stringify({
        user: "MACHINE\\scott",
        userSid: "S-1-5-21-200",
        execute: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        arguments: '-File "C:\\bc\\start-watch.ps1"',
        state: "Ready",
        xml: "<Task />",
      });
    },
  });

  await assert.rejects(adapter.assertOwned(), /not owned/);
});

test("Codex task ownership accepts only the matching current SID", async () => {
  const adapter = taskWiring.createCodexTaskAdapter("C:\\bc\\start-watch.ps1", {
    runPowerShell(script) {
      if (script.includes("WindowsIdentity")) {
        return JSON.stringify({ sid: "S-1-5-21-100", name: "MACHINE\\scott" });
      }
      return JSON.stringify({
        user: "MACHINE\\scott",
        userSid: "s-1-5-21-100",
        execute: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        arguments: '-File "C:\\bc\\start-watch.ps1"',
        state: "Ready",
        xml: "<Task />",
      });
    },
  });

  assert.equal((await adapter.assertOwned()).userSid, "s-1-5-21-100");
});

test("Codex task readback resolves a bare principal only through the local computer authority", async () => {
  const scripts = [];
  const adapter = taskWiring.createCodexTaskAdapter("C:\\bc\\start-watch.ps1", {
    runPowerShell(script) {
      scripts.push(script);
      return "";
    },
  });

  await adapter.read();

  assert.ok(scripts[0].includes('[System.Security.Principal.NTAccount]::new("$env:COMPUTERNAME\\$principal")'));
  assert.ok(scripts[0].includes("if($principal -match '[\\\\/]') { throw }") );
});

const runTaskSchedulerIntegration = process.platform === "win32" && process.env.BEAUTICODE_TASK_SCHEDULER_TEST === "1";
test("Windows Task Scheduler registers and reads back the owned Codex guardian identity", { skip: !runTaskSchedulerIntegration }, async () => {
  assert.equal(typeof taskWiring.createCodexTaskAdapter, "function");
  const taskName = `beautiCode Codex Guardian test-${randomUUID()}`;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "bc-codex-task-"));
  const starter = path.join(directory, "start-watch.ps1");
  const adapter = taskWiring.createCodexTaskAdapter(starter, { taskName });
  await fs.writeFile(starter, "exit 0\r\n", "utf8");
  try {
    await adapter.register();
    await adapter.assertOwned();
  } finally {
    const expectedArguments = `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${starter}"`;
    const psLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;
    const cleanup = `$n=${psLiteral(taskName)}; $t=Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue; ` +
      `if($t){ if($t.Actions.Count -ne 1 -or $t.Actions[0].Execute -ne 'powershell.exe' -or $t.Actions[0].Arguments -ne ${psLiteral(expectedArguments)}) { throw 'Temporary task definition changed; refusing cleanup' }; ` +
      `Unregister-ScheduledTask -TaskName $n -Confirm:$false }`;
    const encoded = Buffer.from(`$ErrorActionPreference='Stop'; ${cleanup}`, "utf16le").toString("base64");
    try {
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
        windowsHide: true,
        timeout: 10_000,
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
});

function fixture({ run = "old-command", task = null } = {}) {
  const state = { run, task };
  let stopped = 0;
  const taskAdapter = {
    async read() { return state.task && { ...state.task }; },
    async assertOwned() { if (state.task?.owner !== "beauticode") throw Error("task is not owned"); },
    async stop() { if (state.task?.owner === "beauticode") state.task.running = false; },
    async removeOwned() { if (state.task?.owner === "beauticode") state.task = null; },
  };
  return {
    state,
    task: taskAdapter,
    runKey: {
      async read() { return state.run; },
      async remove() { state.run = null; },
    },
    async stopOwned() { stopped++; },
    get stopped() { return stopped; },
  };
}

test("Codex guardian scheduled task is allowed to stay running on battery", async () => {
  const source = await readFile(
    new URL("../../../integrations/codex-desktop/task-wiring.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /New-ScheduledTaskSettingsSet[^;]*-AllowStartIfOnBatteries/);
  assert.match(source, /New-ScheduledTaskSettingsSet[^;]*-DontStopIfGoingOnBatteries/);
});

test("foreign task is neither replaced nor removed", async () => {
  const f = fixture({ task: { owner: "foreign", action: "other.exe" } });
  await assert.rejects(() => uninstallCodexWiring(f), /not owned/);
  assert.equal(f.state.task.action, "other.exe");
  assert.equal(f.state.run, "old-command");
  assert.equal(f.stopped, 0);
});

test("uninstall removes only product wiring", async () => {
  const f = fixture({ task: { owner: "beauticode", action: "starter.ps1" } });
  await uninstallCodexWiring(f);
  assert.deepEqual(f.state, { run: null, task: null });
  assert.equal(f.stopped, 1);
});

test("an absent Windows Run value is an empty optional wire, not an installation error", { skip: process.platform !== "win32" }, async () => {
  const runKey = createCodexRunKeyAdapter("C:\\bc\\start-watch.ps1", {
    valueName: `BeautiCodeCodexTest_${randomUUID().replaceAll("-", "")}`,
  });
  assert.equal(await runKey.read(), null);
  await runKey.remove();
});
