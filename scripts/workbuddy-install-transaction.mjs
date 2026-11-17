import { readOwnedFile, replaceOwnedFile } from './owned-file.mjs';

/** Keep the previous runtime active until wiring succeeds; restore only this operation's values. */
export async function commitWorkbuddyInstall({runtime,expectedLauncher,portFile,portText,install,activate,discard}) {
  const before={pointer:readOwnedFile(runtime.pointerPath),launcher:readOwnedFile(runtime.launcher),port:readOwnedFile(portFile)};
  let wiring,portWritten=false;
  try {
    wiring=await install();
    replaceOwnedFile(portFile,before.port,portText);portWritten=true;
    await activate();
  } catch(error) {
    const errors=[];
    for(const undo of [
      ()=>{const current=readOwnedFile(runtime.pointerPath);if(current!==before.pointer){if(JSON.parse(current)?.version!==runtime.version)throw new Error('Runtime changed externally.');replaceOwnedFile(runtime.pointerPath,current,before.pointer);}},
      ()=>{const current=readOwnedFile(runtime.launcher);if(current!==before.launcher){if(current!==expectedLauncher)throw new Error('Launcher changed externally; preserved.');replaceOwnedFile(runtime.launcher,current,before.launcher);}},
      ()=>{if(portWritten)replaceOwnedFile(portFile,portText,before.port);},
      ()=>wiring?.rollback(),
    ])try{undo();}catch(restoreError){errors.push(restoreError);}
    if(!errors.length)await discard();
    if(errors.length)throw new AggregateError([error,...errors],'Installation failed; recovery incomplete. Retain runtime and ownership records.');
    throw error;
  }
}
