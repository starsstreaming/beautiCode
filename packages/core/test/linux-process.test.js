import assert from "node:assert/strict";
import test from "node:test";
import { joinLinuxCommandLine, parseLinuxProcStat, readLinuxProcess, selectLinuxMainProcesses } from "../dist/index.js";

test("parses /proc stat with spaces and parentheses in comm", () => {
  const parsed = parseLinuxProcStat(`123 (Web (Content) x) ${["S", "45", ...Array(17).fill("0"), "98765", "0"].join(" ")}`);
  assert.equal(parsed?.name, "Web (Content) x");
  assert.equal(parsed?.parentPid, 45);
  assert.equal(parsed?.startTicks, 98765);
});

test("quotes argv entries that contain whitespace", () => {
  assert.equal(joinLinuxCommandLine(["/opt/A B/app", "--x=1"]), '"/opt/A B/app" --x=1');
});

test("main-process selection drops Chromium children and same-image helpers", () => {
  const row = (pid, parentPid, commandLine, executablePath = "/usr/share/cursor/cursor") =>
    ({ pid, parentPid, name: "cursor", executablePath, argv: commandLine.split(" "), commandLine, createdAtMs: 1 });
  const rows = [
    row(10, 1, "/usr/share/cursor/cursor"),
    row(11, 10, "/usr/share/cursor/cursor --type=renderer"),
    row(12, 10, "/usr/share/cursor/cursor /usr/share/cursor/resources/app/out/server.js"),
  ];
  assert.deepEqual(selectLinuxMainProcesses(rows, () => true).map((entry) => entry.pid), [10]);
});

test("reads the current process", { skip: process.platform !== "linux" }, () => {
  const self = readLinuxProcess(process.pid);
  assert.equal(self?.pid, process.pid);
  assert.equal(self?.executablePath, process.execPath);
  assert.ok(Math.abs((self?.createdAtMs ?? 0) - (Date.now() - process.uptime() * 1000)) < 2_000);
});
