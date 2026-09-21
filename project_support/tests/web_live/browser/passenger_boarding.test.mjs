import test from 'node:test';
import assert from 'node:assert/strict';
import {boardingAt,PassengerBoardingLayer} from '../../../../digital_twin/visualization/web/passenger_boarding.js';
const plan={vehicle:{id:'test'},legs:[{path:[[127,37,100]]}],boarding:{count:3,path:[[127,37],[127.0001,37]],
  distances_m:[0,10],walk_mps:1,walk_s:10,enter_s:1,release_s:[1,3,5],duration_s:18,asset_id:'person',height_m:1.75}};
test('one passenger per manifest entry, staggered release and exact boarding completion',()=>{
  assert.equal(boardingAt(plan,0).passengers.filter(p=>p.visible).length,0);
  assert.equal(boardingAt(plan,4).passengers.filter(p=>p.visible).length,2);
  assert.equal(boardingAt(plan,12).boarded,1);
  assert.equal(boardingAt(plan,16).boarded,3);
  assert.equal(boardingAt(plan,18).active,false);
});
test('seek and rewind are deterministic, with no accumulated passenger state',()=>{
  const a=boardingAt(plan,6);boardingAt(plan,50);
  assert.deepEqual(boardingAt(plan,6),a);
  assert.equal(boardingAt({},5),null);
  assert.equal(boardingAt(plan,NaN),null);
});
test('distant/completed flights never load people; late loads are destroyed after clear',async()=>{
  let loaded=0,destroyed=0,resolve;
  const C={Cartesian3:class {static fromDegrees(){return {};}static distance(){return 9999;}},
    PrimitiveCollection:class {},Transforms:{eastNorthUpToFixedFrame:()=>[]},Axis:{Z:2,Y:1},
    Model:{fromGltfAsync(){loaded++;return new Promise(r=>resolve=r);}}};
  const scene={primitives:{add:x=>x,remove(){}},camera:{positionWC:{}},requestRender(){}};
  const layer=new PassengerBoardingLayer(C,scene,plan,()=>({uri:'/person.glb'}));
  layer.update(5);assert.equal(loaded,0);
  C.Cartesian3.distance=()=>20;
  layer.update(20);assert.equal(loaded,0);
  layer.update(5);layer.update(6);assert.equal(loaded,1,'only one bounded load batch');
  layer.destroy();resolve({destroy(){destroyed++;}});
  await new Promise(r=>setTimeout(r,0));assert.equal(destroyed,1);
});

test('alighting starts only with charge, follows arrival path and resets on rewind',()=>{
  const arrival={...plan.boarding,path:[[128,36],[128.0001,36]],start_stage:'charge'};
  const p={...plan,alighting:arrival,legs:[...plan.legs,{stage:'charge',start_s:100,path:[[128,36,200]]}]};
  assert.equal(boardingAt(p,99).active,false);
  assert.equal(boardingAt(p,100).phase,'alighting');
  assert.equal(boardingAt(p,100).passengers.filter(p=>p.visible).length,0);
  assert.equal(boardingAt(p,104).passengers.filter(p=>p.visible).length,2);
  assert.equal(boardingAt(p,104).schedule,arrival);
  assert.ok(boardingAt(p,104).passengers[0].longitude>=128);
  assert.equal(boardingAt(p,116).boarded,3);
  assert.equal(boardingAt(p,118).active,false);
  assert.equal(boardingAt(p,4).phase,'boarding');
  p.legs[1].start_s=200;
  assert.equal(boardingAt(p,104).active,false,'Native retiming shifts alighting with charge');
  assert.equal(boardingAt(p,204).phase,'alighting');
});

test('departure and arrival reuse the same bounded pool at each resolved deck height',async()=>{
  let loads=0;
  const C={Cartesian3:class {
    static fromDegrees(x,y,z,ellipsoid,result={}){return Object.assign(result,{x,y,z});}
    static distance(){return 10;}
  },PrimitiveCollection:class {add(x){return x;}},Matrix4:class {},HeadingPitchRoll:class {},
    Math:{toRadians:x=>x*Math.PI/180},Axis:{Z:2,Y:1},
    Transforms:{eastNorthUpToFixedFrame:x=>x,headingPitchRollToFixedFrame:(p,h,e,f,r)=>Object.assign(r,p)},
    Model:{async fromGltfAsync(){loads++;return {ready:false};}}};
  const p={...plan,alighting:{...plan.boarding,path:[[128,36],[128.0001,36]]},
    legs:[...plan.legs,{stage:'charge',start_s:100,path:[[128,36,200]]}]};
  const scene={primitives:{add:x=>x,remove(){}},camera:{positionWC:{}},requestRender(){}};
  const layer=new PassengerBoardingLayer(C,scene,p,()=>({uri:'/person.glb'}));
  layer.update(7);await new Promise(r=>setTimeout(r,0));layer.update(7);
  assert.equal(loads,3);assert.equal(layer.slots[0].model.modelMatrix.z,100.03);
  layer.update(107);
  assert.equal(loads,3);assert.equal(layer.slots[0].model.modelMatrix.z,200.03);
  assert.ok(layer.slots.every(s=>s.model.show));
  layer.update(118);assert.ok(layer.slots.every(s=>!s.model.show));
  layer.update(7);assert.equal(loads,3);assert.equal(layer.slots[0].model.modelMatrix.z,100.03);
});
