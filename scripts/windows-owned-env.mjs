import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const key = 'WORKBUDDY_REMOTE_DEBUGGING_PORT';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function powershell(script) {
  const encoded = Buffer.from(`$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);${script}`, 'utf16le').toString('base64');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error('Unable to read or update the WorkBuddy user environment.');
  return result.stdout.trim();
}

export const windowsPortRegistry = {
  read() {
    const raw = powershell(`$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment');try {if($null -eq $k -or $k.GetValueNames() -notcontains '${key}'){'null'}else{@{value=$k.GetValue('${key}',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);kind=$k.GetValueKind('${key}').ToString()}|ConvertTo-Json -Compress}}finally{if($k){$k.Dispose()}}`);
    const value = JSON.parse(raw);
    if (value === null) return null;
    if (!['String', 'ExpandString'].includes(value.kind) || typeof value.value !== 'string') throw new Error('Unsupported existing WorkBuddy environment value; left unchanged.');
    return { value: value.value, kind: value.kind };
  },
  write(value) {
    const literal = value ? `'${value.value.replaceAll("'", "''")}'` : null;
    powershell(`$k=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment');try {${value ? `$k.SetValue('${key}',${literal},[Microsoft.Win32.RegistryValueKind]::${value.kind})` : `$k.DeleteValue('${key}',$false)`}}finally{$k.Dispose()}`);
  },
};

/** Journal before changing the registry; never adopt or delete someone else's later value. */
export function updateOwnedPort(options) {
  fs.mkdirSync(path.dirname(options.journal), { recursive: true });
  const lock = options.journal + '.lock';
  const fd = fs.openSync(lock, 'wx');
  try { return updateOwnedPortLocked(options); }
  finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

function updateOwnedPortLocked({ journal, port, remove = false, registry = windowsPortRegistry }) {
  let saved;
  try { saved = JSON.parse(fs.readFileSync(journal, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const validValue = value => value === null || (value && typeof value.value === 'string' && ['String', 'ExpandString'].includes(value.kind));
  if (saved && (!validValue(saved.original) || !validValue(saved.written) || (saved.previousWritten !== undefined && !validValue(saved.previousWritten)))) throw new Error('Invalid environment journal values.');
  if (saved && (saved.schema !== 1 || saved.key !== key || !saved.written || !Object.hasOwn(saved, 'original'))) throw new Error('Invalid environment ownership journal; no registry changes made.');
  const current = registry.read();
  if (remove) {
    if (!saved) return 'unmanaged'; // Legacy installations have no provable original value.
    if (!same(current, saved.written) && !(saved.previousWritten && same(current, saved.previousWritten))) return 'externally-changed';
    registry.write(saved.original);
    if (!same(registry.read(), saved.original)) throw new Error('Environment restore verification failed; journal retained.');
    fs.unlinkSync(journal);
    return 'restored';
  }
  if (!/^\d+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid WorkBuddy port.');
  if (saved && !same(current, saved.written) && !same(current, saved.original) && !(saved.previousWritten && same(current, saved.previousWritten))) throw new Error('WorkBuddy environment was changed externally; left unchanged.');
  const written = { value: String(port), kind: 'String' };
  const record = { schema: 1, key, original: saved ? saved.original : current, written, previousWritten: saved ? current : null };
  fs.mkdirSync(path.dirname(journal), { recursive: true });
  const temporary = `${journal}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(record), { flag: 'wx' });
  fs.renameSync(temporary, journal);
  registry.write(written);
  if (!same(registry.read(), written)) throw new Error('Environment write verification failed; journal retained.');
  return 'installed';
}
