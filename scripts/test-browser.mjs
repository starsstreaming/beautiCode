import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

if (!process.env.BEAUTICODE_PLAYWRIGHT_MODULE) {
  throw new Error('BEAUTICODE_PLAYWRIGHT_MODULE is required; browser validation must not silently skip.');
}
process.env.BEAUTICODE_BROWSER_CHANNEL ||= 'msedge';
const tests = [
  'packages/adapter-codex/test/appearance.browser.test.js',
  'packages/adapter-codex/test/wallpaper.browser.test.js',
  'integrations/deepseek-harness/test/background-rendering.browser.test.mjs',
  'integrations/deepseek-harness/test/plugin-readability.browser.test.mjs',
];
for (const directory of ['packages/adapter-codex/test', 'packages/adapter-desktop-cdp/test']) {
  for (const file of fs.readdirSync(directory).filter(name => name.endsWith('.browser.test.js'))) {
    const target = directory + '/' + file;
    if (!tests.includes(target)) tests.push(target);
  }
}
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...tests], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true });
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
if (result.error) throw result.error;
const summary = /(?:skipped|skip)\s+(\d+)/g;
const skipped = [...(result.stdout || '').matchAll(summary)].some(match => Number(match[1]) > 0);
process.exitCode = result.status !== 0 || skipped ? 1 : 0;
