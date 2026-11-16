import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const token = 'a'.repeat(32);
const base = `http://127.0.0.1:4400/scene/${token}`;
const config = { pkgUrl: `${base}/scene.pkg?t=${token}`, bundleUrl: `${base}/scene-frame.js?t=${token}`, project: { type: 'scene', file: 'scene.json' } };

async function setup() {
  const source = await fs.readFile(new URL('../player.js', import.meta.url), 'utf8').catch(() => '');
  const messages = [], commands = [], frames = [], docEvents = new Map(), globalEvents = new Map();
  let channel, onFailure;
  const document = {
    hidden: false,
    addEventListener: (type, callback) => docEvents.set(type, callback),
    removeEventListener: type => docEvents.delete(type),
    createElement: () => {
      const frame = {
        style: {}, attrs: {}, handlers: {}, removed: false,
        setAttribute(name, value) { this.attrs[name] = value; },
        addEventListener(type, callback) { this.handlers[type] = callback; },
        remove() { this.removed = true; },
        contentWindow: { postMessage(data, origin, transferred) { messages.push({ data, origin, transferred }); } },
      };
      frames.push(frame);
      return frame;
    },
  };
  class MessageChannel {
    constructor() {
      this.port1 = { onmessage: null, start() {}, close() {}, postMessage: data => commands.push(data) };
      this.port2 = {};
      channel = this;
    }
  }
  const context = {
    URL, AbortController, DOMException, Uint8Array, TextDecoder, setTimeout, clearTimeout, setInterval, clearInterval,
    document, MessageChannel, crypto: { randomUUID: () => '12345678-1234-1234-1234-123456789abc' },
    addEventListener: (type, callback) => globalEvents.set(type, callback),
    removeEventListener: type => globalEvents.delete(type),
    fetch: async url => new Response(url.includes('scene-frame.js') ? 'window.fixture=1;' : new Uint8Array([1, 2, 3])),
  };
  vm.runInNewContext(source, context);
  assert.ok(context.BeauticodeScenePlayer, 'shared scene player exists');
  const slot = { append(frame) { queueMicrotask(() => frame.handlers.load()); } };
  return {
    api: context.BeauticodeScenePlayer, document, frames, messages, commands, slot,
    start() { return this.api.mount(slot, config, { timeoutMs: 1000, onError: error => { onFailure = error; } }); },
    get channel() { return channel; }, get failure() { return onFailure; },
  };
}

test('accepts only matching tokenized package and bundle URLs at 127.0.0.1', async () => {
  const h = await setup();
  const validate = h.api._test.validateConfig;
  assert.equal(validate(config).project.type, 'scene');
  for (const bad of [
    { ...config, pkgUrl: config.pkgUrl.replace('127.0.0.1', 'evil.invalid') },
    { ...config, pkgUrl: config.pkgUrl.replace('http:', 'https:') },
    { ...config, pkgUrl: `${config.pkgUrl}&x=1` },
    { ...config, bundleUrl: config.bundleUrl.replace(token, 'b'.repeat(32)) },
    { ...config, bundleUrl: config.bundleUrl.replace('/scene-frame.js', '/private') },
    { ...config, project: { type: 'web' } },
  ]) assert.throws(() => validate(bad));
});

test('bounds resource reads by both response length and actual streamed bytes', async () => {
  const h = await setup();
  const read = h.api._test.readLimited;
  assert.equal((await read(new Response(new Uint8Array([1, 2])), 2)).byteLength, 2);
  await assert.rejects(read(new Response('123', { headers: { 'Content-Length': '3' } }), 2), /size/i);
  await assert.rejects(read(new Response('123'), 2), /size/i);
});

test('frame document blocks remote resources and dynamic script evaluation', async () => {
  const h = await setup();
  const html = h.api._test.frameDocument('globalThis.x="</script>";', 'abc');
  assert.match(html, /default-src 'none'/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /worker-src 'none'/);
  assert.match(html, /frame-src 'none'/);
  assert.ok(!html.includes('unsafe-eval'));
  assert.equal((html.match(/<\/script>/g) || []).length, 1);
});

test('only bytes and project cross the single-use sandbox channel; later errors dispose playback', async () => {
  const h = await setup();
  const pending = h.start();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(h.frames.length, 1);
  assert.equal(h.frames[0].attrs.sandbox, 'allow-scripts');
  assert.equal(h.messages.length, 1);
  const init = h.messages[0].data;
  assert.deepEqual(Object.keys(init).sort(), ['bytes', 'project', 'renderDpr', 'type']);
  assert.equal(init.bytes.byteLength, 3);
  assert.ok(!JSON.stringify(init).includes(token));
  h.channel.port1.onmessage({ data: { type: 'ready' } });
  const controller = await pending;
  controller.setMuted(false);
  controller.setPaused(true);
  assert.ok(h.commands.some(command => command.type === 'muted' && command.value === false));
  assert.ok(h.commands.some(command => command.type === 'pause'));
  h.channel.port1.onmessage({ data: { type: 'error', code: 'SCENE_SCRIPT_UNSUPPORTED' } });
  assert.equal(h.frames[0].removed, true);
  assert.equal(controller.disposed, true);
  assert.match(h.failure.message, /script/i);
});

test('abort before the first frame removes the candidate without changing the slot', async () => {
  const h = await setup();
  const controller = new AbortController();
  const pending = h.api.mount(h.slot, config, { signal: controller.signal, timeoutMs: 1000 });
  await new Promise(resolve => setTimeout(resolve, 20));
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(h.frames[0].removed, true);
});
