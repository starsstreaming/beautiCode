import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_PKG_BYTES = 512 * 1024 * 1024;
const MAX_INDEX_BYTES = 16 * 1024 * 1024;
const PREVIEW_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif']);
// Scanning/searching a library must not hash every large package repeatedly.
// Reuse only the immutable package digest while the OS file identity is unchanged.
const packageDigests = new Map<string, { fingerprint: string; digest: string }>();
export interface ValidatedSceneProject {
  projectPath: string;
  pkgPath: string;
  project: Record<string, unknown>;
  identity: string;
  packageDigest: string;
  packageFingerprint: string;
  previewPath?: string;
}

export function fileFingerprint(stat: Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

/** No user-controlled link/junction may redirect a trusted directory or file. */
export async function canonicalLocalPath(value: string, kind: 'file' | 'directory'): Promise<string> {
  // UNC and device paths can reach a different machine or bypass normal path
  // semantics; a Steam library is restricted to a local, fully qualified path.
  if (!path.isAbsolute(value) || value.includes('\0') || /^(?:\\\\|\/\/)/.test(value) ||
      (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(value))) {
    throw new Error('An absolute local path is required.');
  }
  const absolute = path.resolve(value);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error('Symbolic links and junctions are not allowed.');
  }
  const stat = await fs.lstat(absolute);
  if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) throw new Error(`Expected a regular ${kind}.`);
  const resolved = await fs.realpath(absolute);
  const key = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
  if (key(resolved) !== key(absolute)) throw new Error('Local path changed or was redirected.');
  return resolved;
}

/** Bind the checked path to the opened file before any caller reads its bytes. */
export async function openVerifiedLocalFile(value: string): Promise<{ file: string; handle: FileHandle; stat: Stats }> {
  const file = await canonicalLocalPath(value, 'file');
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat();
    await canonicalLocalPath(file, 'file');
    const current = await fs.lstat(file);
    if (!opened.isFile() || !current.isFile() || fileFingerprint(opened) !== fileFingerprint(current)) {
      throw new Error('Local file changed while opening.');
    }
    return { file, handle, stat: opened };
  } catch (error) { await handle.close(); throw error; }
}

