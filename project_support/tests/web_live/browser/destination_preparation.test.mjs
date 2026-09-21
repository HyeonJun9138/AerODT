import test from 'node:test';
import assert from 'node:assert/strict';
import {DestinationPreparation} from '../../../../digital_twin/visualization/web/destination_preparation.js';
function fixture(){
 let now=0;const events=[],loads=[],timers=new Map();let seq=0;
 const item=(id,x,extra={})=>({entity:{entity_id:id,kind:'uam'},assetId:'uam',position:{x,y:0,z:0},...extra});
 const scene={items:new Map(),assets:new Map([['uam',{uri:'/visual-assets/uam.glb'}]]),layers:{uam:{visible:true,showModels:true}},performance:{maxModels:24},
 loadModel:(i,p)=>loads.push([i.entity.entity_id,p])};
 const prep=new DestinationPreparation(scene,{now:()=>now,onStatus:s=>events.push(s),setTimer:(fn,ms)=>{const id=++seq;timers.set(id,{fn,ms});return id;},clearTimer:id=>timers.delete(id)});
 return {prep,scene,events,loads,timers,item,time:t=>now=t};
}
test('prepares nearest bounded models during travel, then finishes as GPU and textures become ready',()=>{
 const h=fixture();for(let i=0;i<12;i++)h.scene.items.set(String(i),h.item(String(i),i*30));
 const token=h.prep.start({x:0,y:0,z:0});assert.equal(h.loads.length,8);assert.equal(h.events.at(-1).phase,'moving');
 h.prep.arrive(token);assert.equal(h.events.at(-1).phase,'preparing');
 for(const i of h.scene.destinationItems){i.model={ready:true};i.modelTexturesReady=false;}
 h.time(200);h.prep.update();assert.equal(h.events.at(-1).phase,'preparing');
 for(const i of h.scene.destinationItems)i.modelTexturesReady=true;
 h.time(400);h.prep.update();assert.equal(h.events.at(-1).phase,'ready');assert.equal(h.scene.destinationItems.size,0);assert.equal(h.timers.size,0);
});
test('last destination owns callbacks and maximum 5 second arrival wait',()=>{
 const h=fixture();h.scene.items.set('A',h.item('A',0));const a=h.prep.start({x:0,y:0,z:0});const b=h.prep.start({x:0,y:0,z:0});
 h.prep.arrive(a);assert.equal(h.events.at(-1).phase,'moving');h.prep.arrive(b);
 const deadline=[...h.timers.values()][0];assert.equal(deadline.ms,5000);deadline.fn();
 assert.equal(h.events.at(-1).phase,'timeout');assert.equal(h.scene.destinationItems.size,0);
 h.prep.arrive(a);assert.equal(h.events.at(-1).phase,'timeout');
});
test('empty, hidden, missing, removed and failed models never strand overlay',()=>{
 const h=fixture();h.scene.items.set('far',h.item('far',20000));h.scene.items.set('failed',h.item('failed',0,{failed:true}));
 h.scene.items.set('missing',h.item('missing',0,{assetId:'unknown'}));
 h.scene.items.set('sat',h.item('sat',0,{entity:{entity_id:'sat',kind:'satellite'}}));
 const token=h.prep.start({x:0,y:0,z:0});h.prep.arrive(token);h.time(800);h.prep.update();
 assert.equal(h.events.at(-1).phase,'ready');assert.equal(h.loads.length,0);
 h.scene.items.set('near',h.item('near',0));const t=h.prep.start({x:0,y:0,z:0});h.prep.arrive(t);h.scene.items.delete('near');h.time(1600);h.prep.update();assert.equal(h.events.at(-1).phase,'ready');
});
test('manual cancellation releases priorities without destroying cached models',()=>{
 const h=fixture();const model={ready:true};h.scene.items.set('A',h.item('A',0,{model}));h.prep.start({x:0,y:0,z:0});h.prep.cancel();
 assert.equal(h.events.at(-1).phase,'cancelled');assert.equal(h.scene.items.get('A').model,model);assert.equal(h.timers.size,0);
});
import {LiveGlobe} from '../../../../digital_twin/visualization/web/globe.js';
test('vertiport flight prepares before animation, arrival checks readiness, old cancellation cannot cancel new target',()=>{
 const calls=[];let options;const host={C:{Cartesian3:{fromDegrees:(x,y,z)=>({x,y,z})},BoundingSphere:class{},HeadingPitchRange:class{},Math:{toRadians:v=>v}},
  motion:{cancel(){}},stopTracking(){},select(){},entityScene:{modelsMoving:false},destinationPreparation:{start:c=>{assert.equal(host.entityScene.modelsMoving,true);calls.push('start');return 7;},arrive:t=>calls.push(['arrive',t]),cancel:()=>calls.push('cancel'),active:{token:7}},
  viewer:{camera:{flyToBoundingSphere:(_b,o)=>{calls.push('fly');options=o;}}}};
 LiveGlobe.prototype.flyToVertiport.call(host,{longitude:127,latitude:37});assert.deepEqual(calls,['start','fly']);
 options.complete();assert.deepEqual(calls.at(-1),['arrive',7]);host.destinationPreparation.active.token=8;options.cancel();assert.notEqual(calls.at(-1),'cancel');
});

test('default browser timers are invoked without a class receiver',()=>{
 const oldSet=globalThis.setTimeout,oldClear=globalThis.clearTimeout;
 globalThis.setTimeout=function(){assert.ok(this===undefined||this===globalThis);return 1;};
 globalThis.clearTimeout=function(){assert.ok(this===undefined||this===globalThis);};
 try{const h=fixture(),p=new DestinationPreparation(h.scene);p.start({x:0,y:0,z:0});p.cancel();}
 finally{globalThis.setTimeout=oldSet;globalThis.clearTimeout=oldClear;}
});

test('zoom buttons and slider cancel preparation even after camera flight has ended',()=>{
 const calls=[],host={destinationPreparation:{cancel:()=>calls.push('cancel')},viewer:{camera:{cancelFlight(){}}},motion:{moveTo(){}},range:()=>520};
 LiveGlobe.prototype.zoom.call(host,.5);LiveGlobe.prototype.setRange.call(host,800);assert.deepEqual(calls,['cancel','cancel']);
});
