import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {stageDesktopAggregate} from '../../../scripts/pack-desktop-aggregate.mjs';

test('packaged WorkBuddy wiring imports every transaction dependency without the workspace',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'bc-followup-pack-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 await stageDesktopAggregate(root,{build:false});
 for(const name of ['workbuddy-windows-wiring.mjs','workbuddy-linux-wiring.mjs','workbuddy-install-transaction.mjs'])await import(pathToFileURL(path.join(root,'runtime/workbuddy/scripts',name)).href);
});
