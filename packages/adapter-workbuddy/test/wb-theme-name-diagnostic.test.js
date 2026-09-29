import assert from "node:assert/strict";
import test from "node:test";
import { compareThemeNameStages, fingerprintThemeName } from "../../../scripts/wb-theme-name-diagnostic.mjs";

test("Chinese theme name survives JSON roundtrip without revealing original text", () => {
  const key = Buffer.alloc(32, 7);
  const original = "室内";
  const roundtrip = JSON.parse(JSON.stringify({ name: original })).name;
  const fingerprint = fingerprintThemeName(original, key);
  assert.equal(fingerprint.byteLength, 6);
  const result = compareThemeNameStages({ catalog: original, renderer: roundtrip, persisted: roundtrip }, key);
  assert.equal(result.firstMismatch, null);
  assert.doesNotMatch(JSON.stringify(result), /室内/);
});

test("diagnostic identifies the first corrupt boundary", () => {
  const key = Buffer.alloc(32, 7);
  const result = compareThemeNameStages({ catalog: "室内", renderer: "室内", persisted: "瀹ゅ唴" }, key);
  assert.equal(result.firstMismatch, "persisted");
  assert.doesNotMatch(JSON.stringify(result), /室内|瀹/);
  assert.equal(compareThemeNameStages({ catalog: "室内", renderer: "瀹ゅ唴", persisted: "瀹ゅ唴" }, key).firstMismatch, "renderer");
});
