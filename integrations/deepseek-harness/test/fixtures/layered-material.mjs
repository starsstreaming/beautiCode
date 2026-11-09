// Browser fixtures for ADR 0011's layered material. These are fixture-owned
// class names and inline styles; production selectors are only the host's
// semantic contracts (`[data-global-panel]`, `[data-shell-overlay]`, ARIA roles,
// `data-composer-card`, the three pending-interaction keys).
//
// The page column carries a non-zero offset on purpose: ADR 0011 §4.1 requires
// the containing-block risk of a page-root backdrop-filter to be observable, so
// an in-page `position: fixed` popover can be checked against a portal one.
import { listHtml } from "./plugin-panel.mjs";

export const materialCss = `
/* Palette entries client.js references but the minimal plugin fixture does not
   define. Without them the translucent "host appearance" would resolve to an
   invalid color-mix and the 0% comparisons would pass vacuously. */
body{
  --dsw-static-neutral-bluish-900:#15181f;
  --dsw-static-neutral-bluish-850:#1b1f27;
  --dsw-static-neutral-bluish-750:#2a303b;
  --dsw-static-neutral-bluish-50:#f5f7fa;
  --dsw-static-neutral-bluish-60:#eef1f5;
  --dsw-static-neutral-bluish-75:#e3e7ec;
  --dsw-static-neutral-bluish-100:#d8dde3;
  --dsw-static-neutral-850:#22262e;
  --dsw-static-neutral-800:#2b303a;
  --dsw-static-neutral-50:#f7f8fa;
  --dsw-static-neutral-100:#eceff3;
  --dsw-static-amber-900:#4a3413;
  --dsw-static-amber-100:#fdf0d5;
  --dsw-static-green-900:#123a24;
  --dsw-static-green-100:#dcf5e7;
  --dsw-static-deepseek-800:#123a78;
  --dsw-static-deepseek-100:#dbe9ff;
  --dsw-static-deepseek-50:#eef5ff;
  --dsw-static-deepseek-200:#bcd8ff;
}
body{margin:0;font:14px/20px sans-serif;color:var(--dsw-alias-label-primary)}
#root{display:flex;height:800px}
#sidebar{flex:none;box-sizing:border-box;width:200px;padding:20px;border-right:1px solid #8884}
#global-panel{box-sizing:border-box;flex:1;min-width:0;margin-left:40px;height:800px;overflow:auto;padding:0 24px}
[role=dialog]{position:fixed;right:20px;top:20px;width:320px;min-height:120px;padding:16px;z-index:4}
[role=menu]{position:fixed;left:20px;bottom:260px;width:220px;padding:8px;z-index:5}
[role=tooltip]{position:fixed;left:20px;top:220px;max-width:220px;padding:8px;z-index:6}
[role=listbox]{padding:8px}
[data-shell-overlay]{position:fixed;inset:0;pointer-events:none;z-index:7}
[data-shell-overlay]>[role=dialog]{position:fixed;left:50%;top:40%;width:300px;min-height:160px;pointer-events:auto}
[data-composer-card]{position:fixed;right:20px;bottom:20px;box-sizing:border-box;width:280px;padding:12px;border-radius:12px;z-index:3}
[data-question-key],[data-plan-review-key],[data-approval-key]{position:fixed;left:20px;width:320px;z-index:8}
[data-question-key]{bottom:190px}
[data-plan-review-key]{bottom:110px}
[data-approval-key]{bottom:30px}
[data-question-key]>section,[data-plan-review-key]>section,[data-approval-key]>div{display:block;padding:12px;border-radius:10px}
#portal-fixed{position:fixed;left:40px;top:40px;z-index:9;padding:8px;border-radius:8px;background:#334}
#page-fixed{position:fixed;left:60px;top:60px;z-index:9;padding:8px;border-radius:8px;background:#334}
#third-party-popover{position:fixed;left:340px;top:160px;width:200px;height:90px;z-index:8;background:rgba(0,0,0,.5);border-radius:10px}
`;

/**
 * Page mode: the [data-global-panel] column with the plugin page plus a nested
 * listbox/menu, a body-portal dialog with a nested listbox, a shell.overlay
 * container with its own dialog, a portal menu/tooltip, both fixed popovers and
 * a no-role third-party popover.
 */
export const pageModeHtml = `
<div id="wallpaper"></div>
<div id="root">
  <aside id="sidebar">Settings</aside>
  <div data-global-panel id="global-panel">
    ${listHtml}
    <div role="listbox" id="page-nested-panel">Page nested listbox</div>
    <div role="menu" id="page-nested-menu">Page nested menu</div>
    <div id="page-fixed">fixed inside page</div>
  </div>
</div>
<div data-shell-overlay id="shell-overlay">
  <div role="dialog" id="shell-dialog">Shell overlay dialog</div>
</div>
<div role="dialog" id="portal-dialog">Portal dialog
  <div role="listbox" id="dialog-listbox">Dialog nested listbox</div>
</div>
<div role="menu" id="portal-menu">Portal menu</div>
<div role="tooltip" id="tooltip">Portal tooltip</div>
<div id="portal-fixed">fixed portal</div>
<div id="third-party-popover">no role</div>
<div data-composer-card id="composer">Composer</div>
<div data-question-key="q1"><section id="question-card">Question</section></div>
<div data-plan-review-key="p1"><section id="plan-card">Plan review</section></div>
<div data-approval-key="a1"><div id="approval-card">Approval</div></div>
`;

/**
 * Conversation mode: #root [data-phase=active] and no [data-global-panel]. The
 * composer and the three pending-interaction cards are panels; nothing is a
 * page.
 */
export const sessionModeHtml = `
<div id="wallpaper"></div>
<div id="root" data-phase="active">
  <main id="conversation">Conversation transcript</main>
</div>
<div role="dialog" id="settings-dialog">Settings dialog
  <div role="listbox" id="dialog-listbox">Dialog nested listbox</div>
</div>
<div role="menu" id="portal-menu">Portal menu</div>
<div data-composer-card id="composer">Composer</div>
<div data-question-key="q1"><section id="question-card">Question</section></div>
<div data-plan-review-key="p1"><section id="plan-card">Plan review</section></div>
<div data-approval-key="a1"><div id="approval-card">Approval</div></div>
`;
