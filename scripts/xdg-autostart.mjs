import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { desktopExecQuote } from "./portable-runtime.mjs";

/** Only our exact command in the Desktop Entry group establishes ownership. */
export function isOwnedXdgAutostart(content, launcher, args = []) {
  const lines = String(content ?? "").split(/\r?\n/);
  const start = lines.indexOf("[Desktop Entry]");
  if (start < 0) return false;
  const group = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("[")) break;
    group.push(line);
  }
  const exec = `Exec=${["/bin/sh", launcher, ...args].map(desktopExecQuote).join(" ")}`;
  const commands = group.filter((line) => line.startsWith("Exec="));
  const markers = group.filter((line) => line.startsWith("X-BeautiCode-Managed="));
  return commands.length === 1 && commands[0] === exec &&
    markers.length === 1 && markers[0] === "X-BeautiCode-Managed=true";
}

/** User-owned autostart file; foreign files are conflicts, never replacement targets. */
export function createXdgAutostartAdapter(launcher, { file, args = [] } = {}) {
  if (!path.posix.isAbsolute(launcher)) throw new Error("invalid autostart launcher path");
  if (!file) throw new Error("autostart file is required");
  const read = () => {
    try { return fs.readFileSync(file, "utf8"); }
    catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  };
  const assertAbsentOrOwned = () => {
    const current = read();
    if (current !== null && !isOwnedXdgAutostart(current, launcher, args)) {
      throw new Error("autostart entry is not owned by beautiCode");
    }
    return current;
  };
  const adapter = {
    file,
    read,
    assertAbsentOrOwned,
    isOwned: () => { const current = read(); return current !== null && isOwnedXdgAutostart(current, launcher, args); },
    write(content) {
      if (!isOwnedXdgAutostart(content, launcher, args)) throw new Error("invalid owned autostart content");
      const before = assertAbsentOrOwned();
      if (before === content) return;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temporary = `${file}.tmp-${randomUUID()}`;
      fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o644 });
      try {
        if (before === null) {
          // Publish without replacing a foreign file created after preflight.
          fs.linkSync(temporary, file);
        } else {
          if (assertAbsentOrOwned() !== before) throw new Error("autostart entry changed while writing");
          fs.renameSync(temporary, file);
        }
      } finally { fs.rmSync(temporary, { force: true }); }
    },
    removeOwned() {
      if (assertAbsentOrOwned() !== null) fs.unlinkSync(file);
    },
    restore(previous) {
      if (previous === null) adapter.removeOwned();
      else adapter.write(previous);
    },
  };
  return adapter;
}
