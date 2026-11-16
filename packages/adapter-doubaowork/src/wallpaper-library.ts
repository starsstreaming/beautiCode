import fs from "node:fs";
import path from "node:path";

export const WALLPAPER_APP_ID = "431960";
export const WALLPAPER_LIBRARY_SCHEMA = 1;

export interface WorkshopItem {
  title: string;
  /** scene projects use their preview image. video projects use the mp4. */
  themeType: "scene" | "video";
  projectPath: string;
  mediaPath: string;
}

export interface WallpaperLibraryRecord {
  version: 1;
  roots: string[];
  bindings: Record<string, { themeId?: string; source?: string }>;
}

export function pathsFromLibraryFolders(text: string): string[] {
  const paths: string[] = [];
  const pattern = /"path"\s+"((?:\\.|[^"\\])*)"/g;
  for (const match of String(text).matchAll(pattern)) {
    const raw = match[1];
    if (!raw) continue;
    const value = raw.replace(/\\"/g, '"').replace(/\\\\/g, "\\").trim();
    if (value) paths.push(value);
  }
  return paths;
}

export function workshopRoot(libraryPath: string): string {
  return path.win32.join(libraryPath, "steamapps", "workshop", "content", WALLPAPER_APP_ID);
}

/** Steam library folders plus any workshop root that already exists. */
export function discoverWorkshopRoots(
  libraryFolderTexts: readonly string[],
  exists: (dir: string) => boolean,
): string[] {
  const roots = new Map<string, string>();
  for (const text of libraryFolderTexts) {
    for (const libraryPath of pathsFromLibraryFolders(text)) {
      const root = workshopRoot(libraryPath);
      if (!exists(root)) continue;
      const key = root.toLowerCase();
      if (!roots.has(key)) roots.set(key, root);
    }
  }
  return [...roots.values()];
}

export function mergeWallpaperLibrary(previous: unknown, roots: readonly string[]): WallpaperLibraryRecord {
  const bindings = previous && typeof previous === "object" &&
    (previous as { bindings?: unknown }).bindings &&
    typeof (previous as { bindings?: unknown }).bindings === "object"
    ? { ...(previous as { bindings: Record<string, { themeId?: string; source?: string }> }).bindings }
    : {};
  return { version: 1, roots: [...roots], bindings };
}

function previewFile(dir: string, exists: (file: string) => boolean): string {
  for (const name of ["preview.gif", "preview.jpg", "preview.jpeg", "preview.png", "preview.webp"]) {
    const candidate = path.win32.join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return "";
}

export function mediaForProject(
  projectPath: string,
  project: { title?: unknown; type?: unknown; file?: unknown },
  exists: (file: string) => boolean,
): WorkshopItem | null {
  const dir = path.win32.dirname(projectPath);
  const title = String(project.title || path.win32.basename(dir)).trim().slice(0, 80);
  if (project.type === "video" && typeof project.file === "string" && project.file) {
    // Workshop metadata is external input: it must not select a file outside
    // this project, even if that file would pass the normal media validator.
    if (path.win32.isAbsolute(project.file)) return null;
    const mediaPath = path.win32.resolve(dir, project.file);
    const relative = path.win32.relative(dir, mediaPath);
    if (!relative || relative === ".." || relative.startsWith("..\\") || path.win32.isAbsolute(relative)) return null;
    if (!exists(mediaPath)) return null;
    return { title, themeType: "video", projectPath, mediaPath };
  }
  if (project.type === "scene") {
    const mediaPath = previewFile(dir, exists);
    if (!mediaPath) return null;
    return { title, themeType: "scene", projectPath, mediaPath };
  }
  return null;
}

export function readWorkshopItem(
  projectPath: string,
  readText: (file: string) => string,
  exists: (file: string) => boolean,
): WorkshopItem | null {
  let project: unknown;
  try {
    project = JSON.parse(readText(projectPath)) as unknown;
  } catch {
    return null;
  }
  if (!project || typeof project !== "object" || Array.isArray(project)) return null;
  return mediaForProject(projectPath, project as { title?: unknown; type?: unknown; file?: unknown }, exists);
}

export function listWorkshopItems(
  roots: readonly string[],
  listDirs: (root: string) => string[],
  readText: (file: string) => string,
  exists: (file: string) => boolean,
  limit = 80,
): WorkshopItem[] {
  const items: WorkshopItem[] = [];
  for (const root of roots) {
    for (const dir of listDirs(root)) {
      if (items.length >= limit) return items;
      const item = readWorkshopItem(path.win32.join(dir, "project.json"), readText, exists);
      if (item) items.push(item);
    }
  }
  items.sort((a, b) => a.title.localeCompare(b.title, "zh"));
  return items.slice(0, limit);
}

export function loadWallpaperLibrary(file: string, extraSteamPaths: readonly string[] = []): WallpaperLibraryRecord {
  const texts: string[] = [];
  const steamPaths = [
    ...extraSteamPaths,
    process.env["ProgramFiles(x86)"] ? path.win32.join(process.env["ProgramFiles(x86)"], "Steam") : "",
    process.env.ProgramFiles ? path.win32.join(process.env.ProgramFiles, "Steam") : "",
  ].filter(Boolean);
  for (const steam of steamPaths) {
    try {
      texts.push(fs.readFileSync(path.win32.join(steam, "steamapps", "libraryfolders.vdf"), "utf8"));
    } catch { /* This Steam install is absent. */ }
  }
  const exists = (dir: string) => {
    try { return fs.statSync(dir).isDirectory(); } catch { return false; }
  };
  let previous: unknown = null;
  try { previous = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* First scan. */ }
  const remembered = previous && typeof previous === "object" && Array.isArray((previous as { roots?: unknown }).roots)
    ? (previous as { roots: unknown[] }).roots.filter((root): root is string => typeof root === "string" && exists(root))
    : [];
  const roots = [...new Set([...discoverWorkshopRoots(texts, exists), ...remembered])];
  const record = mergeWallpaperLibrary(previous, roots);
  fs.mkdirSync(path.win32.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(record));
  return record;
}

export function catalogWorkshop(record: WallpaperLibraryRecord): WorkshopItem[] {
  return listWorkshopItems(
    record.roots,
    (root) => {
      try {
        return fs.readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => path.win32.join(root, entry.name));
      } catch { return []; }
    },
    (file) => fs.readFileSync(file, "utf8"),
    (file) => {
      try { return fs.statSync(file).isFile(); } catch { return false; }
    },
  );
}
