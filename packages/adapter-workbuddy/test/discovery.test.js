import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  DEFAULT_WORKBUDDY_CDP_PORT,
  WORKBUDDY_CDP_ENV_KEY,
  classifyWorkBuddyStartupProcess,
  isWorkBuddyMainProcess,
  parsePsElapsedSeconds,
  parseRemoteDebuggingFlags,
  probeWorkBuddyCdp,
  workBuddyInstallCandidates,
  workBuddyCdpPortCandidates,
  selectWorkBuddyCdpPort,
} from "../dist/index.js";

test("WorkBuddy uses a dedicated fallback when Codex owns the default port", () => {
  assert.deepEqual(workBuddyCdpPortCandidates(9335).slice(0, 2), [9335, 9336]);
  assert.equal(selectWorkBuddyCdpPort(9335, new Set([9335])), 9336);
  assert.equal(selectWorkBuddyCdpPort(9335, new Set([9335, 9336])), 9222);
});

test("WorkBuddy startup repair is limited to a fresh process", () => {
  const now = 1_800_000_000_000;
  const process = {
    pid: 42,
    name: "WorkBuddy.exe",
    executablePath: "C:\\Program Files\\WorkBuddy\\WorkBuddy.exe",
    commandLine: '"C:\\Program Files\\WorkBuddy\\WorkBuddy.exe"',
    port: null,
    createdAtMs: now - 9_999,
  };
  assert.equal(classifyWorkBuddyStartupProcess(process, now), "repair-now");
  assert.equal(
    classifyWorkBuddyStartupProcess(
      { ...process, createdAtMs: now - 10_000 },
      now,
    ),
    "ignore-stale",
  );
  assert.equal(
    classifyWorkBuddyStartupProcess({ ...process, createdAtMs: null }, now),
    "ignore-stale",
  );
  assert.equal(
    classifyWorkBuddyStartupProcess({ ...process, port: 9335 }, now),
    "wait-for-cdp",
  );
});

const WB_URL =
  "file:///C:/Users/me/AppData/Local/Programs/WorkBuddy/resources/app.asar/renderer/index.html?locale=zh-CN";

async function serve(handler) {
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("parseRemoteDebuggingFlags accepts loopback Codex-style flags", () => {
  const flags = parseRemoteDebuggingFlags(
    `"WorkBuddy.exe" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9335`,
  );
  assert.equal(flags.port, 9335);
  assert.equal(flags.safe, true);
});

test("parseRemoteDebuggingFlags rejects a LAN bind", () => {
  const flags = parseRemoteDebuggingFlags(
    `app --remote-debugging-address=0.0.0.0 --remote-debugging-port=9222`,
  );
  assert.equal(flags.port, 9222);
  assert.equal(flags.safe, false);

  const quoted = parseRemoteDebuggingFlags(
    `app --remote-debugging-address="0.0.0.0" --remote-debugging-port="9222"`,
  );
  assert.equal(quoted.port, 9222);
  assert.equal(quoted.safe, false);
});

test("WorkBuddy process matching rejects command lines that only mention its name", () => {
  assert.equal(
    isWorkBuddyMainProcess(
      'powershell.exe -Command "Get-Process WorkBuddy"',
      "powershell.exe",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "win32",
    ),
    false,
  );
  assert.equal(
    isWorkBuddyMainProcess(
      '"C:\\Program Files\\WorkBuddy\\WorkBuddy.exe"',
      "WorkBuddy.exe",
      "C:\\Program Files\\WorkBuddy\\WorkBuddy.exe",
      "win32",
    ),
    true,
  );
});

test("macOS ps elapsed time is parsed without Linux etimes", () => {
  assert.equal(parsePsElapsedSeconds("00:09"), 9);
  assert.equal(parsePsElapsedSeconds("00:00:09"), 9);
  assert.equal(parsePsElapsedSeconds("01:02:03"), 3_723);
  assert.equal(parsePsElapsedSeconds("2-03:04:05"), 183_845);
  assert.equal(parsePsElapsedSeconds("bad"), null);
});

test("parseRemoteDebuggingFlags treats omitted address as a loopback-probe candidate", () => {
  const flags = parseRemoteDebuggingFlags(
    `"WorkBuddy.exe" --remote-debugging-port=9335`,
  );
  assert.equal(flags.port, 9335);
  assert.equal(flags.safe, true);
});

test("probeWorkBuddyCdp keeps only the WorkBuddy renderer page", async (t) => {
  const wb = await serve((req, res) => {
    if (req.url === "/json/version") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ Browser: "Chrome/138", webSocketDebuggerUrl: `ws://127.0.0.1:${wb.port}/devtools/browser` }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([
      { id: "1", type: "page", url: WB_URL, webSocketDebuggerUrl: `ws://127.0.0.1:${wb.port}/devtools/page/1` },
    ]));
  });
  t.after(() => wb.close());
  const hit = await probeWorkBuddyCdp(wb.port, { timeoutMs: 500 });
  assert.equal(hit?.port, wb.port);
});

test("probeWorkBuddyCdp ignores a Codex app:// page on the same port", async (t) => {
  const other = await serve((req, res) => {
    if (req.url === "/json/version") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ Browser: "Chrome/138", webSocketDebuggerUrl: `ws://127.0.0.1:${other.port}/devtools/browser` }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([
      { id: "1", type: "page", url: "app://-/index.html", title: "ChatGPT" },
    ]));
  });
  t.after(() => other.close());
  assert.equal(await probeWorkBuddyCdp(other.port, { timeoutMs: 500 }), null);
});

test("install candidates include the usual Windows / macOS locations", () => {
  const win = workBuddyInstallCandidates(
    { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", ProgramFiles: "C:\\Program Files" },
    "win32",
  );
  assert.ok(win.some((p) => p.endsWith("WorkBuddy.exe")));
  const mac = workBuddyInstallCandidates({}, "darwin");
  assert.ok(mac.some((p) => p.includes("WorkBuddy.app")));
  assert.equal(WORKBUDDY_CDP_ENV_KEY, "WORKBUDDY_REMOTE_DEBUGGING_PORT");
  assert.equal(DEFAULT_WORKBUDDY_CDP_PORT, 9335);
});
