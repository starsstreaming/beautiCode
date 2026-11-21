import fs from 'node:fs/promises';
import path from 'node:path';
import { IMAGE_EXTENSIONS, isVideoExtension } from './constants.js';

const MAX_METADATA_BYTES = 1024 * 1024;
const PREVIEW_NAMES = IMAGE_EXTENSIONS.map(extension => 'preview' + extension);

/** Check the whole path so a workshop directory cannot redirect outside the local library. */
export async function canonicalWallpaperPath(value: string, kind: 'file' | 'directory'): Promise<string> {
  if (!path.isAbsolute(value) || value.includes('\0') || /^[\\/]{2}/.test(value) ||
      (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(value))) {
    throw new Error('An absolute local path is required.');
  }
  const absolute = path.resolve(value);
  const { root } = path.parse(absolute);
  let current = root;
  for (const segment of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    if (process.platform === 'win32' && segment.includes(':')) throw new Error('Invalid local path.');
    current = path.join(current, segment);
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Redirected wallpaper paths are unsupported.');
  }
  const stat = await fs.lstat(absolute);
  if (kind === 'file' ? !stat.isFile() : !stat.isDirectory()) throw new Error(`Expected a regular ${kind}.`);
  const resolved = await fs.realpath(absolute);
  if (path.relative(absolute, resolved) !== '') throw new Error('Local path changed or was redirected.');
  return resolved;
}

export async function readWallpaperMetadata(file: string): Promise<string> {
  const canonical = await canonicalWallpaperPath(file, 'file');
  const handle = await fs.open(canonical, 'r');
  try {
    const before = await handle.stat();
    const current = await fs.lstat(await canonicalWallpaperPath(canonical, 'file'));
    if (!before.isFile() || before.size > MAX_METADATA_BYTES ||
        before.dev !== current.dev || before.ino !== current.ino) {
      throw new Error('Wallpaper metadata changed or exceeded the size limit.');
    }
    const bytes = Buffer.alloc(before.size);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    if (bytesRead !== bytes.length || before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('Wallpaper metadata changed while reading.');
    }
    return bytes.toString('utf8').replace(/^\uFEFF/, '');
  } finally {
    await handle.close();
  }
}

type WallpaperType = 'scene' | 'video';

export interface WallpaperProject {
  projectPath: string;
  title: string;
  type: WallpaperType;
  resources: string[];
}

function safeRelativeFile(value: string): string {
  const parts = value.split(/[\\/]/);
  if (value.length > 4096 || parts.some(part => !part || part === '.' || part === '..' ||
      /[\x00-\x1f<>:"|?*]/.test(part) || /[. ]$/.test(part))) {
    throw new Error('Wallpaper resource path is unsafe.');
  }
  return parts.join(path.sep);
}

/** Read bounded metadata only. Media is resolved and validated after selection. */
export async function readWallpaperProject(projectPath: string): Promise<WallpaperProject | null> {
  if (path.basename(projectPath).toLowerCase() !== 'project.json') throw new Error('Select project.json.');
  const project = JSON.parse(await readWallpaperMetadata(projectPath)) as Record<string, unknown> | null;
  if (!project || typeof project !== 'object' || Array.isArray(project)) throw new Error('Invalid wallpaper project.');
  const type = typeof project.type === 'string' ? project.type.toLowerCase() : '';
  if (type !== 'video' && type !== 'scene') return null;
  const title = (typeof project.title === 'string' ? project.title.trim() : '') ||
    path.basename(path.dirname(projectPath));
  if (type === 'video') {
    if (typeof project.file !== 'string' || !isVideoExtension(path.extname(project.file))) return null;
    return { projectPath, title: title.slice(0, 80), type, resources: [safeRelativeFile(project.file)] };
  }
  const resources = [...PREVIEW_NAMES];
  if (typeof project.preview === 'string' && project.preview) {
    const preview = safeRelativeFile(project.preview);
    if ((IMAGE_EXTENSIONS as readonly string[]).includes(path.extname(preview).toLowerCase())) resources.unshift(preview);
  }
  return { projectPath, title: title.slice(0, 80), type, resources: [...new Set(resources)] };
}

export async function resolveWallpaperProject(projectPath: string): Promise<{
  projectPath: string; title: string; type: WallpaperType; mediaPath: string;
}> {
  const project = await readWallpaperProject(projectPath);
  if (!project) throw new Error('Unsupported wallpaper project.');
  for (const resource of project.resources) {
    try {
      const mediaPath = await canonicalWallpaperPath(path.join(path.dirname(projectPath), resource), 'file');
      return { projectPath, title: project.title, type: project.type, mediaPath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  throw new Error('Wallpaper media is unavailable or unsupported.');
}