export function safeProjectRelative(value: string): string {
  const parts = value.replaceAll('\\', '/').split('/');
  if (!value || value.length > 4096 || parts.some(p => !p || p === '.' || p === '..' || /[\x00-\x1f<>:"|?*]/.test(p) || /[. ]$/.test(p))) {
    throw new Error('Project resource path is unsafe.');
  }
  return parts.join(path.sep);
}

export async function projectResource(root: string, relative: string): Promise<string> {
  const target = path.resolve(root, safeProjectRelative(relative));
  const fromRoot = path.relative(root, target);
  if (fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
    throw new Error('Project resource escapes its directory.');
  }
  return canonicalLocalPath(target, 'file');
}

export async function readWallpaperProject(projectPath: string): Promise<{ projectPath: string; project: Record<string, unknown>; identity: string }> {
  if (path.basename(projectPath).toLowerCase() !== 'project.json') throw new Error('Select project.json.');
  const { file: resolved, handle: opened } = await openVerifiedLocalFile(projectPath);
  try {
    const before = await opened.stat();
    if (!before.isFile() || before.size < 2 || before.size > MAX_JSON_BYTES) throw new Error('Project JSON exceeds the 1 MiB limit or is empty.');
    const bytes = Buffer.alloc(before.size);
    const { bytesRead } = await opened.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== bytes.length || fileFingerprint(before) !== fileFingerprint(await opened.stat())) throw new Error('Project changed while reading.');
    const project: unknown = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    if (!project || typeof project !== 'object' || Array.isArray(project)) throw new Error('Project JSON must be an object.');
    return { projectPath: resolved, project: project as Record<string, unknown>, identity: createHash('sha256').update(bytes).digest('hex') };
  } finally { await opened.close(); }
}

export async function projectPreview(root: string, project: Record<string, unknown>): Promise<string | undefined> {
  if (project.preview === undefined || project.preview === '') return undefined;
  if (typeof project.preview !== 'string') throw new Error('Preview must be a relative filename.');
  const relative = safeProjectRelative(project.preview);
  if (!PREVIEW_EXTENSIONS.has(path.extname(relative).toLowerCase())) return undefined;
  try { return await projectResource(root, relative); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function inspectPackage(opened: FileHandle, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const before = await opened.stat();
  if (!before.isFile() || before.size < 16 || before.size > MAX_PKG_BYTES) throw new Error('Scene package must be a regular PKG no larger than 512 MiB.');
  const index = Buffer.alloc(Math.min(before.size, MAX_INDEX_BYTES));
  const { bytesRead } = await opened.read(index, 0, index.length, 0);
  signal?.throwIfAborted();
  let cursor = 0;
  const integer = () => {
    if (cursor + 4 > bytesRead) throw new Error('Truncated PKG index.');
    const value = index.readUInt32LE(cursor); cursor += 4; return value;
  };
  const string = (maxLength: number) => {
    const length = integer();
    if (!length || length > maxLength || cursor + length > bytesRead) throw new Error('Invalid PKG string boundary.');
    const value = index.subarray(cursor, cursor + length).toString('utf8'); cursor += length; return value;
  };
  // Layout follows RePKG PackageReader: offsets are relative to the end of the index.
  if (!/^PKGV\d{4}$/.test(string(8))) throw new Error('Unsupported PKG header.');
  const count = integer();
  if (!count || count > 50000) throw new Error('Invalid PKG entry count.');
  const entries: { offset: number; length: number }[] = [];
  const names = new Set<string>();
  for (let i = 0; i < count; i++) {
    const name = safeProjectRelative(string(4096)).replaceAll(path.sep, '/').toLowerCase();
    if (names.has(name)) throw new Error('Duplicate PKG entry.');
    names.add(name); entries.push({ offset: integer(), length: integer() });
  }
  if (!names.has('scene.json')) throw new Error('PKG does not contain scene.json.');
  for (const entry of entries) {
    if (entry.offset + entry.length > before.size - cursor) throw new Error('PKG entry exceeds data boundary.');
  }
  const hash = createHash('sha256');
  const chunk = Buffer.alloc(Math.min(1024 * 1024, before.size));
  for (let position = 0; position < before.size;) {
    signal?.throwIfAborted();
    const read = await opened.read(chunk, 0, Math.min(chunk.length, before.size - position), position);
    if (!read.bytesRead) throw new Error('Package changed while reading.');
    hash.update(chunk.subarray(0, read.bytesRead)); position += read.bytesRead;
  }
  signal?.throwIfAborted();
  if (fileFingerprint(before) !== fileFingerprint(await opened.stat())) throw new Error('Package changed while validating.');
  return hash.digest('hex');
}

export async function validateSceneProject(projectPath: string, options: { signal?: AbortSignal } = {}): Promise<ValidatedSceneProject> {
  const signal = options.signal;
  signal?.throwIfAborted();
  const metadata = await readWallpaperProject(projectPath);
  signal?.throwIfAborted();
  if (typeof metadata.project.type !== 'string' || metadata.project.type.toLowerCase() !== 'scene') throw new Error('Project type must be scene.');
  const root = path.dirname(metadata.projectPath);
  const file = metadata.project.file;
  if (typeof file !== 'string') throw new Error('Scene project requires a file.');
  const relative = safeProjectRelative(file);
  let packageName = relative;
  if (relative.toLowerCase() === 'scene.json') {
    // Packed scenes advertise their virtual scene.json although it exists only inside scene.pkg.
    try { await fs.lstat(path.join(root, relative)); throw new Error('Unpacked scene projects are unsupported.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    packageName = 'scene.pkg';
  }
  if (path.extname(packageName).toLowerCase() !== '.pkg') throw new Error('Scene file must name a PKG.');
  const pkgPath = await projectResource(root, packageName);
  signal?.throwIfAborted();
  const { handle: opened } = await openVerifiedLocalFile(pkgPath);
  let packageIdentity: string, packageFingerprint: string;
  try {
    const fingerprint = fileFingerprint(await opened.stat());
    packageFingerprint = fingerprint;
    const cached = packageDigests.get(pkgPath);
    packageIdentity = cached?.fingerprint === fingerprint ? cached.digest : await inspectPackage(opened, signal);
    signal?.throwIfAborted();
    if (!cached || cached.fingerprint !== fingerprint) {
      if (packageDigests.size >= 128) packageDigests.delete(packageDigests.keys().next().value!);
      packageDigests.set(pkgPath, { fingerprint, digest: packageIdentity });
    }
  } finally { await opened.close(); }
  const previewPath = await projectPreview(root, metadata.project);
  signal?.throwIfAborted();
  return { projectPath: metadata.projectPath, pkgPath, project: metadata.project, packageDigest: packageIdentity, packageFingerprint,
    identity: createHash('sha256').update(`${metadata.identity}:${packageIdentity}`).digest('hex'),
    ...(previewPath ? { previewPath } : {}) };
}
