import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

/**
 * Run `node --test` (or any node command) with a canonical long-path TMP on
 * Windows. Node's fs.realpath expands Windows 8.3 short names (e.g. USER~1)
 * nondeterministically, so tests that mix store paths with fs.realpath results
 * flake when os.tmpdir() resolves through a short alias. Pointing TMP at the
 * long form up front removes the mismatch at the source.
 */
const env = { ...process.env };
if (process.platform === "win32") {
  const longTemp = path.join(
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
    "Temp",
  );
  env.TMP = longTemp;
  env.TEMP = longTemp;
}

const child = spawn(process.execPath, process.argv.slice(2), {
  stdio: "inherit",
  env,
});
child.on("exit", (code) => process.exit(code ?? 1));
