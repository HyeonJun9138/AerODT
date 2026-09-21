import test from 'node:test';
import assert from 'node:assert/strict';

import * as codec from '../../../../communication/browser/snapshot_codec.js';
import * as sessions from '../../../../communication/browser/tracking_worker_session.js';
import * as clients from '../../../../communication/browser/worker_tracking_client.js';
import {TrackingClient} from '../../../../communication/browser/tracking_client.js';
const entity = (id='a', changes={}) => ({entity_id:id,name:'Test aircraft',kind:'aircraft',
  position_ecef_m:[6378137.125,-3.5,19.125],velocity_ecef_mps:[0,123.125,-4.75],
  latitude_deg:1.234567890123,longitude_deg:126.876543210987,altitude_m:12345.678901,
  heading_deg:359.25,state_time:1234.5,observation_time:1234,received_time:1234.25,
  orbit_epoch:null,derivation:'constant_velocity',quality:'valid',source:'test',
  model_id:'aircraft',visual_asset_id:'plane',provenance:'fixture',
  orientation_source:'ground_track',valid_until:1240,discontinuity:false,continuity_id:0,...changes});
const snapshot = (sequence=1,entities=[entity()],state_time=1000+sequence) => ({schema_version:1,sequence,state_time,
  entities,sources:[{id:'test',status:'ready',updated_at:1000,message:''}],capabilities:{environment:false}});
const era=(epoch,sequence,time)=>({...snapshot(sequence,[entity('uam',{kind:'uam',source:'scenario'})],time),epoch});

