import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "packages", "adapter-codex", "src", "renderer");
const dest = path.join(root, "packages", "adapter-codex", "dist", "renderer");

await fs.mkdir(dest, { recursive: true });
for (const name of await fs.readdir(src)) {
  await fs.copyFile(path.join(src, name), path.join(dest, name));
}
console.log("copied renderer assets → dist/renderer");
