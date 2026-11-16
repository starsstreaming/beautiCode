import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileFingerprint, openVerifiedLocalFile, type ValidatedSceneProject } from './scene-project.js';

export interface SceneSnapshot {
  file: string;
  fingerprint: string;
  dispose(): Promise<void>;
}

/** Make a private, bounded copy whose bytes match the previously verified PKG. */
export async function createSceneSnapshot(project: ValidatedSceneProject, signal: AbortSignal): Promise<SceneSnapshot> {
  signal.throwIfAborted();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'beauticode-scene-'));
  const file = path.join(directory, 'scene.pkg');
  let removed = false;
  const dispose = async () => {
    if (removed) return;
    try { await fs.unlink(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    try { await fs.rmdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    removed = true;
  };
  try {
    await fs.chmod(directory, 0o700);
    const source = await openVerifiedLocalFile(project.pkgPath);
    try {
      if (fileFingerprint(source.stat) !== project.packageFingerprint) throw new Error('Scene source changed before staging.');
      const target = await fs.open(file, 'wx', 0o600);
      try {
        const hash = createHash('sha256');
        const chunk = Buffer.alloc(Math.min(1024 * 1024, source.stat.size));
        let position = 0;
        while (position < source.stat.size) {
          signal.throwIfAborted();
          const { bytesRead } = await source.handle.read(chunk, 0, Math.min(chunk.length, source.stat.size - position), position);
          if (!bytesRead) throw new Error('Scene source changed while staging.');
          hash.update(chunk.subarray(0, bytesRead));
          let written = 0;
          while (written < bytesRead) {
            signal.throwIfAborted();
            const result = await target.write(chunk, written, bytesRead - written, position + written);
            if (!result.bytesWritten) throw new Error('Scene snapshot could not be written.');
            written += result.bytesWritten;
          }
          position += bytesRead;
        }
        signal.throwIfAborted();
        if (hash.digest('hex') !== project.packageDigest || fileFingerprint(await source.handle.stat()) !== project.packageFingerprint) {
          throw new Error('Scene source changed while staging.');
        }
      } finally { await target.close(); }
    } finally { await source.handle.close(); }
    signal.throwIfAborted();
    const fingerprint = fileFingerprint(await fs.stat(file));
    return { file, fingerprint, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
