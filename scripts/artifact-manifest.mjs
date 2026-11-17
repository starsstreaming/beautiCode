import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export async function writeArtifactManifest(dest, sourceRoot) {
  const pkgPath = path.join(dest, 'package.json');
  const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
  pkg.files = [...new Set([...(pkg.files || []), 'build-manifest.json'])];
  await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  const files = {};
  async function visit(dir) {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && entry.name !== 'build-manifest.json') {
        files[path.relative(dest, file).replaceAll('\\', '/')] = crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
      }
    }
  }
  await visit(dest);
  const rev = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8', windowsHide: true });
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: sourceRoot, encoding: 'utf8', windowsHide: true });
  const receipt = { schema: 'beauticode.build/v1', packageName: pkg.name, packageVersion: pkg.version, sourceCommit: rev.status === 0 ? rev.stdout.trim() : null, sourceDirty: status.status === 0 ? !!status.stdout.trim() : null, nodeVersion: process.version, files };
  await fs.writeFile(path.join(dest, 'build-manifest.json'), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}

export async function verifyArtifactManifest(dest) {
  const receipt = JSON.parse(await fs.readFile(path.join(dest, 'build-manifest.json'), 'utf8'));
  for (const [name, expected] of Object.entries(receipt.files)) {
    if (name.split('/').includes('..') || path.isAbsolute(name)) throw new Error('Invalid artifact path');
    const actual = crypto.createHash('sha256').update(await fs.readFile(path.join(dest, name))).digest('hex');
    if (actual !== expected) throw new Error(`Artifact mismatch: ${name}`);
  }
  return receipt;
}
