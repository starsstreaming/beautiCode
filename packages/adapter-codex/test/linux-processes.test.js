import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  scanLinuxCodexProcesses,
} from "../dist/processes.js";

// Exercise the real /proc reader and host selection without touching live PIDs.
function procSnapshot(t, rows) {
  const byPid = new Map(rows.map((row) => [String(row.pid), row]));
  t.mock.method(fs, "readdirSync", (root) => {
    assert.equal(root, "/proc");
    return [...byPid.keys()];
  });
  t.mock.method(fs, "readFileSync", (file) => {
    const normalized = String(file).replaceAll("\\", "/");
    if (normalized === "/proc/stat") return "btime 100000\n";
    const [, pid, kind] = /^\/proc\/(\d+)\/(stat|cmdline)$/.exec(normalized) || [];
    const row = byPid.get(pid);
    assert.ok(row, `unexpected /proc read: ${file}`);
    if (kind === "cmdline") return `${row.argv.join("\0")}\0`;
    const fields = Array(20).fill("0");
    fields[0] = "S";
    fields[1] = String(row.parentPid || 1);
    fields[19] = "100";
    return `${pid} (${path.posix.basename(row.exe)}) ${fields.join(" ")}`;
  });
  t.mock.method(fs, "readlinkSync", (file) => {
    const pid = /\/proc\/(\d+)\/exe$/.exec(String(file).replaceAll("\\", "/"))?.[1];
    assert.ok(byPid.has(pid));
    return byPid.get(pid).exe;
  });
}

const cli = {
  pid: 101,
  exe: "/home/alice/.npm/lib/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex",
  argv: ["codex", "resume"],
};
const desktop = { pid: 102, exe: "/usr/lib/chatgpt/ChatGPT", argv: ["/usr/lib/chatgpt/ChatGPT"] };

test("Linux discovery leaves a standalone Codex CLI outside desktop repair", (t) => {
  procSnapshot(t, [cli]);
  assert.deepEqual(scanLinuxCodexProcesses(), []);
});

test("Linux discovery keeps the desktop when a standalone CLI is also running", (t) => {
  procSnapshot(t, [cli, desktop]);
  assert.deepEqual(scanLinuxCodexProcesses().map((row) => row.pid), [102]);
});

test("Linux discovery rejects unknown same-name binaries and desktop helpers", (t) => {
  procSnapshot(t, [desktop,
    { pid: 103, exe: "/tmp/Codex", argv: ["/tmp/Codex"] },
    { pid: 104, parentPid: 102, exe: desktop.exe, argv: [desktop.exe, "--type=renderer"] },
    { pid: 105, parentPid: 102, exe: desktop.exe, argv: [desktop.exe, "worker.js"] },
  ]);
  assert.deepEqual(scanLinuxCodexProcesses().map((row) => row.pid), [102]);
});
