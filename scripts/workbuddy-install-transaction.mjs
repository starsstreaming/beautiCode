import fs from 'node:fs';
import { readOwnedFile, replaceOwnedFile, undoFileChange } from './owned-file.mjs';

/** Keep the previous runtime active until wiring succeeds; restore only this operation's values. */
export async function commitWorkbuddyInstall({runtime,expectedLauncher,portFile,portText,install,activate,discard}) {
  let before;
  try {
    if (typeof expectedLauncher === 'function') expectedLauncher = expectedLauncher();
    const launcher = readOwnedFile(runtime.launcher);
    before = {
      launcher,
      launcherMode: launcher === null ? undefined : fs.statSync(runtime.launcher).mode & 0o777,
      pointer: readOwnedFile(runtime.pointerPath),
      port: readOwnedFile(portFile),
    };
  } catch (error) {
    await discard();
    throw error;
  }
  let wiring, portAttempted=false, activationAttempted=false;
  try {
    wiring=await install();
    portAttempted = true;
    replaceOwnedFile(portFile,before.port,portText);
    activationAttempted = true;
    await activate();
  } catch(error) {
    const errors=[];
    for(const undo of [
      ()=>{const current=readOwnedFile(runtime.pointerPath);if(current!==before.pointer){if(JSON.parse(current)?.version!==runtime.version)throw new Error('Runtime changed externally.');replaceOwnedFile(runtime.pointerPath,current,before.pointer);}},
      ()=>{
        if (!activationAttempted) return;
        const current = readOwnedFile(runtime.launcher);
        if (current !== before.launcher) {
          undoFileChange(runtime.launcher, before.launcher, expectedLauncher, before.launcherMode);
        } else if (current !== null && current === expectedLauncher && process.platform !== 'win32') {
          const mode = fs.statSync(runtime.launcher).mode & 0o777;
          if (mode !== before.launcherMode) {
            if (mode !== 0o755 && mode !== (0o666 & ~process.umask())) throw new Error('Launcher mode changed externally; preserved.');
            fs.chmodSync(runtime.launcher, before.launcherMode);
          }
        }
      },
      ()=>{if(portAttempted)undoFileChange(portFile,before.port,portText);},
      ()=>wiring?.rollback(),
    ])try{undo();}catch(restoreError){errors.push(restoreError);}
    if(!errors.length)await discard();
    if(errors.length)throw new AggregateError([error,...errors],'Installation failed; recovery incomplete. Retain runtime and ownership records.');
    throw error;
  }
}
