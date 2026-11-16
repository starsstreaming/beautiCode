(() => {
  'use strict';
  if (globalThis.BeauticodeScenePlayer) return;
  const MAX_PKG_BYTES = 512 * 1024 * 1024;
  const nativeDpr = () => Math.max(1, Math.min(4, Number(globalThis.devicePixelRatio) || 1));

  function localResource(value, filename) {
    const url = new URL(value);
    const match = /^\/scene\/([a-f0-9]{32})\/(scene\.pkg|scene-frame\.js)$/.exec(url.pathname);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.hash ||
        !match || match[2] !== filename || url.search !== `?t=${match[1]}`) throw new Error('Invalid scene resource');
    return { url, token: match[1] };
  }
  function validateConfig(config) {
    if (!config || typeof config.pkgUrl !== 'string' || typeof config.bundleUrl !== 'string' ||
        !config.project || typeof config.project !== 'object' || Array.isArray(config.project) ||
        String(config.project.type).toLowerCase() !== 'scene') throw new Error('Only scene projects are supported');
    const pkg = localResource(config.pkgUrl, 'scene.pkg');
    const bundle = localResource(config.bundleUrl, 'scene-frame.js');
    if (pkg.url.origin !== bundle.url.origin || pkg.token !== bundle.token) throw new Error('Scene resources do not match');
    const serialized = JSON.stringify(config.project);
    if (!serialized || serialized.length > 1024 * 1024) throw new Error('Scene project exceeds size limit');
    return { pkgUrl: pkg.url.href, bundleUrl: bundle.url.href, project: { ...JSON.parse(serialized), type: 'scene' } };
  }
  async function readLimited(response, limit = MAX_PKG_BYTES) {
    if (!response.ok) throw new Error('Scene resource unavailable');
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
      await response.body?.cancel?.().catch(() => {});
      throw new Error('Scene resource exceeds size limit');
    }
    if (!response.body) throw new Error('Scene resource has no body');
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new Error('Scene resource exceeds size limit');
        chunks.push(value);
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes.buffer;
  }
  function frameDocument(bundle, nonce) {
    const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src blob: data:; media-src blob: data:; font-src blob: data:; connect-src 'none'; worker-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'`;
    return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><style>html,body,#scene{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}canvas{display:block}</style></head><body><div id="scene"></div><script nonce="${nonce}">${bundle.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
  }
  function errorFor(code) {
    return new Error(code === 'SCENE_SCRIPT_UNSUPPORTED' ? 'Scene scripts are not supported safely' :
      code === 'SCENE_HEARTBEAT_TIMEOUT' ? 'Scene renderer stopped responding' : 'Scene renderer failed');
  }
  async function mount(slot, input, { signal, timeoutMs = 60_000, onError } = {}) {
    const config = validateConfig(input);
    if (!slot || typeof slot.append !== 'function') throw new TypeError('Scene slot is required');
    if (signal?.aborted) throw new DOMException('Scene mount aborted', 'AbortError');
    const abort = new AbortController();
    let frame, port, timer, watchdog, observer, disposed = false, settled = false, paused = false;
    let healthError = null, lastHeartbeat = Date.now();
    let resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const post = data => { if (!disposed && port) { try { port.postMessage(data); } catch { /* A closing frame is already being discarded. */ } } };
    const visibility = () => { lastHeartbeat = Date.now(); post({ type: paused || document.hidden ? 'pause' : 'resume' }); };
    const resize = () => post({ type: 'resize', renderDpr: nativeDpr() });
    const controller = {
      get error() { return healthError; },
      get disposed() { return disposed; },
      dispose() {
        if (disposed) return;
        if (!settled) { settled = true; rejectReady(new DOMException('Scene mount aborted', 'AbortError')); }
        post({ type: 'dispose' });
        disposed = true;
        clearTimeout(timer); clearInterval(watchdog); abort.abort();
        signal?.removeEventListener('abort', onAbort);
        document.removeEventListener('visibilitychange', visibility);
        globalThis.removeEventListener('resize', resize);
        observer?.disconnect(); port?.close(); frame?.remove();
      },
      setMuted(value) { post({ type: 'muted', value: Boolean(value) }); },
      setPaused(value) { paused = Boolean(value); visibility(); },
    };
    function fail(error) {
      if (disposed) return;
      const wasReady = settled;
      if (error?.name !== 'AbortError') healthError = error;
      if (!settled) { settled = true; rejectReady(error); }
      controller.dispose();
      if (wasReady && healthError && typeof onError === 'function') {
        try { onError(healthError); } catch { /* Host callbacks must not prevent disposal. */ }
      }
    }
    function onAbort() { fail(new DOMException('Scene mount aborted', 'AbortError')); }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    timer = setTimeout(() => fail(new Error('Scene first-frame timeout')), Math.max(1, Math.min(Number(timeoutMs) || 60_000, 120_000)));
    void (async () => {
      try {
        const options = { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: abort.signal };
        const [bundleBytes, bytes] = await Promise.all([
          fetch(config.bundleUrl, options).then(response => readLimited(response, 8 * 1024 * 1024)),
          fetch(config.pkgUrl, options).then(response => readLimited(response)),
        ]);
        if (disposed) return;
        frame = document.createElement('iframe');
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.setAttribute('title', 'beautiCode 场景背景');
        frame.setAttribute('aria-hidden', 'true'); frame.setAttribute('tabindex', '-1');
        frame.setAttribute('referrerpolicy', 'no-referrer');
        Object.assign(frame.style, { width: '100%', height: '100%', border: '0', pointerEvents: 'none', display: 'block' });
        frame.srcdoc = frameDocument(new TextDecoder().decode(bundleBytes), crypto.randomUUID().replace(/-/g, ''));
        frame.addEventListener('load', () => {
          if (disposed || port) return;
          const channel = new MessageChannel(); port = channel.port1;
          port.onmessage = ({ data }) => {
            if (disposed || !data || typeof data !== 'object') return;
            if (data.type === 'heartbeat') lastHeartbeat = Date.now();
            else if (data.type === 'ready' && !settled) {
              settled = true; clearTimeout(timer); lastHeartbeat = Date.now();
              watchdog = setInterval(() => {
                if (!paused && !document.hidden && Date.now() - lastHeartbeat > 12_000) fail(errorFor('SCENE_HEARTBEAT_TIMEOUT'));
              }, 3000);
              resolveReady(controller); visibility();
            } else if (data.type === 'error') fail(errorFor(data.code));
          };
          port.start();
          frame.contentWindow.postMessage({ type: 'beauticode:scene-init', bytes, project: config.project, renderDpr: nativeDpr() }, '*', [channel.port2, bytes]);
          visibility();
        }, { once: true });
        slot.append(frame);
        document.addEventListener('visibilitychange', visibility);
        globalThis.addEventListener('resize', resize);
        if (typeof ResizeObserver === 'function') { observer = new ResizeObserver(resize); observer.observe(slot); }
      } catch (error) {
        if (!disposed) fail(error?.name === 'AbortError' ? error : new Error('Scene resources could not be loaded'));
      }
    })();
    return ready;
  }
  globalThis.BeauticodeScenePlayer = Object.freeze({ mount, _test: Object.freeze({ validateConfig, readLimited, frameDocument }) });
})();
