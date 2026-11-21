import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

function fileUriInsert(uri) {
  return [
    "# beauticode-bridge (installer)",
    "- insert:",
    "    - id: beauticode-bridge",
    `      name: '${uri}'`,
    "      inject: [webServer]",
    "",
  ].join("\n");
}

function packageInsert(pluginName) {
  return [
    "# beauticode-bridge (installer)",
    "- insert:",
    "    - id: beauticode-bridge",
    `      name: '${pluginName}'`,
    "      inject: [webServer]",
    "",
  ].join("\n");
}

function hasBridge(text) {
  return stripBridge(text).count > 0;
}

async function backupPatch(filePath) {
  const base = `${filePath}.beauticode-backup-${Date.now()}`;
  let backup = base;
  let suffix = 0;
  while (fs.existsSync(backup)) backup = `${base}-${++suffix}`;
  await fsp.copyFile(filePath, backup, fs.constants.COPYFILE_EXCL);
  return backup;
}

function stripBridge(text) {
  const lines = text.split(/\r?\n/);
  const removed = new Array(lines.length).fill(false);
  const indentOf = (line) => line.match(/^[ \t]*/)?.[0].length ?? 0;
  const content = (line) => line.trim() && !line.trimStart().startsWith("#");
  const rootIndent = indentOf(lines.find(content) ?? "");
  let count = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const insert = lines[i].match(/^([ \t]*)-\s*insert:\s*(?:#.*)?$/);
    if (!insert) continue;
    const insertIndent = insert[1].length;
    if (insertIndent !== rootIndent) continue;
    let blockEnd = i + 1;
    while (blockEnd < lines.length) {
      const line = lines[blockEnd];
      if (line.trim() && indentOf(line) <= insertIndent) break;
      blockEnd += 1;
    }

    let foundBridge = false;
    const childIndent = indentOf(lines.slice(i + 1, blockEnd).find(content) ?? "");
    for (let j = i + 1; j < blockEnd; ) {
      const bridge = lines[j].match(
        /^([ \t]*)-\s*id:\s*beauticode-bridge\s*(?:#.*)?$/,
      );
      if (!bridge || bridge[1].length !== childIndent) {
        j += 1;
        continue;
      }
      foundBridge = true;
      count++;
      const itemIndent = bridge[1].length;
      let itemEnd = j + 1;
      while (itemEnd < blockEnd) {
        const line = lines[itemEnd];
        if (line.trim() && indentOf(line) <= itemIndent) break;
        itemEnd += 1;
      }
      for (let k = j; k < itemEnd; k += 1) removed[k] = true;
      j = itemEnd;
    }

    if (!foundBridge) continue;
    const marker = `${insert[1]}# beauticode-bridge (installer)`;
    if (i > 0 && lines[i - 1].trimEnd() === marker) removed[i - 1] = true;
    const hasSibling = lines
      .slice(i + 1, blockEnd)
      .some(
        (line, offset) =>
          !removed[i + 1 + offset] &&
          line.trim() !== "" &&
          !line.trimStart().startsWith("#"),
      );
    if (!hasSibling) {
      for (let k = i; k < blockEnd; k += 1) removed[k] = true;
    }
    i = blockEnd - 1;
  }

  return { count, text: lines.filter((_, index) => !removed[index]).join("\n") };
}

function overlayPayload(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .join("\n");
}

function isEmptyOverlay(text) {
  const payload = overlayPayload(text);
  return payload === "" || /^\[\](?:[ \t]+#.*)?$/.test(payload);
}

// DSH seeds overlays as `# comment\n[]`. `[]` is already a complete YAML
// document, so appending `- insert:` makes js-yaml throw.
function keptOverlay(text) {
  const withoutFlowEmpty = text
    .split(/\r?\n/)
    .filter((line) => !/^\[\][ \t]*(?:#.*)?$/.test(line))
    .join("\n");
  if (isEmptyOverlay(withoutFlowEmpty)) return "";
  return withoutFlowEmpty;
}

function withTrailingNewline(text) {
  return text.endsWith("\n") ? text : `${text}\n`;
}

async function writePatch(filePath, body) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const insert = withTrailingNewline(body);
  if (!fs.existsSync(filePath)) {
    await fsp.writeFile(filePath, insert, "utf8");
    return;
  }
  const raw = await fsp.readFile(filePath, "utf8");
  const rewrite = stripBridge(raw);
  if (rewrite.count > 1) {
    await backupPatch(filePath);
  }
  const remainder = rewrite.count ? rewrite.text : raw;
  const kept = keptOverlay(remainder);
  const next = kept ? withTrailingNewline(kept) + insert : insert;
  await fsp.writeFile(filePath, withTrailingNewline(next), "utf8");
}

async function removePatch(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const raw = await fsp.readFile(filePath, "utf8");
  const rewrite = stripBridge(raw);
  if (!rewrite.count) return false;
  const kept = keptOverlay(rewrite.text);
  if (!kept) {
    await fsp.writeFile(
      filePath,
      "# Your patch layer for this dsh profile.\n[]\n",
      "utf8",
    );
    return true;
  }
  await fsp.writeFile(filePath, withTrailingNewline(kept), "utf8");
  return true;
}

export { backupPatch, fileUriInsert, hasBridge, packageInsert, removePatch, writePatch };
