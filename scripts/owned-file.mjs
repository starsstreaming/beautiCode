import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function readOwnedFile(file) {
  try {
    const stat=fs.lstatSync(file);
    if(!stat.isFile() || stat.isSymbolicLink()) throw new Error('Managed target is not a regular file.');
    return fs.readFileSync(file,'utf8');
  } catch(error) { if(error.code==='ENOENT')return null;throw error; }
}
export function replaceOwnedFile(file, before, after) {
  if(readOwnedFile(file)!==before)throw new Error('Managed file changed externally; preserved.');
  if(after===null){if(before!==null)fs.unlinkSync(file);return;}
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temporary=file+'.tmp-'+randomUUID();
  fs.writeFileSync(temporary,after,{flag:'wx',mode:0o600});
  try {
    if(before===null)fs.linkSync(temporary,file);
    else {if(readOwnedFile(file)!==before)throw new Error('Managed file changed externally; preserved.');fs.renameSync(temporary,file);}
  } finally {fs.rmSync(temporary,{force:true});}
}
export function rollbackSteps(undos, original) {
  const errors=[];
  for(const undo of undos.reverse())try{undo();}catch(error){errors.push(error);}
  if(errors.length)throw new AggregateError([...(original?[original]:[]),...errors],'Installation failed; recovery incomplete. Saved ownership records must be retained.');
  if(original)throw original;
}
