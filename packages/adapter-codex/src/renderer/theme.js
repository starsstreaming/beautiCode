// Host appearance owns foreground colors. Background tone is a media preference,
// so it must never select the surface palette or mask an app theme switch.
(() => {
  "use strict";
  const REV = 2;
  const root = document.documentElement;
  const installed = window.__BEAUTICODE_THEME__;
  if (installed && installed.rev === REV) {
    installed.refresh();
    return;
  }
  // A previous revision's observer must not linger across a hot upgrade.
  installed?.stop?.();
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  function hostTone() {
    for (const node of [root, document.body]) {
      if (!node) continue;
      const marker = node.getAttribute('data-theme');
      if (marker === 'light' || marker === 'dark') return marker;
      if (node.classList.contains('light')) return 'light';
      if (node.classList.contains('dark')) return 'dark';
    }
    const scheme = getComputedStyle(root).colorScheme;
    if (scheme === 'light' || scheme === 'dark') return scheme;
    return media?.matches ? 'dark' : 'light';
  }
  function refresh() {
    // Media may install before or after this script, so claim a tone only while
    // the stage is active — and never leave a stale one behind. CSS also matches
    // the host's own appearance attribute, so this is a hint, not the only path.
    if (root.getAttribute('data-bc-active') !== 'true') {
      root.removeAttribute('data-bc-resolved-tone');
      return;
    }
    const tone = hostTone();
    if (root.dataset.bcResolvedTone !== tone) root.dataset.bcResolvedTone = tone;
  }
  // Ignore transcript/hover mutations; only root/body appearance changes and
  // stage activation count.
  const observer = new MutationObserver((records) => {
    if (records.some((record) => record.target === root || record.target === document.body)) refresh();
  });
  observer.observe(root, { subtree: true, childList: true, attributes: true,
    attributeFilter: ['class', 'data-theme', 'style', 'data-bc-active'] });
  media?.addEventListener?.('change', refresh);
  window.__BEAUTICODE_THEME__ = {
    rev: REV,
    refresh,
    stop() {
      observer.disconnect();
      media?.removeEventListener?.('change', refresh);
      root.removeAttribute('data-bc-resolved-tone');
      delete window.__BEAUTICODE_THEME__;
    },
  };
  refresh();
})();
