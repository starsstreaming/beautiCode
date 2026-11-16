// This opaque-origin frame receives bytes, never a local path or resource token.
// SceneScript stays disabled: the iframe cannot reliably prevent self-navigation
// or recover from CPU exhaustion caused by untrusted executable scene content.
export function installFrame(win, { mount, bytesSource, getSkippedScripts }) {
  // WebWallGL 3.0.0 probes `typeof caches` outside a try block. In an opaque
  // origin that getter can throw; expose absence and retain its memory fallback.
  try { void win.caches; }
  catch { Object.defineProperty(win, 'caches', { value: undefined, configurable: true }); }

  let bound = false;
  const onInit = event => {
    const data = event.data;
    if (bound || event.source !== win.parent || data?.type !== 'beauticode:scene-init' ||
        !(data.bytes instanceof ArrayBuffer) || data.bytes.byteLength > 512 * 1024 * 1024 ||
        !data.project || typeof data.project !== 'object' || Array.isArray(data.project) ||
        String(data.project.type).toLowerCase() !== 'scene' || !event.ports?.[0]) return;
    bound = true;
    win.removeEventListener('message', onInit);
    const port = event.ports[0];
    const blobs = new Set();
    const createBlob = win.URL.createObjectURL.bind(win.URL);
    const revokeBlob = win.URL.revokeObjectURL.bind(win.URL);
    win.URL.createObjectURL = (...args) => { const url = createBlob(...args); blobs.add(url); return url; };
    win.URL.revokeObjectURL = url => { blobs.delete(url); revokeBlob(url); };
    const validDpr = value => Number.isFinite(value) ? Math.max(1, Math.min(4, value)) : 1;
    let renderDpr = validDpr(data.renderDpr), engineDpr;
    let scene, interval, disposed = false, paused = false, volume = 0;
    const send = data => { if (!disposed) port.postMessage(data); };
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      if (interval !== undefined) win.clearInterval(interval);
      win.removeEventListener('error', runtimeError);
      win.removeEventListener('unhandledrejection', runtimeError);
      win.removeEventListener('pagehide', dispose);
      scene?.canvas?.removeEventListener('webglcontextlost', contextLost);
      try { scene?.destroy({ releasePkgCache: true }); } catch { /* Release remaining resources even if the engine fails. */ }
      for (const url of blobs) revokeBlob(url);
      blobs.clear();
      port.close();
    };
    const fatal = code => { if (!disposed) { send({ type: 'error', code }); dispose(); } };
    const runtimeError = () => fatal('SCENE_RUNTIME_FAILED');
    const contextLost = () => fatal('SCENE_CONTEXT_LOST');
    const checkScripts = () => {
      try {
        if (typeof getSkippedScripts !== 'function') return fatal('SCENE_SCRIPT_STATUS_UNAVAILABLE');
        if (getSkippedScripts(scene) > 0) return fatal('SCENE_SCRIPT_UNSUPPORTED');
        send({ type: 'heartbeat' });
      } catch { fatal('SCENE_SCRIPT_STATUS_UNAVAILABLE'); }
    };
    win.addEventListener('error', runtimeError);
    win.addEventListener('unhandledrejection', runtimeError);
    win.addEventListener('pagehide', dispose, { once: true });
    port.onmessage = ({ data: command }) => {
      if (disposed || !command || typeof command !== 'object') return;
      switch (command.type) {
        case 'pause': paused = true; scene?.pause(); break;
        case 'resume': paused = false; scene?.resume(); break;
        case 'muted': volume = command.value === false ? 1 : 0; scene?.setVolume(volume); break;
        case 'resize': {
          const next = validDpr(command.renderDpr);
          if (next !== renderDpr) { renderDpr = next; scene?.setRenderDpr(renderDpr); }
          win.dispatchEvent(new win.Event('resize'));
          break;
        }
        case 'dispose': dispose(); break;
      }
    };
    port.start();

    // WebWallGL's mount Promise resolves only after its first completed frame.
    Promise.resolve().then(() => {
      if (disposed) return null;
      engineDpr = renderDpr;
      return mount(win.document.getElementById('scene'), {
        source: bytesSource(data.bytes, { ...data.project, type: 'scene' }),
        scripts: false, audio: null, media: null,
        fps: 60, renderDpr, volume: 0,
        quality: { antiAliasing: 'msaa4', particles: 'high', postProcessing: 'high' },
        autoQuality: false, videoTexScale: 1, fit: 'cover', debugHooks: false, bake: false,
        onDiagnostic: (_message, level) => { if (level === 'error') fatal('SCENE_RENDER_FAILED'); },
        onError: () => fatal('SCENE_RENDER_FAILED'),
      });
    }).then(instance => {
      if (!instance) return;
      scene = instance;
      if (disposed) { instance.destroy({ releasePkgCache: true }); return; }
      instance.canvas?.addEventListener('webglcontextlost', contextLost);
      if (engineDpr !== renderDpr) instance.setRenderDpr(renderDpr);
      if (paused) instance.pause();
      if (volume) instance.setVolume(volume);
      // Some scripts are discovered lazily, so check both here and while active.
      checkScripts();
      if (disposed) return;
      send({ type: 'ready' });
      interval = win.setInterval(checkScripts, 2000);
    }).catch(error => {
      // mount() attaches a partially created instance to failures. It must be
      // destroyed even when first-frame assembly never completed.
      try { error?.instance?.destroy({ releasePkgCache: true }); } catch { /* Preserve failure cleanup. */ }
      fatal('SCENE_MOUNT_FAILED');
    });
  };
  win.addEventListener('message', onInit);
}
