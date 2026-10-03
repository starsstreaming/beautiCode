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
import * as cursorModule from '../dist/index.js';
import { isDesktopTarget } from '../../adapter-desktop-cdp/dist/index.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('Cursor uses its measured workbench target and direct Customize successor', () => {
  assert.equal(CURSOR_HOST_DESCRIPTOR.kind, 'cursor');
  assert.equal(CURSOR_HOST_DESCRIPTOR.capabilities.savedThemes, true);
  assert.equal(CURSOR_CDP_SPEC.defaultPort, 9341);
  assert.equal(CURSOR_CDP_SPEC.popupTopInset, 44);
  assert.equal(CURSOR_CDP_SPEC.anchorText, 'Customize');
  assert.equal(CURSOR_CDP_SPEC.anchorSelector, '[data-action-id="marketplace"][data-sidebar-primary-action], .agent-sidebar-header-actions > .agent-sidebar-cell:nth-child(2)');
  assert.equal(CURSOR_CDP_SPEC.strings.entry, 'background');
  assert.deepEqual(CURSOR_CDP_SPEC.theme.highContrastClassTokens, ['cursor-high-contrast', 'hc-black']);
  assert.deepEqual(CURSOR_CDP_SPEC.theme.darkClassTokens, ['cursor-dark', 'vs-dark']);
  assert.deepEqual(CURSOR_CDP_SPEC.theme.lightClassTokens, ['cursor-light', 'vs', 'vs-light']);
  assert.deepEqual(CURSOR_CDP_SPEC.theme.observeAttributes, ['class', 'data-theme']);
  assert.equal(CURSOR_CDP_SPEC.targetUrl, 'vscode-file://vscode-app/');
  assert.deepEqual(CURSOR_CDP_SPEC.targetIdentity, {
    protocol: 'vscode-file:',
    hostname: 'vscode-app',
    pathSuffix: '/resources/app/out/vs/code/electron-sandbox/workbench/workbench.html',
    hostEvidence: {
      path: ['/cursor/'],
      targetText: ['cursor'],
      browser: ['cursor'],
    },
  });
  assert.ok(CURSOR_CDP_SPEC.contract.backdropSelectors.includes('body > div:has(.agent-panel)'));
  assert.ok(CURSOR_CDP_SPEC.contract.backdropSelectors.includes('div:has(> .ui-sidebar)'));
  assert.ok(CURSOR_CDP_SPEC.contract.surfaceSelectors.includes('.ui-sidebar'));
  assert.ok(!CURSOR_CDP_SPEC.contract.surfaceSelectors.includes('.ui-sidebar-header'));
  const source = buildCursorBackgroundInjection();
  assert.match(source, /agent-sidebar-cell-text/);
  assert.match(source, /agent-sidebar-cell-icon/);
  assert.match(source, /ui-sidebar-menu-button-label/);
  assert.match(source, /ui-sidebar-menu-button-icon-wrapper/);
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

test('Cursor target identity accepts relocated installs but fails closed for other CDP pages', () => {
  const relocated = {
    id: 'cursor',
    type: 'page',
    title: 'Cursor',
    url: 'vscode-file://vscode-app/C:/Tools/Editor/resources/app/out/vs/code/electron-sandbox/workbench/workbench.html',
  };
  assert.equal(isDesktopTarget(CURSOR_CDP_SPEC, relocated, 'Chrome/128 Cursor/3.0'), true);
  for (const url of [
    'https://example.com/resources/app/out/vs/code/electron-sandbox/workbench/workbench.html',
    'file:///C:/WorkBuddy/resources/app/out/vs/code/electron-sandbox/workbench/workbench.html',
    'app://codex/resources/app/out/vs/code/electron-sandbox/workbench/workbench.html',
    'vscode-file://vscode-app/C:/Tools/Other/resources/app/out/vs/code/electron-sandbox/workbench/workbench.html',
  ]) {
    assert.equal(isDesktopTarget(CURSOR_CDP_SPEC, { id: 'foreign', type: 'page', url }), false, url);
  }
});

test('Cursor process identity uses only an owned, valid custom executable record', () => {
  assert.equal(typeof cursorModule.cursorExecutableCandidates, 'function');
  const options = {
    env: { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' },
    readRecord: () => ({ schema: 'beauticode.host-executable/v1', host: 'cursor', path: 'D:\\cursor\\Cursor.exe' }),
    exists: (file) => file.toLowerCase() === 'd:\\cursor\\cursor.exe',
    realpath: (file) => file,
  };
  assert.ok(cursorModule.cursorExecutableCandidates(options).includes('D:\\cursor\\Cursor.exe'));
  assert.ok(!cursorModule.cursorExecutableCandidates({ ...options, readRecord: () => ({ ...options.readRecord(), host: 'doubao' }) }).includes('D:\\cursor\\Cursor.exe'));
  assert.ok(!cursorModule.cursorExecutableCandidates({ ...options, readRecord: () => ({ ...options.readRecord(), path: 'D:\\other\\Other.exe' }) }).includes('D:\\other\\Other.exe'));
  assert.ok(!cursorModule.cursorExecutableCandidates({ ...options, exists: () => false }).includes('D:\\cursor\\Cursor.exe'));
});

test('shared desktop runner uses TopMost picker, file handles, and does not launch an absent host', () => {
  const runner = fs.readFileSync(path.join(repo, 'scripts', 'desktop-cdp-runner.mjs'), 'utf8');
  const launch = fs.readFileSync(path.join(repo, 'packages', 'adapter-desktop-cdp', 'src', 'launch.ts'), 'utf8');
  const ensure = fs.readFileSync(path.join(repo, 'packages', 'adapter-desktop-cdp', 'src', 'ensure.ts'), 'utf8');
  assert.match(runner, /\$owner\.TopMost=\$true/);
  assert.match(runner, /ShowDialog\(\$owner\)/);
  assert.match(runner, /DOM\.setFileInputFiles/);
  assert.doesNotMatch(runner, /readFileSync\(resolved/);
  assert.match(ensure, /processes\.length === 0/);
  assert.match(ensure, /等待用户从原始图标启动/);
  assert.match(launch, /Start-Process -FilePath/);
  assert.doesNotMatch(launch, /created=\[DateTimeOffset\]::UtcNow/);
});
