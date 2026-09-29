import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DOUBAO_CDP_SPEC,
  DOUBAO_HOST_DESCRIPTOR,
  buildDoubaoBackgroundInjection,
} from '../dist/index.js';
import { DesktopStartupRepairController } from '@beauticode/adapter-desktop-cdp';

test('Doubao uses the measured chat target and direct More successor', () => {
  assert.equal(DOUBAO_HOST_DESCRIPTOR.kind, 'doubao');
  assert.equal(DOUBAO_HOST_DESCRIPTOR.capabilities.video, true);
  assert.equal(DOUBAO_CDP_SPEC.defaultPort, 9342);
  assert.equal(DOUBAO_CDP_SPEC.popupTopInset, 12);
  assert.equal(DOUBAO_CDP_SPEC.repairSuppressionMs, 0);
  assert.equal(DOUBAO_CDP_SPEC.restartDelayMs, 1_200);
  assert.equal(DOUBAO_CDP_SPEC.targetUrl, 'doubao://doubao-chat/chat');
  assert.equal(DOUBAO_CDP_SPEC.anchorSelector, '[data-testid="skill-page-item-more"]');
  assert.equal(DOUBAO_CDP_SPEC.anchorText, '更多');
  assert.equal(DOUBAO_CDP_SPEC.strings.entry, '自定义背景');
  assert.equal(DOUBAO_CDP_SPEC.theme.rootAttribute, 'data-theme');
  assert.deepEqual(DOUBAO_CDP_SPEC.theme.darkAttributeValues, ['dark']);
  assert.deepEqual(DOUBAO_CDP_SPEC.theme.lightAttributeValues, ['light']);
  assert.deepEqual(DOUBAO_CDP_SPEC.theme.observeAttributes, ['class', 'data-theme']);
  const source = buildDoubaoBackgroundInjection();
  assert.match(source, /insertAdjacentElement\('afterend',entry\)/);
  assert.match(source, /PERSIST\.themes/);
  assert.match(source, /dim:49/);
  assert.match(source, /blur:0/);
  assert.match(source, /alpha:100/);
  assert.match(source, /PERSIST\.cleared=true;PERSIST\.activeThemeId=null;persist\(\)/);
  assert.doesNotMatch(source, /PERSIST\.cleared=true;PERSIST\.themes=\[\]/);
  assert.match(source, /data-bc-theme/);
  assert.match(source, /MutationObserver/);
});

test('a new Doubao PID and creation time remain repairable after a verified session', async () => {
  let now = 1_000;
  let repairs = 0;
  const controller = new DesktopStartupRepairController(
    async () => {
      repairs += 1;
      return 'verified';
    },
    () => now,
    10_000,
    DOUBAO_CDP_SPEC.repairSuppressionMs ?? 0,
  );
  const firstSession = {
    pid: 101,
    name: 'Doubao.exe',
    executablePath: 'D:\\Doubao\\app\\Doubao.exe',
    commandLine: '"D:\\Doubao\\app\\Doubao.exe"',
    port: null,
    createdAtMs: now,
  };
  const nextSession = { ...firstSession, pid: 202, createdAtMs: now + 1 };

  assert.equal(await controller.observe(firstSession), 'repaired');
  now += 1;
  assert.equal(await controller.observe(nextSession), 'repaired');
  assert.equal(repairs, 2);
});
