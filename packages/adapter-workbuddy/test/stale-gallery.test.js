import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('new selection, clear and disposal invalidate all old WorkBuddy gallery callbacks', async () => {
  const source=fs.readFileSync(new URL('../src/background-bar.ts',import.meta.url),'utf8');
  const nodes=[],elements=[],pending=new Set();let wallpaper=null;
  const ctx=vm.createContext({ Set,window:{},mediaGeneration:0,pendingMedia:pending,BC:'fixture',PERSIST:{},currentUrl:null,
    isVideo:()=>false,isImage:()=>true,stageEl:()=>({querySelectorAll:()=>nodes.slice(),appendChild(n){nodes.push(n)}}),
    document:{createElement(){const events={};const n={events,dataset:{},setAttribute(){},addEventListener(k,fn){events[k]=fn},removeEventListener(){},remove(){const i=nodes.indexOf(n);if(i>=0)nodes.splice(i,1)}};elements.push(n);return n}},
    filePathToUrl:p=>p,markMedia(){},markVideoReady(){},rememberImportedTheme(){},persistMark(p){wallpaper=p},setTimeout:()=>1,clearTimeout(){},URL:{revokeObjectURL(){}},
  });
  vm.runInContext(source.slice(source.indexOf('function cancelPendingMedia()'),source.indexOf('function clearMedia()')),ctx);
  vm.runInContext(source.slice(source.indexOf('function applyGalleryPath(p, meta)'),source.indexOf('window.__bcApplyBackgroundPath')),ctx);
  const a=vm.runInContext("applyGalleryPath('a.png',{})",ctx);const failed=assert.rejects(a,/取消|过期/);
  const b=vm.runInContext("applyGalleryPath('b.png',{})",ctx);const late=elements[0].events.load;
  elements[1].events.load();await b;late();await failed;
  assert.equal(wallpaper,'b.png');assert.equal(nodes.length,1);
  const c=vm.runInContext("applyGalleryPath('c.png',{})",ctx);const cancelled=assert.rejects(c,/取消|过期/);
  vm.runInContext('cancelPendingMedia()',ctx);nodes.splice(0);wallpaper=null;elements[2].events.load();await cancelled;
  assert.equal(wallpaper,null);assert.equal(nodes.length,0);assert.equal(pending.size,0);
});
