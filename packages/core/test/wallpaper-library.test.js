import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { packageBytes } from './fixtures/scene-package.js';

const api = await import('../dist/wallpaper-library.js').catch(() => null);

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bc-wallpaper-library-'));
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), root);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('unsafe fixture path');
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

async function project(root, name, metadata) {
  const dir = path.join(root, name);
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'project.json'), typeof metadata === 'string' ? metadata : JSON.stringify(metadata));
  return dir;
}

function minimalVideo() {
  const bytes = Buffer.alloc(24);
  bytes.writeUInt32BE(24, 0);
  bytes.write('ftyp', 4);
  bytes.write('isom', 8);
  bytes.write('isom', 16);
  bytes.write('mp41', 20);
  return bytes;
}

test('library indexes scenes and videos without exposing paths and isolates malformed projects', async (t) => {
  assert.equal(typeof api?.WallpaperLibrary, 'function');
  const root = await workspace(t);
  const video = await project(root, 'video', { title: '视频', type: 'Video', file: 'clip.mp4', preview: 'preview.gif' });
  await fs.writeFile(path.join(video, 'clip.mp4'), minimalVideo());
  await fs.writeFile(path.join(video, 'preview.gif'), 'GIF89a');
  const scene = await project(root, 'scene', { title: '场景', type: 'Scene', file: 'scene.pkg' });
  await fs.writeFile(path.join(scene, 'scene.pkg'), packageBytes());
  await project(root, 'web', { title: '网页', type: 'Web', file: 'index.html' });
  await project(root, 'broken', '{');

  const library = new api.WallpaperLibrary();
  await library.connect(root);
  await library.connect(root);
  const all = await library.list();
  assert.equal(library.roots.length, 1);
  assert.equal(all.total, 3);
  assert.ok(all.warnings.length > 0);
  assert.equal(JSON.stringify(all).includes(root), false);
  const byType = Object.fromEntries(all.items.map(item => [item.type, item]));
  assert.equal(byType.video.available, true);
  assert.equal(byType.scene.available, true);
  assert.equal(byType.web.available, false);
  assert.equal(byType.video.hasPreview, true);
  assert.notEqual(byType.video.id, byType.scene.id);
  assert.equal((await library.list({ q: '场景', type: 'SCENE' })).total, 1);
  assert.equal((await library.list({ offset: 1, limit: 1 })).items.length, 1);
  assert.equal((await library.resolve(byType.video.id)).mediaPath, await fs.realpath(path.join(video, 'clip.mp4')));
  assert.equal((await library.resolve(byType.scene.id)).projectPath, await fs.realpath(path.join(scene, 'project.json')));

  await fs.writeFile(path.join(video, 'project.json'), JSON.stringify({ type: 'video', file: '../outside.mp4' }));
  await assert.rejects(() => library.resolve(byType.video.id));
  await assert.rejects(() => library.resolve(byType.web.id));
  library.disconnect(root);
  await assert.rejects(() => library.resolve(byType.scene.id));
});

test('disconnect invalidates an in-flight scan instead of restoring revoked IDs', async (t) => {
  assert.equal(typeof api?.WallpaperLibrary, 'function');
  const root = await workspace(t);
  await project(root, 'web', { title: '网页', type: 'web', file: 'index.html' });
  const library = new api.WallpaperLibrary();
  await library.connect(root);
  const scan = library.list();
  library.disconnect(root);
  await assert.rejects(scan, /changed|refresh/i);
  assert.equal((await library.list()).total, 0);
});

test('library rejects invalid pagination and decodes only safe Steam VDF escapes', async (t) => {
  assert.equal(typeof api?.WallpaperLibrary, 'function');
  const library = new api.WallpaperLibrary();
  await assert.rejects(() => library.list({ offset: -1 }));
  await assert.rejects(() => library.list({ limit: 10000 }));
  assert.deepEqual(api.parseSteamLibraryFolders('"path" "E:\\\\steam"'), ['E:\\steam']);
  assert.deepEqual(api.parseSteamLibraryFolders('"path" "bad\\npath"'), []);
});
