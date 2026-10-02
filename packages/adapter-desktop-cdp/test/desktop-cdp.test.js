import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import test from 'node:test';
import {
  DesktopStartupRepairController,
  DesktopStartupSnapshotTracker,
  assertLoopbackDebuggerUrl,
  buildDesktopBackgroundInjection,
  buildDesktopLaunchCommand,
  classifyDesktopStartupProcess,
  isDesktopMainProcess,
  parseRemoteDebuggingFlags,
  probeDesktopCdp,
  readBoundedJson,
  repairDesktopProcess,
  selectDesktopMainProcesses,
  waitForDesktopCdp,
} from '../dist/index.js';

test('CDP streaming cap cancels a response without Content-Length before buffering all bytes', async (t) => {
  const chunkBytes = 64 * 1024;
  let pulled = 0;
  let cancelled = false;
  const response = new Response(new ReadableStream({
    pull(controller) {
      if (pulled === 128) { controller.close(); return; }
      pulled++;
      controller.enqueue(new Uint8Array(chunkBytes).fill(32));
    },
    cancel() { cancelled = true; },
  }));
  t.mock.method(globalThis, 'fetch', async () => response);
  await assert.rejects(readBoundedJson('http://127.0.0.1:1/test', { maxBytes: 1024 * 1024 }), /safety limit/);
  assert.equal(cancelled, true);
  assert.ok(pulled < 128, 'must stop before pulling the whole 8 MiB response');
  assert.equal(response.body.locked, false);
});

test('CDP streaming cap accepts a multi-chunk JSON response exactly at the cap', async (t) => {
  const bytes = new TextEncoder().encode('{"text":"背景"}');
  const response = new Response(new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  }));
  t.mock.method(globalThis, 'fetch', async () => response);
  assert.deepEqual(await readBoundedJson('http://127.0.0.1:1/test', { maxBytes: bytes.length }), { text: '背景' });
  assert.equal(response.body.locked, false);
});

test('CDP rejects declared oversize bodies, invalid JSON and missing bodies', async (t) => {
  for (const [response, pattern] of [
    [new Response('{}', { headers: { 'content-length': '99999' } }), /safety limit/],
    [new Response('not JSON'), /JSON|Unexpected token/],
    [new Response(null), /readable body/],
    [new Response('{}', { status: 503 }), /CDP HTTP 503/],
  ]) {
    t.mock.method(globalThis, 'fetch', async () => response);
    await assert.rejects(readBoundedJson('http://127.0.0.1:1/test', { maxBytes: 32 }), pattern);
    assert.ok(!response.body?.locked);
    t.mock.restoreAll();
  }
});

test('CDP timeout remains active while a response body is stalled', async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  await assert.rejects(readBoundedJson(`http://127.0.0.1:${server.address().port}`, { timeoutMs: 150 }),
    (error) => error.name === 'TimeoutError' || error.name === 'AbortError');
});

const spec = {
  kind: 'cursor', displayName: 'Cursor', processName: 'Cursor.exe',
  executableCandidates: ['C:\\Apps\\Cursor\\Cursor.exe'],
  defaultPort: 9341, candidatePorts: [9351],
  popupTopInset: 44,
  targetUrl: 'vscode-file://vscode-app/measured/workbench.html',
  targetRuntimeUrl: 'vscode-file://vscode-app/', mount: 'cursor',
  anchorSelector: '[data-action-id="marketplace"]', anchorText: 'Customize',
  strings: {},
  theme: {
    highContrastClassTokens: ['cursor-high-contrast', 'hc-black'],
    darkClassTokens: ['cursor-dark', 'vs-dark'],
    lightClassTokens: ['cursor-light'],
    rootAttribute: 'data-theme',
    darkAttributeValues: ['dark'],
    lightAttributeValues: ['light'],
    observeAttributes: ['class', 'data-theme'],
  },
  contract: { backdropSelectors: [], surfaceSelectors: [], flattenSelectors: [] },
};

const processRow = (createdAtMs, port = null) => ({
  pid: 42, name: 'Cursor.exe', executablePath: 'C:\\Apps\\Cursor\\Cursor.exe',
  commandLine: '"C:\\Apps\\Cursor\\Cursor.exe"', port, createdAtMs,
});

