#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(here, "watch.log");

function adapterHref() {
  const vendor = path.join(here, "vendor", "adapter-codex", "index.js");
  const workspace = path.join(here, "../../packages/adapter-codex/dist/index.js");
  const file = fs.existsSync(vendor) ? vendor : workspace;
  if (!fs.existsSync(file)) {
    throw new Error("找不到 @beauticode/adapter-codex。请先在仓库根目录运行 npm run build。");
  }
  return pathToFileURL(file).href;
}

function log(message) {
  try {
    const line = `${new Date().toISOString()} ${message}\n`;
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 256 * 1024) {
      fs.writeFileSync(LOG, line);
    } else {
      fs.appendFileSync(LOG, line);
    }
  } catch {
    /* ignore */
  }
}

const { BeautiSession, startCodexStartupRepairMonitor } = await import(adapterHref());
const startupMonitor = startCodexStartupRepairMonitor({
  repairWindowMs: 10_000,
  log: {
    info: (...messages) => log(messages.join(" ")),
    warn: (...messages) => log(messages.join(" ")),
  },
});
const session = new BeautiSession({
  autoDiscover: true,
  autoLaunchHost: false,
  deferHostConnect: true,
  onStatus: (message) => log(message),
  onError: (error) => log(`session error: ${error.message}`),
});

try {
  await session.start();
  log("watch started");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/injector|lock|another/i.test(message)) {
    console.error("beautiCode 已在运行（托盘或其它注入进程）。本次 watch 退出。");
    process.exit(0);
  }
  throw error;
}

setInterval(() => {}, 60_000);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    startupMonitor.close();
    void session.stop().finally(() => process.exit(0));
  });
}
