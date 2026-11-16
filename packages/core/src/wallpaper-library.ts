import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateVideoFile } from './media-validation.js';
import { canonicalLocalPath, projectPreview, projectResource, readWallpaperProject, validateSceneProject } from './scene-project.js';

export interface WallpaperItem {
  id: string;
  title: string;
  type: string;
  available: boolean;
  reason?: string;
  hasPreview: boolean;
}
export interface ResolvedWallpaper {
  type: 'scene' | 'video' | 'image';
  projectPath: string;
  mediaPath?: string;
  previewPath?: string;
  title: string;
}
const SCAN_LIMIT = 5000;
const KNOWN_TYPES = new Set(['scene', 'video', 'web', 'application']);
function pathKey(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
function isWithinRoot(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function titleFor(project: Record<string, unknown>, projectPath: string): string {
  return typeof project.title === 'string' && project.title.trim() ? project.title.slice(0, 256) : path.basename(path.dirname(projectPath));
}
function typeFor(project: Record<string, unknown>): string {
  const type = typeof project.type === 'string' ? project.type.toLowerCase() : 'unknown';
  return KNOWN_TYPES.has(type) ? type : 'unknown';
}

/** Read-only inventory. Only opaque IDs cross the UI boundary; resolving revalidates disk state. */
export class WallpaperLibrary {
  private connected: string[] = [];
  private records = new Map<string, { file: string; root: string }>();
  private idsByPath = new Map<string, string>();
  private revision = 0;
  private scanSequence = 0;
  get roots(): readonly string[] { return [...this.connected]; }
  async connect(root: string): Promise<void> {
    const resolved = await canonicalLocalPath(root, 'directory');
    if (!this.connected.some(existing => pathKey(existing) === pathKey(resolved))) {
      this.connected.push(resolved);
      this.revision++;
    }
  }
  disconnect(root: string): void {
    const key = pathKey(root);
    const next = this.connected.filter(existing => pathKey(existing) !== key);
    if (next.length === this.connected.length) return;
    this.connected = next;
    this.revision++;
    for (const [id, record] of this.records) {
      if (pathKey(record.root) !== key) continue;
      this.records.delete(id);
      this.idsByPath.delete(pathKey(record.file));
    }
  }
  async list(options: { q?: string; type?: string; offset?: number; limit?: number } = {}): Promise<{ items: WallpaperItem[]; total: number; warnings: string[] }> {
    const { offset = 0, limit = 100 } = options;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid wallpaper pagination.');
    if ((options.q !== undefined && typeof options.q !== 'string') || (options.type !== undefined && typeof options.type !== 'string')) throw new Error('Invalid wallpaper filter.');
    const warnings: string[] = [];
    const revision = this.revision;
    const scan = ++this.scanSequence;
    const ensureCurrent = () => {
      if (revision !== this.revision || scan !== this.scanSequence) {
        throw new Error('Wallpaper library changed during scanning. Refresh the library.');
      }
    };
    const nextRecords = new Map<string, { file: string; root: string }>();
    const nextIds = new Map<string, string>();
    const all: WallpaperItem[] = [];
    let scanned = 0;
    for (const root of [...this.connected]) {
      try {
        ensureCurrent();
        await canonicalLocalPath(root, 'directory');
        const directory = await fs.opendir(root);
        for await (const entry of directory) {
          ensureCurrent();
          if (scanned >= SCAN_LIMIT) { warnings.push('Wallpaper scan stopped at 5000 entries.'); break; }
          scanned++;
          if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
          const file = path.join(root, entry.name, 'project.json');
          try {
            const metadata = await readWallpaperProject(file);
            if (!isWithinRoot(root, metadata.projectPath)) throw new Error('Wallpaper project escaped its authorized root.');
            const key = pathKey(metadata.projectPath);
            if (nextIds.has(key)) continue;
            const id = this.idsByPath.get(key) ?? randomBytes(16).toString('hex');
            const type = typeFor(metadata.project);
            const item: WallpaperItem = { id, title: titleFor(metadata.project, file), type, available: false, hasPreview: false };
            nextRecords.set(id, { file: metadata.projectPath, root });
            nextIds.set(key, id);
            try {
              item.hasPreview = Boolean(await projectPreview(path.dirname(file), metadata.project));
              if (type !== 'scene' && type !== 'video') item.reason = 'This wallpaper type is not supported.';
              else { await this.resolvePath(file); item.available = true; }
            } catch { item.reason = 'Wallpaper resources are unavailable or invalid.'; }
            all.push(item);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push('A wallpaper entry has invalid or unreadable project metadata.');
          }
        }
      } catch {
        ensureCurrent();
        warnings.push('A wallpaper folder is unavailable.');
      }
      if (scanned >= SCAN_LIMIT) {
        if (!warnings.some(warning => warning.includes('5000'))) warnings.push('Wallpaper scan stopped at 5000 entries.');
        break;
      }
    }
    ensureCurrent();
    this.records = nextRecords;
    this.idsByPath = nextIds;
    const query = (options.q ?? '').toLowerCase();
    const type = (options.type ?? '').toLowerCase();
    const filtered = all.filter(item => (!query || item.title.toLowerCase().includes(query)) && (!type || item.type === type));
    return { items: filtered.slice(offset, offset + limit), total: filtered.length, warnings };
  }
  async resolve(id: string): Promise<ResolvedWallpaper> {
    const record = this.records.get(id);
    if (!record) throw new Error('Unknown wallpaper ID. Refresh the library.');
    const result = await this.resolvePath(record.file);
    if (![result.projectPath, result.mediaPath, result.previewPath].filter((file): file is string => Boolean(file))
      .every(file => isWithinRoot(record.root, file))) throw new Error('Wallpaper resource escaped its authorized root.');
    if (this.records.get(id) !== record) throw new Error('Wallpaper access was revoked. Refresh the library.');
    return result;
  }
  async preview(id: string): Promise<string | null> {
    const record = this.records.get(id);
    if (!record) return null;
    try {
      const metadata = await readWallpaperProject(record.file);
      const preview = await projectPreview(path.dirname(metadata.projectPath), metadata.project) ?? null;
      return this.records.get(id) === record ? preview : null;
    } catch { return null; }
  }
  private async resolvePath(file: string): Promise<ResolvedWallpaper> {
    const metadata = await readWallpaperProject(file);
    const type = typeFor(metadata.project);
    const title = titleFor(metadata.project, file);
    if (type === 'scene') {
      const scene = await validateSceneProject(file);
      return { type, projectPath: scene.projectPath, title, ...(scene.previewPath ? { previewPath: scene.previewPath } : {}) };
    }
    if (type !== 'video' || typeof metadata.project.file !== 'string') throw new Error('Unsupported wallpaper type.');
    const mediaPath = await projectResource(path.dirname(metadata.projectPath), metadata.project.file);
    await validateVideoFile(mediaPath, { mode: 'fast', maxBytes: 800 * 1024 * 1024 });
    const previewPath = await projectPreview(path.dirname(metadata.projectPath), metadata.project);
    return { type, projectPath: metadata.projectPath, mediaPath, title, ...(previewPath ? { previewPath } : {}) };
  }
}

/** Only the VDF path records are needed; unknown escape sequences are rejected, never evaluated. */
export function parseSteamLibraryFolders(source: string): string[] {
  const results: string[] = [];
  for (const match of source.matchAll(/"path"\s+"((?:[^"\\]|\\.)*)"/gi)) {
    const raw = match[1]!;
    if (/\\(?![\\"])/.test(raw.replaceAll('\\\\', ''))) continue;
    const decoded = raw.replace(/\\([\\"])/g, '$1');
    if (!/[\x00-\x1f]/.test(decoded)) results.push(decoded);
  }
  return [...new Set(results)];
}

/** Discovery does not authorize a folder: callers explicitly connect a returned root. */
export async function discoverWallpaperRoots(): Promise<string[]> {
  if (process.platform !== 'win32') return [];
  const candidates: string[] = [];
  try {
    const { stdout } = await promisify(execFile)('reg.exe', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { timeout: 3000, maxBuffer: 64 * 1024, windowsHide: true });
    const steam = /SteamPath\s+REG_SZ\s+([^\r\n]+)/i.exec(stdout)?.[1]?.trim();
    if (!steam || !path.isAbsolute(steam)) return [];
    candidates.push(steam);
    const opened = await fs.open(path.join(steam, 'steamapps', 'libraryfolders.vdf'), 'r');
    try {
      const stat = await opened.stat();
      if (stat.isFile() && stat.size <= 1024 * 1024) {
        const bytes = Buffer.alloc(stat.size); const read = await opened.read(bytes, 0, bytes.length, 0);
        if (read.bytesRead === bytes.length) candidates.push(...parseSteamLibraryFolders(bytes.toString('utf8')));
      }
    } finally { await opened.close(); }
  } catch { /* Steam or its optional library inventory is not installed/readable. */ }
  const roots = new Map<string, string>();
  for (const base of candidates) {
    try {
      const root = await canonicalLocalPath(path.join(base, 'steamapps', 'workshop', 'content', '431960'), 'directory');
      roots.set(pathKey(root), root);
    } catch { /* A Steam library need not contain Wallpaper Engine subscriptions. */ }
  }
  return [...roots.values()];
}

