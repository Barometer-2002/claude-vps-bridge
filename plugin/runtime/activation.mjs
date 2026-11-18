// Whether the running Host executes the installed plugin code.
//
// CodexHost loads plugins in a shared background Host. Closing and reopening the
// desktop window leaves that process running with the previously loaded code, so
// "installed" and "active" must be observed separately. The stamp is read once,
// when the Host imports this module; a later reinstall cannot change it here.
import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {replaceFile} from './atomic-file.mjs';

const pluginRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const STAMP_FILE='install-stamp.json';
const validStamp=value=>typeof value?.transaction==='string'&&/^[0-9A-Za-z._-]{1,80}$/.test(value.transaction)?value.transaction:null;

export function readStampSync(root=pluginRoot){
  try{return validStamp(JSON.parse(readFileSync(path.join(root,STAMP_FILE),'utf8')));}catch{return null;}
}
export async function readStamp(root=pluginRoot){
  try{return validStamp(JSON.parse(await fs.readFile(path.join(root,STAMP_FILE),'utf8')));}catch{return null;}
}

const LOADED=readStampSync();

export async function recordLoadedInstall(stateDirectory,{stamp=LOADED,pid=process.pid,now=()=>new Date()}={}){
  const file=path.join(stateDirectory,'loaded-install.json');
  await fs.mkdir(stateDirectory,{recursive:true});
  const temp=file+'.'+randomUUID()+'.tmp';
  await fs.writeFile(temp,JSON.stringify({transaction:stamp,pid,loadedAt:now().toISOString()}),{mode:0o600});
  await replaceFile(temp,file);
}

export function processAlive(pid){
  if(!Number.isSafeInteger(pid)||pid<1)return false;
  try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}
}

// installed: stamp currently on disk; loaded: record written by the running Host.
export function activationStatus(installed,loaded,isAlive=processAlive){
  if(!installed)return {status:'unknown',reason:'install-stamp-missing'};
  if(!loaded||!Number.isSafeInteger(loaded.pid)||!isAlive(loaded.pid))return {status:'not-loaded',installed};
  const active=validStamp(loaded);
  if(active===installed)return {status:'current',installed,loadedAt:loaded.loadedAt};
  return {status:'stale',installed,active,loadedAt:loaded.loadedAt};
}