test('both transport gates accept a new simulation epoch at an earlier time, never an old-epoch replay',()=>{
  for(const Client of [TrackingClient,clients.WorkerTrackingClient]){
    const received=[],client=new Client({url:'ws://local',onSnapshot:s=>received.push(s)});
    const live=era(2,100,18000),start=era(3,101,1000),next=era(3,102,1001),reset=era(4,103,900);
    for(const s of [live,start,era(2,104,19000),start,next,reset])client.accept(s);
    assert.deepEqual(received,[live,start,next,reset],Client.name);
  }
});
test('worker floor and paused pending queue compare epochs before timestamps',()=>{
  const {session,sockets,frames}=makeSession();
  session.handle({type:'floor',epoch:2,sequence:100,state_time:18000});
  sockets[0].receive(era(3,101,1000));assert.equal(frames().length,1);
  sockets[0].receive(era(3,102,1001));assert.equal(session.pending.epoch,3);
  session.handle({type:'floor',epoch:2,sequence:999,state_time:19000});
  assert.equal(session.pending.epoch,3,'late HTTP floor cannot erase the simulation');
  session.handle({type:'ack',ticket:frames()[0].ticket});assert.equal(frames().length,2);
  session.handle({type:'pause',paused:true,revision:1});sockets[0].receive(era(4,103,900));
  session.handle({type:'floor',epoch:5,sequence:104,state_time:800});
  assert.equal(session.pending,null,'newer rebase overtakes pending even at lower time');session.stop();
});
test('facade forwards the epoch to worker startup, floor and fallback',()=>{
  const {client,workers,sockets,received}=makeClient();client.accept(era(4,100,18000));client.start();
  assert.equal(workers[0].messages[0].epoch,4);
  client.accept(era(5,101,1000));assert.equal(workers[0].messages.at(-1).epoch,5);
  workers[0].onerror({preventDefault(){}});assert.equal(client.fallback.epoch,5);
  sockets[0].onmessage({data:JSON.stringify(era(5,101,1000))});
  sockets[0].onmessage({data:JSON.stringify(era(4,102,19000))});assert.equal(received.length,2);
  sockets[0].onmessage({data:JSON.stringify(era(6,103,900))});assert.equal(received.at(-1).epoch,6);client.stop();
});
test('resume confirmation for an obsolete epoch does not strand a newer HTTP rebase',()=>{
  const {client,workers,received}=makeClient();client.accept(era(2,100,18000));client.start();
  client.setPaused(true);client.setPaused(false);client.accept(era(4,102,900));
  workers[0].receive({type:'resumed',revision:client.pauseRevision,pending:true,epoch:3,sequence:101,state_time:1000});
  assert.equal(received.at(-1).epoch,4);client.stop();
});
test('a new socket after server restart accepts reset epoch while late old-socket messages are ignored',()=>{
  const sockets=[],timers=[],received=[];
  class Socket {constructor(){sockets.push(this);}close(){this.onclose?.();}receive(s){this.onmessage({data:JSON.stringify(s)});}}
  const client=new clients.WorkerTrackingClient({url:'ws://local',WorkerClass:null,WebSocketClass:Socket,
    setTimer:fn=>timers.push(fn),clearTimer:()=>{},onSnapshot:s=>received.push(s)});
  client.start();sockets[0].receive(era(5,100,18000));sockets[0].close();timers.shift()();
  sockets[1].receive(era(0,101,19000));sockets[0].receive(era(6,102,20000));sockets[1].receive(era(0,102,19001));
  assert.deepEqual(received.map(s=>[s.epoch,s.sequence]),[[5,100],[0,101],[0,102]]);client.stop();
});
test('worker restart stream supersedes old floor messages and resets facade acceptance exactly once',()=>{
  const sockets=[],timers=[],messages=[];
  class Socket {constructor(){sockets.push(this);}close(){this.onclose?.();}receive(s){this.onmessage({data:JSON.stringify(s)});}}
  const session=new sessions.TrackingWorkerSession({WebSocketClass:Socket,setTimer:fn=>timers.push(fn),clearTimer:()=>{},postMessage:m=>messages.push(m)});
  session.start({url:'ws://local'});sockets[0].receive(era(5,100,18000));
  const first=messages.find(m=>m.type==='snapshot');session.handle({type:'ack',ticket:first.ticket});
  sockets[0].close();timers.shift()();sockets[1].receive(era(0,1,19000));
  session.handle({type:'floor',epoch:5,sequence:100,state_time:18000,streamRevision:0});
  assert.equal(session.client.epoch,0);
  const {client,workers,received}=makeClient();client.start();
  for(const message of messages.filter(m=>m.type==='snapshot'))workers[0].receive(message);
  assert.deepEqual(received.map(s=>s.epoch),[5,0]);
  assert.equal(workers[0].messages.findLast(m=>m.type==='floor').streamRevision,1);
  client.stop();session.stop();
});
function makeCodec() {
  assert.equal(typeof codec.SnapshotEncoder,'function','SnapshotEncoder is not implemented');
  assert.equal(typeof codec.SnapshotDecoder,'function','SnapshotDecoder is not implemented');
  return {encoder:new codec.SnapshotEncoder(),decoder:new codec.SnapshotDecoder()};
}

test('native attitude and actuator telemetry survive worker transport and updates',()=>{
 const {encoder,decoder}=makeCodec();
 const sample=entity('uam',{source:'scenario',kind:'uam',orientation_source:'attitude',
   pitch_deg:8.3,roll_deg:-4.2,tilt_deg:74,rotor_radps:315,flight_phase:'cruise'});
 assert.deepEqual(decoder.decode(encoder.encode(snapshot(1,[sample]))).entities[0],sample);
 const next={...sample,tilt_deg:0,rotor_radps:230,flight_phase:'descent'};
 assert.deepEqual(decoder.decode(encoder.encode(snapshot(2,[next]))).entities[0],next);
});

test('optional deck references round-trip on the fast path and unchanged references stay cached',()=>{
 const {encoder,decoder}=makeCodec();
 const full=entity('uam',{visual_match:'representative',pitch_deg:0,roll_deg:0,tilt_deg:0,rotor_radps:0,flight_phase:'parked'});
 for(const [i,surface_reference] of [undefined,null,{vertiport_id:'VP012',altitude_m:93.96865063033704},
   {vertiport_id:'VP012',altitude_m:93.96865063033704},{vertiport_id:'VP002',altitude_m:44}].entries()){
   const e=surface_reference===undefined?full:{...full,surface_reference};
   const frame=encoder.encode(snapshot(i+1,[e]));
   assert.equal(frame.complete,true,'new datum must not de-optimize every aircraft/satellite in the frame');
   assert.deepEqual(decoder.decode(frame).entities[0],e);
   if(i===3)assert.equal(frame.metadata.length,0,'an unchanged physical deck is not sent each frame');
 }
});

