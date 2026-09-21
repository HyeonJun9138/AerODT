import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraRangeMotion, cameraEase } from '../../../../digital_twin/visualization/web/camera_motion.js';
import { chooseLod, DisplaySamples, displayHeading, provenanceLabel } from '../../../../digital_twin/visualization/web/display_samples.js';
import { LoadingPhases, smoothProgress } from '../../../../user_application/web/loading.js';
import { TrackingClient } from '../../../../communication/browser/tracking_client.js';

test('camera eases monotonically, clamps dropped frames and reverses immediately', () => {
  let now = 0; const motion = new CameraRangeMotion({now: () => now});
  assert.equal(cameraEase(0), 0); assert.equal(cameraEase(1), 1);
  motion.moveTo(1000, 100); now = 10000;
  const next = motion.advance(1000); assert.ok(next < 1000 && next > 500);
  motion.wheel(next, -120); assert.ok(motion.target > next);
});
test('LOD hysteresis, selection priority and hidden objects', () => {
  assert.equal(chooseLod({distance: 45000, previous: 'model'}), 'model');
  assert.equal(chooseLod({distance: 45000, previous: 'point'}), 'point');
  assert.equal(chooseLod({distance: 90000, selected: true}), 'model');
  assert.equal(chooseLod({distance: 10, visible: false}), 'hidden');
});
const entity = (x, quality = 'valid') => ({entity_id:'a',position_ecef_m:[x,0,0],quality,state_time:100+x});
test('display interpolates only known samples, holds at the newest and removes absent entities', () => {
 const samples = new DisplaySamples();
 samples.replace({sequence:1,state_time:100,entities:[entity(0)]},0);
 samples.replace({sequence:2,state_time:101,entities:[entity(10)]},1000);
 assert.deepEqual(samples.positionAt('a',100.5),[5,0,0]);
 assert.deepEqual(samples.position('a',9000),[10,0,0]);
 assert.equal(samples.replace({sequence:1,state_time:100,entities:[]},1001),false);
 samples.replace({sequence:3,state_time:102,entities:[entity(20,'stale')]},2000);
 assert.deepEqual(samples.positionAt('a',102),[20,0,0]);
 samples.replace({sequence:4,state_time:103,entities:[]},3000);
 assert.equal(samples.entries.size,0);
});
test('failed loading stage is never counted as completed', () => {
 const phases = new LoadingPhases(['library','globe']);
 phases.complete('library'); assert.equal(phases.percent,50);
 phases.fail('globe','WebGL unavailable'); assert.equal(phases.ready,false);
 assert.equal(phases.percent,50); assert.equal(phases.error,'WebGL unavailable');
});
test('ground-track orientation is display-only and fixtures cannot be labelled live', () => {
 assert.equal(displayHeading({heading_deg:0,orientation_source:'ground_track'}),-Math.PI/2);
 assert.equal(displayHeading({heading_deg:0,orientation_source:'ground_track'},90),0);
 assert.equal(displayHeading({heading_deg:0,orientation_source:'ground_track'},NaN),-Math.PI/2);
 assert.equal(displayHeading({heading_deg:90,orientation_source:'unavailable'},0),0);
 assert.equal(displayHeading({heading_deg:90,orientation_source:'ground_track'}),0);
 assert.equal(displayHeading({heading_deg:90,orientation_source:'unavailable'}),0);
 assert.equal(provenanceLabel({provenance:'fixture'}),'시험 입력 (LIVE 아님)');
 assert.equal(provenanceLabel({provenance:'live'}),'실제 공급자');
});
test('transport reconnects once, drops old sequences and stops cleanly', () => {
 const sockets=[];const timers=[];const received=[];
 class Socket { constructor(){sockets.push(this);} close(){this.onclose?.();} }
 const client=new TrackingClient({url:'ws://example/ws/live',WebSocketClass:Socket,setTimer:fn=>(timers.push(fn),timers.length),clearTimer:()=>{},onSnapshot:s=>received.push(s)});
 client.start(); sockets[0].onopen();
 sockets[0].onmessage({data:JSON.stringify({schema_version:1,sequence:2,state_time:1,entities:[],sources:[]})});
 sockets[0].onmessage({data:JSON.stringify({schema_version:1,sequence:1,state_time:1,entities:[],sources:[]})});
 assert.equal(received.length,1);sockets[0].onclose();assert.equal(timers.length,1);
 timers[0]();assert.equal(sockets.length,2);client.stop();assert.equal(timers.length,1);
});
test('newer server epoch can restart sequence without freezing display', () => {
 const samples = new DisplaySamples();
 samples.replace({sequence:300,state_time:100,entities:[entity(0)]},0);
 assert.equal(samples.replace({sequence:1,state_time:200,entities:[entity(10)]},1000),true);
 const received=[];
 const client = new TrackingClient({url:'ws://example',onSnapshot:value=>received.push(value)});
 client.accept({schema_version:1,sequence:300,state_time:100,entities:[],sources:[]});
 client.accept({schema_version:1,sequence:1,state_time:200,entities:[],sources:[]});
 assert.equal(received.length,2);
});
test('authoritative discontinuity resets display without interpolation across correction', () => {
 const samples = new DisplaySamples();
 samples.replace({sequence:1,state_time:100,entities:[entity(0)]},0);
 samples.replace({sequence:2,state_time:101,entities:[{...entity(10000),discontinuity:true}]},1000);
 assert.deepEqual(samples.position('a',1001),[10000,0,0]);
});
test('an early new snapshot never moves the displayed position backwards',()=>{
 const samples=new DisplaySamples();samples.replace({sequence:1,state_time:100,entities:[entity(0)]},0);
 samples.replace({sequence:2,state_time:101,entities:[entity(10)]},1000);
 const shown=samples.position('a',1400)[0];
 samples.replace({sequence:3,state_time:101.5,entities:[entity(20)]},1500);
 assert.ok(samples.position('a',1500)[0]>=shown);
 assert.ok(samples.position('a',1600)[0]>=samples.position('a',1500)[0]);
});
test('loading weights report actual completed work and smooth progress never exceeds it',()=>{
 const loading=new LoadingPhases(['engine','assets'],{engine:80,assets:20});
 loading.complete('engine');loading.fail('assets','자산 수신 실패');assert.equal(loading.percent,80);assert.equal(loading.ready,false);
 const shown=smoothProgress(0,80,100);assert.ok(shown>0 && shown<80);assert.ok(smoothProgress(shown,80,100000)<=80);
});
test('apparent size promotes large nearby objects while small distant objects remain points',()=>{
 assert.equal(chooseLod({distance:100000,sizeM:1000,viewportHeight:720,fov:Math.PI/3}),'model');
 assert.equal(chooseLod({distance:100000,sizeM:1,viewportHeight:720,fov:Math.PI/3}),'point');
});
test('default browser reconnect timer preserves its global receiver',()=>{
 const original=globalThis.setTimeout;let called=false;
 globalThis.setTimeout=function(){assert.equal(this,globalThis);called=true;return 1;};
 try {
   class Socket{close(){}}
   const client=new TrackingClient({url:'ws://example',WebSocketClass:Socket,onSnapshot:()=>{}});
   client.start();client.socket.onclose();assert.equal(called,true);
 } finally {globalThis.setTimeout=original;}
});
test('persistent continuity id prevents smoothing across a skipped discontinuity snapshot',()=>{
 const samples=new DisplaySamples();samples.replace({sequence:1,state_time:1,entities:[{...entity(0),continuity_id:0}]},0);
 samples.replace({sequence:3,state_time:3,entities:[{...entity(10000),discontinuity:false,continuity_id:1}]},1000);
 assert.deepEqual(samples.position('a',1000),[10000,0,0]);
});

