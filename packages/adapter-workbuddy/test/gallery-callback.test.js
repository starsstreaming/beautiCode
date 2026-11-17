import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

for (const kind of ['image', 'video']) for (const fails of [false, true]) {
  test(`gallery ${kind} callback settles even when persistence ${fails ? 'throws' : 'succeeds'}`, async () => {
    const source = fs.readFileSync(new URL('../src/background-bar.ts', import.meta.url), 'utf8');
    const start = source.indexOf('function applyGalleryPath(p, meta) {');
    const end = source.indexOf('window.__bcApplyBackgroundPath', start);
    const events = {};
    const el = { setAttribute() {}, addEventListener(n, fn) { events[n] = fn; }, remove() {}, play: () => Promise.resolve() };
    const ctx = vm.createContext({ isVideo: () => kind === 'video', isImage: () => kind === 'image', stageEl: () => ({ querySelectorAll: () => [], appendChild() {} }), document: { createElement: () => el }, BC: 'fixture', filePathToUrl: p => p, setTimeout: () => 1, clearTimeout() {}, markMedia() {}, markVideoReady() {}, rememberImportedTheme() {}, persistMark() { if (fails) throw new Error('persistence failed'); }, PERSIST: {}, currentUrl: null });
    vm.runInContext(source.slice(start, end), ctx);
    const result = vm.runInContext("applyGalleryPath('fixture', {themeName:'fixture'})", ctx);
    events[kind === 'video' ? 'loadeddata' : 'load']();
    if (fails) await assert.rejects(result, /persistence failed/);
    else assert.equal(await result, true);
    events.error(); // an obsolete callback cannot change the completed result
  });
}
