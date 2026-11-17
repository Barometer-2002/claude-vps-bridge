import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {acquireWriter,releaseWriter,writerStatus} from './task-coordination.mjs';
import {optionValue} from './agent-binding.mjs';
import {replaceFile} from './atomic-file.mjs';
const terminal=new Set(['completed','failed','interrupted','cancelled']);
const ref=value=>typeof value==='string'?value.replace(/^codex:\/\/threads\//,''):null;
function threadOf(value){return ref(value?.thread??value?.threadId);}
async function saveDelegation(file,record,{exclusive=false}={}){
 const temp=file+'.'+randomUUID()+'.tmp';
 try{
  await fs.writeFile(temp,JSON.stringify(record),{flag:'wx'});
  if(exclusive)await fs.link(temp,file);
  else await replaceFile(temp,file);
 }finally{await fs.rm(temp,{force:true});}
}
async function reservationTransition(root,projectId,operation){
 const directory=path.join(root,'delegations',projectId);await fs.mkdir(directory,{recursive:true});
 const file=path.join(directory,'.transition'),deadline=Date.now()+5000;let handle;
 for(;;){
  try{handle=await fs.open(file,'wx');break;}
  catch(error){if(error.code!=='EEXIST')throw error;if(Date.now()>=deadline)throw Object.assign(new Error('Delegation metadata transition is unresolved; inspect the original reservation'),{code:'PROJECT_RESERVATION_BUSY'});await new Promise(resolve=>setTimeout(resolve,10));}
 }
 // This serializes metadata only. It never acquires or replaces the project writer,
 // and no CLI call or long thread wait runs inside this critical section.
 try{return await operation();}finally{await handle.close();await fs.unlink(file);}
}
async function unresolvedControls(root,projectId,requestId){
 const directory=path.join(root,'delegations',projectId),names=await fs.readdir(directory);
 for(const name of names.filter(name=>name.endsWith('.json'))){
  const record=JSON.parse(await fs.readFile(path.join(directory,name),'utf8'));
  if(record.ownerRequestId===requestId&&['submitting','unknown'].includes(record.status))return true;
 }
 return false;
}
async function childDrained(root,projectId,thread){
 const scope=createHash('sha256').update(projectId+'\n'+thread).digest('hex');
 if((await writerStatus(root,scope)).locked)return false;
 const jobs=path.join(root,'jobs',projectId),names=await fs.readdir(jobs).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
 for(const name of names){const dir=path.join(jobs,name);let spec;try{spec=JSON.parse(await fs.readFile(path.join(dir,'request.json'),'utf8'));}catch{return false;}
  if(ref(spec.parentThread)!==thread)continue;
  const state=await fs.readFile(path.join(dir,'status.json'),'utf8').then(JSON.parse,()=>null);
  if(!['succeeded','failed','cancelled'].includes(state?.status))return false;
 }
 return true;
}
export async function writerScope(root,projectId,hostThread){
 const owner=await writerStatus(root,projectId);
 if(owner.kind!=='agent'||!hostThread)return projectId;
 const file=path.join(root,'delegations',projectId,owner.requestId+'.json');
 const saved=await fs.readFile(file,'utf8').then(JSON.parse,e=>{if(e.code==='ENOENT')return null;throw e;});
 // The bound Host child may write beneath its own reservation; other sessions cannot.
 return saved?.thread&&saved.thread===ref(hostThread)?createHash('sha256').update(projectId+'\n'+saved.thread).digest('hex'):projectId;
}
export async function coordinatedAgent(root,info,argv,execute,{requestId:bridgeRequestId}={}){
 const starts=argv[0]==='delegate'&&argv[1]==='start',sends=argv[0]==='thread'&&argv[1]==='send';
 const mutation=(starts||sends)&&!argv.includes('--help')&&!argv.includes('-h');
 const interruptIndex=argv.indexOf('--interrupt');
 const interrupt=argv.includes('--interrupt=true')||interruptIndex>=0&&argv[interruptIndex+1]!=='false';
 if(mutation&&sends&&optionValue(argv,'--steer')==='true'&&interrupt)throw Object.assign(new Error('--steer true and --interrupt are mutually exclusive'),{code:'INVALID_ARGUMENT'});
 if(!mutation){
  let observation;
  if(argv[0]==='thread'&&['read','wait'].includes(argv[1])){
   observation=await reservationTransition(root,info.projectId,async()=>{
    const owner=await writerStatus(root,info.projectId);if(owner.kind!=='agent')return null;
    const record=JSON.parse(await fs.readFile(path.join(root,'delegations',info.projectId,owner.requestId+'.json'),'utf8'));
    return {token:owner.token,revision:record.controlRevision??0,pending:await unresolvedControls(root,info.projectId,owner.requestId)};
   });
  }
  const result=await execute(argv);
  // Cancellation acknowledgement is not proof of termination: read/wait only.
  if(argv[0]==='thread'&&['read','wait'].includes(argv[1])&&terminal.has(result?.status)){
   return reservationTransition(root,info.projectId,async()=>{
   const owner=await writerStatus(root,info.projectId);
   if(owner.kind==='agent'){
    const file=path.join(root,'delegations',info.projectId,owner.requestId+'.json');
    const saved=await fs.readFile(file,'utf8').then(JSON.parse,e=>{if(e.code==='ENOENT')return null;throw e;});
    if(saved&&saved.thread===ref(argv[2])&&threadOf(result)===saved.thread){
      if(!observation||observation.pending||observation.token!==owner.token||observation.revision!==(saved.controlRevision??0)||await unresolvedControls(root,info.projectId,owner.requestId))return {...result,writerRetained:true,writerReason:'A child control request overlapped this read or has an unresolved outcome. Read its current state again after resolving the original request.'};
      if(!await childDrained(root,info.projectId,saved.thread))return {...result,writerRetained:true,writerReason:'The agent ended but its managed local jobs or writer are not confirmed stopped. Inspect those tasks before modifying this workspace.'};
      await releaseWriter(root,info.projectId,owner.token);saved.status=result.status;await saveDelegation(file,saved);
    }
   }
   return result;
   });
  }
  return result;
 }
 const requestIndex=argv.indexOf('--request-id');
 const requestId=requestIndex>=0?argv[requestIndex+1]:bridgeRequestId;
 if(!/^[a-zA-Z0-9_-]{1,100}$/.test(requestId??''))throw new Error('Invalid delegation request ID');
 if(starts&&requestIndex<0)argv=[...argv,'--request-id',requestId];
 const file=path.join(root,'delegations',info.projectId,requestId+'.json');
 const saved=await fs.readFile(file,'utf8').then(JSON.parse,e=>{if(e.code==='ENOENT')return null;throw e;});
 if(saved){if(JSON.stringify(saved.argv)!==JSON.stringify(argv))throw new Error('Delegation request ID belongs to different work');if(saved.result)return saved.result;throw new Error('Delegation outcome unknown. Inspect the saved request and original Host task; do not resubmit');}
 let lease,reusedOwner,record,duplicate;
 if(starts)lease=await acquireWriter(root,info.projectId,{kind:'agent',requestId});
 try{
  await reservationTransition(root,info.projectId,async()=>{
   duplicate=await fs.readFile(file,'utf8').then(JSON.parse,error=>{if(error.code==='ENOENT')return null;throw error;});if(duplicate)return;
   let ownerFile,reservation;
   if(sends){
    const owner=await writerStatus(root,info.projectId);ownerFile=path.join(root,'delegations',info.projectId,owner.requestId+'.json');
    reservation=owner.kind==='agent'?await fs.readFile(ownerFile,'utf8').then(JSON.parse):null;
    if(!owner.locked||!reservation?.thread||reservation.thread!==ref(argv[2]))throw Object.assign(new Error('Only the child holding this project reservation can receive a control send'),{code:'PROJECT_WRITE_BUSY'});
    reusedOwner=owner;
   }
   record={requestId,argv,thread:sends?ref(argv[2]):null,status:'submitting',...(reusedOwner?{ownerRequestId:reusedOwner.requestId}:{}),createdAt:new Date().toISOString()};
   await saveDelegation(file,record,{exclusive:true});
   if(reservation){reservation.controlRevision=(reservation.controlRevision??0)+1;await saveDelegation(ownerFile,reservation);}
  });
 }catch(error){if(lease)await lease.release();throw error;}
 if(duplicate){if(lease)await lease.release();if(JSON.stringify(duplicate.argv)!==JSON.stringify(argv))throw new Error('Delegation request ID belongs to different work');if(duplicate.result)return duplicate.result;throw new Error('Delegation outcome unknown; inspect the original request without resubmitting');}
 try{
  if(reusedOwner&&(await writerStatus(root,info.projectId)).token!==reusedOwner.token)throw new Error('Project reservation changed before send; no command was submitted');
  const result=await execute(argv);record.thread=threadOf(result)??record.thread;if(!record.thread)throw new Error('Host accepted delegation but returned no recognized thread identity; outcome must be inspected');record.result=result;record.status='accepted';await saveDelegation(file,record);
  // Retain ownership until a subsequent authenticated read/wait confirms terminal.
  return result;
 }catch(e){record.status='unknown';await saveDelegation(file,record);throw e;}
}
