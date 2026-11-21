import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  canonicalWallpaperPath,
  readWallpaperMetadata,
  readWallpaperProject,
  resolveWallpaperProject,
  type WallpaperProject,
} from './wallpaper-project.js';

const WORKSHOP_PATH = ['steamapps', 'workshop', 'content', '431960'];
const SCAN_LIMIT = 5000;

export interface WallpaperItem {
  id: string;
  title: string;
  type: WallpaperProject['type'];
}

/** One read-only inventory per library opening. The renderer only sees opaque IDs. */
export class WallpaperLibrary {
  private constructor(private readonly items: ReadonlyMap<string, WallpaperProject>) {}

  static async scan(roots: readonly string[]): Promise<WallpaperLibrary> {
    const projects = new Map<string, WallpaperProject>();
    let remaining = SCAN_LIMIT;
    for (const root of roots) {
      if (remaining === 0) break;
      try {
        const canonical = await canonicalWallpaperPath(root, 'directory');
        const directory = await fs.opendir(canonical);
        for await (const entry of directory) {
          if (remaining === 0) break;
          remaining--;
          if (!entry.isDirectory()) continue;
          try {
            const project = await readWallpaperProject(path.join(canonical, entry.name, 'project.json'));
            if (project) projects.set(project.projectPath, project);
          } catch { /* Ignore malformed or unavailable subscriptions. */ }
        }
      } catch { /* A library may disappear during scanning. */ }
    }
    const sorted = [...projects.values()].sort((a, b) =>
      a.title.localeCompare(b.title, 'zh') || a.projectPath.localeCompare(b.projectPath));
    return new WallpaperLibrary(new Map(sorted.map(project => [randomBytes(16).toString('hex'), project])));
  }

  list(offset: number, limit: number): { items: WallpaperItem[]; total: number } {
    if (!Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid wallpaper pagination.');
    const items = [...this.items].slice(offset, offset + limit).map(([id, { title, type }]) => ({ id, title, type }));
    return { items, total: this.items.size };
  }

  async resolve(id: string): ReturnType<typeof resolveWallpaperProject> {
    const project = this.items.get(id);
    if (!project) throw new Error('Unknown wallpaper ID. Refresh the library.');
    return resolveWallpaperProject(project.projectPath);
  }
}

export function parseSteamLibraryFolders(source: string): string[] {
  const paths = new Set<string>();
  for (const match of source.matchAll(/"path"\s+"((?:[^"\\]|\\[\\"])*)"/gi)) {
    const decoded = match[1]!.replace(/\\([\\"])/g, '$1');
    if (!/[\x00-\x1f]/.test(decoded)) paths.add(decoded);
  }
  return [...paths];
}

/** Discover the known Workshop path in registered and default Steam libraries. */
export async function discoverWallpaperRoots(previousScanFile?: string): Promise<string[]> {
  if (process.platform !== 'win32') return [];
  const steamPaths = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]
    .filter((base): base is string => Boolean(base)).map(base => path.join(base, 'Steam'));
  try {
    const { stdout } = await promisify(execFile)('reg.exe', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], {
      timeout: 3000, maxBuffer: 64 * 1024, windowsHide: true,
    });
    const steam = /SteamPath\s+REG_SZ\s+([^\r\n]+)/i.exec(stdout)?.[1]?.trim();
    if (steam) steamPaths.push(steam);
  } catch { /* Steam may not be registered. */ }

  const candidates = new Set<string>();
  for (const steam of new Set(steamPaths)) {
    let libraries = [steam];
    try {
      const config = await readWallpaperMetadata(path.join(steam, 'steamapps', 'libraryfolders.vdf'));
      libraries = libraries.concat(parseSteamLibraryFolders(config));
    } catch { /* The primary Steam library is still discoverable. */ }
    for (const base of libraries) {
      if (path.isAbsolute(base)) candidates.add(path.join(base, ...WORKSHOP_PATH));
    }
  }
  // Read older installations' remembered roots even when the cache is read-only.
  if (previousScanFile) {
    try {
      const previous = JSON.parse(await readWallpaperMetadata(previousScanFile)) as { version?: unknown; roots?: unknown };
      const suffix = path.sep + WORKSHOP_PATH.join(path.sep);
      if (previous?.version === 1 && Array.isArray(previous.roots)) {
        for (const root of previous.roots) {
          if (typeof root === 'string' && path.normalize(root).toLowerCase().endsWith(suffix)) candidates.add(root);
        }
      }
    } catch { /* A missing or damaged optional cache cannot stop discovery. */ }
  }
  const roots = new Map<string, string>();
  for (const candidate of candidates) {
    try {
      const root = await canonicalWallpaperPath(candidate, 'directory');
      roots.set(root.toLowerCase(), root);
    } catch { /* A Steam library need not contain subscriptions. */ }
  }
  return [...roots.values()];
}
