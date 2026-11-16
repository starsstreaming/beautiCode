import assert from 'node:assert/strict';
import test from 'node:test';

const adapter = await import('../engine.js').catch(() => null);

test('script count uses the pinned engine runtime link and fails closed if it is unavailable', () => {
  assert.equal(typeof adapter?.getSkippedScripts, 'function');
  const instance = {};
  const key = Symbol.for('webwallgl.runtime-link');
  const links = new WeakMap();
  const realm = { [key]: links };
  assert.throws(() => adapter.getSkippedScripts(instance, realm));
  links.set(instance, { sceneCtl: { editor: { getSkippedScripts: () => 3 } } });
  assert.equal(adapter.getSkippedScripts(instance, realm), 3);
  links.set(instance, { sceneCtl: { editor: { getSkippedScripts: () => NaN } } });
  assert.throws(() => adapter.getSkippedScripts(instance, realm));
});
