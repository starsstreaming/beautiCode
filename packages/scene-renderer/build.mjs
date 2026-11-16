import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
await build({
  entryPoints: [path.join(here, 'frame.js')],
  outfile: path.join(here, 'dist', 'scene-frame.js'),
  bundle: true, format: 'iife', platform: 'browser', target: 'chrome120', minify: true,
  legalComments: 'inline',
  plugins: [{
    name: 'native-scene-textures',
    setup(builder) {
      builder.onLoad({ filter: /[\\/]webwallgl[\\/]webwallgl\.mjs$/ }, async ({ path: source }) => {
        // WebWallGL 3.0.0 has no public texture policy suitable for an opaque
        // srcdoc. Keep authored texture resolution and fail on upstream drift;
        // remove this patch when an equivalent public option is available.
        let contents = await readFile(source, 'utf8');
        for (const anchor of ['const KEY = Symbol.for("webwallgl.runtime-link");', 'get editor() {', 'getSkippedScripts() {']) {
          if (contents.split(anchor).length !== 2) throw new Error('Script status bridge requires review after WebWallGL source changes');
        }
        for (const [from, to] of [
          ['const resOff = resourcesOff();', 'const resOff = true;'],
          ['const resScaleBase = resourceScaleFor(rt, cfg);', 'const resScaleBase = 1;'],
          ['const resScaleNormal = resourceScaleForNormal(rt, cfg);', 'const resScaleNormal = 1;'],
        ]) {
          if (contents.split(from).length !== 2) throw new Error('Native texture policy requires review after WebWallGL source changes');
          contents = contents.replace(from, to);
        }
        return { contents, loader: 'js' };
      });
    },
  }],
});

async function packageRoot(entry, name) {
  let directory = path.dirname(entry);
  for (;;) {
    try {
      const info = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
      if (info.name === name) return { directory, info };
    } catch { /* Search the parent for the owning package metadata. */ }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`Missing package metadata for ${name}`);
    directory = parent;
  }
}
const webwallgl = await packageRoot(require.resolve('webwallgl'), 'webwallgl');
const mediaRequire = createRequire(path.join(webwallgl.directory, 'package.json'));
const mediabunny = await packageRoot(mediaRequire.resolve('mediabunny'), 'mediabunny');
const notices = [];
for (const component of [webwallgl, mediabunny]) {
  const { name, version, license } = component.info;
  if (!/^[\w.-]+$/.test(name) || !/^[\w.-]+$/.test(version)) throw new Error('Invalid dependency metadata');
  const text = await readFile(path.join(component.directory, 'LICENSE'), 'utf8');
  notices.push(`${name} ${version} (${license})\nSource: https://registry.npmjs.org/${name}/-/${name}-${version}.tgz\n\n${text}`);
}
await writeFile(path.join(here, 'dist', 'THIRD_PARTY_NOTICES.txt'), notices.join('\n\n---\n\n'));
