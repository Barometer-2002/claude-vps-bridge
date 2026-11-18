// Limits apply before an unterminated frame or a slow peer can grow memory.
export const MAX_FRAME_BYTES=48*1024*1024;
export const MAX_QUEUE_BYTES=64*1024*1024;
export function transportError(code,message){return Object.assign(new Error(message),{code});}

export function readJsonLines(stream,onFrame,{maxBytes=MAX_FRAME_BYTES,onError,onEnd}={}){
  let storage=null,bytes=0,closed=false;
  const fail=error=>{if(closed)return;dispose();onError?.(error);};
  function data(chunk){
    if(closed)return;
    const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);let offset=0;
    try{
      while(offset<buffer.length){
        const newline=buffer.indexOf(10,offset),end=newline<0?buffer.length:newline;
        const piece=buffer.subarray(offset,end);
        if(bytes+piece.length>maxBytes)throw transportError('FRAME_TOO_LARGE','Bridge frame exceeds the configured byte limit');
        if(piece.length){
          const required=bytes+piece.length;
          if(!storage||storage.length<required){const next=Buffer.allocUnsafe(Math.min(maxBytes,Math.max(required,(storage?.length??32768)*2)));storage?.copy(next,0,0,bytes);storage=next;}
          piece.copy(storage,bytes);bytes=required;
        }
        if(newline<0)break;
        const line=storage?.toString('utf8',0,bytes)??'';bytes=0;if(storage?.length>1024*1024)storage=null;
        let value;try{value=JSON.parse(line);}catch{throw transportError('INVALID_FRAME','Invalid bridge JSON frame');}
        onFrame(value);if(closed)return;offset=newline+1;
      }
    }catch(error){fail(error);}
  }
  function end(){if(closed)return;if(bytes){fail(transportError('TRUNCATED_FRAME','Bridge closed during a JSON frame'));return;}dispose();onEnd?.();}
  function dispose(){if(closed)return;closed=true;storage=null;bytes=0;stream.off('data',data);stream.off('end',end);stream.off('error',fail);}
  stream.on('data',data);stream.on('end',end);stream.on('error',fail);
  return {dispose,get bufferedBytes(){return bytes;}};
}

export function jsonFrame(value,maxBytes=MAX_FRAME_BYTES){
  const text=JSON.stringify(value);
  if(Buffer.byteLength(text)>maxBytes)throw transportError('FRAME_TOO_LARGE','Bridge frame exceeds the configured byte limit');
  return Buffer.from(text+'\n');
}

export class JsonWriter{
  constructor(stream,{maxBytes=MAX_FRAME_BYTES,maxQueueBytes=MAX_QUEUE_BYTES,maxQueuedFrames=4096,onError}={}){
    this.stream=stream;this.maxBytes=maxBytes;this.maxQueueBytes=maxQueueBytes;this.maxQueuedFrames=maxQueuedFrames;this.onError=onError;
    this.queue=[];this.bytes=0;this.blocked=false;this.closed=false;this.ending=false;
    this.drain=()=>{this.blocked=false;this.flush();};
    stream.on('drain',this.drain);
  }
  get bufferedBytes(){return this.bytes+(this.stream.writableLength??0);}
  send(value){return this.sendBuffer(jsonFrame(value,this.maxBytes));}
  sendBuffer(buffer){
    if(this.closed||this.ending||this.stream.destroyed||this.stream.writableEnded)throw transportError('TRANSPORT_CLOSED','Bridge output is closed');
    if(this.bufferedBytes+buffer.length>this.maxQueueBytes||this.queue.length>=this.maxQueuedFrames)throw transportError('TRANSPORT_BACKPRESSURE','Bridge output queue is full; operation was not queued');
    this.queue.push(buffer);this.bytes+=buffer.length;this.flush();
  }
  flush(){
    try{
      while(!this.closed&&!this.blocked&&this.queue.length){
        const buffer=this.queue.shift();this.bytes-=buffer.length;this.blocked=!this.stream.write(buffer);
      }
      if(this.ending&&!this.queue.length&&!this.blocked&&!this.closed){this.dispose();this.stream.end();}
    }catch(error){this.dispose();this.onError?.(error);}
  }
  end(){if(this.closed)return;this.ending=true;this.flush();}
  dispose(){if(this.closed)return;this.closed=true;this.stream.off('drain',this.drain);this.queue=[];this.bytes=0;}
}