test('transfer codec round-trips every TwinEntity field without numerical precision loss',()=>{
  const {encoder,decoder}=makeCodec();const original=snapshot(1,[entity('a',{velocity_ecef_mps:[-0,123.125,-4.75]}),entity('b',{velocity_ecef_mps:null,heading_deg:null,observation_time:null,valid_until:null})]);
  const frame=encoder.encode(original);
  assert.ok(frame.values instanceof Float64Array);assert.ok(frame.handles instanceof Uint32Array);
  const moved=structuredClone(frame,{transfer:codec.snapshotTransferables(frame)});
  assert.equal(frame.values.byteLength,0);assert.equal(frame.handles.byteLength,0);
  assert.deepEqual(decoder.decode(moved),original);
});
test('unchanged metadata is omitted, changes are delivered, deletion removes transport metadata',()=>{
  const {encoder,decoder}=makeCodec();decoder.decode(encoder.encode(snapshot(1,[entity(),entity('b')])));
  const update=encoder.encode(snapshot(2,[entity('b',{altitude_m:800}),entity('a',{name:'New name',quality:'stale',discontinuity:true,continuity_id:1})]));
  assert.equal(update.metadata.length,1);assert.deepEqual(decoder.decode(update),snapshot(2,[entity('b',{altitude_m:800}),entity('a',{name:'New name',quality:'stale',discontinuity:true,continuity_id:1})]));
  const next=encoder.encode(snapshot(3,[entity('b',{altitude_m:900})]));assert.equal(next.metadata.length,0);assert.equal(next.removed.length,1);
  assert.deepEqual(decoder.decode(next),snapshot(3,[entity('b',{altitude_m:900})]));assert.equal(decoder.metadata.size,1);assert.equal(encoder.entries.size,1);
  const readded=encoder.encode(snapshot(4,[entity('a'),entity('b')]));assert.equal(readded.metadata.length,1);assert.deepEqual(decoder.decode(readded),snapshot(4,[entity('a'),entity('b')]));
});
test('decoder never mutates a prior entity or coordinate array across continuity changes',()=>{
  const {encoder,decoder}=makeCodec();const first=decoder.decode(encoder.encode(snapshot()));const saved=structuredClone(first);
  const next=decoder.decode(encoder.encode(snapshot(2,[entity('a',{position_ecef_m:[1,2,3],continuity_id:7})])));
  assert.notEqual(first.entities[0],next.entities[0]);assert.notEqual(first.entities[0].position_ecef_m,next.entities[0].position_ecef_m);
  assert.notEqual(first.entities[0].velocity_ecef_mps,next.entities[0].velocity_ecef_mps);assert.deepEqual(first,saved);
});
test('codec preserves absent optional fields, null vectors and extra metadata without conflating them',()=>{
  const {encoder,decoder}=makeCodec();const original=snapshot(1,[{entity_id:'s',kind:'satellite',position_ecef_m:[1,2,3],quality:'stale',extra:{note:'test'}},entity('null',{velocity_ecef_mps:null,heading_deg:null})]);
  assert.deepEqual(decoder.decode(encoder.encode(original)),original);
});
test('decoder rejects missing metadata instead of constructing a misleading entity',()=>{
  const {encoder,decoder}=makeCodec();const frame=encoder.encode(snapshot());frame.metadata=[];
  assert.throws(()=>decoder.decode(frame),/metadata/i);
});
test('invalid encoding cannot commit metadata which the decoder has never received',()=>{
  const {encoder,decoder}=makeCodec();decoder.decode(encoder.encode(snapshot()));
  assert.throws(()=>encoder.encode(snapshot(2,[entity('b'),entity('bad',{position_ecef_m:[NaN,1,2]})])),/numeric/);
  const next=encoder.encode(snapshot(3,[entity('b')]));assert.equal(next.metadata.length,1);assert.deepEqual(decoder.decode(next),snapshot(3,[entity('b')]));
  assert.throws(()=>encoder.encode(snapshot(4,[entity('b'),entity('b')])),/duplicate/);
});
test('empty snapshots evict the entire encoder and decoder transport cache',()=>{
  const {encoder,decoder}=makeCodec();decoder.decode(encoder.encode(snapshot()));
  assert.deepEqual(decoder.decode(encoder.encode(snapshot(2,[]))),snapshot(2,[]));
  assert.equal(encoder.entries.size,0);assert.equal(decoder.metadata.size,0);
});

