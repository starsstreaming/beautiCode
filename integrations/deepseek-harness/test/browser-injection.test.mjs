import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createBrowserInjection } from "../browser-injection.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

test("Desktop requests need the per-Host page key after proxy header stripping", () => {
  const injection = createBrowserInjection();
  const rows = [];
  injection.contribute(rows);
  const key = rows[0].value;
  const request = (headers) => ({ headers: { host: "127.0.0.1:19387", ...headers } });

  assert.equal(injection.isSameOrigin(request({ origin: "http://127.0.0.1:19387" })), true);
  assert.equal(injection.isSameOrigin(request({ origin: "https://evil.example", "x-beauticode-desktop-key": key })), false);
  assert.equal(injection.isSameOrigin(request({})), false);
  assert.equal(injection.isSameOrigin(request({ "x-beauticode-desktop-key": "0".repeat(64) })), false);
  assert.equal(injection.isSameOrigin(request({ "x-beauticode-desktop-key": key })), true);
  assert.equal(createBrowserInjection().isSameOrigin(request({ "x-beauticode-desktop-key": key })), false);
});

test("Desktop transport sends its key as a header and parses the event stream", async () => {
  const source = await fs.readFile(path.join(here, "..", "transport.js"), "utf8");
  const received = [];
  let close;
  const message = new Promise((resolve) => { close = resolve; });
  const context = {
    location: { protocol: "dsh-app:", hostname: "app" },
    __BEAUTICODE_DESKTOP_KEY__: "a".repeat(64),
    AbortController,
    TextDecoder,
    setTimeout,
    clearTimeout,
    fetch: async (_url, init) => {
      received.push(init);
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"type":"ap'));
          controller.enqueue(new TextEncoder().encode('ply"}\n\n'));
          controller.close();
        },
      });
      return { ok: true, body };
    },
  };
  vm.runInNewContext(source, context);
  const stream = context.__beauticodeTransport.events("/__beauticode/events?clientId=test-client", (event) => {
    close(event.data);
  });
  assert.equal(await message, '{"type":"apply"}');
  stream.close();
  assert.equal(received[0].headers["X-Beauticode-Desktop-Key"], "a".repeat(64));
  assert.equal(received[0].mode, "same-origin");
});