export function flowLimits({chunkBytes=32768,windowBytes=65536}={}){
  if(!Number.isInteger(chunkBytes)||chunkBytes<256||chunkBytes>262144||
     !Number.isInteger(windowBytes)||windowBytes<1024||windowBytes>1048576||chunkBytes+256>windowBytes){
    throw transportError('INVALID_FLOW_LIMIT','Invalid bridge chunk or window size');
  }
  return {chunkBytes,windowBytes};
}

// Sequence numbers are assigned at dispatch, not at enqueue. The journal is
// exactly the unacknowledged wire window. An SSH process owns neither queue.
export class FlowSender {
  constructor(limits){
    Object.assign(this,flowLimits(limits));
    // Keep one packet of credit for interactive traffic. With the default
    // window three 16 KiB bulk packets can be outstanding at the same time.
    this.quantum=Math.min(this.chunkBytes,Math.floor(this.windowBytes/4));
    this.seq=0;this.acked=0;this.nextPart=0;this.inFlight=0;this.retained=0;
    this.queue=[];this.journal=[];this.send=null;this.pumping=false;
  }
  checkCursor(cursor){
    if(!Number.isSafeInteger(cursor)||cursor<this.acked||cursor>this.seq)
      throw transportError('REPLAY_GAP','Cannot resume from that cursor; outstanding outcomes are unknown');
  }
  attach(cursor,send){
    this.checkCursor(cursor);this.detach();this.acknowledge(cursor);this.send=send;
    this.pumping=true;
    try{for(const entry of [...this.journal]){if(!this.send)break;send(entry.buffer);}}
    finally{this.pumping=false;}
    this.pump();
  }
  detach(){this.send=null;}
  acknowledge(cursor){
    this.checkCursor(cursor);this.acked=cursor;
    while(this.journal.length&&this.journal[0].seq<=cursor)this.inFlight-=this.journal.shift().buffer.length;
    this.pump();
  }
  enqueue(value,{key,lane,onSent,discard,replyTo,terminal=false}={}){
    const raw=jsonFrame(value);
    const byteLimit=terminal?MAX_QUEUE_BYTES:MAX_QUEUE_BYTES-1024*1024;
    const frameLimit=terminal?16384:12288;
    if(this.queue.length>=frameLimit||this.retained+raw.length>byteLimit)
      throw transportError('TRANSPORT_CAPACITY','Bridge send queue is full');
    const large=raw.length-1>this.chunkBytes;
    this.queue.push({raw,value:large?undefined:value,large,part:large?++this.nextPart:undefined,
      offset:0,key,lane,onSent,discard,replyTo});
    this.retained+=raw.length;this.pump();
  }
  has(key){return this.queue.some(item=>item.key===key);}
  cancel(key){
    const i=this.queue.findIndex(item=>item.key===key);
    if(i<0)return;
    const [item]=this.queue.splice(i,1);this.retained-=item.raw.length;
    return item.offset?item.part:undefined;
  }
  chunk(item,seq){
    const total=item.raw.length-1;
    let end=Math.min(total,item.offset+Math.floor((this.quantum-128)*3/4));
    // The logical frame is UTF-8 JSON. Keep entire code points together.
    while(end<total&&(item.raw[end]&0xc0)===0x80)end--;
    const text=item.raw.toString('utf8',item.offset,end);
    const wire={seq,part:item.part,offset:item.offset,total,replyTo:item.offset===0?item.replyTo:undefined};
    // Plain text and existing media base64 travel without another base64
    // expansion. Heavily escaped JSON uses base64 when it costs fewer bytes.
    if(Buffer.byteLength(JSON.stringify(text))-2<=4*Math.ceil((end-item.offset)/3))wire.text=text;
    else wire.data=item.raw.toString('base64',item.offset,end);
    return {end,wire};
  }
  pump(){
    if(!this.send||this.pumping)return;
    this.pumping=true;
    try{
      while(this.send&&this.queue.length&&this.inFlight<this.windowBytes){
        // A lane preserves dependencies (ordered events, monotonic requests).
        // Independent small replies jump ahead; bulk lane heads rotate.
        const seen=new Set();let i=-1;
        for(let n=0;n<this.queue.length;n++){
          const item=this.queue[n];
          if(item.lane&&seen.has(item.lane))continue;
          if(item.lane)seen.add(item.lane);
          if(!item.large){i=n;break;}
          if(i<0)i=n;
        }
        const item=this.queue[i],seq=this.seq+1;
        let wire,end;
        if(item.large)({end,wire}=this.chunk(item,seq));
        else wire={seq,payload:item.value,discard:item.discard};
        const buffer=jsonFrame(wire);
        const available=item.large?this.windowBytes-this.quantum:this.windowBytes;
        if(this.inFlight+buffer.length>available)break;
        this.seq=seq;this.journal.push({seq,buffer});this.inFlight+=buffer.length;
        if(item.large)item.offset=end;
        if(!item.large||end===item.raw.length-1){
          this.queue.splice(i,1);this.retained-=item.raw.length;item.onSent?.(seq);
        }else{
          // Rotate the whole lane so no later message can pass its head.
          const group=item.lane?this.queue.filter(other=>other.lane===item.lane):[item];
          if(item.lane)this.queue=this.queue.filter(other=>other.lane!==item.lane);
          else this.queue.splice(i,1);
          this.queue.push(...group);
        }
        this.send(buffer);
      }
    }finally{this.pumping=false;}
  }
}

