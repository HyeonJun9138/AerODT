import test from 'node:test';
import assert from 'node:assert/strict';
import {FlightLayer} from '../../../../digital_twin/visualization/web/flight_layer.js';
import {EntityScene} from '../../../../digital_twin/visualization/web/entity_scene.js';
import {visualModelScale,visualModelChoice} from '../../../../digital_twin/visualization/web/visual_asset_loader.js';

for(const [id,size,measured] of [['joby_s4',9.6,7.352],['projectairsim_airtaxi',10.6,8.123],['kp2a',12.2,7.352],['amvlab_evtol',14,7.352]]){
 test(`${id}: single/manual load has the same metre scale as Simulation and Physical`,async()=>{
  const asset={asset_id:id,uri:'original.glb',size_m:1.4,flight_visual:{uri:'flight.glb',size_m:size,measured_m:measured}};
  const layer=Object.create(FlightLayer.prototype);
  let drawn;
  Object.assign(layer,{assets:()=>asset,plan:{aircraft:{asset_id:id}},sample:{manual:true},matrixFor:()=>[1],
    visible:true,models:{add:m=>m},loadLabelExtent:()=>{},onWarning:s=>assert.fail(s),
    C:{Axis:{X:0,Y:1},Model:{async fromGltfAsync(options){drawn=options;return {...options,errorEvent:{addEventListener(){}}};}}}});
  await layer.loadModel();
  assert.equal(drawn.url,'flight.glb');assert.equal(drawn.scale,size/measured);
  assert.equal(drawn.maximumScale,drawn.scale);assert.equal(drawn.minimumPixelSize,0);
  const scene={assets:new Map([[id,asset]]),scales:new Map()};
  assert.equal(EntityScene.prototype.scaleOf.call(scene,id,true),drawn.scale);
  assert.equal(EntityScene.prototype.scaleOf.call(scene,id,false),1);
  assert.equal(layer.model.scale,drawn.scale,'cockpit uses the actual loaded model scale');
 });
}
test('invalid/unmeasured assets stay authored; overrides use the chosen rig units',()=>{
 const asset={size_m:100,flight_visual:{size_m:14,measured_m:7}};
 assert.equal(visualModelScale(asset,{flight:true}),2);
 assert.equal(visualModelScale(asset,{flight:true,span:21}),3);
 assert.equal(visualModelScale(asset,{span:200}),2);
 for(const measured_m of [undefined,0,-2,NaN,Infinity])assert.equal(visualModelScale({flight_visual:{size_m:14,measured_m}},{flight:true}),1);
 for(const size_m of [undefined,0,-2,NaN,Infinity])assert.equal(visualModelScale({flight_visual:{size_m,measured_m:7}},{flight:true}),1);
});

// The file and the scale are one decision, never two. A flight rig drawn at the
// base model's scale is drawn at the wrong size, and everything afterwards
// measured off that picture - apparent size to range above all - inherits the
// error. These pin the pair: no argument produces one model's uri with the
// other model's scale.
test('the chosen uri and the chosen scale always arrive as one pair',()=>{
 const asset={asset_id:'joby_s4',uri:'original.glb',size_m:1.4,flight_visual:{uri:'flight.glb',size_m:9.6,measured_m:7.352}};
 assert.deepEqual(visualModelChoice(asset,{flight:true}),{uri:'flight.glb',scale:9.6/7.352,flight:true});
 assert.deepEqual(visualModelChoice(asset,{flight:false}),{uri:'original.glb',scale:1,flight:false});
 assert.deepEqual(visualModelChoice(asset),{uri:'original.glb',scale:1,flight:false},'no rig unless one was asked for');
 // A pushed span moves the size; it never moves the file the size applies to.
 assert.deepEqual(visualModelChoice(asset,{flight:true,span:19.2}),{uri:'flight.glb',scale:19.2/7.352,flight:true});
 assert.deepEqual(visualModelChoice(asset,{flight:false,span:2.8}),{uri:'original.glb',scale:2,flight:false});
 for(const flight of [true,false])for(const span of [undefined,19.2,2.8]){
  const choice=visualModelChoice(asset,{flight,span});
  assert.equal(choice.uri,flight?'flight.glb':'original.glb');
  assert.equal(choice.flight,flight);
  // The scale belongs to the uri that came back with it, and to nothing else.
  assert.equal(choice.scale,visualModelScale(asset,{flight,span}));
  assert.equal(choice.scale,span?span/(flight?7.352:1.4):(flight?9.6/7.352:1));
  assert.notEqual(choice.scale,visualModelScale(asset,{flight:!flight,span}),'the other rig would be the wrong size');
 }
 // Nothing to mix up when there is only one model: no rig, authored size.
 for(const flight of [true,false])
  assert.deepEqual(visualModelChoice({uri:'original.glb',size_m:1.4},{flight}),{uri:'original.glb',scale:1,flight:false});
 assert.deepEqual(visualModelChoice(undefined,{flight:true}),{uri:undefined,scale:1,flight:false});
});

test('the map reads the file and the scale from the same call',()=>{
 const asset={asset_id:'kp2a',uri:'original.glb',size_m:1.4,flight_visual:{uri:'flight.glb',size_m:12.2,measured_m:7.352}};
 const scene={assets:new Map([['kp2a',asset]]),scales:new Map()};
 const visualOf=entity=>EntityScene.prototype.visualOf.call(scene,{assetId:'kp2a',entity});
 // Everything the day and the physical twin articulate draws the rig.
 for(const entity of [{kind:'uam',source:'scenario'},{kind:'uam',source:'physical_uam'},{kind:'aircraft',source:'scenario'}]){
  assert.deepEqual(visualOf(entity),{uri:'flight.glb',scale:12.2/7.352,flight:true});
  assert.equal(visualOf(entity).scale,EntityScene.prototype.scaleOf.call(scene,'kp2a',true));
 }
 // Acquired live traffic draws the library model, as authored.
 for(const entity of [{kind:'aircraft',source:'opensky'},{kind:'uam',source:'opensky'}]){
  assert.deepEqual(visualOf(entity),{uri:'original.glb',scale:1,flight:false});
  assert.equal(visualOf(entity).scale,EntityScene.prototype.scaleOf.call(scene,'kp2a',false));
 }
 scene.scales=new Map([['kp2a',24.4]]);
 assert.deepEqual(visualOf({kind:'uam',source:'scenario'}),{uri:'flight.glb',scale:24.4/7.352,flight:true});
 assert.deepEqual(visualOf({kind:'uam',source:'opensky'}),{uri:'original.glb',scale:24.4/1.4,flight:false});
});
