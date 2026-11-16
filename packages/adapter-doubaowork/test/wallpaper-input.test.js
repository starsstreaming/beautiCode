import assert from 'node:assert/strict';
import test from 'node:test';
import { mediaForProject, readWorkshopItem } from '../dist/wallpaper-library.js';

const projectPath = 'E:\\Steam\\steamapps\\workshop\\content\\431960\\123\\project.json';

test('a malformed project does not prevent other wallpaper projects from being read', () => {
  assert.equal(readWorkshopItem(projectPath, () => 'null', () => true), null);
});

test('video project media must stay inside its own project directory', () => {
  const exists = () => true;
  for (const file of ['..\\private.mp4', '..\\..\\private.mp4', 'C:\\private.mp4', '\\\\server\\share\\private.mp4']) {
    assert.equal(mediaForProject(projectPath, { type: 'video', file }, exists), null, file);
  }
  assert.equal(
    mediaForProject(projectPath, { type: 'video', file: 'media\\wallpaper.mp4' }, exists)?.mediaPath,
    'E:\\Steam\\steamapps\\workshop\\content\\431960\\123\\media\\wallpaper.mp4',
  );
});