function makeSession() {
  assert.equal(typeof sessions.TrackingWorkerSession,'function','TrackingWorkerSession is not implemented');
  const sockets=[],messages=[],timers=[];
  class Socket {constructor(){sockets.push(this);} close(){this.onclose?.();} receive(value){this.onmessage?.({data:JSON.stringify(value)});} }
  const session=new sessions.TrackingWorkerSession({postMessage:(message,transfer)=>messages.push(structuredClone(message,{transfer:transfer??[]})),
    WebSocketClass:Socket,setTimer:fn=>(timers.push(fn),timers.length),clearTimer:()=>{}});
  session.handle({type:'start',url:'ws://local/ws/live',sequence:-1,state_time:-Infinity});
  return {session,sockets,messages,timers,frames:()=>messages.filter(message=>message.type==='snapshot')};
}
test('worker backpressure holds one sent frame and only the newest pending snapshot until ACK',()=>{
  const {session,sockets,frames}=makeSession();sockets[0].receive(snapshot(1));sockets[0].receive(snapshot(2,[entity('b')]));sockets[0].receive(snapshot(3,[entity('c')]));
  assert.equal(frames().length,1);assert.equal(session.pending.sequence,3);
  session.handle({type:'ack',ticket:frames()[0].ticket});assert.equal(frames().length,2);assert.equal(frames()[1].frame.header.sequence,3);
  const {decoder}=makeCodec();decoder.decode(frames()[0].frame);assert.deepEqual(decoder.decode(frames()[1].frame),snapshot(3,[entity('c')]));
  session.handle({type:'ack',ticket:frames()[1].ticket});assert.equal(session.pending,null);assert.equal(session.inFlight,null);
});
test('worker ignores obsolete ACK and drops snapshots older than the initial HTTP floor',()=>{
  const {session,sockets,frames}=makeSession();session.handle({type:'floor',sequence:5,state_time:1005});
  sockets[0].receive(snapshot(4));assert.equal(frames().length,0);
  sockets[0].receive(snapshot(6));sockets[0].receive(snapshot(7));session.handle({type:'ack',ticket:999});assert.equal(frames().length,1);
  session.handle({type:'ack',ticket:frames()[0].ticket});assert.equal(frames().length,2);
});
test('worker reconnects once, accepts a newer server epoch and stops pending or late responses',()=>{
  const {session,sockets,frames,timers}=makeSession();sockets[0].receive(snapshot(300,[entity()],1000));session.handle({type:'ack',ticket:frames()[0].ticket});
  sockets[0].onclose();assert.equal(timers.length,1);timers[0]();assert.equal(sockets.length,2);
  sockets[1].receive(snapshot(1,[entity()],2000));assert.equal(frames().length,2);
  sockets[1].receive(snapshot(2,[entity()],2001));session.handle({type:'stop'});sockets[1].receive(snapshot(3,[entity()],2002));
  session.handle({type:'ack',ticket:frames()[1].ticket});assert.equal(frames().length,2);assert.equal(session.pending,null);
});
test('a newer HTTP floor discards pending display states without losing acknowledged metadata',()=>{
  const {session,sockets,frames}=makeSession();sockets[0].receive(snapshot(1));sockets[0].receive(snapshot(2,[entity('b')]));
  session.handle({type:'floor',sequence:4,state_time:1004});assert.equal(session.pending,null);
  session.handle({type:'ack',ticket:frames()[0].ticket});assert.equal(frames().length,1);
  sockets[0].receive(snapshot(5,[entity('b')]));assert.equal(frames().length,2);
  const {decoder}=makeCodec();decoder.decode(frames()[0].frame);assert.deepEqual(decoder.decode(frames()[1].frame),snapshot(5,[entity('b')]));
});
test('malformed wire input reports an error and a later valid message still arrives',()=>{
  const {sockets,messages,frames}=makeSession();sockets[0].onmessage({data:'{bad'});
  assert.ok(messages.some(message=>message.type==='status' && message.status==='error'));
  sockets[0].receive(snapshot());assert.equal(frames().length,1);
});

