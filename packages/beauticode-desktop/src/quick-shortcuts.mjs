import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NAMES = Object.freeze({ codex: 'Codex', workbuddy: 'WorkBuddy', cursor: 'Cursor', doubao: 'Doubao' });

function psLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function stableQuickLauncher(host, options = {}) {
  if (!NAMES[host]) throw new Error('unsupported-quick-launch-host');
  const local = options.localAppData || process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return host === 'codex'
    ? path.join(local, 'beautiCode', 'codex-plugin', 'launcher.ps1')
    : path.join(local, 'beautiCode', 'runtime', host, 'launcher.ps1');
}

/** Create only an owned Start Menu link; a same-named foreign link is a conflict. */
export function installHostQuickShortcut(host, options = {}) {
  if (process.platform !== 'win32') throw new Error('windows-only');
  if (!NAMES[host]) throw new Error('unsupported-quick-launch-host');
  const launcher = options.launcher || stableQuickLauncher(host, options);
  if (!path.win32.isAbsolute(launcher) || !fs.existsSync(launcher)) throw new Error('stable-launcher-missing');
  const appData = options.appData || process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const programsDir = options.programsDir || path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'beautiCode');
  fs.mkdirSync(programsDir, { recursive: true });
  const shortcutPath = path.join(programsDir, `beautiCode ${NAMES[host]} (背景).lnk`);
  const description = `beautiCode quick launch for ${host}`;
  const script = [
    "$ErrorActionPreference='Stop'",
    "$shell=New-Object -ComObject WScript.Shell",
    `$shortcutPath=${psLiteral(shortcutPath)}`,
    `$launcher=${psLiteral(launcher)}`,
    `$description=${psLiteral(description)}`,
    "$target=(Join-Path $env:WINDIR 'System32\\WindowsPowerShell\\v1.0\\powershell.exe')",
    "  $arguments='-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " + '"' + "' + $launcher + '" + '"' + " --quick-launch'",
    "if(Test-Path -LiteralPath $shortcutPath){",
    "  $existing=$shell.CreateShortcut($shortcutPath)",
    "  if($existing.Description -ne $description -or $existing.Arguments -ne $arguments -or $existing.TargetPath -ine $target){throw 'shortcut-conflict'}",
    "  [Console]::Out.WriteLine('present')",
    '}else{',
    "  $link=$shell.CreateShortcut($shortcutPath)",
    "  $link.TargetPath=$target",
    "  $link.Arguments=$arguments",
    "  $link.WorkingDirectory=(Split-Path -Parent $launcher)",
    "  $link.WindowStyle=7",
    "  $link.Description=$description",
    "  $link.Save()",
    "  [Console]::Out.WriteLine('created')",
    '}',
  ].join('\n');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, timeout: 8_000, maxBuffer: 16 * 1024,
  });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || 'shortcut-create-failed').trim().slice(0, 200));
  const outcome = String(result.stdout).trim();
  if (outcome !== 'created' && outcome !== 'present') throw new Error('shortcut-result-invalid');
  return { outcome, path: shortcutPath };
}
