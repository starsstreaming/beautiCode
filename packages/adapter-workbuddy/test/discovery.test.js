import assert from "node:assert/strict";
import http from "node:http";
import { performance } from "node:perf_hooks";
import test from "node:test";
import {
  DEFAULT_WORKBUDDY_CDP_PORT,
  WORKBUDDY_CDP_ENV_KEY,
  classifyWorkBuddyStartupProcess,
  isWorkBuddyMainProcess,
  parsePsElapsedSeconds,
  parseRemoteDebuggingFlags,
  probeForeignCdp,
  probeWorkBuddyCdp,
  pickAvailableLoopbackPort,
  ensureWorkBuddyCdp,
  waitForWorkBuddyCdp,
  selectWorkBuddyReconnectDelay,
  workBuddyInstallCandidates,
  workBuddyCdpPortCandidates,
  selectWorkBuddyCdpPort,
} from "../dist/index.js";

test("WorkBuddy uses a dedicated fallback when Codex owns the default port", () => {
  assert.deepEqual(workBuddyCdpPortCandidates(9335).slice(0, 2), [9335, 9336]);
  assert.equal(selectWorkBuddyCdpPort(9335, new Set([9335])), 9336);
  assert.equal(selectWorkBuddyCdpPort(9335, new Set([9335, 9336])), 9222);
});

test("port selection skips a foreign CDP owner and keeps WorkBuddy identity checks", async () => {
  const picked = await pickAvailableLoopbackPort(61001, {
    probeCdp: async (port) => port === 61001
      ? { browserUrl: "http://127.0.0.1:61001" }
      : null,
    probeWorkBuddy: async () => null,
    isPortFree: async (port) => port === 9336,
  });
  assert.equal(picked, 9336);
});

test("port selection advances to a bounded next candidate when 9336 is foreign", async () => {
  const picked = await pickAvailableLoopbackPort(9336, {
    probeCdp: async (port) => port === 9336 || port === 9335
      ? { browserUrl: `http://127.0.0.1:${port}` }
      : null,
    probeWorkBuddy: async () => null,
    isPortFree: async (port) => port === 9222,
  });
  assert.equal(picked, 9222);
});

test("ensure repairs a fresh foreign-port WorkBuddy process onto 9336", async () => {
  const process = {
    pid: 42,
    name: "WorkBuddy.exe",
    executablePath: "C:\\Program Files\\WorkBuddy\\WorkBuddy.exe",
    commandLine: '"C:\\Program Files\\WorkBuddy\\WorkBuddy.exe" --remote-debugging-port=9335',
    port: 9335,
    createdAtMs: Date.now() - 1_000,
  };
  const target = {
    port: 9336,
    browserUrl: "http://127.0.0.1:9336",
    source: "probe",
  };
  const launched = [];
  let stopped = 0;
  let waitCalls = 0;
  const result = await ensureWorkBuddyCdp({
    preferredPort: 9335,
    hooks: {
      discover: async () => null,
      listProcesses: async () => [process],
      probeForeignCdp: async () => false,
      waitForCdp: async (ports) => {
        waitCalls += 1;
        return ports.length === 1 && ports[0] === 9336 ? target : null;
      },
      findExecutable: () => process.executablePath,
      stopFresh: async () => { stopped += 1; return true; },
      pickPort: async () => 9336,
      launchWithCdp: async (port) => { launched.push(port); },
    },
  });
  assert.equal(stopped, 1);
  assert.deepEqual(launched, [9336]);
  assert.equal(waitCalls, 2);
  assert.deepEqual(result, { ...target, launched: true, restarted: true });
});

test("foreign CDP identity skips the 2s settling grace before fresh repair", async () => {
  const process = {
    pid: 42,
    name: "WorkBuddy.exe",
    executablePath: "C:\\Program Files\\WorkBuddy\\WorkBuddy.exe",
    commandLine: '"C:\\Program Files\\WorkBuddy\\WorkBuddy.exe" --remote-debugging-port=9335',
    port: 9335,
    createdAtMs: Date.now() - 1_000,
  };
  const target = {
    port: 9336,
    browserUrl: "http://127.0.0.1:9336",
    source: "probe",
  };
  let waitCalls = 0;
  let stopped = 0;
  const startedAt = performance.now();
  const result = await ensureWorkBuddyCdp({
    preferredPort: 9335,
    hooks: {
      discover: async () => null,
      listProcesses: async () => [process],
      probeForeignCdp: async (port) => port === 9335,
      waitForCdp: async (ports) => {
        waitCalls += 1;
        if (ports[0] === 9335) {
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          return null;
        }
        return target;
      },
      findExecutable: () => process.executablePath,
      stopFresh: async () => { stopped += 1; return true; },
      pickPort: async () => 9336,
      launchWithCdp: async () => {},
    },
  });
  const elapsed = performance.now() - startedAt;
  assert.ok(elapsed < 500, `foreign-CDP repair took ${Math.round(elapsed)}ms`);
  assert.equal(waitCalls, 1, "only the post-launch wait should run");
  assert.equal(stopped, 1);
  assert.deepEqual(result, { ...target, launched: true, restarted: true });
});

