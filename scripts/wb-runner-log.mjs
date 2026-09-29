import fs from "node:fs";
import path from "node:path";

export function redactWorkBuddyLog(value) {
  return String(value)
    .replace(/(?:https?|file|blob):\/\/[^\s)]+/gi, "[url]")
    .replace(/(?:[A-Za-z]:\\|\\\\)[^\s)"']+/g, "[path]")
    .replace(/[\r\n\t\x00-\x1f]/g, " ");
}

/** Direct writes survive the hidden VBS → PowerShell launcher with no stdio. */
export function createWorkBuddyLogger({ file, maxBytes = 1024 * 1024, stderr = (message) => process.stderr.write(message), debug = false }) {
  let reportedFailure = false;
  const limit = Math.max(256, Math.trunc(maxBytes));
  function write(level, parts) {
    if (level === "debug" && !debug) return;
    const budget = Math.min(2048, Math.floor(limit / 2));
    const safe = redactWorkBuddyLog(parts.join(" "));
    const trimmed = Buffer.from(safe, "utf8").subarray(0, budget).toString("utf8");
    const line = `${new Date().toISOString()} [${level}] ${trimmed}\n`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const bytes = Buffer.byteLength(line);
      if (fs.existsSync(file) && fs.statSync(file).size + bytes > limit) {
        fs.rmSync(`${file}.previous`, { force: true });
        fs.renameSync(file, `${file}.previous`);
      }
      fs.appendFileSync(file, line, "utf8");
    } catch {
      if (!reportedFailure) {
        reportedFailure = true;
        try { stderr("workbuddy log unavailable\n"); } catch { /* no foreground stream */ }
      }
    }
  }
  return Object.fromEntries(["info", "warn", "error", "debug"].map((level) => [level, (...parts) => write(level, parts)]));
}
