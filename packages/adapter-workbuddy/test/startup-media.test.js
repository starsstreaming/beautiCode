import assert from "node:assert/strict";
import test from "node:test";
import { shouldApplyDefaultWallpaper } from "../../../scripts/wb-startup-media.mjs";

test("cleared state and saved media outrank the default wallpaper", () => {
  assert.equal(shouldApplyDefaultWallpaper({ cleared: true, wallpaper: null, hasMedia: false }), false);
  assert.equal(shouldApplyDefaultWallpaper({ cleared: false, wallpaper: "C:\\saved.jpg", hasMedia: false }), false);
  assert.equal(shouldApplyDefaultWallpaper({ cleared: false, wallpaper: null, hasMedia: true }), false);
  assert.equal(shouldApplyDefaultWallpaper({ cleared: false, wallpaper: null, hasMedia: false }), true);
});
