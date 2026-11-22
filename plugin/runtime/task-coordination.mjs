// Cooperative project writers. Unknown owners are never silently evicted.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const projectIdPattern=/^[a-f0-9]{64}$/;
const uuidPattern=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const finalJobStatuses=new Set(['succeeded','failed','cancelled']);
function directory(root,id){if(!projectIdPattern.test(id))throw new Error('Invalid project identity');return path.join(root,'writers',id);}
export async function writerStatus(root,id){
  const dir=directory(root,id);
  try{return {...JSON.parse(await fs.readFile(path.join(dir,'owner.json'),'utf8')),locked:true};}
  catch(e){if(e.code!=='ENOENT')throw e;return await fs.stat(dir).then(()=>({locked:true,status:'owner-unknown'}),e=>{if(e.code==='ENOENT')return {locked:false};throw e;});}
}
export async function releaseWriter(root,id,token){
  const dir=directory(root,id),owner=await writerStatus(root,id);
  if(!owner.locked)return;
  if(owner.token!==token)throw new Error('Writer ownership changed; lock was not released');
  await fs.unlink(path.join(dir,'owner.json'));await fs.rmdir(dir);
}
function runnerExited(pid){
  if(!Number.isSafeInteger(pid)||pid<1)return false;
  try{process.kill(pid,0);return false;}catch(error){return error.code==='ESRCH';}
}
async function reclaimStoppedJob(root,id,dir,owner){
  // Only the job runner releases a job lease. A dead PID alone cannot prove
  // that a child or descendant stopped writing to the project.
  if(owner.kind!=='job'||!uuidPattern.test(owner.token??'')||!runnerExited(owner.pid))return false;
  const projectId=owner.job?.projectId??id;
  if(!projectIdPattern.test(projectId)||!/^[a-zA-Z0-9_-]{1,100}$/.test(owner.requestId??''))return false;
  const jobDirectory=path.join(root,'jobs',projectId,owner.requestId);
  const runnerToken=owner.job?.runnerToken;
  let neverLaunched=false;
  if(uuidPattern.test(runnerToken??'')){
    const request=await fs.readFile(path.join(jobDirectory,'request.json'),'utf8').then(JSON.parse).catch(()=>null);
    neverLaunched=request?.requestId===owner.requestId&&request?.project?.projectId===projectId&&
      await fs.stat(path.join(jobDirectory,'command-launch-'+runnerToken)).then(()=>false,error=>error.code==='ENOENT');
  }
  if(!neverLaunched){
    const status=await fs.readFile(path.join(jobDirectory,'status.json'),'utf8').then(JSON.parse).catch(()=>null);
    if(status?.runnerPid!==owner.pid||status.requestId!==owner.requestId||
      (runnerToken&&status.runnerToken!==runnerToken)||!finalJobStatuses.has(status.status)||
      !status.completedAt||status.cancellationWarning)return false;
  }
  // Keep the token-specific destination containing owner.json. A competing
  // reclaimer of this same lease cannot rename a successor over it.
  const retired=path.join(path.dirname(dir),`${id}.recovered-${owner.token}`);
  try{await fs.rename(dir,retired);return true;}
  catch(error){if(['ENOENT','EEXIST','ENOTEMPTY','EACCES','EPERM','EBUSY'].includes(error.code))return false;throw error;}
}
export async function acquireWriter(root,id,{kind='operation',requestId,job,waitMs=10000,isCancelled=()=>false,onWait=()=>{}}={}){
  const dir=directory(root,id),deadline=Date.now()+waitMs;await fs.mkdir(path.dirname(dir),{recursive:true});
  for(;;){
    if(await isCancelled())throw Object.assign(new Error('Cancelled while waiting for the project writer'),{code:'CANCELLED'});
    try{await fs.mkdir(dir);break;}catch(e){if(e.code!=='EEXIST')throw e;}
    const owner=await writerStatus(root,id);
    if(await reclaimStoppedJob(root,id,dir,owner))continue;
    await onWait(owner);
    if(Date.now()>=deadline)throw Object.assign(new Error('Another managed task owns this project. Query its original task or use an isolated worktree; no write ran.'),{code:'PROJECT_WRITE_BUSY',owner});
    await sleep(Math.min(100,Math.max(1,deadline-Date.now())));
  }
  const owner={token:randomUUID(),pid:process.pid,kind,requestId,...(job?{job}:{}),createdAt:new Date().toISOString()};
  try{await fs.writeFile(path.join(dir,'owner.json'),JSON.stringify(owner),{flag:'wx'});}catch(e){await fs.rmdir(dir).catch(()=>{});throw e;}
  return {...owner,release:()=>releaseWriter(root,id,owner.token)};
}
export async function withWriter(root,id,options,fn){const lease=await acquireWriter(root,id,options);try{return await fn();}finally{await lease.release();}}
export async function withWriters(root,ids,options,fn){
 const leases=[];
 try{for(const id of [...new Set(ids)].sort())leases.push(await acquireWriter(root,id,options));return await fn();}
 finally{const results=await Promise.allSettled(leases.reverse().map(lease=>lease.release()));const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(errors.length)throw new AggregateError(errors,'One or more project writer releases could not be confirmed');}
}
