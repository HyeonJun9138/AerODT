import {TrackingClient,validateSnapshot,snapshotAfter} from './tracking_client.js?v=20260911-epoch';
import {SnapshotDecoder} from './snapshot_codec.js';

// Compatibility facade for the existing dashboard. Only transport decoding is
// moved to a worker; every emitted value remains the unchanged server snapshot.
export class WorkerTrackingClient {
  constructor(options) {
    this.options=options;this.url=options.url;this.onSnapshot=options.onSnapshot;this.onStatus=options.onStatus??(()=>{});
    this.WorkerClass=Object.hasOwn(options,'WorkerClass')?options.WorkerClass:globalThis.Worker;
    this.workerUrl=options.workerUrl??new URL('./tracking_worker.js?v=20260911-epoch',import.meta.url);
    this.epoch=0;this.streamRevision=0;this.sequence=-1;this.stateTime=-Infinity;this.running=false;this.worker=null;this.fallback=null;
    this.paused=false;this.resuming=false;this.pauseRevision=0;this.pendingSnapshot=null;
    this.transportMode='idle';this.metrics={decodeMs:0,entities:0};
  }
  accept(snapshot) {
    if(!validateSnapshot(snapshot)){this.onStatus('error','잘못된 snapshot');return;}
    if(!snapshotAfter(snapshot,this))return;
    this.epoch=snapshot.epoch??0;this.sequence=snapshot.sequence;this.stateTime=snapshot.state_time;
    if(this.paused || this.resuming)this.pendingSnapshot=snapshot;
    else {this.pendingSnapshot=null;this.onSnapshot(snapshot);}
    if(this.worker)this.worker.postMessage({type:'floor',epoch:this.epoch,sequence:this.sequence,state_time:this.stateTime,streamRevision:this.streamRevision});
  }
  setPaused(paused) {
    paused=Boolean(paused);if(paused===this.paused)return;
    this.paused=paused;this.resuming=!paused && this.worker!==null;this.pauseRevision++;
    if(this.worker)this.worker.postMessage({type:'pause',paused,revision:this.pauseRevision});
    else this.flushPending();
  }
  flushPending() {
    if(this.paused || this.resuming || !this.pendingSnapshot)return;
    const snapshot=this.pendingSnapshot;this.pendingSnapshot=null;this.onSnapshot(snapshot);
  }
  start() {
    if(this.running)return;this.running=true;this.streamRevision=0;this.decoder=new SnapshotDecoder();
    if(typeof this.WorkerClass!=='function'){this.startFallback();return;}
    try {
      const worker=this.worker=new this.WorkerClass(this.workerUrl,{type:'module',name:'AeroDT tracking'});
      this.transportMode='worker';
      worker.onmessage=event=>{
        if(!this.running || this.worker!==worker)return;
        const message=event.data;
        if(message.type==='status'){this.onStatus(message.status,message.message);return;}
        if(message.type==='resumed') {
          if(message.revision===this.pauseRevision && !this.paused) {
            const queued=this.pendingSnapshot;
            const overtaken=(message.streamRevision??0)===this.streamRevision && queued && Number.isFinite(message.state_time) &&
              !snapshotAfter(message,queued);
            // A later HTTP floor can erase the worker's pending frame after its
            // confirmation. Do not wait forever for that older promised frame.
            this.resuming=false;if(!message.pending || overtaken)this.flushPending();
          }
          return;
        }
        if(message.type!=='snapshot')return;
        let decoded=false;
        try {
          const started=performance.now(),snapshot=this.decoder.decode(message.frame);
          decoded=true;
          this.metrics={decodeMs:performance.now()-started,entities:snapshot.entities.length};
          const revision=message.streamRevision??0;
          if(revision<this.streamRevision)return;
          if(revision>this.streamRevision){this.streamRevision=revision;this.resetFloor();}
          this.accept(snapshot);
          // A newer HTTP value may have overtaken this pending worker frame.
          // Keep that value rather than losing it when the older frame drops.
          this.flushPending();
        } catch {
          this.onStatus('error','수신 상태를 복원하지 못했습니다. 마지막 위치를 유지합니다.');
          // Continuing to ACK a broken metadata cache would make unchanged
          // future deltas undecodable forever. Use the declared safe fallback.
          if(!decoded)this.startFallback();
        }
        finally {if(this.running && this.worker===worker)worker.postMessage({type:'ack',ticket:message.ticket});}
      };
      worker.onerror=event=>{
        event.preventDefault?.();if(this.running && this.worker===worker)this.startFallback();
      };
      worker.onmessageerror=()=>{if(this.running && this.worker===worker)this.startFallback();};
      worker.postMessage({type:'start',url:this.url,epoch:this.epoch,sequence:this.sequence,state_time:this.stateTime,paused:this.paused});
    } catch {this.startFallback();}
  }
  startFallback() {
    if(!this.running || this.fallback)return;
    this.worker?.terminate();this.worker=null;this.decoder=null;this.transportMode='main-thread-fallback';
    this.resuming=false;this.flushPending();
    this.onStatus('fallback','Web Worker를 사용할 수 없어 기본 연결로 전환합니다. 상태 수신 때 화면이 잠시 지연될 수 있습니다.');
    const client=this.fallback=new TrackingClient({...this.options,
      onReset:()=>{if(this.running && this.fallback===client)this.resetFloor();},
      onSnapshot:snapshot=>{if(this.running && this.fallback===client)this.accept(snapshot);},
      onStatus:(status,message)=>{if(this.running && this.fallback===client)this.onStatus(status,message);}});
    client.epoch=this.epoch;client.sequence=this.sequence;client.stateTime=this.stateTime;client.start();
  }
  resetFloor() {this.epoch=0;this.sequence=-1;this.stateTime=-Infinity;this.pendingSnapshot=null;}
  stop() {
    this.running=false;
    if(this.worker){this.worker.postMessage({type:'stop'});this.worker.terminate();this.worker=null;}
    this.fallback?.stop();this.fallback=null;this.decoder=null;this.transportMode='idle';
    this.pendingSnapshot=null;this.resuming=false;
  }
}
