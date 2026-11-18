import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WallpaperLibrary, parseSteamLibraryFolders } from '../dist/wallpaper-library.js';
import { resolveWallpaperProject } from '../dist/wallpaper-project.js';

async function workspace(t) {
  const temporary = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temporary, 'bc-wallpaper-library-'));
  t.after(async () => {
    assert.match(path.relative(temporary, root), /^bc-wallpaper-library-[^/\\]+$/);
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

test('library sorts the whole inventory before pagination and returns IDs without paths', async t => {
  const root = await workspace(t);
  for (let index = 0; index < 81; index++) {
    await project(root, String(index).padStart(3, '0'), {
      title: String(81 - index).padStart(3, '0'), type: 'video', file: 'clip.mp4',
    });
  }
  const library = await WallpaperLibrary.scan([root, root]);
  const first = library.list(0, 80);
  const second = library.list(80, 80);
  assert.equal(first.total, 81);
  assert.equal(first.items[0].title, '001');
  assert.equal(first.items[79].title, '080');
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].title, '081');
  assert.equal(JSON.stringify(first).includes(root), false);
  assert.equal(library.list(0, 1).items[0].id, first.items[0].id);
  await assert.rejects(() => library.resolve(first.items[0].id), /unavailable/);
});

test('cataloging reads metadata and a selected scene resolves its preview without opening its package', async t => {
  const root = await workspace(t);
  const scene = await project(root, 'scene', { title: '场景', type: 'Scene', file: 'scene.pkg', preview: 'cover.png' });
  await fs.writeFile(path.join(scene, 'cover.png'), '');
  await project(root, 'broken', '{');
  await project(root, 'web', { type: 'web', file: 'index.html' });
  const library = await WallpaperLibrary.scan([root]);
  assert.equal(library.list(0, 10).total, 1);
  const [listed] = library.list(0, 10).items;
  const resolved = await library.resolve(listed.id);
  assert.equal(resolved.mediaPath, path.join(scene, 'cover.png'));
  assert.equal(resolved.type, 'scene');
  await fs.rm(resolved.mediaPath);
  await assert.rejects(() => library.resolve(listed.id), /unavailable/);
  await assert.rejects(() => library.resolve('another-page-id'), /Unknown wallpaper ID/);
});

test('selection checks edited metadata and accepts a nested local video', async t => {
  const root = await workspace(t);
  const dir = await project(root, 'video', { type: 'Video', file: 'media\\clip.mp4' });
  await fs.mkdir(path.join(dir, 'media'));
  await fs.writeFile(path.join(dir, 'media', 'clip.mp4'), '');
  const library = await WallpaperLibrary.scan([root]);
  const [video] = library.list(0, 10).items;
  assert.equal((await library.resolve(video.id)).mediaPath, path.join(dir, 'media', 'clip.mp4'));
  const meta = path.join(dir, 'project.json');
  await fs.writeFile(meta, JSON.stringify({ type: 'video', file: '../outside.mp4' }));
  await assert.rejects(() => library.resolve(video.id), /unsafe/);
  await assert.rejects(() => resolveWallpaperProject(path.join(dir, 'another.json')), /project.json/);
  await fs.writeFile(meta, Buffer.alloc(1024 * 1024 + 1, 32));
  assert.equal((await WallpaperLibrary.scan([root])).list(0, 10).total, 0);
});

test('library rejects invalid pagination and decodes Steam VDF escapes', async () => {
  const library = await WallpaperLibrary.scan([]);
  assert.throws(() => library.list(-1, 80), /pagination/);
  assert.throws(() => library.list(0, 10000), /pagination/);
  assert.deepEqual(parseSteamLibraryFolders('"path" "E:\\\\steam"'), ['E:\\steam']);
  assert.deepEqual(parseSteamLibraryFolders('"path" "bad\\npath"'), []);
});
