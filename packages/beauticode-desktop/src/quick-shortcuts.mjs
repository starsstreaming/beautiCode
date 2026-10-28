import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const NAMES = Object.freeze({ codex: 'Codex', workbuddy: 'WorkBuddy', cursor: 'Cursor', doubao: 'Doubao' });

function psLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function linuxDataHome(options = {}) {
  const xdg = options.xdgDataHome || process.env.XDG_DATA_HOME;
  return xdg && path.isAbsolute(xdg) ? xdg : path.join(options.home || os.homedir(), '.local', 'share');
}

export function stableQuickLauncher(host, options = {}) {
  if (!NAMES[host]) throw new Error('unsupported-quick-launch-host');
  if ((options.platform || process.platform) === 'linux') {
    const local = options.localAppData || linuxDataHome(options);
    return host === 'codex'
      ? path.join(local, 'beautiCode', 'codex-plugin', 'launcher.sh')
      : path.join(local, 'beautiCode', 'runtime', host, 'launcher.sh');
  }
  const local = options.localAppData || process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return host === 'codex'
    ? path.join(local, 'beautiCode', 'codex-plugin', 'launcher.ps1')
    : path.join(local, 'beautiCode', 'runtime', host, 'launcher.ps1');
}

/** Create only an owned Start Menu link; a same-named foreign link is a conflict. */
export function installHostQuickShortcut(host, options = {}) {
  if ((options.platform || process.platform) === 'linux') return installLinuxQuickShortcut(host, options);
  if (process.platform !== 'win32') throw new Error('windows-only');
  if (!NAMES[host]) throw new Error('unsupported-quick-launch-host');
  const launcher = options.launcher || stableQuickLauncher(host, options);
  if (!path.win32.isAbsolute(launcher) || !fs.existsSync(launcher)) throw new Error('stable-launcher-missing');
  const appData = options.appData || process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const programsDir = options.programsDir || path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'beautiCode');
  fs.mkdirSync(programsDir, { recursive: true });
  const shortcutPath = path.join(programsDir, `beautiCode ${NAMES[host]} (背景).lnk`);
  // WScript shortcut persistence can reject Unicode filenames on an English Windows image.
  // Use a private ASCII alias for COM reads/writes; the filesystem publishes the unchanged display name without overwrite.
  const temporaryPath = path.join(programsDir, `.beauticode-${randomUUID()}.lnk`);
  const description = `beautiCode quick launch for ${host}`;
  const script = [
    "$ErrorActionPreference='Stop'",
    "$ProgressPreference='SilentlyContinue'",
    "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
    `$shortcutPath=${psLiteral(shortcutPath)}`,
    `$temporaryPath=${psLiteral(temporaryPath)}`,
    `$launcher=${psLiteral(launcher)}`,
    `$description=${psLiteral(description)}`,
    "$target=(Join-Path $env:WINDIR 'System32\\WindowsPowerShell\\v1.0\\powershell.exe')",
    "  $arguments='-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " + '"' + "' + $launcher + '" + '"' + " --quick-launch'",
    'try {',
    "$shell=New-Object -ComObject WScript.Shell",
    "if(Test-Path -LiteralPath $shortcutPath){",
    "  [System.IO.File]::Copy($shortcutPath,$temporaryPath)",
    "  $existing=$shell.CreateShortcut($temporaryPath)",
    "  if($existing.Description -ne $description -or $existing.Arguments -ne $arguments -or $existing.TargetPath -ine $target){throw 'shortcut-conflict'}",
    "  [Console]::Out.WriteLine('present')",
    '}else{',
    "  $link=$shell.CreateShortcut($temporaryPath)",
    "  $link.TargetPath=$target",
    "  $link.Arguments=$arguments",
    "  $link.WorkingDirectory=(Split-Path -Parent $launcher)",
    "  $link.WindowStyle=7",
    "  $link.Description=$description",
    "  $link.Save()",
    "  [System.IO.File]::Move($temporaryPath,$shortcutPath)",
    "  [Console]::Out.WriteLine('created')",
    '}',
    '} catch {',
    "  [Console]::Error.WriteLine($_.Exception.Message)",
    '  exit 1',
    '} finally {',
    "  [System.IO.File]::Delete($temporaryPath)",
    '}',
  ].join('\n');
  let operationError;
  try {
    const result = (options.spawnSync || spawnSync)('powershell.exe', ['-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      encoding: 'utf8', windowsHide: true, timeout: 8_000, maxBuffer: 64 * 1024,
    });
    if (result.error || result.status !== 0) {
      const code = result.error?.code || (/shortcut-conflict/.test(String(result.stderr)) ? 'shortcut-conflict' : `exit-${result.status ?? 'unknown'}`);
      const detail = result.error ? '' : String(result.stderr || result.stdout || '')
        .replaceAll(launcher, '[path]').replaceAll(shortcutPath, '[path]').replaceAll(temporaryPath, '[path]').replaceAll(programsDir, '[path]')
        .replace(/(?:https?|file):\/\/[^\s"'<>]+/gi, '[url]')
        .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^"'<>\r\n]+/g, '[path]')
        .replace(/[\x00-\x1f]+/g, ' ').trim().slice(0, 500);
      throw Object.assign(new Error(`shortcut-create-failed: ${code}${detail ? `: ${detail}` : ''}`), { code });
    }
    const outcome = String(result.stdout).trim();
    if (outcome !== 'created' && outcome !== 'present') throw new Error('shortcut-result-invalid');
    return { outcome, path: shortcutPath };
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try { fs.rmSync(temporaryPath, { force: true }); }
    catch (error) {
      const code = error.code || "unknown";
      const detail = operationError ? `${operationError.message}; ` : "";
      throw Object.assign(new Error(`${detail}shortcut-temp-cleanup-failed: ${code}`), { code });
    }
  }
}

const LINUX_ICONS = Object.freeze({ codex: 'chatgpt', workbuddy: 'workbuddy', cursor: 'co.anysphere.cursor', doubao: 'doubao' });

function desktopExecQuote(value) {
  // Same rules as portable-runtime desktopExecQuote (Desktop Entry spec).
  return `"${String(value).replace(/["`$\\]/g, (char) => `\\${char}`).replaceAll('%', '%%')}"`;
}

