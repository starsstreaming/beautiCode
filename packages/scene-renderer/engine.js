/**
 * WebWallGL 3.0.0 exposes the skipped-script counter only on its internal
 * editor, not on SceneInstance. This pinned-version bridge stays inside the
 * opaque frame. Replace it when upstream publishes the counter on SceneInstance;
 * build.mjs checks the internal anchors and absence always fails closed.
 */
export function getSkippedScripts(instance, realm = globalThis) {
  const runtime = realm[Symbol.for('webwallgl.runtime-link')]?.get(instance);
  const editor = runtime?.sceneCtl?.editor;
  if (typeof editor?.getSkippedScripts !== 'function') throw new Error('Script status is unavailable');
  const count = editor.getSkippedScripts();
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid script status');
  return count;
}
