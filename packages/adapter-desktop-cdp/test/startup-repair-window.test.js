import assert from 'node:assert/strict';
import test from 'node:test';
import { DesktopStartupRepairController, repairDesktopProcess } from '../dist/index.js';

const spec = {
  kind: 'doubaowork',
  displayName: '豆包工作',
  repairWindowMs: 30_000,
};

function repairAtAge(ageMs) {
  let now = 100_000;
  let running = true;
  const events = [];
  const row = {
    pid: 42,
    name: 'DoubaoWork.exe',
    executablePath: 'C:\\Apps\\DoubaoWork.exe',
    commandLine: '"C:\\Apps\\DoubaoWork.exe"',
    port: null,
    createdAtMs: now - ageMs,
  };
  const controller = new DesktopStartupRepairController(
    (processInfo) => repairDesktopProcess(spec, processInfo, undefined, {
      listProcesses: async () => running ? [row] : [],
      terminate: async () => { events.push('close'); running = false; return true; },
      pickPort: async () => 9346,
      launch: async () => { events.push('launch'); },
      waitForCdp: async () => null,
      sleep: async (ms) => { now += ms; },
      now: () => now,
      exists: () => true,
    }),
    () => now,
    spec.repairWindowMs,
  );
  return { controller, row, events };
}

test('a host with a 30 second repair window can repair a 20 second old launch', async () => {
  const { controller, row, events } = repairAtAge(20_000);
  assert.equal(await controller.observe(row), 'repaired');
  assert.deepEqual(events, ['close', 'launch']);
});

test('a launch at the end of its repair window is left alone', async () => {
  const { controller, row, events } = repairAtAge(30_000);
  assert.equal(await controller.observe(row), 'ignore-stale');
  assert.deepEqual(events, []);
});

test('failed close operations are distinguished from successful termination in diagnostics', async () => {
  let now = 100_000;
  const messages = [];
  const row = {
    pid: 42, name: 'DoubaoWork.exe', executablePath: 'C:\\Apps\\DoubaoWork.exe',
    commandLine: '"C:\\Apps\\DoubaoWork.exe"', port: null, createdAtMs: now,
  };
  const log = { info: (message) => messages.push(message), warn: (message) => messages.push(message) };
  const result = await repairDesktopProcess(spec, row, log, {
    listProcesses: async () => [row],
    terminate: async () => false,
    forceTerminate: async () => false,
    pickPort: async () => 9346,
    sleep: async (ms) => { now += Math.max(ms, 600); },
    now: () => now,
    exists: () => true,
  });
  assert.equal(result, 'failed');
  assert.ok(messages.some((message) => /stage=graceful-close .*result=failed/.test(message)));
  assert.ok(messages.some((message) => /stage=force-terminate .*result=failed/.test(message)));
});

test('a slower host can finish its bounded teardown after the original process exits', async () => {
  let now = 100_000;
  let running = true;
  const row = {
    pid: 42, name: 'DoubaoWork.exe', executablePath: 'C:\\Apps\\DoubaoWork.exe',
    commandLine: '"C:\\Apps\\DoubaoWork.exe"', port: null, createdAtMs: now,
  };
  const result = await repairDesktopProcess({ ...spec, repairTransactionTimeoutMs: 20_000 }, row, undefined, {
    listProcesses: async () => { now += 2_000; return running ? [row] : []; },
    terminate: async () => { now += 3_000; return false; },
    forceTerminate: async () => { now += 4_000; running = false; return true; },
    pickPort: async () => 9346,
    launch: async () => {},
    waitForCdp: async () => null,
    sleep: async (ms) => { now += ms; },
    now: () => now,
    exists: () => true,
  });
  assert.equal(result, 'launched');
});

test('a teardown that exceeds its deadline never starts a replacement', async () => {
  let now = 100_000;
  let reads = 0;
  let relaunched = false;
  const row = {
    pid: 42, name: 'DoubaoWork.exe', executablePath: 'C:\\Apps\\DoubaoWork.exe',
    commandLine: '"C:\\Apps\\DoubaoWork.exe"', port: null, createdAtMs: now,
  };
  const result = await repairDesktopProcess({ ...spec, repairTransactionTimeoutMs: 20_000 }, row, undefined, {
    listProcesses: async () => { reads += 1; if (reads === 1) return [row]; now += 10_000; return []; },
    terminate: async () => true,
    pickPort: async () => 9346,
    launch: async () => { relaunched = true; },
    waitForCdp: async () => null,
    sleep: async (ms) => { now += ms; },
    now: () => now,
    exists: () => true,
  });
  assert.equal(result, 'failed');
  assert.equal(relaunched, false);
});