/** XDG application entry; an existing same-named entry we do not own is a conflict. */
function installLinuxQuickShortcut(host, options) {
  if (!NAMES[host] || host === 'doubao') throw new Error('unsupported-quick-launch-host');
  const launcher = options.launcher || stableQuickLauncher(host, { ...options, platform: 'linux' });
  if (!path.isAbsolute(launcher) || !fs.existsSync(launcher)) throw new Error('stable-launcher-missing');
  const applicationsDir = options.programsDir || path.join(linuxDataHome(options), 'applications');
  const shortcutPath = path.join(applicationsDir, `beautiCode-${host}-background.desktop`);
  const exec = `${desktopExecQuote('/bin/sh')} ${desktopExecQuote(launcher)} --quick-launch`;
  const content = [
    '[Desktop Entry]',
    'Type=Application',
    `Name=beautiCode ${NAMES[host]} (背景)`,
    `Comment=beautiCode quick launch for ${host}`,
    `Exec=${exec}`,
    `Icon=${LINUX_ICONS[host]}`,
    'Terminal=false',
    'Categories=Utility;',
    'X-BeautiCode-Managed=true',
    '',
  ].join('\n');
  let existing = null;
  try { existing = fs.readFileSync(shortcutPath, 'utf8'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  if (existing != null) {
    if (!/^X-BeautiCode-Managed=true$/m.test(existing) || !existing.includes(`Exec=${exec}`)) throw new Error('shortcut-conflict');
    return { outcome: 'present', path: shortcutPath };
  }
  fs.mkdirSync(applicationsDir, { recursive: true });
  const temporaryPath = path.join(applicationsDir, `.beauticode-${randomUUID()}.tmp`);
  fs.writeFileSync(temporaryPath, content, { mode: 0o644 });
  try {
    fs.linkSync(temporaryPath, shortcutPath); // fails instead of overwriting a racing foreign file
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('shortcut-conflict');
    throw error;
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
  return { outcome: 'created', path: shortcutPath };
}

/** Remove only our own XDG application entry (uninstall). */
export function removeLinuxQuickShortcut(host, options = {}) {
  const shortcutPath = path.join(options.programsDir || path.join(linuxDataHome(options), 'applications'), `beautiCode-${host}-background.desktop`);
  try {
    if (!/^X-BeautiCode-Managed=true$/m.test(fs.readFileSync(shortcutPath, 'utf8'))) return false;
  } catch { return false; }
  fs.rmSync(shortcutPath, { force: true });
  return true;
}
