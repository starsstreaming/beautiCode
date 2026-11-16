import assert from 'node:assert/strict';
import test from 'node:test';

const runtime = await import('../runtime.js').catch(() => null);
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  const events = new Map(), timers = new Map(), messages = [], actions = [];
  const parent = {};
  const port = { postMessage: data => messages.push(data), start() {}, close() { actions.push('close'); } };
  const engine = {
    canvas: new EventTarget(), skipped: 0,
    pause() { actions.push('pause'); }, resume() { actions.push('resume'); },
    setVolume(value) { actions.push(['volume', value]); },
    setRenderDpr(value) { actions.push(['dpr', value]); },
    destroy(options) { actions.push(['destroy', options]); },
  };
  let nextTimer = 0, options, resolveMount;
  const win = {
    parent,
    document: { getElementById: () => ({}) },
    addEventListener: (type, handler) => events.set(type, handler),
    removeEventListener: type => events.delete(type),
    dispatchEvent() {}, Event: class {},
    setInterval: fn => { timers.set(++nextTimer, fn); return nextTimer; },
    clearInterval: id => timers.delete(id),
    URL: { createObjectURL() { return 'blob:fixture'; }, revokeObjectURL(url) { actions.push(['revoke', url]); } },
  };
  const api = {
    bytesSource: (bytes, project) => ({ bytes, project }),
    getSkippedScripts: instance => instance.skipped,
    mount: (_slot, value) => { options = value; return new Promise(resolve => { resolveMount = () => resolve(engine); }); },
  };
  return {
    win, port, messages, actions, api, events, timers, engine,
    get options() { return options; },
    resolveMount: () => resolveMount(),
    tick: () => [...timers.values()].forEach(fn => fn()),
    init(source = parent) {
      events.get('message')?.({ source, data: { type: 'beauticode:scene-init', bytes: new ArrayBuffer(16), project: { type: 'scene' }, renderDpr: 1.5 }, ports: [port] });
    },
  };
}

test('frame accepts one parent handshake and reports ready only after an actual script-free mount', async () => {
  assert.equal(typeof runtime?.installFrame, 'function');
  const h = harness();
  runtime.installFrame(h.win, h.api);
  h.init({});
  assert.equal(h.options, undefined);
  h.init();
  await Promise.resolve();
  assert.equal(h.options.scripts, false);
  assert.equal(h.options.volume, 0);
  assert.equal(h.options.autoQuality, false);
  assert.equal(h.options.renderDpr, 1.5);
  assert.deepEqual(h.messages, []);
  h.resolveMount();
  await flush();
  assert.equal(h.messages.filter(message => message.type === 'ready').length, 1);
  h.port.onmessage({ data: { type: 'pause' } });
  h.port.onmessage({ data: { type: 'muted', value: false } });
  h.port.onmessage({ data: { type: 'resume' } });
  h.port.onmessage({ data: { type: 'resize', renderDpr: 2 } });
  h.port.onmessage({ data: { type: 'dispose' } });
  assert.deepEqual(h.actions, ['pause', ['volume', 1], 'resume', ['dpr', 2], ['destroy', { releasePkgCache: true }], 'close']);
  assert.equal(h.timers.size, 0);
});

test('a scene requiring skipped scripts fails before ready and releases its engine', async () => {
  assert.equal(typeof runtime?.installFrame, 'function');
  const h = harness();
  runtime.installFrame(h.win, h.api);
  h.init();
  await Promise.resolve();
  h.engine.skipped = 1;
  h.resolveMount();
  await flush();
  assert.deepEqual(h.messages, [{ type: 'error', code: 'SCENE_SCRIPT_UNSUPPORTED' }]);
  assert.ok(h.actions.some(action => Array.isArray(action) && action[0] === 'destroy'));
  assert.equal(h.timers.size, 0);
});

test('scripts discovered after the first frame stop playback and report an error', async () => {
  assert.equal(typeof runtime?.installFrame, 'function');
  const h = harness();
  runtime.installFrame(h.win, h.api);
  h.init();
  await Promise.resolve();
  h.resolveMount();
  await flush();
  h.tick();
  assert.ok(h.messages.some(message => message.type === 'heartbeat'));
  h.engine.skipped = 1;
  h.tick();
  assert.equal(h.messages.at(-1).code, 'SCENE_SCRIPT_UNSUPPORTED');
  assert.ok(h.actions.some(action => Array.isArray(action) && action[0] === 'destroy'));
  assert.equal(h.timers.size, 0);
});

test('late mount after cancellation is destroyed and an error never includes scene details', async () => {
  assert.equal(typeof runtime?.installFrame, 'function');
  const h = harness();
  runtime.installFrame(h.win, h.api);
  h.init();
  await Promise.resolve();
  h.win.URL.createObjectURL({});
  h.port.onmessage({ data: { type: 'dispose' } });
  h.resolveMount();
  await flush();
  assert.ok(h.actions.some(action => Array.isArray(action) && action[0] === 'destroy'));
  assert.ok(h.actions.some(action => Array.isArray(action) && action[0] === 'revoke'));
  assert.equal(h.messages.some(message => message.type === 'ready'), false);

  const failure = harness();
  runtime.installFrame(failure.win, failure.api);
  failure.init();
  await Promise.resolve();
  failure.resolveMount();
  await flush();
  failure.events.get('error')?.({ message: 'secret from scene' });
  assert.equal(failure.messages.at(-1).code, 'SCENE_RUNTIME_FAILED');
  assert.ok(!JSON.stringify(failure.messages).includes('secret from scene'));
});

test('a rejected mount releases the partial instance attached by WebWallGL', async () => {
  assert.equal(typeof runtime?.installFrame, 'function');
  const h = harness();
  h.api.mount = () => Promise.reject(Object.assign(new Error('private details'), { instance: h.engine }));
  runtime.installFrame(h.win, h.api);
  h.init();
  await flush();
  assert.deepEqual(h.messages, [{ type: 'error', code: 'SCENE_MOUNT_FAILED' }]);
  assert.ok(h.actions.some(action => Array.isArray(action) && action[0] === 'destroy' && action[1].releasePkgCache));
});
