import assert from "node:assert/strict";
import test from "node:test";
import { ensureBackgroundStage } from "../dist/background-stage.js";

function fakeDocument() {
  const doc = { stage: null, insertions: 0, body: {}, getElementById(id) { return this.stage?.id === id ? this.stage : null; }, createElement() { return { id: "", isConnected: false, style: {}, setAttribute() {} }; } };
  doc.documentElement = { insertBefore(node) { node.isConnected = true; doc.stage = node; doc.insertions++; } };
  return doc;
}

test("stage is created eagerly once and recreated after detachment", () => {
  const doc = fakeDocument();
  const first = ensureBackgroundStage(doc);
  assert.equal(first.id, "beauticode-bg-stage");
  assert.equal(ensureBackgroundStage(doc), first);
  assert.equal(doc.insertions, 1);
  first.isConnected = false;
  assert.notEqual(ensureBackgroundStage(doc), first);
  assert.equal(doc.insertions, 2);
});
