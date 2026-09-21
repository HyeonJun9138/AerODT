import test from 'node:test';
import assert from 'node:assert/strict';
import {arriveAtManualAircraft} from '../../../../user_application/web/domains/uam/cockpit/manual_assignment_arrival.js';
function fixture({late=0,initialTracking=false,mode='3d',cancelAt=Infinity}={}){
 let time=0,focuses=0,finishes=0,enters=0,selects=[];const item={};
 const g={items:new Map(),sceneMode:mode,selected:initialTracking?'scenario:A1':null,tracking:initialTracking,
 select(id,options){selects.push(options);this.selected=id;if(options?.focus&&this.tracking)this.tracking=false;},
 focus(){focuses++;this.approaching=true;this.approach={};},
 // The real globe lands the approach in the same frame it was asked to.
 finishApproach(){finishes++;this.approaching=false;this.approach=null;return true;},
 async setSceneMode(mode){this.sceneMode=mode;},
 cockpit:{usable:()=>time>=late+300,enter(){enters++;return true;}}};
 const args={aircraftId:'A1',getGlobe:()=>g,now:()=>time,isCurrent:()=>time<cancelAt,
 wait:async ms=>{time+=ms;if(time>=late)g.items.set('scenario:A1',item);},timeoutMs:2000};
 if(!late)g.items.set('scenario:A1',item);
 return {g,args,stats:()=>({time,focuses,finishes,enters,selects})};
}
test('a late fleet snapshot is waited for, and after that only the model is',async()=>{
 // Two waits and no third: the object has to arrive from the day, and its
 // airframe has to finish loading. The camera used to add a journey on top of
 // both, which is what made getting in feel long.
 const f=fixture({late:700});assert.equal(await arriveAtManualAircraft(f.args),'scenario:A1');
 const stats=f.stats();
 assert.equal(stats.focuses,1);assert.equal(stats.finishes,1);assert.equal(stats.enters,1);
 assert.ok(stats.time>=1000,'객체와 모델은 기다린다');
 assert.ok(stats.time<1300,'그 위에 카메라 이동 시간이 더 붙지 않는다');
});
test('already-followed aircraft receives explicit focus, never the selection toggle',async()=>{
 const f=fixture({initialTracking:true});await arriveAtManualAircraft(f.args);
 assert.deepEqual(f.stats().selects,[undefined]);assert.equal(f.stats().focuses,1);
});
test('2D assignment switches to 3D before arrival',async()=>{
 const f=fixture({mode:'2d'});await arriveAtManualAircraft(f.args);assert.equal(f.g.sceneMode,'3d');assert.equal(f.stats().enters,1);
});
test('stopped session cannot steal the camera after a delayed snapshot',async()=>{
 const f=fixture({late:700,cancelAt:300});await assert.rejects(arriveAtManualAircraft(f.args),/취소/);assert.equal(f.stats().focuses,0);assert.equal(f.stats().enters,0);
});
test('entry animation is allowed to finish before selecting aircraft',async()=>{
 const f=fixture();f.g.entryActive=true;const wait=f.args.wait;f.args.wait=async ms=>{await wait(ms);if(f.stats().time>=400)f.g.entryActive=false;};await arriveAtManualAircraft(f.args);assert.equal(f.stats().focuses,1);
});
test('missing aircraft times out explicitly without entering another cockpit',async()=>{
 const f=fixture({late:5000});await assert.rejects(arriveAtManualAircraft(f.args),/지도에서/);assert.equal(f.stats().enters,0);
});
test('the airframe is asked for the moment the object exists, and kept asked for',async()=>{
 // The load is the long part of getting in, so nothing may be ordered ahead of
 // it: the beat the object appears on is the beat it is requested on. It is
 // asked for again every beat after that, because the request costs nothing
 // once the model is on its way and repeating it is what stops the scene
 // retiring a model that is not visible yet.
 let time=0,enters=0;const prepared=[],item={};
 const g={items:new Map(),sceneMode:'3d',selected:null,
  select(id){this.selected=id;},focus(){this.approaching=true;this.approach={};},
  finishApproach(){this.approaching=false;this.approach=null;return true;},
  prepareModel(){prepared.push(time);return true;},
  cockpit:{usable:()=>time>=900,enter(){enters++;return true;}}};
 const args={aircraftId:'A1',getGlobe:()=>g,now:()=>time,
  wait:async ms=>{time+=ms;if(time>=300)g.items.set('scenario:A1',item);},timeoutMs:9000};
 assert.equal(await arriveAtManualAircraft(args),'scenario:A1');
 assert.equal(enters,1);
 assert.equal(prepared[0],300,'객체가 생긴 즉시 요청한다');
 assert.ok(prepared.length>3,'한 번이 아니라 준비될 때까지 계속 붙잡아 둔다');
});
test('an object the map has not delivered yet is not asked to prepare',async()=>{
 // `prepareModel` takes an id, so a globe that has never heard of it would be
 // asked about nothing on every beat for the whole 25 s deadline.
 const f=fixture({late:5000});let asked=0;f.g.prepareModel=()=>{asked++;return false;};
 await assert.rejects(arriveAtManualAircraft(f.args),/지도에서/);
 assert.equal(asked,0,'없는 기체는 요청하지 않는다');
});
