import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
const css = await fs.readFile(new URL("../src/renderer/background.css", import.meta.url), "utf8");
test("wallpaper preserves the host sidebar, main and hero corner radii", () => {
    assert.doesNotMatch(css, /border-radius:\s*0\s*!important/);
});
test("ordinary tooltips and popper positioning wrappers are not painted as panels", () => {
    const panels = css.slice(css.indexOf("/* Functional panels"), css.indexOf("background-color: var(--bc-readable-fill)", css.indexOf("/* Functional panels")));
    assert.doesNotMatch(panels, /role="tooltip"|data-radix-popper-content-wrapper/);
});
test("overlay protection follows the host palette and excludes owned UI", () => {
    assert.match(css, /data-overlay-owner/);
    assert.doesNotMatch(css, /rgba\(25[035],\s*25[0259],\s*25[345],\s*0\.9/);
    assert.doesNotMatch(css, /main aside\s*\{/);
    assert.doesNotMatch(css, /_ComposerLayoutRoot_|empty-state-pag|class\*="_shell_"/);
});