function makeClient(override={}) {
  assert.equal(typeof clients.WorkerTrackingClient,'function','WorkerTrackingClient is not implemented');
  const workers=[],received=[],statuses=[],sockets=[];
  class Worker {constructor(url,options){this.url=url;this.options=options;this.messages=[];workers.push(this);}postMessage(value){this.messages.push(value);}terminate(){this.terminated=true;}receive(value){this.onmessage?.({data:value});}}
  class Socket {constructor(){sockets.push(this);}close(){this.onclose?.();}}
  const client=new clients.WorkerTrackingClient({url:'ws://local/ws/live',WorkerClass:Worker,WebSocketClass:Socket,onSnapshot:s=>received.push(s),onStatus:(...s)=>statuses.push(s),...override});
  return {client,workers,received,statuses,sockets};
}
test('facade accepts HTTP snapshot, passes its floor into the worker and ACKs decoded frames',()=>{
  const {client,workers,received}=makeClient();client.accept(snapshot(5));client.start();
  assert.equal(received.length,1);assert.equal(workers[0].options.type,'module');assert.equal(workers[0].messages[0].sequence,5);
  const {encoder}=makeCodec();workers[0].receive({type:'snapshot',ticket:1,frame:encoder.encode(snapshot(6))});
  assert.deepEqual(received[1],snapshot(6));assert.deepEqual(workers[0].messages.at(-1),{type:'ack',ticket:1});
  assert.ok(client.metrics.decodeMs>=0);client.stop();assert.equal(workers[0].terminated,true);
});
test('facade consumes obsolete frame metadata but never emits an older snapshot',()=>{
  const {client,workers,received}=makeClient();client.accept(snapshot(5));client.start();const {encoder}=makeCodec();
  workers[0].receive({type:'snapshot',ticket:1,frame:encoder.encode(snapshot(4))});assert.equal(received.length,1);
  workers[0].receive({type:'snapshot',ticket:2,frame:encoder.encode(snapshot(6))});assert.deepEqual(received.at(-1),snapshot(6));
});
test('stopped or replaced workers cannot deliver stale callbacks and restart uses fresh metadata',()=>{
  const {client,workers,received}=makeClient();client.start();const oldHandler=workers[0].onmessage;client.stop();client.start();
  const {encoder}=makeCodec();oldHandler({data:{type:'snapshot',ticket:1,frame:encoder.encode(snapshot())}});assert.equal(received.length,0);
  const fresh=makeCodec().encoder;workers[1].receive({type:'snapshot',ticket:1,frame:fresh.encode(snapshot(2))});assert.deepEqual(received,[snapshot(2)]);
});
test('missing Worker support explicitly falls back to the existing transport API',()=>{
  const {client,statuses,sockets,received}=makeClient({WorkerClass:null});client.accept(snapshot(5));client.start();
  assert.ok(statuses.some(([status])=>status==='fallback'));assert.equal(client.transportMode,'main-thread-fallback');assert.equal(sockets.length,1);
  sockets[0].onmessage({data:JSON.stringify(snapshot(4))});assert.equal(received.length,1);
  sockets[0].onmessage({data:JSON.stringify(snapshot(6))});assert.deepEqual(received.at(-1),snapshot(6));
  const receive=sockets[0].onmessage;client.stop();receive({data:JSON.stringify(snapshot(7))});assert.equal(received.length,2);
});
test('worker startup failure terminates it and creates only one fallback connection',()=>{
  const {client,workers,sockets,statuses}=makeClient();client.start();const fail=workers[0].onerror;fail({preventDefault(){}});fail({preventDefault(){}});
  assert.equal(workers[0].terminated,true);assert.equal(sockets.length,1);assert.ok(statuses.some(([status])=>status==='fallback'));client.stop();
});
test('synchronous module worker constructor failure also uses the declared fallback',()=>{
  class FailingWorker {constructor(){throw new Error('Worker disabled');}}
  const {client,sockets,statuses}=makeClient({WorkerClass:FailingWorker});client.start();
  assert.equal(sockets.length,1);assert.ok(statuses.some(([status])=>status==='fallback'));client.stop();
});
test('start and stop remain idempotent without additional WebSocket or Worker creation',()=>{
  const {client,workers}=makeClient();client.start();client.start();assert.equal(workers.length,1);
  client.stop();client.stop();assert.equal(workers[0].terminated,true);assert.equal(client.running,false);
});

