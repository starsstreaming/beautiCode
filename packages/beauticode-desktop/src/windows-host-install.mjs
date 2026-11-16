import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const REGISTRY_PATHS = [
  "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",
  "HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",
  "HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",
];

const HOSTS = Object.freeze({
  cursor: { executable: "Cursor.exe", names: new Set(["Cursor", "Cursor (User)"]) },
  doubao: { executable: "Doubao.exe", names: new Set(["豆包", "Doubao"]) },
  doubaowork: { executable: "DoubaoWork.exe", names: new Set(["豆包工作"]) },
});

/** Read only the display fields needed for install discovery. No user data is logged. */
export function queryWindowsInstallRecords({ platform = process.platform, spawn = spawnSync } = {}) {
  if (platform !== "win32") return [];
  const quoted = REGISTRY_PATHS.map((entry) => `'${entry.replaceAll("'", "''")}'`).join(",");
  const script = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Get-ItemProperty ${quoted} -ErrorAction SilentlyContinue | Select-Object DisplayName,InstallLocation,DisplayIcon | ConvertTo-Json -Compress -Depth 3`;
  const result = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", windowsHide: true, timeout: 8_000, maxBuffer: 256 * 1024,
  });
  if (result.status !== 0 || !String(result.stdout || "").trim()) return [];
  try {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch { return []; }
}

function displayIconExecutable(raw) {
  const icon = String(raw || "").trim();
  const match = /^(?:"([^"]+)"|([^,]+?))(?:,\s*\d+)?$/.exec(icon);
  return match ? (match[1] || match[2]).trim() : "";
}

/** Return one canonical executable only when a trusted product record proves it. */
export function resolveRegisteredExecutable(host, options = {}) {
  const config = HOSTS[host];
  if (!config) return null;
  const query = options.query || queryWindowsInstallRecords;
  const exists = options.exists || fs.existsSync;
  const realpath = options.realpath || fs.realpathSync.native;
  const found = new Map();
  for (const row of query()) {
    if (!row || !config.names.has(String(row.DisplayName || "").trim())) continue;
    const candidates = [];
    if (host === "doubaowork") {
      // Doubao Work registers an .ico beside its launcher, while its main
      // process runs from app/. Prefer that process when both files exist.
      const icon = displayIconExecutable(row.DisplayIcon);
      const roots = [String(row.InstallLocation || "")];
      if (["icon.ico", config.executable.toLowerCase()].includes(path.win32.basename(icon).toLowerCase())) {
        roots.push(path.win32.dirname(icon));
      }
      for (const root of roots) {
        // Registry entries are untrusted; do not probe UNC/network paths.
        if (!/^[a-z]:[\\/]/i.test(root)) continue;
        const nested = path.win32.join(root, "app", config.executable);
        const direct = path.win32.join(root, config.executable);
        candidates.push(exists(nested) ? nested : direct);
      }
    } else {
      if (row.InstallLocation && path.win32.isAbsolute(String(row.InstallLocation))) {
        candidates.push(path.win32.join(String(row.InstallLocation), config.executable));
      }
      candidates.push(displayIconExecutable(row.DisplayIcon));
    }
    for (const candidate of candidates) {
      if (!path.win32.isAbsolute(candidate) || path.win32.basename(candidate).toLowerCase() !== config.executable.toLowerCase()) continue;
      if (!exists(candidate)) continue;
      try {
        const canonical = path.win32.normalize(realpath(candidate));
        if (path.win32.basename(canonical).toLowerCase() !== config.executable.toLowerCase()) continue;
        found.set(canonical.toLowerCase(), canonical);
      } catch { /* Broken or inaccessible registration is not evidence. */ }
    }
  }
  return found.size === 1 ? [...found.values()][0] : null;
}

/** The host adapter accepts this record only after rechecking the file. */
export async function writeVerifiedExecutableRecord(host, dataDir, options = {}) {
  const file = path.join(dataDir, "executable.json");
  const executable = resolveRegisteredExecutable(host, options);
  if (!executable) {
    await fsp.rm(file, { force: true });
    return null;
  }
  await fsp.mkdir(dataDir, { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await fsp.writeFile(temporary, `${JSON.stringify({
      schema: "beauticode.host-executable/v1", host, path: executable,
    })}\n`, "utf8");
    await fsp.rename(temporary, file);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return file;
}
