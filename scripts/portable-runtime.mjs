import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

export const MIN_NODE_MAJOR = 22;
export const RUNTIME_SCHEMA = "beauticode.runtime/v1";

/**
 * Per-user machine-local data base. Windows keeps %LOCALAPPDATA%; Linux uses
 * the XDG data home so every beautiCode file lives under ~/.local/share.
 */
export function localDataBase(env = process.env, home = os.homedir(), platform = process.platform) {
  if (platform === "linux" && !env.LOCALAPPDATA) {
    return env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, ".local", "share");
  }
  return env.LOCALAPPDATA || path.join(home, "AppData", "Local");
}

function localAppData(env = process.env, home = os.homedir()) {
  return localDataBase(env, home);
}

/**
 * Host state directory used by the Cursor/Doubao/WorkBuddy guardians. Windows
 * keeps its historical lower-case folder (the filesystem is case-insensitive);
 * Linux shares core's `beautiCode` data root instead of creating a twin.
 */
export function beautiCodeLocalRoot(env = process.env, home = os.homedir(), platform = process.platform) {
  return path.join(localDataBase(env, home, platform), platform === "linux" ? "beautiCode" : "beauticode");
}

export function xdgConfigHome(env = process.env, home = os.homedir()) {
  return env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, ".config");
}

/** XDG autostart entry path (~/.config/autostart/<name>.desktop). */
export function xdgAutostartPath(name, env = process.env, home = os.homedir()) {
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(String(name))) throw new Error("无效的 autostart 名称。");
  return path.join(xdgConfigHome(env, home), "autostart", `${name}.desktop`);
}

export function stableRuntimeRoot(env = process.env, home = os.homedir()) {
  return path.join(localAppData(env, home), "beautiCode", "runtime");
}

export function hostRuntimeRoot(stableRoot, host) {
  if (!/^[a-z][a-z0-9-]{1,24}$/i.test(String(host))) throw new Error("无效的 host runtime 名称。");
  return path.join(path.resolve(stableRoot), String(host).toLowerCase());
}

function randomSuffix() {
  return `${process.pid}-${crypto.randomUUID()}`;
}

