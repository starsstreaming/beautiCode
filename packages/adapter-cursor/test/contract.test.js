import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CURSOR_CDP_SPEC,
  CURSOR_HOST_DESCRIPTOR,
  buildCursorBackgroundInjection,
} from '../dist/index.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('Cursor uses its measured workbench target and direct Customize successor', () => {
  assert.equal(CURSOR_HOST_DESCRIPTOR.kind, 'cursor');
  assert.equal(CURSOR_HOST_DESCRIPTOR.capabilities.savedThemes, true);
  assert.equal(CURSOR_CDP_SPEC.defaultPort, 9341);
  assert.equal(CURSOR_CDP_SPEC.popupTopInset, 44);
  assert.equal(CURSOR_CDP_SPEC.anchorText, 'Customize');
  assert.equal(CURSOR_CDP_SPEC.strings.entry, 'background');
  assert.deepEqual(CURSOR_CDP_SPEC.theme.highContrastClassTokens, ['cursor-high-contrast', 'hc-black']);
  assert.deepEqual(CURSOR_CDP_SPEC.theme.darkClassTokens, ['cursor-dark', 'vs-dark']);
  assert.deepEqual(CURSOR_CDP_SPEC.theme.lightClassTokens, ['cursor-light']);
  assert.deepEqual(CURSOR_CDP_SPEC.theme.observeAttributes, ['class', 'data-theme']);
  assert.match(CURSOR_CDP_SPEC.targetUrl, /^vscode-file:\/\/vscode-app\/.+workbench\.html$/);
  assert.ok(CURSOR_CDP_SPEC.contract.backdropSelectors.includes('body > div:has(.agent-panel)'));
  assert.ok(CURSOR_CDP_SPEC.contract.backdropSelectors.includes('div:has(> .ui-sidebar)'));
  assert.ok(CURSOR_CDP_SPEC.contract.surfaceSelectors.includes('.ui-sidebar'));
  assert.ok(!CURSOR_CDP_SPEC.contract.surfaceSelectors.includes('.ui-sidebar-header'));
  const source = buildCursorBackgroundInjection();
  assert.match(source, /insertAdjacentElement\('afterend',entry\)/);
  assert.match(source, /nameInput\.value=''/);
  assert.match(source, /__bcDesktopApplyRequest/);
  assert.match(source, /if\(root\.getAttribute\('data-bc-desktop-build'\).*return 'already-installed'/);
  assert.match(source, /window\.__bcDesktopAbort\.abort/);
  assert.match(source, /signal:aborter\.signal/);
  assert.match(source, /dim:49/);
  assert.match(source, /blur:0/);
  assert.match(source, /alpha:100/);
  assert.match(source, /data-bc-theme/);
  assert.match(source, /MutationObserver/);
});

test('shared desktop runner uses TopMost picker, file handles, and does not launch an absent host', () => {
  const runner = fs.readFileSync(path.join(repo, 'scripts', 'desktop-cdp-runner.mjs'), 'utf8');
  const launch = fs.readFileSync(path.join(repo, 'packages', 'adapter-desktop-cdp', 'src', 'launch.ts'), 'utf8');
  assert.match(runner, /\$owner\.TopMost=\$true/);
  assert.match(runner, /ShowDialog\(\$owner\)/);
  assert.match(runner, /DOM\.setFileInputFiles/);
  assert.doesNotMatch(runner, /readFileSync\(resolved/);
  assert.match(launch, /processes\.length === 0/);
  assert.match(launch, /等待用户从原始图标启动/);
  assert.match(launch, /Start-Process -FilePath/);
  assert.doesNotMatch(launch, /created=\[DateTimeOffset\]::UtcNow/);
});
