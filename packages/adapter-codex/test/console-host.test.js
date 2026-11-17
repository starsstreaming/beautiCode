import assert from 'node:assert/strict';
import test from 'node:test';
import { createConsoleHost } from '../dist/console-host.js';

test('the background console describes completed failure instead of asking the user to wait', async () => {
  const diagnostic = 'Live verify did not pass (fail): poster/image missing；事务阶段=rendererVerify=fail';
  const internalResult = { ok: false, error: diagnostic };
  const host = createConsoleHost({ useSavedTheme: async () => internalResult });
  const result = await host.handle({ path: '/__beauticode/ui/theme/use', body: { id: 'test-theme' } });
  assert.equal(result.ok, false);
  assert.match(result.error, /背景验证失败/);
  assert.doesNotMatch(result.error, /等待30/);
  assert.equal(internalResult.error, diagnostic, 'the UI boundary preserves internal diagnostics');
});

test('console preserves rollback evidence and blocked or deferred audio outcomes', async () => {
  const host = createConsoleHost({
    useSavedTheme: async () => ({ ok: false, rolledBack: true, error: 'decode failed' }),
    setMuted: async () => ({ ok: true, muted: false, blocked: true, sessions: 2 }),
  });
  const failure = await host.handle({ path: '/__beauticode/ui/theme/use', body: { id: 'fixture' } });
  assert.equal(failure.rolledBack, true);
  assert.match(failure.error, /磁盘状态已回滚/);
  const audio = await host.handle({ path: '/__beauticode/ui/mode', body: { muted: false } });
  assert.equal(audio.blocked, true);
  assert.equal(audio.sessions, 2);
  assert.match(audio.message, /被阻止/);
  assert.doesNotMatch(audio.message, /声音已打开/);
  const deferred = createConsoleHost({ setMuted: async () => ({ ok: true, muted: false, blocked: false, sessions: 0 }) });
  assert.match((await deferred.handle({ path: '/__beauticode/ui/mode', body: { muted: false } })).message, /等待连接/);
});