const withPid = (row, pid) => ({ ...row, pid });

test('startup repair has an exclusive 10 second boundary and requires creation time', () => {
  const now = 2_000_000;
  assert.equal(classifyDesktopStartupProcess(processRow(now - 9_999), now), 'repair-now');
  assert.equal(classifyDesktopStartupProcess(processRow(now - 10_000), now), 'ignore-stale');
  assert.equal(classifyDesktopStartupProcess(processRow(null), now), 'ignore-stale');
  assert.equal(classifyDesktopStartupProcess(processRow(now - 1, 9341), now), 'wait-for-cdp');
});

test('startup repair deduplicates a PID and creation-time pair', async () => {
  let calls = 0;
  const row = processRow(1000);
  const controller = new DesktopStartupRepairController(async () => { calls++; return 'verified'; }, () => 1001);
  assert.equal(await controller.observe(row), 'repaired');
  assert.equal(await controller.observe(row), 'already-handled');
  assert.equal(calls, 1);
});

test('a blind process created by a controlled relaunch is not restarted again', async () => {
  let now = 1_000;
  let calls = 0;
  const controller = new DesktopStartupRepairController(
    async () => { calls++; return 'launched'; }, () => now,
  );
  assert.equal(await controller.observe(processRow(now)), 'repaired');
  now += 100;
  const replacement = withPid(processRow(now), 43);
  controller.observeSnapshot([replacement]);
  assert.equal(await controller.observe(replacement), 'repair-suppressed');
  assert.equal(calls, 1);
  controller.observeSnapshot([]);
  now += 100;
  assert.equal(await controller.observe(withPid(processRow(now), 44)), 'repaired');
  assert.equal(calls, 2);
});

test('a failed repair does not long-suppress a different process generation', async () => {
  let now = 1_000;
  let calls = 0;
  const controller = new DesktopStartupRepairController(
    async () => { calls++; return 'failed'; },
    () => now,
    10_000,
    60_000,
  );
  assert.equal(await controller.observe(processRow(now)), 'repair-failed');
  now += 12_000;
  assert.equal(
    await controller.observe(withPid(processRow(now), 43)),
    'repair-failed',
  );
  assert.equal(calls, 2);
});

test('a failed repair never restarts the same process generation twice', async () => {
  let now = 1_000;
  let calls = 0;
  const row = processRow(now);
  const controller = new DesktopStartupRepairController(
    async () => { calls++; return 'failed'; },
    () => now,
    10_000,
    60_000,
    100,
  );
  assert.equal(await controller.observe(row), 'repair-failed');
  now += 100;
  assert.equal(await controller.observe(row), 'already-handled');
  now += 100;
  assert.equal(await controller.observe(row), 'already-handled');
  assert.equal(calls, 1);
});

test('event and snapshot after a failed repair share the same one-attempt decision', async () => {
  let calls = 0;
  const row = processRow(1_000);
  const controller = new DesktopStartupRepairController(async () => { calls++; return 'failed'; }, () => 1_001);
  const tracker = new DesktopStartupSnapshotTracker((observed) => controller.observe(observed));
  assert.equal(await controller.observe(row), 'repair-failed');
  await tracker.observeSnapshot([row]);
  await tracker.observeSnapshot([row]);
  assert.equal(calls, 1);
});

test('persistent snapshots wait for a stable PID and creation-time pair', async () => {
  let calls = 0;
  const tracker = new DesktopStartupSnapshotTracker(async () => { calls++; });
  const createdAtMs = Date.now() - 1_000;
  const row = processRow(createdAtMs);

  // A bootstrap process may disappear before the next snapshot. It must not
  // be repaired merely because one event mentioned its PID.
  await tracker.observeSnapshot([row]);
  assert.equal(calls, 0);
  await tracker.observeSnapshot([]);
  await tracker.observeSnapshot([withPid(row, 43)]);
  assert.equal(calls, 0);
  await tracker.observeSnapshot([withPid(row, 43)]);
  assert.equal(calls, 1);
});

