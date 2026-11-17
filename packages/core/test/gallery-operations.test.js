import test from 'node:test';
import assert from 'node:assert/strict';
import {createGalleryOperations} from '../dist/index.js';
const wait=()=>new Promise(r=>setTimeout(r,5));

test('operation receipt survives disconnect, cancel stops downloads, atomic apply is queryable',async()=>{
 const ops=createGalleryOperations();let applied=false;
 const first=ops.start('a',async({signal,beginApply})=>{await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));beginApply();applied=true;return{ok:true}});
 await wait();assert.equal(ops.cancel(first.id).cancellable,true);await wait();assert.equal(ops.status(first.id).phase,'cancelled');assert.equal(applied,false);
 let finish;const gate=new Promise(r=>{finish=r});
 const second=ops.start('b',async({beginApply})=>{beginApply();await gate;return{ok:true,message:'done'}});
 await wait();assert.equal(ops.cancel(second.id).cancellable,false);assert.equal(ops.status(second.id).phase,'apply');
 assert.equal(ops.start('other',async()=>({ok:true})).ok,false);
 finish();await wait();assert.equal(ops.status(second.id).result.ok,true);assert.equal(ops.status('not-there').code,'operation_unknown');
});
test('download deadline and receipt capacity are bounded',async()=>{
 const ops=createGalleryOperations({timeoutMs:10,maxEntries:2});
 const first=ops.start('a',async({signal})=>{await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));return{ok:true}});
 await new Promise(r=>setTimeout(r,25));assert.equal(ops.status(first.id).phase,'cancelled');
 const second=ops.start('b',async()=>({ok:true}));await wait();ops.start('c',async()=>({ok:true}));await wait();
 assert.equal(ops.status(first.id).ok,false);assert.equal(ops.status(second.id).result.ok,true);
});

test('client operation ID recovers a lost start response and prevents duplicate apply',async()=>{
 const ops=createGalleryOperations();let calls=0;const id='client-operation-12345';
 ops.start('a',async()=>{calls++;return{ok:true}},id);await wait();
 assert.equal(ops.status(id).result.ok,true);
 assert.equal(ops.start('a',async()=>{calls++;return{ok:true}},id).result.ok,true);
 assert.equal(calls,1);assert.equal(ops.start('other',async()=>({ok:true}),id).ok,false);
});
test('cancel before task dispatch cannot start a download',async()=>{
 const ops=createGalleryOperations();let calls=0;
 const entry=ops.start('a',async()=>{calls++;return{ok:true}});ops.cancel(entry.id);await wait();
 assert.equal(calls,0);assert.equal(ops.status(entry.id).phase,'cancelled');
});
