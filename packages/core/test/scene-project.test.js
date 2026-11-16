import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { packageBytes } from './fixtures/scene-package.js';

const scene = await import('../dist/scene-project.js').catch(() => null);

async function fixture(t, project = { type: 'Scene', file: 'scene.json', title: '示例' }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-scene-project-'));
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), root);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('unsafe fixture path');
    await fs.rm(root, { recursive: true, force: true });
  });
  const projectPath = path.join(root, 'project.json');
  const pkgPath = path.join(root, 'scene.pkg');
  await fs.writeFile(projectPath, JSON.stringify(project));
  await fs.writeFile(pkgPath, packageBytes());
  return { root, projectPath, pkgPath };
}

function requireValidator() {
  assert.equal(typeof scene?.validateSceneProject, 'function', 'Scene project validation must be available');
  return scene;
}

test('validates a packed scene and changes identity when its project or package changes', async (t) => {
  const { validateSceneProject } = requireValidator();
  const { root, projectPath, pkgPath } = await fixture(t, {
    type: 'Scene', file: 'scene.json', title: '示例', preview: 'preview.gif',
  });
  await fs.writeFile(path.join(root, 'preview.gif'), 'GIF89a');
  const first = await validateSceneProject(projectPath);
  assert.equal(first.projectPath, await fs.realpath(projectPath));
  assert.equal(first.pkgPath, await fs.realpath(pkgPath));
  assert.equal(first.previewPath, await fs.realpath(path.join(root, 'preview.gif')));
  assert.equal(first.identity, (await validateSceneProject(projectPath)).identity);
  await fs.writeFile(projectPath, JSON.stringify({ type: 'scene', file: 'scene.json', title: '更新' }));
  const changedProject = await validateSceneProject(projectPath);
  assert.notEqual(changedProject.identity, first.identity);
  await fs.writeFile(pkgPath, packageBytes([{ name: 'scene.json', content: '{"revision":2}' }]));
  assert.notEqual((await validateSceneProject(projectPath)).identity, changedProject.identity);
});

test('rejects invalid, duplicate and out-of-bounds package indexes', async (t) => {
  const { validateSceneProject } = requireValidator();
  const { projectPath, pkgPath } = await fixture(t);
  const invalid = [
    Buffer.from('not a package'),
    packageBytes([{ name: 'scene.json', content: '{}', offset: 1000 }]),
    packageBytes([{ name: '../outside', content: '{}' }]),
    packageBytes([{ name: 'scene.json', content: '{}' }, { name: 'SCENE.JSON', content: '{}' }]),
    packageBytes([{ name: 'other.json', content: '{}' }]),
  ];
  for (const bytes of invalid) {
    await fs.writeFile(pkgPath, bytes);
    await assert.rejects(() => validateSceneProject(projectPath));
  }
});

test('rejects malformed or oversized metadata and package files', async (t) => {
  const { validateSceneProject } = requireValidator();
  const { projectPath, pkgPath } = await fixture(t);
  for (const text of ['null', '[]', '{', JSON.stringify({ type: 'video', file: 'scene.pkg' }), ' '.repeat(1024 * 1024 + 1)]) {
    await fs.writeFile(projectPath, text);
    await assert.rejects(() => validateSceneProject(projectPath));
  }
  await fs.writeFile(projectPath, JSON.stringify({ type: 'scene', file: 'scene.pkg' }));
  const handle = await fs.open(pkgPath, 'w');
  try { await handle.truncate(512 * 1024 * 1024 + 1); } finally { await handle.close(); }
  await assert.rejects(() => validateSceneProject(projectPath));
});

test('rejects external project resources, network or device paths and linked directories', async (t) => {
  const { validateSceneProject, canonicalLocalPath } = requireValidator();
  const { root, projectPath } = await fixture(t);
  for (const file of ['../outside.pkg', 'C:\\outside.pkg', '\\\\server\\share\\scene.pkg', '\\\\?\\C:\\scene.pkg']) {
    await fs.writeFile(projectPath, JSON.stringify({ type: 'scene', file }));
    await assert.rejects(() => validateSceneProject(projectPath));
  }
  for (const file of ['\\\\server\\share\\project.json', '\\\\?\\C:\\project.json', '\\\\.\\C:\\project.json']) {
    await assert.rejects(() => canonicalLocalPath(file, 'file'), /local|absolute/i);
  }
  await fs.writeFile(projectPath, JSON.stringify({ type: 'scene', file: 'scene.pkg' }));
  const linked = path.join(root, 'linked');
  await fs.symlink(root, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(() => validateSceneProject(path.join(linked, 'project.json')), /link|junction/i);
});

test('cancelled scene validation stops and releases its file handles', async (t) => {
  const { validateSceneProject } = requireValidator();
  const { projectPath, pkgPath } = await fixture(t);
  const controller = new AbortController();
  const validation = validateSceneProject(projectPath, { signal: controller.signal });
  controller.abort();
  await assert.rejects(validation, error => error?.name === 'AbortError');
  await fs.rename(pkgPath, `${pkgPath}.cancelled`);
});

test('rejects a directory replaced by a junction during canonicalization', async (t) => {
  const { canonicalLocalPath } = requireValidator();
  const { root } = await fixture(t);
  const inside = path.join(root, 'inside'), outside = path.join(root, 'outside');
  await fs.mkdir(inside);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(inside, 'project.json'), '{}');
  await fs.writeFile(path.join(outside, 'project.json'), '{}');
  const target = path.join(inside, 'project.json');
  const original = fs.realpath;
  let swapped = false;
  fs.realpath = async (value, ...args) => {
    if (!swapped && value === target) {
      swapped = true;
      await fs.rename(inside, `${inside}-old`);
      await fs.symlink(outside, inside, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return original(value, ...args);
  };
  try {
    await assert.rejects(() => canonicalLocalPath(target, 'file'), /link|changed|redirect/i);
    assert.equal(swapped, true);
  } finally { fs.realpath = original; }
});

test('rejects a swapped directory even if it is restored immediately after opening', async (t) => {
  const { readWallpaperProject } = requireValidator();
  const { root } = await fixture(t);
  const inside = path.join(root, 'inside'), outside = path.join(root, 'outside');
  await fs.mkdir(inside);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(inside, 'project.json'), '{"type":"scene"}');
  await fs.writeFile(path.join(outside, 'project.json'), '{"type":"scene","title":"outside"}');
  const target = path.join(inside, 'project.json');
  const original = fs.open;
  let swapped = false;
  fs.open = async (file, ...args) => {
    if (!swapped && file === target) {
      swapped = true;
      await fs.rename(inside, `${inside}-old`);
      await fs.symlink(outside, inside, process.platform === 'win32' ? 'junction' : 'dir');
      const opened = await original(file, ...args);
      await fs.unlink(inside);
      await fs.rename(`${inside}-old`, inside);
      return opened;
    }
    return original(file, ...args);
  };
  try {
    await assert.rejects(() => readWallpaperProject(target), /changed|redirect/i);
    assert.equal(swapped, true);
  } finally { fs.open = original; }
});