test('persistent snapshot tracker preserves startup safety decisions', async () => {
  let now = 100_000;
  let repairs = 0;
  const controller = new DesktopStartupRepairController(
    async () => { repairs++; },
    () => now,
  );
  const tracker = new DesktopStartupSnapshotTracker((row) => controller.observe(row));

  await tracker.observeSnapshot([{ ...processRow(now - 1_000), pid: 42 }]);
  await tracker.observeSnapshot([{ ...processRow(now - 1_000), pid: 42 }]);
  await tracker.observeSnapshot([{ ...processRow(now - 1_000, 9341), pid: 43 }]);
  await tracker.observeSnapshot([{ ...processRow(now - 1_000, 9341), pid: 43 }]);
  await tracker.observeSnapshot([{ ...processRow(now - 10_000), pid: 44 }]);
  await tracker.observeSnapshot([{ ...processRow(now - 10_000), pid: 44 }]);
  await tracker.observeSnapshot([]); // user close: no host means no launch callback
  assert.equal(repairs, 1);
});

test('repair transaction absorbs a replacement no-CDP PID before controlled launch', async () => {
  const oldRow = { ...processRow(1000), pid: 42, commandLine: '"C:\\Apps\\Cursor\\Cursor.exe" --start_time=123' };
  const replacement = { ...processRow(1001), pid: 43 };
  const snapshots = [[oldRow], [oldRow], [replacement], []];
  const killed = [];
  const events = [];
  let launchArgs = '';
  const result = await repairDesktopProcess(spec, oldRow, undefined, {
    listProcesses: async () => snapshots.shift() || [],
    terminate: async (row) => { killed.push(`${row.pid}:${row.createdAtMs}`); events.push(`kill:${row.pid}`); return true; },
    pickPort: async () => 9341,
    launch: async (_executable, _port, originalArguments) => { launchArgs = originalArguments; events.push('launch'); },
    waitForCdp: async () => ({ port: 9341, browserUrl: 'http://127.0.0.1:9341', browser: 'Chrome/test', target: { id: '1', type: 'page', url: spec.targetUrl, webSocketDebuggerUrl: 'ws://127.0.0.1:9341/devtools/page/1' } }),
    sleep: async () => {},
    now: () => 1001,
    exists: () => true,
  });
  assert.equal(result, 'launched');
  assert.deepEqual(killed, ['42:1000', '43:1001']);
  assert.equal(events.at(-1), 'launch');
  assert.equal(launchArgs, '--start_time=123');
});

test('repair waits for two empty snapshots before controlled launch', async () => {
  const oldRow = { ...processRow(1000), pid: 42 };
  const snapshots = [[oldRow], [oldRow], [], [], []];
  let reads = 0;
  const result = await repairDesktopProcess(spec, oldRow, undefined, {
    listProcesses: async () => { reads++; return snapshots.shift() || []; },
    terminate: async () => true,
    pickPort: async () => 9341,
    launch: async () => {},
    waitForCdp: async () => ({ port: 9341, browserUrl: 'http://127.0.0.1:9341', browser: 'Chrome/test', target: { id: '1', type: 'page', url: spec.targetUrl, webSocketDebuggerUrl: 'ws://127.0.0.1:9341/devtools/page/1' } }),
    sleep: async () => {},
    now: () => 1001,
    exists: () => true,
  });
  assert.equal(result, 'launched');
  assert.equal(reads, 4);
});

test('repair escalates to force-kill only after graceful close leaves the same generation', async () => {
  const row = { ...processRow(1000), pid: 42 };
  const snapshots = [[row], [row], [row], [row], [], [], []];
  const events = [];
  let now = 1001;
  const result = await repairDesktopProcess(spec, row, undefined, {
    listProcesses: async () => snapshots.shift() || [],
    terminate: async () => { events.push('graceful'); return true; },
    forceTerminate: async () => { events.push('force'); return true; },
    pickPort: async () => 9341,
    launch: async () => { events.push('launch'); },
    waitForCdp: async () => ({ port: 9341, browserUrl: 'http://127.0.0.1:9341', browser: 'Chrome/test', target: { id: '1', type: 'page', url: spec.targetUrl, webSocketDebuggerUrl: 'ws://127.0.0.1:9341/devtools/page/1' } }),
    sleep: async () => { now += 1_000; },
    now: () => now,
    exists: () => true,
  });
  assert.equal(result, 'launched');
  assert.deepEqual(events, ['graceful', 'force', 'launch']);
});

