#!/usr/bin/env node
// beauticode-linux shares beauticode-desktop's CLI source. The packed tarball
// carries it at ../src; in the source workspace it lives in the sibling package.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packed = path.join(here, "..", "src", "index.mjs");
const workspace = path.join(here, "..", "..", "beauticode-desktop", "src", "index.mjs");
const cli = await import(pathToFileURL(fs.existsSync(packed) ? packed : workspace).href);
const { getAllStatus, helpText, parseCommand, runAllHealth, runAllInstall, runHostCommand, runHostHealth, statusText } = cli;

try {
  if (process.platform !== "linux") {
    throw new Error("beauticode-linux 只支持 Linux；Windows 请安装 beauticode-desktop。");
  }
  const command = parseCommand(process.argv.slice(2));
  if (command.kind === "help") {
    process.stdout.write(`${helpText("beauticode-linux", "linux")}\n`);
    process.exit(0);
  }
  if (command.kind === "all") {
    const result = command.command === "status" ? getAllStatus()
      : command.command === "health" ? await runAllHealth()
        : runAllInstall();
    process.stdout.write(`${statusText(result)}\n`);
    if (command.command === "install" && !result.ok) process.exitCode = 2;
  } else {
    const result = command.command === "health"
      ? await runHostHealth(command.host)
      : runHostCommand(command.host, command.command);
    if (command.command === "status" || command.command === "health") process.stdout.write(`${statusText(result)}\n`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
