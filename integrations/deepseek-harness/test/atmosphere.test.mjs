import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { canvasImagePath, normalizeAtmosphere } from "../presets.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const atmosphereSource = fs.readFileSync(path.join(here, "../atmosphere.js"), "utf8");
const atmosphereSandbox = { BeauticodeAtmosphere: null };
vm.runInNewContext(atmosphereSource, atmosphereSandbox);
const atmosphere = atmosphereSandbox.BeauticodeAtmosphere;

test("gallery canvas asset is present", () => {
  const filePath = canvasImagePath();
  assert.ok(fs.existsSync(filePath));
  assert.match(filePath, /bg-canvas-4k\.png$/);
});

test("water sim rises under a poke so mouse follow can drive ripples", () => {
  const water = atmosphere.createWaterSim(64, 36);
  const before = water.heights()[18 * 64 + 32];
  water.poke(32, 18, 2, 3);
  const after = water.heights()[18 * 64 + 32];
  assert.ok(after > before);
  water.step(0.033);
  assert.equal(water.heights().length, 64 * 36);
});

test("gallery is a valid atmosphere preset", () => {
  assert.equal(normalizeAtmosphere({ preset: "gallery" }).preset, "gallery");
});

test("atmosphere.js stays a valid browser script", () => {
  const source = fs.readFileSync(path.join(here, "../atmosphere.js"), "utf8");
  assert.doesNotThrow(() => new Function(source));
  assert.match(source, /#beauticode-bg-stage img,\s*\nhtml\[data-bc-gallery="true"\] #beauticode-bg-stage video/);
});
