import assert from 'node:assert/strict';
import test from 'node:test';
import { createConsoleHost } from '../dist/console-host.js';

test('the background console displays the requested media verification hint', async () => {
  const diagnostic = 'Live verify did not pass (fail): poster/image missing；事务阶段=rendererVerify=fail';
  const internalResult = { ok: false, error: diagnostic };
  const host = createConsoleHost({ useSavedTheme: async () => internalResult });
  const result = await host.handle({ path: '/__beauticode/ui/theme/use', body: { id: 'test-theme' } });
  assert.deepEqual(result, { ok: false, error: '正在媒体验证中，请等待30s再次导入' });
  assert.equal(internalResult.error, diagnostic, 'the UI boundary preserves internal diagnostics');
});
