import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {EntityScene} from '../../../../digital_twin/visualization/web/entity_scene.js';
import {ManualTurnaround} from '../../../../digital_twin/visualization/web/manual_turnaround.js';
const flush=()=>new Promise(r=>setTimeout(r,0));
function fixture(){
 class Value{constructor(v={}){Object.assign(this,v);}}
 class Collection{constructor(){this.values=[];}add(x){this.values.push(x);return x;}remove(x){this.values=this.values.filter(v=>v!==x);}}
 class Vector{constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z});}static fromDegrees(x,y,z,e,out=new Vector()){return Object.assign(out,{x,y,z});}static distance(){return 10;}}
 const C={Cartesian3:Vector,PrimitiveCollection:Collection,Matrix4:class{},HeadingPitchRoll:class{},Math:{toRadians:x=>x*Math.PI/180},Axis:{Z:2,Y:1},
  Transforms:{eastNorthUpToFixedFrame:x=>x,headingPitchRollToFixedFrame:(p,h,e,f,r)=>Object.assign(r,p)},
  Model:{async fromGltfAsync(){return {ready:false,destroy(){this.destroyed=true;}};}},
  Primitive:Value,Geometry:Value,GeometryAttribute:Value,GeometryInstance:Value,PerInstanceColorAppearance:Value,
  ComponentDatatype:{DOUBLE:1,FLOAT:2},PrimitiveType:{TRIANGLES:1},BoundingSphere:{fromVertices:()=>({})},
  Color:class{constructor(...rgba){this.rgba=rgba;}},ColorGeometryInstanceAttribute:{fromColor:c=>c}};
 const viewer={scene:{primitives:new Collection(),camera:{positionWC:{}},requestRender(){}},entities:new Collection()};
 const plan={vehicle:{id:'A1',passengers:2}},walk={count:2,path:[[127,37,80],[127.0001,37,80]],distances_m:[0,10],walk_mps:1,walk_s:10,enter_s:1,release_s:[0,2],duration_s:14,asset_id:'person',height_m:1.75};
 const g={start_s:10,position:[127,37,80],vertiport:'VP1',gate:'G2',walk,crew_path:null,crew_start_s:16,crew_walk_s:10,charge_requested_s:null,socket:[127.0001,37,80],phase:'alighting',door_open:1};
 const scene=Object.create(EntityScene.prototype);Object.assign(scene,{C,viewer,items:new Map([['scenario:A1',{entity:{entity_id:'scenario:A1',kind:'uam'},assetId:'aircraft',model:{ready:false}}]]),assets:new Map([['person',{uri:'/person.glb'}],['kenney_blocky_person_q',{uri:'/worker.glb'}]]),layers:{uam:{visible:true}},onWarning:()=>{}});
 return {scene,g,plan,C,viewer};
}
test('fleet manual sample reaches the same renderer: alighting, waiting, crew, plug and release',async()=>{
 const {scene,g,plan}=fixture();
 const update=(time_s,ground=g)=>{scene.setManualSample('scenario:A1',{time_s,ground_handling:ground,passengers:0},plan);scene.updateManualGround(true);};
 update(14);await flush();update(14);
 assert.equal(scene.manualTurnaround.constructor.name,'ManualTurnaround');
 assert.equal(scene.manualTurnaround.people.slots.filter(s=>s.model.show).length,2);
 const position=scene.manualTurnaround.people.slots[0].model.modelMatrix.x;
 update(15);assert.ok(scene.manualTurnaround.people.slots[0].model.modelMatrix.x>position);
 update(50,{...g,phase:'awaiting_charge'});
 assert.equal(scene.manualTurnaround.worker,null);assert.equal(scene.manualTurnaround.cable,null);
 const connected={...g,phase:'connecting',charge_requested_s:50,crew_start_s:40,crew_path:[[127.0001,37,80],[127,37,80.85]]};
 update(55,connected);await flush();update(55,connected);
 assert.equal(scene.manualTurnaround.worker.slots[0].model.show,true);
 assert.equal(scene.manualTurnaround.cable.geometryInstances.length,2,'cable tube and plug');
 update(66,{...connected,phase:'charging'});assert.ok(scene.manualTurnaround.cable);
 scene.updateManualGround(false);assert.equal(scene.manualTurnaround.cable,null);
 assert.equal(scene.manualTurnaround.worker.slots[0].model.show,false);
 update(75,{...connected,phase:'released',release_s:70,door_open:0});assert.equal(scene.manualTurnaround.cable,null);
 scene.setManualSample(null,null);assert.equal(scene.manualTurnaround.people,null);
 assert.equal(scene.manualTurnaround.worker,null);
});
test('switching the controlled aircraft clears old people and dropped entity clears visuals',()=>{
 const {scene,g,plan}=fixture();scene.setManualSample('scenario:A1',{time_s:14,ground_handling:g},plan);scene.updateManualGround();
 const old=scene.manualTurnaround.people;
 scene.setManualSample('scenario:A2',{time_s:14,ground_handling:g},plan);
 assert.equal(old.disposed,true);scene.updateManualGround();assert.equal(scene.manualTurnaround.operation,null);
});
test('app forwards manual plan and fleet cabin rendering cannot overwrite manual doors',()=>{
 const app=readFileSync(new URL('../../../../user_application/web/app.js',import.meta.url),'utf8');
 const globe=readFileSync(new URL('../../../../digital_twin/visualization/web/globe.js',import.meta.url),'utf8');
 assert.match(app,/setManualSample\(`scenario:\$\{manualFlight.twin\}`,sample,manualFlight.plan\)/);
 assert.match(globe,/updateManualGround\(passengers\?\.shown!==false\)/);
 assert.match(globe,/if\(this.entityScene.manualSample\(item\)\)continue;/);
});

