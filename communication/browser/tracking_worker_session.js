import {TrackingClient,snapshotAfter} from './tracking_client.js?v=20260911-epoch';
import {SnapshotEncoder,snapshotTransferables} from './snapshot_codec.js';

// One in-flight transferable frame plus one latest pending value. Encoding is
// delayed until send, so skipped states cannot corrupt metadata delta ordering.
export class TrackingWorkerSession {
  constructor({postMessage,WebSocketClass=globalThis.WebSocket,
    setTimer=globalThis.setTimeout.bind(globalThis),clearTimer=globalThis.clearTimeout.bind(globalThis)}) {
    Object.assign(this,{postMessage,WebSocketClass,setTimer,clearTimer});
    this.running=false;this.paused=false;this.generation=0;this.ticket=0;this.pending=null;this.inFlight=null;
  }
  handle(message) {
    if(message.type==='start')this.start(message);
    else if(message.type==='stop')this.stop();
    else if(message.type==='floor')this.setFloor(message);
    else if(message.type==='pause' && this.running)this.setPaused(message);
    else if(message.type==='ack' && this.running && message.ticket===this.inFlight) {
      this.inFlight=null;this.flush();
    }
  }
  start({url,epoch=0,sequence=-1,state_time=-Infinity,paused=false}) {
    this.stop();this.running=true;this.streamRevision=0;this.paused=Boolean(paused);this.encoder=new SnapshotEncoder();const generation=this.generation;
    this.client=new TrackingClient({url,WebSocketClass:this.WebSocketClass,setTimer:this.setTimer,clearTimer:this.clearTimer,
      onSnapshot:snapshot=>{if(this.running && generation===this.generation)this.offer(snapshot);},
      onReset:()=>{if(this.running && generation===this.generation){this.streamRevision++;this.pending=null;}},
      onStatus:(status,message)=>{if(this.running && generation===this.generation)this.postMessage({type:'status',status,message});}});
    this.setFloor({epoch,sequence,state_time});this.client.start();
  }
  setFloor({epoch=0,sequence,state_time,streamRevision=0}) {
    if(!this.client || !Number.isInteger(sequence) || streamRevision!==this.streamRevision)return;
    const floor={epoch,sequence,state_time};
    if(snapshotAfter(floor,this.client)) {
      this.client.epoch=epoch;this.client.sequence=sequence;this.client.stateTime=state_time;
    }
    if(this.pending && !snapshotAfter(this.pending,floor))this.pending=null;
  }
  offer(snapshot) {
    if(this.paused || this.inFlight!==null)this.pending=snapshot;
    else this.send(snapshot);
  }
  setPaused({paused,revision}) {
    this.paused=Boolean(paused);
    if(!this.paused) {
      // This confirmation precedes the latest frame. The main thread must not
      // replay an older already-ACKed frame before a newer pending state.
      const pending=this.pending;
      this.postMessage({type:'resumed',revision,streamRevision:this.streamRevision,pending:pending!==null,
        ...(pending?{epoch:pending.epoch??0,sequence:pending.sequence,state_time:pending.state_time}:{})});this.flush();
    }
  }
  flush() {
    if(this.paused || this.inFlight!==null)return;
    const pending=this.pending;this.pending=null;if(pending)this.send(pending);
  }
  send(snapshot) {
    const previousEntries=this.encoder.entries,previousHandle=this.encoder.nextHandle;
    try {
      const frame=this.encoder.encode(snapshot),ticket=++this.ticket;this.inFlight=ticket;
      this.postMessage({type:'snapshot',ticket,streamRevision:this.streamRevision,frame},snapshotTransferables(frame));
    } catch {
      // postMessage can fail before delivery as well as encoding can fail.
      // Roll back metadata, so the next frame cannot reference an unsent delta.
      this.encoder.entries=previousEntries;this.encoder.nextHandle=previousHandle;
      this.inFlight=null;this.postMessage({type:'status',status:'error',message:'수신 상태를 표시 형식으로 변환하지 못했습니다.'});
    }
  }
  stop() {
    this.running=false;this.generation++;this.client?.stop();this.client=null;
    this.pending=null;this.inFlight=null;this.encoder=null;this.paused=false;
  }
}
