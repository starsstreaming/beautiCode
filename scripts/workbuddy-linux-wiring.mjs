import fs from 'node:fs';
import path from 'node:path';
import { xdgConfigHome, xdgAutostartPath, renderXdgDesktopEntry } from './portable-runtime.mjs';
import { createXdgAutostartAdapter } from './xdg-autostart.mjs';

export function workbuddyLinuxPaths(env, home) {
  return {
    environment: path.join(xdgConfigHome(env, home), 'environment.d', 'beauticode-wb.conf'),
    desktop: xdgAutostartPath('beauticode-beauticode-wb-runner', env, home),
  };
}

export function workbuddyLinuxWiring({ env, home, launcher }) {
  const paths = workbuddyLinuxPaths(env, home);
  const desktop = createXdgAutostartAdapter(launcher, { file: paths.desktop, args: ['--watchdog'] });
  const marker = '# beautiCode WorkBuddy environment';
  const readEnv = () => { try { return fs.readFileSync(paths.environment, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
  const checkEnv = () => { const text = readEnv(); if (text !== null && !text.startsWith(marker + '\n')) throw new Error('WorkBuddy environment file is not owned; preserved.'); return text; };
  return {
    install(port) {
      desktop.assertAbsentOrOwned(); checkEnv();
      const value = Number(port);
      if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('Invalid WorkBuddy port');
      desktop.write(renderXdgDesktopEntry({ name: 'beautiCode WorkBuddy runner', launcher, args: ['--watchdog'] }));
      fs.mkdirSync(path.dirname(paths.environment), { recursive: true });
      fs.writeFileSync(paths.environment, `${marker}\nWORKBUDDY_REMOTE_DEBUGGING_PORT=${value}\n`);
    },
    remove() {
      desktop.assertAbsentOrOwned(); const previous = checkEnv();
      desktop.removeOwned();
      if (previous !== null) fs.unlinkSync(paths.environment);
    },
  };
}
