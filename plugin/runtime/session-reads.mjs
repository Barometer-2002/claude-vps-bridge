import {createHash} from 'node:crypto';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const cancelled=()=>Object.assign(new Error('Bridge read was abandoned'),{code:'CANCELLED'});

// Keep the immutable wire representation. Host-side projection can freely
// modify its own result without changing a future conditional read.
export class SessionReads {
  constructor(rpc,{maxBytes=16*1024*1024,maxEntries=32}={}) {
    this.rpc=rpc;
    this.maxBytes=maxBytes;
    this.maxEntries=maxEntries;
    this.bytes=0;
    this.cache=new Map();
    this.pending=new Map();
  }
  forget(sessionId) {
    const entry=this.cache.get(sessionId);
    if(entry){this.bytes-=entry.bytes.length;this.cache.delete(sessionId);}
  }
  remember(sessionId,result,tag,bytes) {
    this.forget(sessionId);
    if(bytes.length>this.maxBytes||!this.maxEntries)return;
    // A conditional request can still receive a delta for its base. Keep that
    // base counted against the budget until its response has been decoded.
    for(const [other,entry] of this.cache){
      if(this.bytes+bytes.length<=this.maxBytes&&this.cache.size<this.maxEntries)break;
      if(!entry.pins)this.forget(other);
    }
    if(this.bytes+bytes.length>this.maxBytes||this.cache.size>=this.maxEntries)return;
    const turns=result.value.turns;
    const condition={digest:tag,turnCount:turns.length,turnsDigest:digest(JSON.stringify(turns))};
    this.cache.set(sessionId,{bytes,condition,pins:0});
    this.bytes+=bytes.length;
  }
  async snapshot(params,timeout,signal) {
    const {sessionId}=params;
    const previous=this.cache.get(sessionId);
    if(previous){
      previous.pins++;
      this.cache.delete(sessionId);
      this.cache.set(sessionId,previous);
    }
    try{
      const wire=await this.rpc('snapshot',{...params,conditionalSnapshot:previous?.condition??{}},timeout,signal);
      signal.throwIfAborted();
      // A protocol-2 worker (and an unsuccessful read) returns the original
      // HarnessResult. Only the negotiated envelope is a cache response.
      if(!wire?.snapshotEncoding)return wire;
      const {snapshotEncoding:encoding,digest:tag}=wire;
      if(encoding==='unchanged'){
        if(!previous||tag!==previous.condition.digest)throw new Error('Snapshot base does not match the unchanged reply');
        return JSON.parse(previous.bytes);
      }
      const result=wire.result;
      if(result?.ok!==true||!Array.isArray(result.value?.turns))throw new Error('Invalid snapshot response');
      if(encoding==='append'){
        if(!previous||wire.base!==previous.condition.digest)throw new Error('Snapshot base does not match the incremental reply');
        result.value.turns=JSON.parse(previous.bytes).value.turns.concat(result.value.turns);
      }else if(encoding!=='full')throw new Error('Unknown snapshot encoding');
      const bytes=Buffer.from(JSON.stringify(result));
      if(digest(bytes)!==tag)throw new Error('Snapshot digest mismatch');
      this.remember(sessionId,result,tag,bytes);
      return result;
    }finally{if(previous)previous.pins--;}
  }
  read(method,params,timeout,signal) {
    if(signal?.aborted)return Promise.reject(cancelled());
    const key=JSON.stringify([method,params]);
    let entry=this.pending.get(key);
    if(!entry){
      const controller=new AbortController();
      entry={controller,sessionId:params.sessionId,waiters:new Set()};
      this.pending.set(key,entry);
      const read=method==='snapshot'?this.snapshot(params,timeout,controller.signal):this.rpc(method,params,timeout,controller.signal);
      const finish=(error,value)=>{
        if(this.pending.get(key)===entry)this.pending.delete(key);
        for(const waiter of entry.waiters)waiter(error,value);
        entry.waiters.clear();
      };
      read.then(value=>finish(null,value),error=>finish(error));
    }
    return new Promise((resolve,reject)=>{
      const settle=(error,value)=>{
        signal?.removeEventListener('abort',abort);
        if(error)reject(error);else resolve(value);
      };
      const abort=()=>{
        if(!entry.waiters.delete(settle))return;
        if(!entry.waiters.size){
          if(this.pending.get(key)===entry)this.pending.delete(key);
          entry.controller.abort(cancelled());
        }
        settle(cancelled());
      };
      entry.waiters.add(settle);
      signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted)abort();
    });
  }
  close(sessionId) {
    for(const [key,entry] of this.pending){
      if(sessionId!==undefined&&entry.sessionId!==sessionId)continue;
      this.pending.delete(key);
      const reason=cancelled();
      entry.controller.abort(reason);
      for(const waiter of entry.waiters)waiter(reason);
      entry.waiters.clear();
    }
    if(sessionId!==undefined)this.forget(sessionId);
    else{this.cache.clear();this.bytes=0;}
  }
}
