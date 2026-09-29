import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const MIN_NODE_MAJOR = 22;
export const RUNTIME_SCHEMA = "beauticode.runtime/v1";

function localAppData(env = process.env, home = os.homedir()) {
  return env.LOCALAPPDATA || path.join(home, "AppData", "Local");
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
  await atomicWrite(launcher, renderRuntimeLauncherPs1({ host, startupLogPath: options.startupLogPath }));
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
    const runtime = { host, hostRoot, activeRoot, pointerPath: path.join(hostRoot, "current.json"), launcher: path.join(hostRoot, "launcher.ps1"), version, entrypoint };
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
