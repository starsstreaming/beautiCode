// Shadow belongs to the media lifecycle, not the optional sidebar console.
// Install before the first frame; Codex may replace html.style during startup.
(() => {
  const installed = globalThis.BeauticodeBackgroundDim;
  if (installed?.rev === 1) { installed.refresh(); return; }
  installed?.stop?.();
  const root = document.documentElement;
  const key = 'beauticode-dim';
  function parse(value) {
    if (value == null || String(value).trim() === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 && number <= 1 ? number : null;
  }
  let value = null;
  try { value = parse(localStorage.getItem(key)); } catch { /* Storage may be unavailable. */ }
  function refresh() {
    if (value == null) {
      if (root.hasAttribute('data-bc-dim-user')) root.removeAttribute('data-bc-dim-user');
      if (root.style.getPropertyValue('--bc-dim')) root.style.removeProperty('--bc-dim');
    } else {
      if (root.getAttribute('data-bc-dim-user') !== 'true') root.setAttribute('data-bc-dim-user', 'true');
      if (root.style.getPropertyValue('--bc-dim') !== String(value)) root.style.setProperty('--bc-dim', String(value));
    }
  }
  function persist() {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, String(value));
    } catch { /* Keep the live preference when storage is unavailable. */ }
    refresh();
  }
  // Observe only the host-owned root attributes; idempotent writes prevent a
  // mutation loop. Keep the preference across clear/reapply until window close.
  const observer = new MutationObserver(refresh);
  observer.observe(root, { attributes: true, attributeFilter: ['style', 'data-bc-dim-user'] });
  globalThis.BeauticodeBackgroundDim = {
    rev: 1,
    get: () => value,
    set(next) { const parsed = parse(next); if (parsed != null) { value = parsed; persist(); } return value; },
    clear() { value = null; persist(); return null; },
    refresh,
    stop() { observer.disconnect(); },
  };
  refresh();
})();
