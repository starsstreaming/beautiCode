import assert from "node:assert/strict";
import test from "node:test";
import { StartupRepairChain } from "../dist/index.js";

const row = (pid, createdAtMs, port = null) => ({ pid, createdAtMs, port });

test("a controlled relaunch cannot recursively restart its own blind replacement", () => {
  let now = 1_000;
  const chain = new StartupRepairChain(() => now);
  assert.equal(chain.claim(row(10, now)), true);
  chain.markLaunched();
  now += 100;
  chain.observeSnapshot([row(11, now)]);
  assert.equal(chain.claim(row(11, now)), false);
  assert.equal(chain.claim(row(10, 1_000)), false);
});

test("closing the replacement resets the budget for a later original-icon launch", () => {
  let now = 1_000;
  const chain = new StartupRepairChain(() => now);
  assert.equal(chain.claim(row(10, now)), true);
  chain.markLaunched();
  now += 100;
  chain.observeSnapshot([row(11, now)]);
  chain.observeSnapshot([]);
  now += 100;
  assert.equal(chain.claim(row(12, now)), true);
});

test("the teardown gap does not reset a relaunch budget", () => {
  let now = 1_000;
  const chain = new StartupRepairChain(() => now);
  assert.equal(chain.claim(row(10, now)), true);
  chain.markLaunched();
  chain.observeSnapshot([]);
  now += 100;
  assert.equal(chain.claim(row(11, now)), false);
});

test("verified CDP releases the chain but the same generation stays handled", () => {
  let now = 1_000;
  const chain = new StartupRepairChain(() => now);
  assert.equal(chain.claim(row(10, now)), true);
  chain.markLaunched();
  chain.markVerified();
  assert.equal(chain.claim(row(10, now)), false);
  now += 100;
  assert.equal(chain.claim(row(11, now)), true);
});

test("unknown creation time, stale processes and missing host do not claim a repair", () => {
  let now = 20_000;
  const chain = new StartupRepairChain(() => now);
  assert.equal(chain.claim(row(10, null)), false);
  assert.equal(chain.claim(row(10, 10_000)), false);
  chain.observeSnapshot([]);
  assert.equal(chain.claim(row(11, now)), true);
  chain.markLaunched();
  now += 30_001;
  assert.equal(chain.claim(row(12, now)), true, "a launch that never produced a process expires safely");
});
