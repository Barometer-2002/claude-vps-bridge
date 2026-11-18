import net from 'node:net';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import {statSync,realpathSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {replaceFile} from './atomic-file.mjs';

const helper=fileURLToPath(new URL('socks-connect.mjs',import.meta.url));
const label=/^[\p{L}][\p{L}\p{N}_-]{0,47}$/u;
const reasons=new Set(['connection-failed','handshake-timeout','read-stalled','route-helper-unavailable']);
export function routeFailureReason(error){
  if(error.code==='ROUTE_HELPER_UNAVAILABLE')return 'route-helper-unavailable';
  if(['HANDSHAKE_TIMEOUT','SSH_HANDSHAKE_TIMEOUT','REMOTE_HEALTH_TIMEOUT'].includes(error.code))return 'handshake-timeout';
  return 'connection-failed';
}
export function validHost(host){
  if(typeof host!=='string'||!host.length||host.length>253||/[^A-Za-z0-9.:-]/.test(host))return false;
  if(net.isIP(host))return true;
  return host.replace(/\.$/,'').split('.').every(part=>/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(part));
}

export function validateRoutes(routes){
  if(routes===undefined)return [{name:'direct',direct:true}];
  if(!Array.isArray(routes)||!routes.length||routes.length>16)throw Error('sshRoutes must contain 1 to 16 routes');
  const names=new Set();
  for(const route of routes){
    if(!route||typeof route.name!=='string'||!label.test(route.name)||names.has(route.name))throw Error('Invalid or duplicate SSH route name');
    names.add(route.name);
    if(Object.keys(route).length!==2)throw Error('Invalid SSH route fields');
    if(route.direct===true)continue;
    const p=route.proxy;
    if(p?.type==='cloudflared'){
      if(Object.keys(p).some(k=>!['type','hostname','executable'].includes(k))||!validHost(p.hostname)||net.isIP(p.hostname))throw Error('Invalid cloudflared hostname');
      if(p.executable!==undefined){
        if(typeof p.executable!=='string'||!/^[A-Za-z]:[\\/]/.test(p.executable)||p.executable.slice(2).includes(':')||p.executable.split(/[\\/]/).includes('..')||!p.executable.toLowerCase().endsWith('.exe'))throw Error('Invalid cloudflared executable');
        commandPath(p.executable);
      }
    }else if(!p||Object.keys(p).length!==3||p.type!=='socks5'||!validHost(p.host)||!Number.isInteger(p.port)||p.port<1||p.port>65535)throw Error('Invalid SOCKS5 route');
  }
  return routes;
}

function commandPath(file){
  // OpenSSH interprets ProxyCommand as a command string. Only literal paths
  // and validated endpoint arguments may enter it, including on Windows.
  if((!path.win32.isAbsolute(file)&&!path.isAbsolute(file))||/["'%!$&`|<>^\x00-\x1f]/.test(file))throw Error('Unsafe ProxyCommand executable or helper path');
  return '"'+file+'"';
}

function findCloudflared(explicit){
  const env=process.env;
  const dirs=(env.PATH??'').split(path.delimiter).map(v=>v.replace(/^"(.*)"$/,'$1')).filter(v=>path.isAbsolute(v));
  for(const base of [env.ProgramFiles,env['ProgramFiles(x86)']])if(base)dirs.push(path.join(base,'cloudflared'));
  if(env.LOCALAPPDATA)dirs.push(path.join(env.LOCALAPPDATA,'Microsoft','WinGet','Links'));
  for(const file of explicit?[explicit]:dirs.map(dir=>path.join(dir,'cloudflared.exe'))){
    try{if(statSync(file).isFile()){const resolved=realpathSync(file);commandPath(resolved);return resolved;}}catch{}
  }
  throw Object.assign(Error('cloudflared executable unavailable'),{code:'ROUTE_HELPER_UNAVAILABLE'});
}
export class SshRoutes{
  constructor(config,{locateCloudflared=findCloudflared}={}){this.config=config;this.routes=validateRoutes(config.sshRoutes);this.locateCloudflared=locateCloudflared;this.index=0;this.lastSwitchReason=null;}
  get current(){return this.routes[this.index];}
  get length(){return this.routes.length;}
  advance(reason){
    if(this.length===1)return false;
    this.index=(this.index+1)%this.length;
    this.lastSwitchReason=reasons.has(reason)?reason:'connection-failed';
    return true;
  }
  args(command,{connectTimeout=12,keepAlive=false}={}){
    const args=['-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout='+connectTimeout];
    if(keepAlive)args.push('-o','ServerAliveInterval=10','-o','ServerAliveCountMax=2');
    if(this.current.proxy?.type==='cloudflared'){
      const {executable,hostname}=this.current.proxy;
      args.push('-o','ProxyCommand='+commandPath(this.locateCloudflared(executable))+' access ssh --hostname '+hostname);
    }else if(this.current.proxy){
      const {host,port}=this.current.proxy;
      const node=path.win32.join(this.config.hostRoot,'runtime','node.exe');
      args.push('-o','ProxyCommand='+[commandPath(node),commandPath(helper),host,port,'"%h"','%p'].join(' '));
    }else if(this.config.sshRoutes)args.push('-o','ProxyCommand=none');
    return [...args,this.config.sshHost,command];
  }
  async firstAvailable(attempt,mayRetry=()=>true){
    for(let i=0;;i++){
      try{return await attempt(this);}
      catch(error){
        if(i+1>=this.length||!mayRetry(error))throw error;
        this.advance(routeFailureReason(error));
      }
    }
  }
}

const states=new Set(['connecting','reconnecting','connected','unavailable','closed']);
const routeTypes=new Set(['direct','cloudflared','socks5']);
function safeIngress(value){
  const kind=['direct','local-proxy'].includes(value?.kind)?value.kind:'unknown';
  const process=kind==='local-proxy'&&typeof value?.process==='string'&&/^[A-Za-z][A-Za-z0-9_+-]{0,63}$/.test(value.process)?value.process:null;
  return {kind,process};
}
let pendingObservation=Promise.resolve();
export function recordRouteState(directory,state){
  if(typeof state.route!=='string'||!label.test(state.route)||!states.has(state.state))return Promise.resolve();
  const row={route:state.route,routeType:routeTypes.has(state.routeType)?state.routeType:null,state:state.state,ingress:safeIngress(state.ingress),lastSwitchReason:reasons.has(state.lastSwitchReason)?state.lastSwitchReason:null,observedAt:new Date().toISOString(),pid:process.pid};
  const file=path.join(directory,'ssh-route.json');
  // Preserve callback order even when mkdir/rename of an earlier state is slow.
  pendingObservation=pendingObservation.catch(()=>{}).then(async()=>{
    await fs.mkdir(directory,{recursive:true});
    const temp=file+'.'+randomUUID()+'.tmp';
    await fs.writeFile(temp,JSON.stringify(row),{mode:0o600});
    await replaceFile(temp,file);
  });
  return pendingObservation;
}

export function routeObservation(config,row,isAlive){
  if(!row||!states.has(row.state))return null;
  if(typeof row.route!=='string'||!label.test(row.route))return null;
  const selected=validateRoutes(config.sshRoutes).find(r=>r.name===row.route);
  if(!selected&&!routeTypes.has(row.routeType))return null;
  const observed=Date.parse(row.observedAt);
  if(!Number.isFinite(observed)||!Number.isSafeInteger(row.pid)||row.pid<1)return null;
  const ingress=safeIngress(row.ingress),type=routeTypes.has(row.routeType)?row.routeType:selected.proxy?.type??'direct';
  // A SOCKS exit may reach sshd over the network or through a local tunnel.
  // Its final hop alone cannot establish which Windows-side proxy was used.
  let consistency='unknown';
  if(ingress.kind!=='unknown'){
    if(type==='direct')consistency=ingress.kind==='direct'?'match':'mismatch';
    if(type==='cloudflared'){
      if(ingress.kind==='direct')consistency='mismatch';
      else if(ingress.process)consistency=ingress.process==='cloudflared'?'match':'mismatch';
    }
  }
  return {route:row.route,routeType:type,state:isAlive(row.pid)===false?'stopped':row.state,ingress,consistency,lastSwitchReason:reasons.has(row.lastSwitchReason)?row.lastSwitchReason:null,observedAt:new Date(observed).toISOString()};
}