test('repair transaction fails closed when forwarded CDP port never opens', async () => {
  const row = processRow(1000);
  const events = [];
  const result = await repairDesktopProcess(spec, row, undefined, {
    listProcesses: async () => events.length ? [] : [row],
    terminate: async () => { events.push('kill'); return true; },
    pickPort: async () => 9341,
    launch: async () => { events.push('launch'); },
    waitForCdp: async () => null,
    sleep: async () => {},
    now: () => 1001,
    exists: () => true,
  });
  assert.equal(result, 'launched');
  assert.deepEqual(events, ['kill', 'launch']);
});

test('controlled launch appends loopback flags after original icon arguments', () => {
  assert.deepEqual(
    buildDesktopLaunchCommand('D:\\Doubao\\app\\Doubao.exe', 9342, '--start_time=123').args,
    ['--start_time=123', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9342'],
  );
});

test('controlled launch drops shell syntax while preserving safe startup flags', () => {
  assert.deepEqual(
    buildDesktopLaunchCommand('D:\\Doubao\\app\\Doubao.exe', 9342, '--start_time=123; Get-Process').args,
    ['--start_time=123', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9342'],
  );
});

test('the Windows monitor uses one persistent CIM snapshot loop', () => {
  // This is the red-capable seam for the real monitor: one long-lived
  // PowerShell process, direct CIM enumeration, and a bounded cadence.
  const source = fs.readFileSync(
    new URL('../src/launch.ts', import.meta.url), 'utf8',
  );
  assert.match(source, /Get-CimInstance Win32_Process -Filter/);
  assert.doesNotMatch(source, /Get-Process -Name/);
  assert.match(source, /Start-Sleep -Milliseconds 500/);
  assert.match(source, /snapshot=\$true;rows=\$rows/);
  assert.doesNotMatch(source, /\$seen=\@\{\}/);
});

test('main-process matching is exact and excludes child processes', () => {
  assert.equal(isDesktopMainProcess(spec, rowCmd(), 'Cursor.exe', 'C:\\Apps\\Cursor\\Cursor.exe', 'win32'), true);
  assert.equal(isDesktopMainProcess(spec, `${rowCmd()} --type=renderer`, 'Cursor.exe', 'C:\\Apps\\Cursor\\Cursor.exe', 'win32'), false);
  assert.equal(isDesktopMainProcess(spec, `${rowCmd()} --type renderer`, 'Cursor.exe', 'C:\\Apps\\Cursor\\Cursor.exe', 'win32'), false);
  assert.equal(isDesktopMainProcess(spec, rowCmd(), 'Cursor.exe', 'D:\\Cursor\\Cursor.exe', 'win32'), false);
  assert.equal(isDesktopMainProcess(spec, rowCmd(), 'powershell.exe', 'C:\\Apps\\Cursor\\Cursor.exe', 'win32'), false);
  assert.equal(isDesktopMainProcess(spec, rowCmd(), 'Cursor.exe', 'C:\\Apps\\Cursor\\Cursor.exe', 'linux'), false);
});

test('same-image descendants without --type are not treated as another main process', () => {
  const exe = 'C:\\Apps\\Cursor\\Cursor.exe';
  const rows = [
    { pid: 100, parentPid: 50, name: 'Cursor.exe', exe, cmd: `"${exe}" --remote-debugging-address=127.0.0.1 --remote-debugging-port=9341`, created: 1000 },
    { pid: 101, parentPid: 100, name: 'Cursor.exe', exe, cmd: `"${exe}" --type=utility`, created: 1001 },
    { pid: 102, parentPid: 101, name: 'Cursor.exe', exe, cmd: `"${exe}" --dns-result-order=ipv4first`, created: 1002 },
  ];
  assert.deepEqual(selectDesktopMainProcesses(spec, rows, 'win32').map((row) => row.pid), [100]);
});

function rowCmd() { return '"C:\\Apps\\Cursor\\Cursor.exe"'; }

test('debug flags reject non-loopback binds and WebSockets reject wrong ports', () => {
  assert.equal(parseRemoteDebuggingFlags('x --remote-debugging-port=9341 --remote-debugging-address=127.0.0.1').safe, true);
  assert.equal(parseRemoteDebuggingFlags('x --remote-debugging-port=9341 --remote-debugging-address=0.0.0.0').safe, false);
  assert.throws(() => assertLoopbackDebuggerUrl('ws://192.168.1.2:9341/devtools/page/1', 9341));
  assert.throws(() => assertLoopbackDebuggerUrl('ws://127.0.0.1:9999/devtools/page/1', 9341));
});

test('probe accepts only the exact host target, not Codex, WorkBuddy, or a web page', async () => {
  let targets = [];
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/json/version') res.end(JSON.stringify({ Browser: 'Chrome/test' }));
    else res.end(JSON.stringify(targets));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const page = (url) => ({ id: '1', type: 'page', url, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/1` });
  try {
    for (const url of ['https://example.com/', 'file:///WorkBuddy/renderer.html', 'http://localhost:5173/codex']) {
      targets = [page(url)];
      assert.equal(await probeDesktopCdp(spec, port), null);
    }
    targets = [page(spec.targetUrl)];
    assert.equal((await probeDesktopCdp(spec, port)).target.url, spec.targetUrl);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('probe rejects an oversized CDP response before parsing it', async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader('content-length', '1000001'); res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { assert.equal(await probeDesktopCdp(spec, server.address().port), null); }
  finally { await new Promise((resolve) => server.close(resolve)); }
});

test('desktop target polling uses a 150ms fake-clock cadence after a 220ms probe', async () => {
  let now = 0;
  let calls = 0;
  const sleeps = [];
  const target = {
    id: '1', type: 'page', url: spec.targetUrl,
    webSocketDebuggerUrl: 'ws://127.0.0.1:9341/devtools/page/1',
  };
  const found = await waitForDesktopCdp(spec, [9341], 1_000, {
    now: () => now,
    discover: async () => {
      calls += 1;
      if (calls === 1) { now += 220; return null; }
      return now >= 220
        ? { port: 9341, browserUrl: 'http://127.0.0.1:9341', browser: 'Chrome/fake', target }
        : null;
    },
    sleep: async (ms) => { sleeps.push(ms); now += ms; },
  });
  assert.equal(found?.target.url, spec.targetUrl);
  assert.deepEqual(sleeps, [150]);
  assert.equal(now, 370);
});

test('desktop renderer scopes host surfaces to active media and uses shared defaults', () => {
  const source = buildDesktopBackgroundInjection(spec);
  assert.match(source, /DESKTOP_DEFAULT_DIM|dim:49/);
  assert.match(source, /blur:0/);
  assert.match(source, /alpha:100/);
  assert.match(source, /html\[data-bc-active="true"\]/);
  assert.match(source, /scope\(selectors\)/);
  assert.match(source, /"popupTopInset":44/);
  assert.match(source, /maxHeight/);
  assert.match(source, /safeTop/);
  assert.doesNotMatch(source, /html,body\{background:transparent!important\}/);
});

test('desktop renderer has an explicit host theme contract and idempotent live refresh', () => {
  const source = buildDesktopBackgroundInjection(spec);
  assert.match(source, /"highContrastClassTokens":\["cursor-high-contrast","hc-black"\]/);
  assert.match(source, /"darkClassTokens":\["cursor-dark","vs-dark"\]/);
  assert.match(source, /"lightClassTokens":\["cursor-light"\]/);
  assert.match(source, /data-bc-theme/);
  assert.match(source, /MutationObserver/);
  assert.match(source, /prefers-color-scheme: dark/);
  assert.match(source, /themeObserver\.disconnect/);
  assert.match(source, /lastTheme/);
  assert.match(source, /data-bc-theme="high-contrast"/);
  assert.match(source, /--bc-panel-bg/);
  assert.match(source, /--bc-panel-border/);
  assert.match(source, /--bc-panel-text/);
  assert.match(source, /data-bc-active="true"/);
});

test('desktop runners fail closed on stale identities and preserve video skin types', () => {
  const source = fs.readFileSync(new URL('../../../scripts/desktop-cdp-runner.mjs', import.meta.url), 'utf8');
  assert.match(source, /assertStableMedia\(resolved, checked\.identity\)/);
  assert.match(source, /downloadApprovedAsset\(item, item\.type/);
  assert.match(source, /createElement\(s\.type==='video'\?'video':'img'\)/);
});
