import test from 'node:test';
import assert from 'node:assert/strict';
import {ScenarioPassengerLayer} from '../../../../digital_twin/visualization/web/scenario_passengers.js';
class Point {constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z});}static fromDegrees(x,y,z){return new Point(x,y,z);}static distance(a,b){return Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);}}
const C={Cartesian3:Point,PrimitiveCollection:class{}};
const scene={primitives:{add:x=>x,remove:()=>{}},camera:{positionWC:new Point()}};
const walk=elapsed=>({aircraft_id:'A',flight_id:'F1',phase:'boarding',elapsed_s:elapsed,deck_m:0,walk:{count:1,path:[[0,0],[100,0]],distances_m:[0,100],release_s:[0],walk_mps:1,walk_s:100,enter_s:1}});

test('charger crew uses display time and passenger endpoint follows door sill',async()=>{
 const w=walk(50);w.walk.path_height_offsets_m=[0,2];
 const l=new ScenarioPassengerLayer(C,scene,{load:async()=>({state_time:100,time_s:10,aircraft:[w],cabins:[{aircraft_id:'A',on_board:2}],crew:[{role:'charger',action:'walk',path:[[0,0],[20,0]],elapsed_s:5,walk_s:20,deck_m:0}]}),displayAnchor:()=>({time:100,epoch:1})});
 l.setShown(true);await l.refresh();const people=l.people(scene.camera.positionWC);
 assert.equal(people.length,2);assert.equal(people.find(x=>x.crew).person.longitude,5);
 assert.equal(people.find(x=>!x.crew).height,1.03);assert.equal(l.cabins[0].on_board,2);
 l.setShown(false);assert.equal(l.cabins.length,0);
});
test('passengers share aircraft display time and never rewind on refreshed/rounded elapsed',async()=>{
 let time=100,wall=0,answer={state_time:100,time_s:10,aircraft:[walk(4)]};
 const l=new ScenarioPassengerLayer(C,scene,{load:async()=>answer,now:()=>wall,displayAnchor:()=>({time,epoch:1})});
 l.setShown(true);await l.refresh();
 const elapsed=()=>l.people(scene.camera.positionWC)[0].person.elapsed;
 assert.equal(elapsed(),4);time=101;wall=1000;assert.equal(elapsed(),5);
 answer={state_time:100.6,time_s:10.6,aircraft:[walk(4.55)]};await l.refresh();
 assert.equal(elapsed(),5,'packet correction never pushes the same walker backwards');
 time=102;assert.ok(elapsed()>5.9);const frozen=elapsed();wall=10000;
 assert.equal(elapsed(),frozen,'wall time cannot move people when the aircraft display is paused');
});
test('only one passenger request is in flight and closing rejects its late response',async()=>{
 let resolve,calls=0;const l=new ScenarioPassengerLayer(C,scene,{load:()=>{calls++;return new Promise(r=>resolve=r);}});
 l.setShown(true);const pending=l.refresh();void l.refresh();assert.equal(calls,1);
 l.setShown(false);resolve({state_time:100,time_s:10,aircraft:[walk(4)]});await pending;
 assert.equal(l.walks.length,0);
});

test('stale passenger replies are ignored and a new display epoch clears old walking progress',async()=>{
 let epoch=1,time=102,answer={state_time:102,time_s:12,scenario_id:'day',aircraft:[walk(6)]};
 const l=new ScenarioPassengerLayer(C,scene,{load:async()=>answer,displayAnchor:()=>({time,epoch})});
 l.setShown(true);await l.refresh();assert.equal(l.people(scene.camera.positionWC)[0].person.elapsed,6);
 answer={state_time:101,time_s:11,scenario_id:'day',aircraft:[walk(5)]};await l.refresh();assert.equal(l.stateTime,102);
 epoch=2;time=100;assert.equal(l.people(scene.camera.positionWC).length,0,'old epoch not drawn');
 answer={state_time:100,time_s:10,scenario_id:'day',aircraft:[walk(4)]};await l.refresh();
 assert.equal(l.people(scene.camera.positionWC)[0].person.elapsed,4,'intentional seek is allowed');
});
