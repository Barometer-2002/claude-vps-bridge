import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validHost} from './ssh-routes.mjs';

function port(value){
  if(!/^\d{1,5}$/.test(String(value))||Number(value)<1||Number(value)>65535)throw Error('INVALID_ENDPOINT');
  return Number(value);
}
function address(host){
  if(!validHost(host))throw Error('INVALID_ENDPOINT');
  if(net.isIPv4(host))return Buffer.from([1,...host.split('.').map(Number)]);
  if(net.isIPv6(host)){
    const canonical=new URL('http://['+host+']/').hostname.slice(1,-1);
    const [left,right]=canonical.split('::').map(side=>side?side.split(':'):[]);
    const groups=right?[...left,...Array(8-left.length-right.length).fill('0'),...right]:left;
    const bytes=Buffer.alloc(17);bytes[0]=4;
    groups.forEach((part,i)=>bytes.writeUInt16BE(parseInt(part,16),1+2*i));
    return bytes;
  }
  const domain=Buffer.from(host,'ascii');return Buffer.concat([Buffer.from([3,domain.length]),domain]);
}
export function connectSocks({proxyHost,proxyPort,targetHost,targetPort,input,output,connect=options=>net.createConnection(options),timeoutMs=10000}){
  if(!validHost(proxyHost))throw Error('INVALID_ENDPOINT');
  const target=address(targetHost),p=port(targetPort);
  const request=Buffer.concat([Buffer.from([5,1,0]),target,Buffer.from([p>>8,p&255])]);
  const socket=connect({host:proxyHost,port:port(proxyPort),allowHalfOpen:true});
  return new Promise((resolve,reject)=>{
    let stage=0,pending=Buffer.alloc(0),failure;
    const fail=code=>{failure??=Error(code);socket.destroy();};
    const timer=setTimeout(()=>fail('SOCKS_TIMEOUT'),timeoutMs);
    const ioError=()=>fail('SOCKS_PIPE_ERROR');
    input.on('error',ioError);output.on('error',ioError);
    socket.once('error',()=>fail('SOCKS_CONNECTION_ERROR'));
    socket.once('connect',()=>socket.write(Buffer.from([5,1,0])));
    socket.once('end',()=>{if(stage!==2)fail('SOCKS_TRUNCATED_HANDSHAKE');});
    socket.once('close',()=>{
      clearTimeout(timer);input.unpipe(socket);input.pause();socket.unpipe(output);
      input.off('error',ioError);output.off('error',ioError);
      if(failure||stage!==2)reject(failure??Error('SOCKS_TRUNCATED_HANDSHAKE'));else resolve();
    });
    function handshake(bytes){
      pending=pending.length?Buffer.concat([pending,bytes]):bytes;
      if(stage===0){
        if(pending.length<2)return;
        if(pending[0]!==5||pending[1]!==0){fail('SOCKS_AUTH_REFUSED');return;}
        pending=pending.subarray(2);stage=1;socket.write(request);
      }
      if(pending.length<4)return;
      if(pending[0]!==5||pending[2]!==0){fail('SOCKS_INVALID_REPLY');return;}
      if(pending[1]!==0){fail('SOCKS_CONNECT_REFUSED_'+pending[1]);return;}
      const type=pending[3];
      if(type===3&&pending.length<5)return;
      const size=type===1?10:type===4?22:type===3&&pending[4]>0?7+pending[4]:0;
      if(!size){fail('SOCKS_INVALID_REPLY');return;}
      if(pending.length<size)return;
      const tail=pending.subarray(size);pending=Buffer.alloc(0);stage=2;clearTimeout(timer);
      socket.pause();socket.off('data',handshake);
      // pipe preserves backpressure for coalesced SSH banner bytes as well.
      if(tail.length)socket.unshift(tail);
      socket.pipe(output);input.pipe(socket);
    }
    socket.on('data',handshake);
  });
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [proxyHost,proxyPort,targetHost,targetPort]=process.argv.slice(2);
  try{await connectSocks({proxyHost,proxyPort,targetHost,targetPort,input:process.stdin,output:process.stdout});}
  catch(error){process.stderr.write((/^(?:SOCKS_[A-Z_0-9]+|INVALID_ENDPOINT)$/.test(error.message)?error.message:'SOCKS_CONNECTION_ERROR')+'\n');process.exitCode=1;}
}
