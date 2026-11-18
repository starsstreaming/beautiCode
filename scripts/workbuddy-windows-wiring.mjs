import path from 'node:path';
import { renderWindowsStartupVbs, startupDirectory } from './portable-runtime.mjs';
import { updateOwnedPort, windowsPortRegistry } from './windows-owned-env.mjs';
import { readOwnedFile, replaceOwnedFile, undoFileChange, rollbackSteps } from './owned-file.mjs';

export function workbuddyWindowsPaths(env, home) {
  const appData=env.APPDATA || path.join(home,'AppData','Roaming');
  return {startup:path.join(startupDirectory(env,home),'beauticode-wb-runner.vbs'),legacy:path.join(appData,'beauticode-wb-runner.vbs')};
}
export function workbuddyWindowsWiring({env,home,launcher,journal,registry=windowsPortRegistry,replace=replaceOwnedFile}) {
  const paths=workbuddyWindowsPaths(env,home),content=renderWindowsStartupVbs({launcher,args:['--watchdog']});
  function inspect() {
    const startup=readOwnedFile(paths.startup),legacy=readOwnedFile(paths.legacy);
    if(startup!==null&&startup!==content)throw new Error('Startup file is not owned by this launcher; preserved.');
    return {startup,legacy};
  }
  return {
    install(port) {
      const before=inspect(),oldValue=registry.read(),oldJournal=readOwnedFile(journal),undos=[];
      const target={value:String(port),kind:'String'};
      try {
        // Register undo before the registry call: write verification can fail after a write.
        undos.push(()=>{
          const current=registry.read();
          if(JSON.stringify(current)!==JSON.stringify(target)&&JSON.stringify(current)!==JSON.stringify(oldValue))throw new Error('Environment changed during install; preserved.');
          registry.write(oldValue);
          if(JSON.stringify(registry.read())!==JSON.stringify(oldValue))throw new Error('Environment recovery verification failed.');
          const currentJournal=readOwnedFile(journal);
          if(currentJournal!==oldJournal){const saved=JSON.parse(currentJournal);if(JSON.stringify(saved.written)!==JSON.stringify(target))throw new Error('Ownership journal changed; preserved.');replaceOwnedFile(journal,currentJournal,oldJournal);}
        });
        updateOwnedPort({journal,port,registry});
        if(before.startup!==content){undos.push(()=>undoFileChange(paths.startup,before.startup,content));replace(paths.startup,before.startup,content);}
        if(paths.legacy!==paths.startup&&before.legacy===content){undos.push(()=>undoFileChange(paths.legacy,content,null));replace(paths.legacy,content,null);}
        return {rollback(){rollbackSteps(undos);}};
      } catch(error){rollbackSteps(undos,error);}
    },
    remove() {
      const before=inspect();
      // Restore configuration first. A registry error must not already have removed startup.
      const result=updateOwnedPort({journal,remove:true,registry});
      if(before.startup===content)replace(paths.startup,content,null);
      if(paths.legacy!==paths.startup&&before.legacy===content)replace(paths.legacy,content,null);
      return result;
    },
  };
}