// Only complete JSON values are delivered. Partial bodies and cursor live
// together for the relay epoch, including across SSH process replacement.
export class FlowReceiver {
  constructor(limits){
    Object.assign(this,flowLimits(limits));this.cursor=0;this.parts=new Map();this.buffered=0;this.reserved=0;
  }
  accept(frame,deliver,onProgress){
    if(!Number.isSafeInteger(frame.seq)||frame.seq<1)throw transportError('INVALID_FRAME','Invalid wire sequence');
    if(frame.seq<=this.cursor)return;
    if(frame.seq!==this.cursor+1)throw transportError('REPLAY_GAP','Missing transport frame');
    if(Object.hasOwn(frame,'payload')){
      if(frame.discard!==undefined){
        const partial=this.parts.get(frame.discard);
        if(partial){this.buffered-=partial.bytes;this.reserved-=partial.total;this.parts.delete(frame.discard);}
      }
      deliver(frame.payload);
    }else{
      const {part,offset,total,data,text}=frame;
      if(!Number.isSafeInteger(part)||part<1||!Number.isSafeInteger(total)||total<=0||total>MAX_FRAME_BYTES||
         (data===undefined)===(text===undefined)||!Number.isSafeInteger(offset))
        throw transportError('INVALID_FRAME','Invalid chunk header');
      const encoded=data??text;
      if(typeof encoded!=='string'||!encoded.length||Buffer.byteLength(encoded)>this.chunkBytes)
        throw transportError('INVALID_FRAME','Invalid chunk body');
      const bytes=Buffer.from(encoded,data===undefined?'utf8':'base64');
      let state=this.parts.get(part);
      if(state&&state.total!==total||offset!==(state?.bytes??0)||!bytes.length||offset+bytes.length>total||
         (data!==undefined&&bytes.toString('base64')!==data)||frame.replyTo!==undefined&&
         (offset!==0||typeof frame.replyTo!=='string'||frame.replyTo.length>100))
        throw transportError('INVALID_FRAME','Invalid chunk data or offset');
      if(!state){
        if(this.parts.size>=16384||this.reserved+total>MAX_QUEUE_BYTES)
          throw transportError('TRANSPORT_CAPACITY','Too many partial frames');
        state={total,bytes:0,body:Buffer.allocUnsafe(total),replyTo:frame.replyTo};
        this.parts.set(part,state);this.reserved+=total;
      }
      bytes.copy(state.body,offset);this.buffered+=bytes.length;state.bytes+=bytes.length;
      if(state.bytes===total){
        const value=JSON.parse(state.body.toString('utf8'));
        if(state.replyTo!==undefined&&state.replyTo!==value?.id)throw transportError('INVALID_FRAME','Response identity mismatch');
        this.parts.delete(part);this.buffered-=total;this.reserved-=total;deliver(value);
      }else if(state.replyTo)onProgress?.(state.replyTo);
    }
    this.cursor=frame.seq;
  }
}
