import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {workbuddyWindowsPaths,workbuddyWindowsWiring} from '../../../scripts/workbuddy-windows-wiring.mjs';
import {workbuddyLinuxPaths,workbuddyLinuxWiring} from '../../../scripts/workbuddy-linux-wiring.mjs';
import {commitWorkbuddyInstall} from '../../../scripts/workbuddy-install-transaction.mjs';
import {renderWindowsStartupVbs} from '../../../scripts/portable-runtime.mjs';

function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'bc-install-tx-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test('preflight failures discard the candidate before any wiring', async t => {
  const root = fixture(t);
  let discarded = 0;
  const options = {
    runtime: { pointerPath: root, launcher: path.join(root, 'launcher') },
    install: () => assert.fail('unexpected install'),
    discard: () => { discarded++; },
  };
  await assert.rejects(commitWorkbuddyInstall(options), /regular file/);
  await assert.rejects(commitWorkbuddyInstall({ ...options, expectedLauncher() { throw Error('render failed'); } }), /render failed/);
  assert.equal(discarded, 2);
});
test('foreign startup and redirected APPDATA are checked before registry writes; later edits preserved',t=>{
 const root=fixture(t),env={APPDATA:path.join(root,'redirected')},paths=workbuddyWindowsPaths(env,root);let value={value:'9000',kind:'String'};
 assert.ok(paths.startup.startsWith(env.APPDATA));fs.mkdirSync(path.dirname(paths.startup),{recursive:true});fs.writeFileSync(paths.startup,'foreign');
 const registry={read:()=>value,write:v=>{value=v}},journal=path.join(root,'journal');
 const options={env,home:root,launcher:path.join(root,'launcher.ps1'),journal,registry};
 assert.throws(()=>workbuddyWindowsWiring(options).install('9335'),/not owned/);assert.equal(value.value,'9000');
 fs.unlinkSync(paths.startup);fs.writeFileSync(paths.legacy,'foreign legacy');
 workbuddyWindowsWiring(options).install('9335');assert.equal(value.value,'9335');
 assert.equal(fs.readFileSync(paths.legacy,'utf8'),'foreign legacy');
 fs.writeFileSync(paths.startup,'user edited');assert.throws(()=>workbuddyWindowsWiring(options).remove(),/not owned/);assert.equal(value.value,'9335');
});
test('Windows startup write failure restores previous registry/journal state; successful wiring can undo',t=>{
 const root=fixture(t),env={APPDATA:root};let value=null;
 const registry={read:()=>value,write:v=>{value=v}},journal=path.join(root,'journal'),opts={env,home:root,launcher:path.join(root,'launcher.ps1'),journal,registry};
 assert.throws(()=>workbuddyWindowsWiring({...opts,replace(){throw new Error('fixture disk full')}}).install('9335'),/disk full/);
 assert.equal(value,null);assert.equal(fs.existsSync(journal),false);
 const tx=workbuddyWindowsWiring(opts).install('9335');tx.rollback();assert.equal(value,null);
 assert.equal(fs.existsSync(workbuddyWindowsPaths(env,root).startup),false);
});
test('Linux environment failure removes newly created autostart; rollback preserves externally changed target',t=>{
 const root=fixture(t),env={XDG_CONFIG_HOME:path.join(root,'config')},paths=workbuddyLinuxPaths(env,root);fs.mkdirSync(env.XDG_CONFIG_HOME,{recursive:true});fs.writeFileSync(path.dirname(paths.environment),'block');
 const opts={env,home:root,launcher:'/tmp/fixture/launcher.sh'};
 assert.throws(()=>workbuddyLinuxWiring(opts).install('9335'));assert.equal(fs.existsSync(paths.desktop),false);
 fs.unlinkSync(path.dirname(paths.environment));const tx=workbuddyLinuxWiring(opts).install('9335');
 fs.writeFileSync(paths.environment,'external edit');assert.throws(()=>tx.rollback(),/recovery incomplete/);assert.equal(fs.readFileSync(paths.environment,'utf8'),'external edit');
});
test('runtime activation failure restores wiring, port, pointer and launcher before discarding candidate',async t=>{
 const root=fixture(t),runtime={pointerPath:path.join(root,'current.json'),launcher:path.join(root,'launcher.ps1'),version:'v-new'};
 const portFile=path.join(root,'port.json');fs.writeFileSync(runtime.pointerPath,'{"version":"v-old"}');fs.writeFileSync(runtime.launcher,'old launcher');fs.writeFileSync(portFile,'old port');let wired=false,discarded=false;
 if(process.platform !== 'win32') fs.chmodSync(runtime.launcher, 0o751);
 await assert.rejects(commitWorkbuddyInstall({runtime,expectedLauncher:'new launcher',portFile,portText:'new port',install:()=>{wired=true;return{rollback(){wired=false}}},activate:()=>{fs.writeFileSync(runtime.launcher,'new launcher');fs.writeFileSync(runtime.pointerPath,'{"version":"v-new"}');throw new Error('fixture activation')},discard:()=>{discarded=true}}),/fixture activation/);
 if(process.platform !== 'win32') assert.equal(fs.statSync(runtime.launcher).mode & 0o777, 0o751);
 assert.equal(wired,false);assert.equal(discarded,true);assert.equal(fs.readFileSync(runtime.pointerPath,'utf8'),'{"version":"v-old"}');assert.equal(fs.readFileSync(runtime.launcher,'utf8'),'old launcher');assert.equal(fs.readFileSync(portFile,'utf8'),'old port');
});
