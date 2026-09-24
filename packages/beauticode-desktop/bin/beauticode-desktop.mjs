#!/usr/bin/env node
import { helpText, parseCommand, runHostCommand, statusText } from "../src/index.mjs";

try {
  const command = parseCommand(process.argv.slice(2));
  if (command.kind === "help") {
    process.stdout.write(`${helpText()}\n`);
    process.exit(0);
  }
  const result = runHostCommand(command.host, command.command);
  if (command.command === "status") process.stdout.write(`${statusText(result)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
