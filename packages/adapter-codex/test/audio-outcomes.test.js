import test from 'node:test';
import assert from 'node:assert/strict';
import {CodexHostApplier,aggregateAudioState} from '../dist/host-applier.js';

test('mute preference is distinct from actual per-window state and partial failures',async()=>{
 const host=Object.create(CodexHostApplier.prototype);host.closed=false;host.videoMuted=true;host.reconcileSessions=async()=>{};
 host.sessions=new Map([
  ['allowed',{closed:false,evaluate:async()=>({ok:true,muted:false,actualMuted:false,hasVideo:true,blocked:false})}],
  ['blocked',{closed:false,evaluate:async()=>({ok:true,muted:false,actualMuted:true,hasVideo:true,blocked:true})}],
  ['failed',{closed:false,evaluate:async()=>{throw new Error('fixture')}}],
 ]);
 const result=await host.setMuted(false);assert.equal(result.muted,false);assert.equal(result.actualMuted,null);assert.equal(result.partial,true);assert.equal(result.blocked,true);
 assert.deepEqual(result.outcomes.map(o=>o.muted),[false,true,null]);assert.equal(result.sessions,2);
 host.sessions=new Map([['rejected',{closed:false,evaluate:async()=>({ok:false,hasVideo:false})}]]);
 const rejected=await host.setMuted(true);
 assert.equal(rejected.ok,false);assert.equal(rejected.sessions,0);assert.equal(rejected.actualMuted,null);
 assert.equal(aggregateAudioState([{id:'a',ok:true,hasVideo:true,muted:true,blocked:true}]),true);
 assert.equal(aggregateAudioState([{id:'a',ok:true,hasVideo:false,muted:null,blocked:false}]),null);
});
