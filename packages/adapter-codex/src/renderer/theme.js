// Host appearance owns foreground colors. Background tone is a media preference,
// so it must never select the surface palette or mask an app theme switch.
(() => {
  const root = document.documentElement;
  if (root.getAttribute('data-bc-active') !== 'true') {
    // A hot upgrade can reuse an older media runtime with no theme cleanup.
    window.__BEAUTICODE_THEME__?.stop();
    return;
  }
  if (window.__BEAUTICODE_THEME__) {
    window.__BEAUTICODE_THEME__.refresh();
    return;
  }
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  function refresh() {
    let tone;
    for (const node of [root, document.body]) {
      if (!node) continue;
      const marker = node.getAttribute('data-theme');
      if (marker === 'light' || marker === 'dark') { tone = marker; break; }
      if (node.classList.contains('light')) { tone = 'light'; break; }
      if (node.classList.contains('dark')) { tone = 'dark'; break; }
    }
    if (!tone) {
      const scheme = getComputedStyle(root).colorScheme;
      tone = scheme === 'light' || scheme === 'dark' ? scheme : media?.matches ? 'dark' : 'light';
    }
    if (root.dataset.bcResolvedTone !== tone) root.dataset.bcResolvedTone = tone;
  }
  // Ignore transcript/hover mutations; only root/body appearance changes count.
  const observer = new MutationObserver((records) => {
    if (records.some((record) => record.target === root || record.target === document.body)) refresh();
  });
  observer.observe(root, { subtree: true, childList: true, attributes: true,
    attributeFilter: ['class', 'data-theme', 'style'] });
  media?.addEventListener?.('change', refresh);
  window.__BEAUTICODE_THEME__ = {
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
