import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Files + installer wiring are installation evidence, never a live UI handshake. */
export function inspectDshInstallation({ home, env, exists = fs.existsSync, readFile = fs.readFileSync }) {
  const root = env.DSH_HOME || path.join(home, '.dsh');
  const profiles = [root, path.join(root, 'profiles', 'web')];
  for (const profile of profiles) {
    let profilePatch = '';
    try { profilePatch = readFile(path.join(profile, 'cordis.patch.yml'), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') continue; }
    const patches = [profilePatch];
    // A dependency exposes its files to the loader. The profile's bundle list
    // determines whether the dependency's patch is part of the composition.
    if (!/\bbeauticode-bridge\b/.test(profilePatch.replace(/^[ \t]*#.*$/gm, ''))) {
      try {
        const manifest = JSON.parse(readFile(path.join(profile, 'package.json'), 'utf8'));
        const dependency = manifest.dependencies?.['beauticode-dsh'];
        const bundles = manifest.dsh?.profile?.bundles;
        const plugin = path.join(profile, 'node_modules', 'beauticode-dsh');
        if (Array.isArray(bundles) && bundles.includes('beauticode-dsh') &&
            typeof dependency === 'string' && dependency.startsWith('link:') && dependency.length > 5) {
          const target = path.resolve(profile, dependency.slice(5));
          if (fs.realpathSync.native(plugin) === fs.realpathSync.native(target)) {
            patches.push(readFile(path.join(plugin, 'cordis.patch.yml'), 'utf8'));
          }
        }
      } catch { /* Unknown dependency layouts are not proof of active wiring. */ }
    }
    for (const patch of patches) try {
      // Only recognize the installer's active insert record. Unknown wiring is not proof.
      const inserts = [...patch.matchAll(/^- insert:\s*\r?\n((?:[ \t]+[^\r\n]*(?:\r?\n|$)|\r?\n)*)/gm)];
      const records = inserts.flatMap(match => match[1].split(/(?=^[ \t]*-[ \t]*id:)/m));
      for (const record of records) {
        if (!/^[ \t]*-[ \t]*id:\s*beauticode-bridge\s*(?:#.*)?$/m.test(record)) continue;
        const block = record.split(/^\S/m)[0];
        if (/^\s*(?:disabled:\s*true|enabled:\s*false)/m.test(block)) continue;
        if (!/^\s*inject:\s*\[webServer\]\s*$/m.test(block)) continue;
        const name = /^\s*name:\s*['"]?([^'"\r\n]+?)['"]?\s*$/m.exec(block)?.[1];
        let entry;
        if (name === 'beauticode-dsh') entry = path.join(profile, 'node_modules', name, 'index.mjs');
        else if (name?.startsWith('file:')) entry = fileURLToPath(name);
        else continue;
        const pkg = JSON.parse(readFile(path.join(path.dirname(entry), 'package.json'), 'utf8'));
        if (pkg.name !== 'beauticode-dsh' || !pkg.version || !exists(entry)) continue;
        return { installed: true, state: 'plugin-wired', profile, version: pkg.version, liveVerified: false };
      }
    } catch { /* missing or unreadable files do not prove installation */ }
  }
  return { installed: false, state: 'not-installed', liveVerified: false };
}