test("ensure never repairs an old or multi-process WorkBuddy session", async () => {
  const oldProcess = {
    pid: 42,
    name: "WorkBuddy.exe",
    executablePath: "C:\\Program Files\\WorkBuddy\\WorkBuddy.exe",
    commandLine: '"C:\\Program Files\\WorkBuddy\\WorkBuddy.exe" --remote-debugging-port=9335',
    port: 9335,
    createdAtMs: Date.now() - 30_000,
  };
  let stopped = 0;
  const options = {
    preferredPort: 9335,
    hooks: {
      discover: async () => null,
      probeForeignCdp: async () => false,
      waitForCdp: async () => null,
      stopFresh: async () => { stopped += 1; return true; },
    },
  };
  await assert.rejects(
    ensureWorkBuddyCdp({ ...options, hooks: { ...options.hooks, listProcesses: async () => [oldProcess] } }),
    /没有 WorkBuddy 目标页/,
  );
  await assert.rejects(
    ensureWorkBuddyCdp({ ...options, hooks: { ...options.hooks, listProcesses: async () => [oldProcess, { ...oldProcess, pid: 43 }] } }),
    /没有 WorkBuddy 目标页/,
  );
  assert.equal(stopped, 0);
});

test("ensure does not launch when the user has closed WorkBuddy", async () => {
  await assert.rejects(
    ensureWorkBuddyCdp({
      launchIfMissing: false,
      hooks: {
        discover: async () => null,
        listProcesses: async () => [],
      },
    }),
    /等待用户从原始图标启动/,
  );
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
  assert.equal(
    isWorkBuddyMainProcess(
      'C:\\Users\\me\\AppData\\Local\\Programs\\WorkBuddy\\WorkBuddy.exe C:\\Users\\me\\AppData\\Local\\Programs\\WorkBuddy\\resources\\app.asar\\main\\daemon-app-server-entry.js --stdio',
      "WorkBuddy.exe",
      "C:\\Users\\me\\AppData\\Local\\Programs\\WorkBuddy\\WorkBuddy.exe",
      "win32",
    ),
    false,
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
  assert.equal(await probeForeignCdp(other.port, { timeoutMs: 500 }), true);
});

test("foreign CDP probe keeps an empty or WorkBuddy target in settling grace", async (t) => {
  const settling = await serve((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(req.url === "/json/version"
      ? JSON.stringify({ Browser: "Chrome/138" })
      : JSON.stringify([]));
  });
  const workbuddy = await serve((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(req.url === "/json/version"
      ? JSON.stringify({ Browser: "Chrome/138" })
      : JSON.stringify([{ id: "1", type: "page", url: WB_URL }]));
  });
  t.after(() => Promise.all([settling.close(), workbuddy.close()]));
  assert.equal(await probeForeignCdp(settling.port, { timeoutMs: 500 }), false);
  assert.equal(await probeForeignCdp(workbuddy.port, { timeoutMs: 500 }), false);
});

test("WorkBuddy target polling uses a 200ms fake-clock cadence after a 220ms probe", async () => {
  let now = 0;
  let calls = 0;
  const sleeps = [];
  const target = { port: 9335, browserUrl: "http://127.0.0.1:9335", source: "probe" };
  const found = await waitForWorkBuddyCdp([9335], 1_000, {
    now: () => now,
    discover: async () => {
      calls += 1;
      if (calls === 1) { now += 220; return null; }
      return now >= 220 ? target : null;
    },
    sleep: async (ms) => { sleeps.push(ms); now += ms; },
  });
  assert.equal(found?.port, 9335);
  assert.deepEqual(sleeps, [200]);
  assert.equal(now, 420);
});

test("WorkBuddy reconnects fast only while a process or fresh startup is observable", () => {
  const now = 1_800_000_000_000;
  assert.equal(selectWorkBuddyReconnectDelay([], now), 3_000);
  assert.equal(
    selectWorkBuddyReconnectDelay([{ pid: 42, createdAtMs: now - 30_000 }], now),
    500,
  );
  assert.equal(
    selectWorkBuddyReconnectDelay([{ pid: 0, createdAtMs: now - 9_999 }], now),
    500,
  );
  assert.equal(
    selectWorkBuddyReconnectDelay([{ pid: 0, createdAtMs: now - 10_000 }], now),
    3_000,
  );
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
