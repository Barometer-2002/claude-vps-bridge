import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {SshRoutes} from '../plugin/runtime/ssh-routes.mjs';
import {validateTransportOptions} from '../plugin/runtime/bridge-config.mjs';

// A route may fail after SSH authentication. For installation commands, wait
// for the remote shell to ask for permission to start before sending the
// command's input. Once released, even an SSH exit of 255 is not retryable.
export async function runRouteCommand(config,command,input,{timeoutMs=120000,handshakeMs=18000,spawnProcess=spawn}={}){
  const routes=new SshRoutes(config);
  const guarded=routes.length>1;
  const entry=guarded?'printf "BRIDGE_READY\\n" && IFS= read -r bridge_run && [ "$bridge_run" = RUN ] && exec '+command:command;
  return routes.firstAvailable(route=>new Promise((resolve,reject)=>{
    const child=spawnProcess(config.sshExecutable,route.args(entry),{windowsHide:true,stdio:['pipe','pipe','pipe']});
    let released=!guarded,settled=false,out=[],err='',prefix='';
    function finish(error){
      if(settled)return;settled=true;clearTimeout(timer);
      if(error){error.unknown=released;child.kill();reject(error);}
      else resolve(Buffer.concat(out));
    }
    function watchdog(ms){return setTimeout(()=>finish(Object.assign(Error(released?'SSH command timed out':'SSH handshake timed out'),{code:released?'SSH_COMMAND_TIMEOUT':'SSH_HANDSHAKE_TIMEOUT'})),ms);}
    let timer=watchdog(guarded?handshakeMs:timeoutMs);
    child.once('error',finish);child.stdin.on('error',finish);
    child.stderr.on('data',buf=>{err=(err+buf).slice(-4096);});
    child.stdout.on('data',buf=>{
      if(settled)return;
      if(released){out.push(buf);return;}
      prefix+=buf.toString('ascii');
      if(!'BRIDGE_READY\n'.startsWith(prefix)){finish(Error('Unexpected SSH route handshake'));return;}
      if(prefix==='BRIDGE_READY\n'){
        released=true;clearTimeout(timer);timer=watchdog(timeoutMs);
        child.stdin.write('RUN\n');child.stdin.end(input);
      }
    });
    child.on('close',code=>finish(released&&code===0?null:Error(released?(err||'SSH command failed'):'SSH route unavailable')));
    if(!guarded)child.stdin.end(input);
  }),error=>!error.unknown);
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
    const request=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    validateTransportOptions(request.config);
    if(process.argv[2]!=='--validate')process.stdout.write(await runRouteCommand(request.config,request.command,request.input,{timeoutMs:request.timeoutMs}));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