async function atomicWrite(file, data) {
  const temporary = `${file}.tmp-${randomSuffix()}`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  try {
    await fsp.writeFile(temporary, data, "utf8");
    await fsp.rename(temporary, file);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function writeTextAtomic(file, data) {
  await atomicWrite(file, data);
}

async function copyTree(source, destination, filter = () => true, relativeRoot = "") {
  await fsp.mkdir(destination, { recursive: true });
  for (const entry of await fsp.readdir(source, { withFileTypes: true })) {
    const relative = path.join(relativeRoot, entry.name);
    if (!filter(relative, entry)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyTree(from, to, filter, relative);
    else if (entry.isFile()) await fsp.copyFile(from, to);
  }
}

function quoteVbs(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function psQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function renderRuntimeLauncherPs1({ host, startupLogPath } = {}) {
  const safeHost = String(host).replace(/[^a-z0-9_-]/gi, "");
  if (!safeHost) throw new Error("无效的 host runtime 名称。");
  const body = [
    "$ErrorActionPreference = 'Stop'",
    `$hostName = ${psQuote(safeHost)}`,
    "$hostRoot = Split-Path -Parent $MyInvocation.MyCommand.Path",
    "$pointerPath = Join-Path $hostRoot 'current.json'",
    "if (-not (Test-Path -LiteralPath $pointerPath -PathType Leaf)) { throw 'beautiCode runtime pointer is missing' }",
    "$pointer = Get-Content -LiteralPath $pointerPath -Raw | ConvertFrom-Json",
    "if ($pointer.schema -ne 'beauticode.runtime/v1' -or $pointer.host -ne $hostName -or $pointer.version -notmatch '^[A-Za-z0-9._-]+$') { throw 'beautiCode runtime pointer is invalid' }",
    "$activeRoot = Join-Path (Join-Path $hostRoot 'versions') $pointer.version",
    "if (-not (Test-Path -LiteralPath $activeRoot -PathType Container)) { throw 'beautiCode runtime version is missing' }",
    "$entryRelative = [string]$pointer.entrypoint",
    "if ($args.Count -gt 0 -and $args[0] -eq '--quick-launch') {",
    "  $entryRelative = if ($hostName -eq 'codex-plugin') { 'quick-launch.mjs' } else { 'scripts\\quick-launch.mjs' }",
    "  $args = @($args | Select-Object -Skip 1)",
    "  $args = @($hostName) + $args",
    "}",
    "$entry = Join-Path $activeRoot $entryRelative",
    "if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw 'beautiCode runtime entrypoint is missing' }",
    "$recordPath = Join-Path $hostRoot 'node-source.json'",
    "$candidates = @()",
    "if (Test-Path -LiteralPath $recordPath -PathType Leaf) { try { $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json; if ($record.path) { $candidates += [string]$record.path } } catch {} }",
    "if ($env:BEAUTICODE_NODE_PATH) { $candidates += [string]$env:BEAUTICODE_NODE_PATH }",
    "if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\\nodejs\\node.exe') }",
    "if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'nodejs\\node.exe') }",
    "if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'nodejs\\node.exe') }",
    "$candidates += 'C:\\Program Files\\nodejs\\node.exe'",
    "try { $candidates += @(where.exe node.exe 2>$null) } catch {}",
    "$node = $null",
    "foreach ($candidate in $candidates) {",
    "  if (-not $candidate -or -not [System.IO.Path]::IsPathRooted($candidate) -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }",
    "  if ($candidate -match '(?i)workbuddy.*sandbox|sandbox.*workbuddy') { continue }",
    "  try { $version = (& $candidate --version 2>$null).Trim(); if ($version -match '^v?(\\d+)(?:\\.|$)' -and [int]$Matches[1] -ge 22) { $node = (Resolve-Path -LiteralPath $candidate).Path; break } } catch {}",
    "}",
    "if (-not $node) { throw 'beautiCode requires Node.js >=22; install Node.js 22+ or set BEAUTICODE_NODE_PATH.' }",
    "& $node $entry @args",
    "exit $LASTEXITCODE",
    "",
  ];
  if (!startupLogPath) return body.join("\r\n");
  if (!path.win32.isAbsolute(startupLogPath)) throw new Error("startup log path must be absolute");
  const marked = body.slice(1).flatMap((line) => {
    const code = line.includes("runtime pointer is missing") ? "pointer-missing"
      : line.includes("runtime pointer is invalid") ? "pointer-invalid"
      : line.includes("runtime version is missing") ? "runtime-missing"
      : line.includes("runtime entrypoint is missing") ? "entry-missing"
      : line.includes("requires Node.js") ? "node-unavailable" : null;
    return code ? [`$startupCode = '${code}'`, line] : [line];
  });
  return [
    body[0],
    `$startupLog = ${psQuote(startupLogPath)}`,
    "$startupCode = 'launcher-failure'",
    "try {",
    ...marked,
    "} catch {",
    "  try {",
    "    $dir = Split-Path -Parent $startupLog; New-Item -ItemType Directory -Path $dir -Force | Out-Null",
    "    if ((Test-Path -LiteralPath $startupLog) -and (Get-Item -LiteralPath $startupLog).Length -gt 1048576) { Move-Item -LiteralPath $startupLog -Destination ($startupLog + '.previous') -Force }",
    "    Add-Content -LiteralPath $startupLog -Value ((Get-Date).ToUniversalTime().ToString('o') + ' [launcher-failure] ' + $startupCode) -Encoding UTF8",
    "  } catch {}",
    "  exit 1",
    "}",
    "",
  ].join("\r\n");
}

function shQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

/**
 * POSIX counterpart of launcher.ps1: resolve the active runtime from
 * current.json, find a Node.js >=22 that does not depend on the login PATH,
 * and exec the entrypoint. Launcher failures leave one sanitized log line.
 */
export function renderRuntimeLauncherSh({ host, startupLogPath, nodePath } = {}) {
  const safeHost = String(host).replace(/[^a-z0-9_-]/gi, "");
  if (!safeHost) throw new Error("无效的 host runtime 名称。");
  if (startupLogPath && !path.posix.isAbsolute(startupLogPath)) throw new Error("startup log path must be absolute");
  const quickEntry = safeHost === "codex-plugin" ? "quick-launch.mjs" : "scripts/quick-launch.mjs";
  const resolver = [
    "const fs=require('fs'),path=require('path');",
    "const [pointerPath,hostName,quick]=process.argv.slice(1);",
    "let p;try{p=JSON.parse(fs.readFileSync(pointerPath,'utf8'))}catch{process.exit(2)}",
    "if(p.schema!=='beauticode.runtime/v1'||p.host!==hostName||!/^[A-Za-z0-9._-]+$/.test(String(p.version)))process.exit(2);",
    "const root=path.join(path.dirname(pointerPath),'versions',p.version);",
    "if(!fs.existsSync(root))process.exit(3);",
    "const entry=path.resolve(root,quick||String(p.entrypoint));",
    "if(!entry.startsWith(root+path.sep)||!fs.existsSync(entry))process.exit(4);",
    "process.stdout.write(entry);",
  ].join("");
  return [
    "#!/bin/sh",
    "# beautiCode runtime launcher (generated; do not edit).",
    "set -u",
    `host_name=${shQuote(safeHost)}`,
    `startup_log=${shQuote(startupLogPath || "")}`,
    `node_hint=${shQuote(nodePath || "")}`,
    'host_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1',
    'fail() {',
    '  if [ -n "$startup_log" ]; then',
    '    mkdir -p "$(dirname -- "$startup_log")" 2>/dev/null',
    '    if [ -f "$startup_log" ] && [ "$(wc -c < "$startup_log")" -gt 1048576 ]; then mv -f "$startup_log" "$startup_log.previous"; fi',
    String.raw`    printf '%s [launcher-failure] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$startup_log" 2>/dev/null`,
    '  fi',
    '  echo "beautiCode launcher: $1" >&2',
    '  exit 1',
    '}',
    'pointer="$host_root/current.json"',
    '[ -f "$pointer" ] || fail pointer-missing',
    String.raw`node_ok() { [ -n "$1" ] && [ -x "$1" ] && "$1" -e 'process.exit(Number(process.versions.node.split(".")[0])>=22?0:1)' 2>/dev/null; }`,
    'node_bin=""',
    'record_node=""',
    String.raw`if [ -f "$host_root/node-source.json" ]; then record_node=$(sed -n 's/.*"path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$host_root/node-source.json" | head -n 1); fi`,
    'for candidate in "$node_hint" "${BEAUTICODE_NODE_PATH:-}" "$record_node" "$(command -v node 2>/dev/null)" /usr/local/bin/node /usr/bin/node; do',
    '  if node_ok "$candidate"; then node_bin=$candidate; break; fi',
    'done',
    '[ -n "$node_bin" ] || fail node-unavailable',
    'quick=""',
    'if [ "${1:-}" = "--quick-launch" ]; then',
    '  shift',
    `  quick=${shQuote(quickEntry)}`,
    '  set -- "$host_name" "$@"',
    'fi',
    `entry=$("$node_bin" -e ${shQuote(resolver)} "$pointer" "$host_name" "$quick")`,
    'case $? in',
    '  0) ;;',
    '  3) fail runtime-missing ;;',
    '  4) fail entry-missing ;;',
    '  *) fail pointer-invalid ;;',
    'esac',
    'if [ -n "$startup_log" ]; then',
    '  mkdir -p "$(dirname -- "$startup_log")" 2>/dev/null',
    '  if [ -f "$startup_log" ] && [ "$(wc -c < "$startup_log")" -gt 1048576 ]; then mv -f "$startup_log" "$startup_log.previous"; fi',
    '  exec "$node_bin" "$entry" "$@" >> "$startup_log" 2>&1',
    'fi',
    'exec "$node_bin" "$entry" "$@"',
    "",
  ].join("\n");
}

/** Quote one argument for a freedesktop Desktop Entry Exec key. */
export function desktopExecQuote(value) {
  const text = String(value);
  if (/[\x00-\x1f]/.test(text)) throw new Error("desktop entry argument contains control characters");
  const escaped = text.replace(/[\\"`$]/g, (char) => `\\${char}`).replaceAll("%", "%%");
  // The Exec key itself is a string value: backslashes are escaped once more.
  return `"${escaped.replaceAll("\\", "\\\\")}"`;
}

/** Hidden XDG autostart / application entry that runs a POSIX launcher. */
export function renderXdgDesktopEntry({ name, comment = "", launcher, args = [], autostart = true, icon = "" }) {
  if (!path.posix.isAbsolute(String(launcher))) throw new Error("launcher path must be absolute");
  const line = (value) => String(value).replace(/[\r\n]+/g, " ");
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${line(name)}`,
    ...(comment ? [`Comment=${line(comment)}`] : []),
    `Exec=${["/bin/sh", launcher, ...args].map(desktopExecQuote).join(" ")}`,
    ...(icon ? [`Icon=${line(icon)}`] : []),
    "Terminal=false",
    ...(autostart
      ? ["NoDisplay=true", "X-GNOME-Autostart-enabled=true", "X-KDE-autostart-after=panel"]
      : ["Categories=Development;Utility;", "StartupNotify=false"]),
    "X-BeautiCode-Managed=true",
    "",
  ].join("\n");
}

/** Start a launcher outside this process tree (the Linux "Run startup item now"). */
export function startDetachedLauncher(launcher, args = [], { env = process.env } = {}) {
  const child = spawn("/bin/sh", [launcher, ...args], { detached: true, stdio: "ignore", env });
  child.unref();
  return child.pid ?? null;
}

export function renderWindowsStartupVbs({ launcher, args = [] }) {
  const command = [
    "powershell.exe",
    "-NoProfile",
    "-WindowStyle",
    "Hidden",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    quoteVbs(launcher),
    ...args.map((value) => quoteVbs(value)),
  ].join(" ");
  return `CreateObject("WScript.Shell").Run ${quoteVbs(command)}, 0, False\r\n`;
}

export function renderCodexStarter({ launcher }) {
  return `& powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ${psQuote(launcher)}\r\nexit $LASTEXITCODE\r\n`;
}

export async function activateStableRuntime(runtime, options = {}) {
  const { host, entrypoint, version, pointerPath, launcher } = runtime;
  if (launcher.endsWith(".sh")) {
    const node = options.nodePath ? { path: options.nodePath } : await resolveNodeExecutable({ stableRoot: runtime.hostRoot });
    await atomicWrite(launcher, renderRuntimeLauncherSh({ host, startupLogPath: options.startupLogPath, nodePath: node.path }));
    await fsp.chmod(launcher, 0o755);
  } else {
    await atomicWrite(launcher, renderRuntimeLauncherPs1({ host, startupLogPath: options.startupLogPath }));
  }
  await atomicWrite(pointerPath, `${JSON.stringify({ schema: RUNTIME_SCHEMA, host: String(host).toLowerCase(), version, entrypoint }, null, 2)}\n`);
  return runtime;
}

export async function discardStableRuntime(runtime) {
  await fsp.rm(runtime.activeRoot, { recursive: true, force: true }).catch(() => {});
}

export async function syncStableRuntime({ sourceRoot, stableRoot, host, entrypoint = "runner.mjs", filter, fsApi = fsp, activate = true }) {
  const source = path.resolve(sourceRoot);
  const hostRoot = hostRuntimeRoot(stableRoot, host);
  const versionsRoot = path.join(hostRoot, "versions");
  const version = `v-${Date.now()}-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  const temporary = path.join(versionsRoot, `.tmp-${version}`);
  const activeRoot = path.join(versionsRoot, version);
  await fsApi.mkdir(versionsRoot, { recursive: true });
  try {
    await copyTree(source, temporary, filter);
    const relativeEntry = path.relative(temporary, path.join(temporary, entrypoint));
    if (!relativeEntry || relativeEntry.startsWith("..") || path.isAbsolute(relativeEntry)) {
      throw new Error("runtime entrypoint must stay inside the staged host runtime");
    }
    if (!fs.existsSync(path.join(temporary, entrypoint))) throw new Error(`runtime entrypoint missing: ${entrypoint}`);
    await fsApi.rename(temporary, activeRoot);
    const launcherName = process.platform === "linux" ? "launcher.sh" : "launcher.ps1";
    const runtime = { host, hostRoot, activeRoot, pointerPath: path.join(hostRoot, "current.json"), launcher: path.join(hostRoot, launcherName), version, entrypoint };
    if (activate) await activateStableRuntime(runtime);
    return runtime;
  } catch (error) {
    await fsApi.rm(temporary, { recursive: true, force: true }).catch(() => {});
    await fsApi.rm(activeRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function parseNodeVersion(raw) {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(raw).trim());
  if (!match) return null;
  return { major: Number(match[1]), version: `${match[1]}.${match[2] || 0}.${match[3] || 0}` };
}

function defaultProbeVersion(candidate) {
  const result = spawnSync(candidate, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 3_000 });
  if (result.status !== 0) return null;
  return parseNodeVersion(result.stdout || result.stderr);
}

function isSandboxNode(candidate) {
  return /(?:workbuddy[\\/].*sandbox|sandbox[\\/].*workbuddy)/i.test(String(candidate));
}

function defaultCandidates({ env = process.env, home = os.homedir(), stableRoot }) {
  const out = [];
  if (env.BEAUTICODE_NODE_PATH) out.push(env.BEAUTICODE_NODE_PATH);
  if (env.BEAUTICODE_STABLE_NODE_PATH) out.push(env.BEAUTICODE_STABLE_NODE_PATH);
  const record = path.join(stableRoot, "node-source.json");
  try { out.push(JSON.parse(fs.readFileSync(record, "utf8")).path); } catch {}
  out.push(path.join(stableRoot, "node.exe"));
  if (env.LOCALAPPDATA) out.push(path.join(env.LOCALAPPDATA, "Programs", "nodejs", "node.exe"));
  if (env.ProgramFiles) out.push(path.join(env.ProgramFiles, "nodejs", "node.exe"));
  if (env["ProgramFiles(x86)"]) out.push(path.join(env["ProgramFiles(x86)"], "nodejs", "node.exe"));
  out.push(path.join(home, "AppData", "Local", "Programs", "nodejs", "node.exe"));
  if (process.platform === "win32") {
    try { out.push(...String(spawnSync("where.exe", ["node.exe"], { encoding: "utf8", windowsHide: true }).stdout || "").split(/\r?\n/)); } catch {}
  }
  if (process.platform === "linux") {
    // The installer itself already satisfies engines>=22; prefer its absolute
    // path because a login session's PATH often lacks nvm/fnm/volta shims.
    out.push(process.execPath);
    const pathValue = env.PATH || "";
    for (const directory of pathValue.split(path.delimiter).filter(Boolean)) out.push(path.join(directory, "node"));
    out.push("/usr/local/bin/node", "/usr/bin/node");
  }
  return out.filter(Boolean);
}

export async function resolveNodeExecutable(options = {}) {
  const stableRoot = path.resolve(options.stableRoot || stableRuntimeRoot(options.env, options.home));
  const candidates = (options.candidates || defaultCandidates({ ...options, stableRoot })).map((candidate) => path.resolve(String(candidate)));
  const probeVersion = options.probeVersion || defaultProbeVersion;
  const exists = options.exists || ((candidate) => fs.existsSync(candidate));
  const valid = [];
  const sandbox = [];
  for (const candidate of [...new Set(candidates)]) {
    if (!exists(candidate)) continue;
    let version;
    try { version = await probeVersion(candidate); } catch { version = null; }
    if (!version || version.major < MIN_NODE_MAJOR) continue;
    (isSandboxNode(candidate) ? sandbox : valid).push({ path: candidate, ...version });
  }
  if (valid.length) return { ...valid[0], source: "absolute", sourceRecord: path.join(stableRoot, "node-source.json") };
  if (!sandbox.length) throw new Error(`找不到安全的 Node.js >=${MIN_NODE_MAJOR}。`);
  const source = sandbox[0];
  await fsp.mkdir(stableRoot, { recursive: true });
  const target = path.join(stableRoot, `node-v${source.version}.exe`);
  const copyFile = options.copyFile || ((from, to) => fsp.copyFile(from, to));
  const writeFile = options.writeFile || ((file, data) => atomicWrite(file, data));
  let destination = target;
  if (fs.existsSync(target)) {
    let existing;
    try { existing = await probeVersion(target); } catch { existing = null; }
    if (existing && existing.major >= MIN_NODE_MAJOR) {
      const sourceRecord = path.join(stableRoot, "node-source.json");
      await writeFile(sourceRecord, `${JSON.stringify({ schema: RUNTIME_SCHEMA, source: source.path, path: target, version: existing.version }, null, 2)}\n`);
      return { path: target, major: existing.major, version: existing.version, source: "sandbox-copy", sourceRecord };
    }
    destination = path.join(stableRoot, `node-v${source.version}-${crypto.randomUUID().slice(0, 8)}.exe`);
  }
  const temporary = `${destination}.tmp-${randomSuffix()}`;
  try {
    await copyFile(source.path, temporary);
    const copiedVersion = await probeVersion(temporary);
    if (!copiedVersion || copiedVersion.major < MIN_NODE_MAJOR) throw new Error("复制后的 Node.js 校验失败。");
    await fsp.rename(temporary, destination);
    const sourceRecord = path.join(stableRoot, "node-source.json");
    await writeFile(sourceRecord, `${JSON.stringify({ schema: RUNTIME_SCHEMA, source: source.path, path: destination, version: copiedVersion.version }, null, 2)}\n`);
    return { path: destination, major: copiedVersion.major, version: copiedVersion.version, source: "sandbox-copy", sourceRecord };
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export function startupDirectory(env = process.env, home = os.homedir()) {
  return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}

export function canonicalStartupMarker(host, env = process.env, home = os.homedir()) {
  return path.join(startupDirectory(env, home), `beauticode-${host}-runner.vbs`);
}
