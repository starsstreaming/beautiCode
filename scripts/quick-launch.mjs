import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.basename(here).toLowerCase() === 'scripts' ? path.dirname(here) : here;

export function decideDesktopQuickLaunch(processes) {
  if (processes.length > 1) return 'ambiguous';
  if (processes.length === 0) return 'launch';
  return processes[0].port == null ? 'already-running-blind' : 'already-running-cdp';
}

const SAFE_FAILURE_CODES = new Set([
  'multiple-main-processes',
  'already-running-without-cdp',
  'cdp-target-unavailable',
  'executable-not-found',
  'windows-only',
  'unsupported-host',
]);

export function quickLaunchFailureCode(error) {
  return error instanceof Error && SAFE_FAILURE_CODES.has(error.message)
    ? error.message
    : 'unexpected-error';
}

async function load(relative) {
  return import(pathToFileURL(path.join(runtimeRoot, relative)).href);
}

async function launchDesktop(host) {
  const shared = await load('packages/adapter-desktop-cdp/dist/index.js');
  const adapter = await load(`packages/adapter-${host}/dist/index.js`);
  const spec = host === 'cursor' ? adapter.CURSOR_CDP_SPEC : adapter.DOUBAO_CDP_SPEC;
  const processes = await shared.listDesktopProcesses(spec);
  const decision = decideDesktopQuickLaunch(processes);
  if (decision === 'ambiguous') throw new Error('multiple-main-processes');
  if (decision === 'already-running-blind') throw new Error('already-running-without-cdp');
  if (decision === 'already-running-cdp') {
    const ready = await shared.waitForDesktopCdp(spec, [processes[0].port], 15_000);
    if (!ready) throw new Error('cdp-target-unavailable');
    return 'already-connected';
  }
  const executable = shared.findDesktopExecutable(spec);
  if (!executable) throw new Error('executable-not-found');
  const port = await shared.pickAvailableDesktopPort(spec);
  await shared.launchDesktopWithCdp(executable, port);
  const ready = await shared.waitForDesktopCdp(spec, [port], 15_000);
  if (!ready) throw new Error('cdp-target-unavailable');
  return 'connected';
}

export async function runQuickLaunch(host) {
  if (process.platform !== 'win32') throw new Error('windows-only');
  if (host === 'codex-plugin') {
    const packed = path.join(runtimeRoot, 'vendor', 'adapter-codex', 'index.js');
    const { ensureCodexCdp } = await load(fs.existsSync(packed)
      ? 'vendor/adapter-codex/index.js'
      : 'packages/adapter-codex/dist/index.js');
    const ready = await ensureCodexCdp({ restartIfBlind: false, timeoutMs: 20_000 });
    return ready.launched ? 'connected' : 'already-connected';
  }
  if (host === 'workbuddy') {
    const { ensureWorkBuddyCdp } = await load('packages/adapter-workbuddy/dist/index.js');
    const ready = await ensureWorkBuddyCdp({ restartIfBlind: false, timeoutMs: 20_000 });
    return ready.launched ? 'connected' : 'already-connected';
  }
  if (host === 'cursor' || host === 'doubao') return launchDesktop(host);
  throw new Error('unsupported-host');
}

async function main() {
  const host = String(process.argv[2] || '').toLowerCase();
  const dataHost = host === 'codex-plugin' ? 'codex' : host;
  const file = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'beautiCode', 'hosts', dataHost, 'quick-launch.json');
  let state;
  try {
    state = { at: new Date().toISOString(), result: await runQuickLaunch(host) };
  } catch (error) {
    // The shortcut is hidden; retain a bounded local diagnostic without URLs or command lines.
    state = { at: new Date().toISOString(), result: 'failed', reason: quickLaunchFailureCode(error) };
    process.exitCode = 1;
  }
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, JSON.stringify(state) + '\n', 'utf8');
  process.stdout.write(JSON.stringify(state) + '\n');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href.toLowerCase() === import.meta.url.toLowerCase()) {
  await main();
}