test('paused worker keeps receiving only the newest pending state without sending frames or reconnecting',()=>{
  const {session,sockets,frames,messages}=makeSession();sockets[0].receive(snapshot(1));
  session.handle({type:'pause',paused:true,revision:1});sockets[0].receive(snapshot(2));sockets[0].receive(snapshot(3,[entity('c')]));
  session.handle({type:'ack',ticket:frames()[0].ticket});assert.equal(frames().length,1);assert.equal(session.pending.sequence,3);assert.equal(sockets.length,1);
  session.handle({type:'pause',paused:false,revision:2});assert.equal(frames().length,2);
  const resumed=messages.findIndex(message=>message.type==='resumed');assert.ok(resumed<messages.indexOf(frames()[1]));
  assert.deepEqual(messages[resumed],{type:'resumed',revision:2,streamRevision:0,pending:true,epoch:0,sequence:3,state_time:1003});assert.equal(frames()[1].frame.header.sequence,3);
});
test('facade pauses callbacks and resumes only the latest worker state rather than replaying the in-flight state',()=>{
  const {client,workers,received}=makeClient();assert.equal(typeof client.setPaused,'function');client.accept(snapshot());client.start();client.setPaused(true);
  const {encoder}=makeCodec();workers[0].receive({type:'snapshot',ticket:1,frame:encoder.encode(snapshot(2))});assert.equal(received.length,1);
  client.setPaused(false);workers[0].receive({type:'resumed',revision:client.pauseRevision,pending:true});assert.equal(received.length,1);
  workers[0].receive({type:'snapshot',ticket:2,frame:encoder.encode(snapshot(3,[entity('c')]))});assert.deepEqual(received,[snapshot(),snapshot(3,[entity('c')])]);
});
test('resume emits a retained in-flight state when the worker has no newer pending state',()=>{
  const {client,workers,received}=makeClient();assert.equal(typeof client.setPaused,'function');client.start();client.setPaused(true);const {encoder}=makeCodec();
  workers[0].receive({type:'snapshot',ticket:1,frame:encoder.encode(snapshot(2))});client.setPaused(false);
  workers[0].receive({type:'resumed',revision:client.pauseRevision,pending:false});assert.deepEqual(received,[snapshot(2)]);
});
test('fallback pauses only delivery, retains the newest snapshot and keeps its socket',()=>{
  const {client,sockets,received}=makeClient({WorkerClass:null});assert.equal(typeof client.setPaused,'function');client.start();client.setPaused(true);
  for(let sequence=1;sequence<=3;sequence++)sockets[0].onmessage({data:JSON.stringify(snapshot(sequence))});
  assert.equal(received.length,0);assert.equal(sockets.length,1);client.setPaused(false);assert.deepEqual(received,[snapshot(3)]);assert.equal(sockets.length,1);client.stop();
});
test('pause before start is sent to the worker and old resume confirmations cannot unpause a newer cycle',()=>{
  const {client,workers,received}=makeClient();assert.equal(typeof client.setPaused,'function');client.setPaused(true);client.start();assert.equal(workers[0].messages[0].paused,true);
  client.accept(snapshot(2));client.setPaused(false);const old=client.pauseRevision;client.setPaused(true);client.setPaused(false);
  workers[0].receive({type:'resumed',revision:old,pending:false});assert.equal(received.length,0);
  workers[0].receive({type:'resumed',revision:client.pauseRevision,pending:false});assert.deepEqual(received,[snapshot(2)]);
});
test('a newer HTTP snapshot during resume cannot be lost to an older pending worker frame',()=>{
  const {client,workers,received}=makeClient();assert.equal(typeof client.setPaused,'function');client.accept(snapshot(5));client.start();client.setPaused(true);const {encoder}=makeCodec();
  workers[0].receive({type:'snapshot',ticket:1,frame:encoder.encode(snapshot(6))});client.setPaused(false);client.accept(snapshot(10));
  workers[0].receive({type:'resumed',revision:client.pauseRevision,pending:true});workers[0].receive({type:'snapshot',ticket:2,frame:encoder.encode(snapshot(7))});
  assert.deepEqual(received,[snapshot(5),snapshot(10)]);
});
test('resume delivers the HTTP floor even when it removes the promised worker pending frame before ACK',()=>{
  const toWorker=[],toMain=[],sockets=[],received=[];let bridge;
  class Socket {constructor(){sockets.push(this);}close(){this.onclose?.();}receive(value){this.onmessage({data:JSON.stringify(value)});}}
  class Worker {
    constructor(){bridge=this;this.session=new sessions.TrackingWorkerSession({WebSocketClass:Socket,postMessage:(message,transfer)=>toMain.push(structuredClone(message,{transfer:transfer??[]}))});}
    postMessage(message){toWorker.push(message);}terminate(){this.session.stop();}
  }
  const client=new clients.WorkerTrackingClient({url:'ws://local',WorkerClass:Worker,onSnapshot:s=>received.push(s)});
  client.accept(snapshot(5));client.start();while(toWorker.length)bridge.session.handle(toWorker.shift());
  sockets[0].receive(snapshot(6));sockets[0].receive(snapshot(7));client.setPaused(true);client.setPaused(false);client.accept(snapshot(10));
  while(toWorker.length || toMain.length) {
    while(toWorker.length)bridge.session.handle(toWorker.shift());
    while(toMain.length)bridge.onmessage({data:toMain.shift()});
  }
  assert.equal(bridge.session.pending,null);assert.equal(bridge.session.inFlight,null);assert.deepEqual(received,[snapshot(5),snapshot(10)]);client.stop();
});
test('decoder cache failure falls back instead of ACKing an unrecoverable metadata gap forever',()=>{
  const {client,workers,sockets,received,statuses}=makeClient();client.start();const {encoder}=makeCodec();const frame=encoder.encode(snapshot());frame.metadata=[];
  workers[0].receive({type:'snapshot',ticket:1,frame});assert.equal(client.transportMode,'main-thread-fallback');assert.equal(workers[0].terminated,true);
  assert.ok(statuses.some(([status])=>status==='fallback'));sockets[0].onmessage({data:JSON.stringify(snapshot(2))});assert.deepEqual(received,[snapshot(2)]);client.stop();
});
test('failed transferable post does not commit metadata that never reached the main thread',()=>{
  const sockets=[],messages=[];let fail=true;
  class Socket {constructor(){sockets.push(this);}close(){this.onclose?.();}receive(value){this.onmessage({data:JSON.stringify(value)});}}
  const session=new sessions.TrackingWorkerSession({WebSocketClass:Socket,postMessage:(message,transfer)=>{
    if(message.type==='snapshot' && fail){fail=false;throw new Error('Injected post failure');}
    messages.push(structuredClone(message,{transfer:transfer??[]}));
  }});
  session.handle({type:'start',url:'ws://local'});sockets[0].receive(snapshot());sockets[0].receive(snapshot(2));
  const delivered=messages.filter(message=>message.type==='snapshot');assert.equal(delivered.length,1);
  assert.deepEqual(makeCodec().decoder.decode(delivered[0].frame),snapshot(2));session.stop();
});
