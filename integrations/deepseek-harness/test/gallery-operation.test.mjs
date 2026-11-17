import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createGalleryHandlers} from '../gallery-host.mjs';

test('DSH operation metadata download is cancellable before any atomic import',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'bc-gallery-op-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original});let aborted=false,imports=0;
 globalThis.fetch=(_url,{signal})=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason)},{once:true})});
 const handlers=createGalleryHandlers({dataRoot:root,actions:{importTheme(){imports++;return{ok:true}}}});
 async function call(body){let payload;await handlers.operation({method:'POST'},{writeHead(){return this},end(){}},(_res,_status,value)=>{payload=value},()=>true,async()=>body);return payload;}
 const started=await call({action:'start',id:'skin-abcdefgh'});assert.equal(started.ok,true);
 await new Promise(r=>setTimeout(r,5));await call({action:'cancel',operationId:started.id});await new Promise(r=>setTimeout(r,5));
 assert.equal(aborted,true);assert.equal(imports,0);assert.equal((await call({action:'status',operationId:started.id})).phase,'cancelled');
});