test('small vehicles do not promote to models solely because they are within 35 km',()=>{
 assert.equal(chooseLod({distance:30000,sizeM:37,viewportHeight:720,fov:Math.PI/3}),'point');
 assert.equal(chooseLod({distance:2000,sizeM:37,viewportHeight:720,fov:Math.PI/3}),'model');
});
test('display sample containers and interpolation buffers are reused without changing old snapshots',()=>{
 const samples=new DisplaySamples();const first=entity(0);
 samples.replace({sequence:1,state_time:1,entities:[first]},0);const sample=samples.entries.get('a');
 samples.replace({sequence:2,state_time:2,entities:[entity(10)]},1000);
 assert.equal(samples.entries.get('a'),sample);assert.deepEqual(first.position_ecef_m,[0,0,0]);
});

test('a clock the operator moved on purpose re-anchors instead of being refused', () => {
  // Replaying a scheduled day puts the twin on another date, and closing the
  // console brings it back. Both are earlier-or-later on purpose: refusing them
  // as clock drift would leave the map frozen on whichever day it saw last.
  const samples = new DisplaySamples();
  samples.replace({sequence: 1, state_time: 1_757_000_000, entities: [entity(0)]}, 0);
  samples.replace({sequence: 2, state_time: 1_757_000_001, entities: [entity(10)]}, 1000);
  // Without a new epoch an older instant is drift, and stays refused.
  assert.equal(samples.replace({sequence: 3, state_time: 1_757_000_000.5, entities: [entity(20)]}, 2000), false);
  // With one it is accepted, however far away it is.
  assert.equal(samples.replace({sequence: 4, state_time: 1_791_581_400, epoch: 1, entities: [entity(30)]}, 3000), true);
  assert.deepEqual(samples.positionAt('a', 1_791_581_400), [30, 0, 0]);
  assert.equal(samples.epoch, 1);
  // Nothing is swept across the jump: the sample starts again at the new time.
  assert.deepEqual(samples.positionAt('a', 1_791_581_399), [30, 0, 0]);
  // And coming back to the live clock is another move, not a refusal.
  assert.equal(samples.replace({sequence: 5, state_time: 1_757_000_100, epoch: 2, entities: [entity(40)]}, 4000), true);
  assert.deepEqual(samples.position('a', 9000), [40, 0, 0]);
  assert.equal(samples.epoch, 2);
  // Inside the new run the old rule holds again.
  assert.equal(samples.replace({sequence: 6, state_time: 1_757_000_099, epoch: 2, entities: [entity(50)]}, 5000), false);
});
