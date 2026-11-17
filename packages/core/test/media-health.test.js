import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaHealthState } from '../dist/index.js';

test('an opaque iframe scene is unverified rather than falsely marked decoded or failed', () => {
  assert.equal(mediaHealthState({ selected: true, unverifiable: true, media: false, mediaVisible: true, occluded: false }), 'presentation-unverified');
  assert.equal(mediaHealthState({ selected: true, unverifiable: true, mediaVisible: true, occluded: true }), 'injected-but-occluded');
  assert.equal(mediaHealthState({ selected: true, media: false }), 'media-not-ready');
});
