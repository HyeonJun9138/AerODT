import test from 'node:test';
import assert from 'node:assert/strict';
import {WholeLabelOcclusion} from '../../../../digital_twin/visualization/web/whole_label_occlusion.js';

function fixture(count=1,{cost=3,blocked=false}={}) {
 let time=0,reads=0;
 const C={Cartesian2:class{constructor(x,y){Object.assign(this,{x,y});}},
  SceneTransforms:{worldToWindowCoordinates:()=>({x:100,y:100})}};
 const scene={pickPositionSupported:true,pickPosition:()=>{reads++;time+=cost;return blocked?{x:0,y:0,z:50}:undefined;}};
 const viewer={scene,camera:{positionWC:{x:0,y:0,z:0},directionWC:{x:0,y:0,z:1}},canvas:{clientWidth:500,clientHeight:500}};
 const items=new Map(Array.from({length:count},(_,i)=>[i,{entity:{kind:'uam'},lod:'model',position:{x:0,y:0,z:100},
  labelRect:{width:50,height:24},label:{show:true,text:'UAM',pixelOffset:{x:10,y:-10}}}]));
 const collection={show:true},check=new WholeLabelOcclusion(C,viewer,items,()=>collection);
 check.clock=()=>time;
 const frame=(now=0)=>{const before=reads;check.update(now);return reads-before;};
 return {C,viewer,scene,items,item:items.get(0),collection,check,frame,
  setCost(value){cost=value;},setBlocked(value){blocked=value;},get reads(){return reads;}};
}

test('one over-budget GPU read yields immediately and all six points resume without repetition',()=>{
 const f=fixture(),points=[];
 const pick=f.scene.pickPosition;f.scene.pickPosition=p=>{points.push([p.x,p.y]);return pick(p);};
 for(let i=0;i<6;i++)assert.equal(f.frame(i*16),1);
 assert.equal(new Set(points.map(p=>p.join(','))).size,6);
 assert.equal(f.item.labelClearCount,1,'only a complete clear scan counts');
 assert.equal(f.frame(100),0,'completed labels retain their cooldown');
});

test('budget is checked between cheap reads too and six is the global hard cap',()=>{
 const f=fixture(10,{cost:.6});assert.equal(f.frame(),4);
 const cheap=fixture(10,{cost:0});assert.equal(cheap.frame(),6);
});

test('an unfinished scan never unhides a blocked label; two complete scans do',()=>{
 const f=fixture(1,{blocked:true});f.frame();assert.equal(f.item.label.show,false);
 f.setBlocked(false);
 for(let i=0;i<11;i++){f.frame(160+i*160);assert.equal(f.item.label.show,false);}
 f.frame(1920);assert.equal(f.item.label.show,true);
});

test('a late corner obstruction is still detected after yielding across frames',()=>{
 const f=fixture();
 for(let i=0;i<4;i++)f.frame(i*16);
 f.setBlocked(true);f.frame(64);
 assert.equal(f.item.label.show,false);assert.equal(f.reads,5);
});

test('slow reads rotate over labels rather than starving later aircraft',()=>{
 const f=fixture(5);
 // Six interrupted reads remain consecutive, with a paced gap between labels.
 for(let i=0;i<34;i++)assert.ok(f.frame(i*16)<=1);
 assert.equal(f.reads,30);
 assert.ok([...f.items.values()].every(item=>item.labelClearCount===1));
});

test('removed or replaced aircraft do not retain a pending scan',()=>{
 for(const replace of [false,true]){
  const f=fixture();f.frame();const old=f.item;
  if(replace)f.items.set(0,{...old,label:{...old.label}});else f.items.clear();
  f.setBlocked(true);f.frame(16);
  assert.equal(old.label.show,true);
  if(replace)assert.equal(f.items.get(0).label.show,false);
 }
});

test('hiding the collection or losing depth discards partial evidence and restores labels',()=>{
 for(const fallback of ['collection','depth']){
  const f=fixture(1,{blocked:true});f.frame();f.setBlocked(false);f.frame(160);
  if(fallback==='collection')f.collection.show=false;else f.scene.pickPositionSupported=false;
  assert.equal(f.frame(176),0);assert.equal(f.item.label.show,true);assert.equal(f.check.pending,null);
 }
});

test('a camera jump invalidates incomplete clear evidence, while small flight motion still converges',()=>{
 for(const jump of [true,false]){
  const f=fixture(1,{blocked:true});f.frame();f.setBlocked(false);
  for(let i=0;i<6;i++)f.frame(160+i*16);
  assert.equal(f.item.labelClearCount,1);
  f.frame(500);
  if(jump)f.viewer.camera.positionWC.x=1000;
  else f.item.position.z+=.1;
  for(let i=1;i<6;i++)f.frame(500+i*16);
  assert.equal(f.item.label.show,!jump);
  if(jump){for(let i=0;i<12;i++)f.frame(800+i*160);assert.equal(f.item.label.show,true);}
 }
});

test('continuous normal-speed follow motion does not leave a previously hidden name stuck',()=>{
 const f=fixture(1,{blocked:true});f.frame();f.setBlocked(false);
 for(let i=0;i<12;i++){
  f.viewer.camera.positionWC.x+=8;f.item.position.x+=8;
  f.frame(160+i*160);
 }
 assert.equal(f.item.label.show,true);
});

test('failed depth reads cannot accumulate clear observations',()=>{
 const f=fixture(1,{blocked:true});f.frame();
 f.scene.pickPosition=()=>{throw Error('context temporarily unavailable');};
 for(let i=0;i<10;i++)f.frame(160+i*160);
 assert.equal(f.item.label.show,false);
});

test('zoom and orbit perform no depth readbacks and resume visibility checks at rest',()=>{
 const f=fixture(1,{cost:0,blocked:true});f.frame();assert.equal(f.item.label.show,false);
 f.setBlocked(false);
 const before=f.reads;
 for(let now=16;now<1000;now+=16)f.check.update(now,{moving:true});
 assert.equal(f.reads,before);assert.equal(f.item.label.show,false);
 f.frame(1000);assert.equal(f.item.label.show,false);
 f.frame(1160);assert.equal(f.item.label.show,true);
});
test('overview batches are paced independently of render FPS without starving labels',()=>{
 const f=fixture(20,{cost:0});
 for(let now=0;now<1000;now+=16)f.frame(now);
 assert.ok(f.reads<=60,`received ${f.reads} reads, expected at most ten six-read batches`);
 for(let now=1000;now<5000;now+=16)f.frame(now);
 assert.ok([...f.items.values()].every(item=>item.labelClearCount>=2));
});
test('moving discards unfinished depth evidence rather than combining different views',()=>{
 const f=fixture();f.frame();assert.ok(f.check.pending);
 f.check.update(16,{moving:true});assert.equal(f.check.pending,null);
 f.setBlocked(true);f.frame(32);assert.equal(f.item.label.show,false);
});
