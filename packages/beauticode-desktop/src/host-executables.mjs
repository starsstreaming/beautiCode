import path from "node:path";

function xdgDir(env, key, home, fallback) {
  const value = env[key];
  return value && path.isAbsolute(value) ? value : path.join(home, ...fallback);
}

function windowsExecutableCandidates(host, env, home) {
  const local = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const programFiles = env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  if (host === "codex") return [
    path.join(local, "Programs", "ChatGPT", "ChatGPT.exe"),
    path.join(local, "Programs", "chatgpt", "ChatGPT.exe"),
    path.join(local, "Programs", "Codex", "Codex.exe"),
    path.join(local, "Programs", "codex", "Codex.exe"),
    path.join(local, "OpenAI", "Codex", "Codex.exe"),
    path.join(local, "OpenAI", "ChatGPT", "ChatGPT.exe"),
    path.join(local, "Codex", "app", "Codex.exe"),
    path.join(programFiles, "Codex", "Codex.exe"),
    path.join(programFiles, "ChatGPT", "ChatGPT.exe"),
    path.join(programFilesX86, "ChatGPT", "ChatGPT.exe"),
  ];
  if (host === "workbuddy") return [
    path.join(local, "Programs", "WorkBuddy", "WorkBuddy.exe"),
    path.join(local, "WorkBuddy", "WorkBuddy.exe"),
    path.join(programFiles, "WorkBuddy", "WorkBuddy.exe"),
    path.join(programFilesX86, "WorkBuddy", "WorkBuddy.exe"),
  ];
  if (host === "cursor") return [
    path.join(local, "Programs", "cursor", "Cursor.exe"),
    path.join(programFiles, "Cursor", "Cursor.exe"),
    path.join(programFilesX86, "Cursor", "Cursor.exe"),
  ];
  if (host === "doubao") return [
    // Pre-install detection runs before the desktop adapter is loaded.
    path.join(local, "Doubao", "Application", "Doubao.exe"),
    path.join(local, "Doubao", "Doubao.exe"),
    path.join(local, "Programs", "Doubao", "Doubao.exe"),
    path.join(programFiles, "Doubao", "Doubao.exe"),
    "D:\\Doubao\\app\\Doubao.exe",
  ];
  return [];
}

/** Mirrors the adapters' Linux executable candidates (deb/rpm/opt and per-user installs). */
function linuxExecutableCandidates(host, env, home) {
  const data = xdgDir(env, "XDG_DATA_HOME", home, [".local", "share"]);
  if (host === "codex") return [
    "/usr/lib/chatgpt/ChatGPT", "/opt/ChatGPT/ChatGPT", "/opt/chatgpt/ChatGPT",
    "/usr/lib/codex/Codex", "/opt/Codex/Codex",
    path.join(data, "chatgpt", "ChatGPT"), path.join(home, ".local", "opt", "ChatGPT", "ChatGPT"),
  ];
  if (host === "workbuddy") return [
    "/opt/WorkBuddy/workbuddy", "/opt/workbuddy/workbuddy", "/usr/lib/workbuddy/workbuddy",
    path.join(data, "WorkBuddy", "workbuddy"),
  ];
  if (host === "cursor") return [
    ...(env.BEAUTICODE_CURSOR_EXECUTABLE ? [env.BEAUTICODE_CURSOR_EXECUTABLE] : []),
    "/usr/share/cursor/cursor", "/opt/Cursor/cursor", "/opt/cursor/cursor",
    path.join(data, "cursor", "cursor"), path.join(home, "Applications", "cursor", "cursor"),
  ];
  return [];
}

export { linuxExecutableCandidates, windowsExecutableCandidates, xdgDir };
