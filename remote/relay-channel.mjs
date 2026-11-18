import {FlowReceiver,FlowSender,flowLimits,transportError} from './transport-streams.mjs';
import {RelayLedger} from './relay-ledger.mjs';
import {BRIDGE_PROTOCOL} from './bridge-protocol.mjs';

export function negotiateRelay(frame,id,epoch,existing,sendWorker){
  if(frame.attach!==id||(frame.epoch&&frame.epoch!==epoch))
    throw transportError('REMOTE_RELAY_REPLACED','Relay changed; pending outcomes are unknown');
  if(frame.protocol!==BRIDGE_PROTOCOL)
    throw transportError('BRIDGE_PROTOCOL_INCOMPATIBLE','Update both sides of the bridge before sending requests');
  const limits=flowLimits(frame.limits);
  const channel=existing??new RelayChannel(sendWorker,limits);
  if(channel.limits.chunkBytes!==limits.chunkBytes||channel.limits.windowBytes!==limits.windowBytes)
    throw transportError('INVALID_FLOW_LIMIT','Flow limits changed during resume');
  channel.out.checkCursor(frame.cursor);
  return channel;
}

// Lifetime is one detached relay, independent of any particular socket.
export class RelayChannel {
  constructor(sendWorker,limits){
    this.sendWorker=sendWorker;this.limits=flowLimits(limits);
    this.out=new FlowSender(this.limits);this.input=new FlowReceiver(this.limits);
    this.ledger=new RelayLedger();
  }
  attach(cursor,send){
    this.out.checkCursor(cursor);this.ledger.acknowledge(cursor);this.out.attach(cursor,send);
  }
  ack(cursor){
    this.out.checkCursor(cursor);this.ledger.acknowledge(cursor);this.out.acknowledge(cursor);
  }
  receive(frame){
    this.input.accept(frame,value=>this.request(value));
    return this.input.cursor;
  }
  request(frame){
    if(frame.cancelRequest){
      const id=frame.cancelRequest,entry=this.ledger.requests.get(id);
      if(!entry||entry.cancelled||entry.responseSeq!==null)return;
      entry.cancelled=true;
      const discard=this.out.cancel(id);
      // The CANCELLED result retires the same ID even if the worker's
      // operation is non-interruptible and finishes after the terminal ACK.
      this.out.enqueue({id,error:{code:'CANCELLED',delivery:'unknown',message:'Response abandoned; operation outcome unknown'}},
        {discard,terminal:true,onSent:seq=>this.ledger.responded(id,seq)});
      try{this.sendWorker({cancelRequest:id});}
      catch(error){
        // Local worker pipe pressure can prevent cooperative cancellation.
        // The terminal still suppresses its late result; writes keep running.
        if(!['TRANSPORT_BACKPRESSURE','TRANSPORT_CLOSED'].includes(error.code))throw error;
      }
      return;
    }
    if(frame.id){
      const decision=frame.requestNo===undefined?'INVALID_REQUEST_NUMBER':this.ledger.accept(frame);
      if(decision==='duplicate')return;
      if(decision!=='accepted'){
        const delivery=['RETIRED_REQUEST','REQUEST_ID_CONFLICT'].includes(decision)?'unknown':'refused';
        this.out.enqueue({id:frame.id,error:{code:decision,message:'Relay refused the request: '+decision,delivery}},{terminal:true});
        return;
      }
      // Host consumes earlier turn events before acknowledging execute, and
      // destroys the session's output channel as soon as close is confirmed.
      if(frame.params?.sessionId&&['open','close','execute','commands-execute'].includes(frame.method))
        this.ledger.requests.get(frame.id).lane='session:'+frame.params.sessionId;
    }else if(!frame.controlId)throw transportError('INVALID_FRAME','Invalid client message');
    try{this.sendWorker(frame);}
    catch(error){
      if(!frame.id)throw error;
      this.output({id:frame.id,error:{code:error.code??'TRANSPORT_BACKPRESSURE',message:error.message}});
    }
  }
  output(value){
    if(value.id){
      const entry=this.ledger.requests.get(value.id);
      if(!entry||entry.cancelled||entry.responseSeq!==null||this.out.has(value.id))return;
      const options={key:value.id,lane:entry.lane,replyTo:value.id,onSent:seq=>this.ledger.responded(value.id,seq)};
      try{this.out.enqueue(value,options);}
      catch(error){
        if(!['TRANSPORT_CAPACITY','FRAME_TOO_LARGE'].includes(error.code))throw error;
        this.out.enqueue({id:value.id,error:{code:error.code,message:'Response exceeds available transport capacity; operation outcome unknown',delivery:'unknown'}},
          {...options,terminal:true});
      }
    }else{
      // Preserve controlNo and lifecycle/event order for each session while
      // allowing independent RPC replies and different sessions to interleave.
      const lane=value.controlId?'controls:'+value.sessionId:value.sessionId?'session:'+value.sessionId:undefined;
      this.out.enqueue(value,{lane});
    }
  }
}
