import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");

test("Windows file picker is launched in STA with a TopMost owner", () => {
  const source = fs.readFileSync(path.join(repo, "scripts", "wb-cdp-runner.mjs"), "utf8");
  assert.match(source, /-STA/);
  assert.match(source, /OpenFileDialog/);
  assert.match(source, /\[Console\]::OutputEncoding=\$OutputEncoding/);
  assert.match(source, /\$owner\.TopMost=\$true/);
  assert.match(source, /ShowDialog\(\$owner\)/);
  assert.doesNotMatch(source, /\$d\.ShowDialog\(\)/);
  assert.match(source, /__bcApplyBackgroundPath/);
  assert.match(source, /ensureWorkBuddyCdp/);
  assert.match(source, /launchIfMissing:\s*false/);
  assert.match(source, /repairWindowMs:\s*10_000/);
  assert.match(source, /--watchdog/);
  assert.match(source, /--no-launch/);
  assert.match(source, /--watchdog 不能与 --once 或 --clean 同时使用/);
  assert.match(source, /live\.themes\.length === 0/);
});

test("wb-setup persists env, installs a watchdog runner, and logs under LocalAppData", () => {
  const source = fs.readFileSync(path.join(repo, "scripts", "wb-setup.mjs"), "utf8");
  assert.match(source, /setx/);
  assert.match(source, /workbuddy-port\.json/);
  assert.match(source, /SendMessageTimeout/);
  assert.match(source, /hasWorkBuddyCdp\(Number\(port\)\)/);
  assert.match(source, /9336/);
  assert.match(source, /--watchdog/);
  assert.match(source, /['"]beauticode['"],\s*['"]logs['"]/);
});

test("runner/setup preserve the selected port and never trust a reused watchdog PID", () => {
  const setup = fs.readFileSync(path.join(repo, "scripts", "wb-setup.mjs"), "utf8");
  const runner = fs.readFileSync(path.join(repo, "scripts", "wb-cdp-runner.mjs"), "utf8");

  // A foreign CDP owner on 9335 must not be reported as WorkBuddy, and a
  // fallback selected during setup must be persisted for the next icon launch.
  assert.match(setup, /target\.type === 'page'/);
  assert.match(setup, /resources\/app\.asar\/renderer\/index\.html/);
  assert.match(setup, /writeConfiguredPort\(port\)/);
  assert.match(setup, /broadcastWindowsEnvironment/);

  // Installing over a stale PID file may only stop our exact watchdog command.
  assert.match(setup, /Get-CimInstance Win32_Process/);
  assert.match(setup, /RUNNER/);
  assert.match(setup, /--watchdog/);
  assert.match(setup, /taskkill/);

  // The runner must not relaunch a user-closed WorkBuddy and must retain a
  // fallback port across the reconnect/session boundary.
  assert.match(runner, /workbuddy-port\.json/);
  assert.match(runner, /persistPortSelection/);
  assert.match(runner, /launchIfMissing:\s*false/);
  assert.match(runner, /repairWindowMs:\s*10_000/);
  assert.match(runner, /RUNNER_PID_FILE/);
  assert.match(runner, /releasePid/);
  assert.match(runner, /selectWorkBuddyReconnectDelay/);
  assert.match(runner, /reconnectDelayMs/);
  assert.match(runner, /setTimeout\(r, reconnectDelayMs\)/);
});
