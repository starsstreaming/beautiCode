#!/usr/bin/env node
import { getAllStatus, helpText, parseCommand, runAllHealth, runAllInstall, runHostCommand, runHostHealth, statusText } from "../src/index.mjs";

try {
  const command = parseCommand(process.argv.slice(2));
  if (command.kind === "help") {
    process.stdout.write(`${helpText()}\n`);
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
