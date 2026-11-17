import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { updateOwnedPort } from '../../../scripts/windows-owned-env.mjs';

for (const original of [null, { value: '%PORT%', kind: 'ExpandString' }, { value: '9000', kind: 'String' }]) {
  test(`port ownership restores original ${JSON.stringify(original)} after repeat installs`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-env-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const journal = path.join(root, 'journal.json');
    let value = original;
    const registry = { read: () => value, write: v => { value = v; } };
    updateOwnedPort({ journal, port: '9335', registry });
    updateOwnedPort({ journal, port: '9336', registry });
    assert.equal(updateOwnedPort({ journal, remove: true, registry }), 'restored');
    assert.deepEqual(value, original);
    assert.equal(fs.existsSync(journal), false);
  });
}
test('uninstall preserves unowned and externally changed values; interrupted writes keep original', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const journal = path.join(root, 'journal.json');
  let value = { value: '9000', kind: 'String' }, fail = false;
  const registry = { read: () => value, write: v => { if (fail) throw new Error('denied'); value = v; } };
  assert.equal(updateOwnedPort({ journal, remove: true, registry }), 'unmanaged');
  fail = true;
  assert.throws(() => updateOwnedPort({ journal, port: '9335', registry }), /denied/);
  fail = false;
  updateOwnedPort({ journal, port: '9335', registry });
  value = { value: '9999', kind: 'String' };
  assert.equal(updateOwnedPort({ journal, remove: true, registry }), 'externally-changed');
  assert.equal(value.value, '9999');
  assert.throws(() => updateOwnedPort({ journal, port: '9335', registry }), /externally/);
});

test('a failed port change can restore the original and an existing lock blocks mutation', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const journal = path.join(root, 'journal.json');
  let value = null, fail = false;
  const registry = { read: () => value, write: v => { if (fail) throw new Error('denied'); value = v; } };
  updateOwnedPort({ journal, port: '9335', registry });
  fail = true;
  assert.throws(() => updateOwnedPort({ journal, port: '9336', registry }), /denied/);
  fail = false;
  assert.equal(updateOwnedPort({ journal, remove: true, registry }), 'restored');
  assert.equal(value, null);
  fs.writeFileSync(journal + '.lock', '');
  assert.throws(() => updateOwnedPort({ journal, port: '9335', registry }), /EEXIST/);
  assert.equal(value, null);
});
