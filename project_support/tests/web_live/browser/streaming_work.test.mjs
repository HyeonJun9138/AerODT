import test from 'node:test';
import assert from 'node:assert/strict';
import {EntityScene,MODEL_PREPARATION_TIMEOUT_MS} from '../../../../digital_twin/visualization/web/entity_scene.js';
import {yieldTerrainWork} from '../../../../digital_twin/visualization/web/terrain_work_yield.js';

const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function event() {
  const listeners=new Set();
  return {listeners,addEventListener(fn){listeners.add(fn);return ()=>listeners.delete(fn);},
    raise(){for(const fn of [...listeners])fn();}};
}
function fixture(t,{load}={}) {
  const calls=[],models=[];
  const makeModel=()=>({ready:false,readyEvent:event(),errorEvent:event(),destroy(){this.destroyed=true;}});
  const scene=Object.assign(Object.create(EntityScene.prototype),{
    C:{Cartesian3:{},Axis:{X:0,Y:1},Model:{fromGltfAsync:options=>{
      calls.push(options.url);const model=makeModel();models.push(model);return load?load(model):Promise.resolve(model);
    }}},
    viewer:{scene:{camera:{positionWC:{x:0,y:0,z:0},directionWC:{x:1,y:0,z:0}},requestRender(){}}},
    assets:new Map(['a','b','c'].map(id=>[id,{uri:`/${id}.glb`}])) ,scaleOf:()=>1,
    layers:{uam:{models:{add:m=>m,remove:m=>m.destroy()}}},
    fadingLabels:new Set(),residentModels:[],frameItems:[]});
  t.after(()=>scene.destroy());
  return {scene,calls,models};
}

test('prewarm serializes fetch, GPU readiness and warm drawing, not just a resolved promise',async t=>{
  const {scene,calls,models}=fixture(t);
  assert.equal(scene.warmAsset('a'),true);assert.equal(scene.warmAsset('b'),true);
  assert.equal(scene.warmAsset('a'),false);await flush();
  assert.deepEqual(calls,['/a.glb']);
  models[0].readyEvent.raise();await flush();
  assert.equal(models[0].show,true);assert.equal(calls.length,1);
  scene.settleWarmAssets(Infinity);await flush();
  assert.deepEqual(calls,['/a.glb','/b.glb']);assert.equal(models[0].show,false);
  assert.equal(models[0].readyEvent.listeners.size,0);
  assert.equal(models[0].errorEvent.listeners.size,0);
  models[1].readyEvent.raise();scene.settleWarmAssets(Infinity);await scene.warmQueue;
});

test('failed GPU preparation releases its model and advances the queue',async t=>{
  const {scene,calls,models}=fixture(t);
  scene.warmAsset('a');scene.warmAsset('b');await flush();
  models[0].errorEvent.raise();await flush();
  assert.equal(models[0].destroyed,true);assert.equal(calls.length,2);
  assert.equal(models[0].readyEvent.listeners.size,0);
});

test('GPU readiness timeout cannot permanently block later prewarm assets',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const {scene,calls,models}=fixture(t);
  scene.warmAsset('a');scene.warmAsset('b');await flush();
  t.mock.timers.tick(MODEL_PREPARATION_TIMEOUT_MS);await flush();
  assert.equal(models[0].destroyed,true);assert.equal(calls.length,2);
});

test('destroy cancels ready waits and no queued asset starts on a dead scene',async t=>{
  const {scene,calls,models}=fixture(t);
  scene.warmAsset('a');scene.warmAsset('b');await flush();
  scene.destroy();await scene.warmQueue;
  assert.equal(calls.length,1);assert.equal(models[0].destroyed,true);
  assert.equal(models[0].readyEvent.listeners.size,0);
});

test('an in-flight prewarm finishing after destruction is destroyed, without starting the next',async t=>{
  let release;
  const {scene,calls,models}=fixture(t,{load:model=>new Promise(resolve=>release=()=>resolve(model))});
  scene.warmAsset('a');scene.warmAsset('b');await flush();scene.destroy();
  release();await scene.warmQueue;
  assert.equal(calls.length,1);assert.equal(models[0].destroyed,true);
});

test('simultaneous DEM continuations get separate paint opportunities with hidden-tab fallback',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const frames=new Map();let next=0;const resumed=[];
  const saved=[globalThis.requestAnimationFrame,globalThis.cancelAnimationFrame];
  t.after(()=>{for(const [i,key] of ['requestAnimationFrame','cancelAnimationFrame'].entries()){
    if(saved[i]===undefined)delete globalThis[key];else globalThis[key]=saved[i];}});
  globalThis.requestAnimationFrame=fn=>{frames.set(++next,fn);return next;};
  globalThis.cancelAnimationFrame=id=>frames.delete(id);
  const a=yieldTerrainWork().then(()=>resumed.push('a'));
  const b=yieldTerrainWork().then(()=>resumed.push('b'));
  assert.equal(frames.size,1);
  const [id,paint]=frames.entries().next().value;frames.delete(id);paint();
  assert.deepEqual(resumed,[],'rAF itself does not run the CPU continuation before paint');
  t.mock.timers.tick(0);await flush();assert.deepEqual(resumed,['a']);
  assert.equal(frames.size,1);
  t.mock.timers.tick(100);await Promise.all([a,b]);
  assert.deepEqual(resumed,['a','b']);assert.equal(frames.size,0);
});
