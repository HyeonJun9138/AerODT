import test from 'node:test';
import assert from 'node:assert/strict';
import {cameraEnvironment,CameraEnvironment} from '../../../../digital_twin/visualization/web/camera_environment.js';
import {cellsFor,VWorldBuildingLayer} from '../../../../digital_twin/visualization/web/vworld_building_layer.js';
import {EntityScene} from '../../../../digital_twin/visualization/web/entity_scene.js';

test('aircraft inspection bounds the ground region even at high geodetic altitude',()=>{
  const close=cameraEnvironment({following:true,height:10000,range:200});
  assert.ok(close.range<=1400);assert.ok(close.hazeStrength>.9);
  assert.equal(cameraEnvironment({following:true,height:10000,range:200,fog:0}).range,40000);
  const low=cameraEnvironment({height:350,range:300,following:true});assert.ok(low.range<1500);
  assert.ok(low.range<cameraEnvironment({height:350,range:300}).range);
  const policy=new CameraEnvironment();policy.update({height:10000},0);
  let previous=40000;for(let at=200;at<8000;at+=200){const next=policy.update({following:true,height:350,range:300},at).range;assert.ok(next<=previous);previous=next;}
  assert.ok(previous<=1500);
});

test('requested footprint cells intersect visible circular coverage, including boundary cells',()=>{
  const focus={longitude:127.005,latitude:37.505},range=1600,cos=Math.cos(focus.latitude*Math.PI/180);
  const cells=cellsFor(null,64,focus,range);assert.ok(cells.length>0);
  for(const {column,row} of cells){const w=(column*.01-focus.longitude)*111320*cos,e=w+1113.2*cos;
    const s=(row*.01-focus.latitude)*111320,n=s+1113.2;
    assert.ok(Math.hypot(Math.max(w,0,-e),Math.max(s,0,-n))<=range*.98+1e-6);
  }
  assert.ok(cells.some(c=>c.column===12700&&c.row===3750));
});

test('picked-model handoff pauses new building work and resumes without clearing resident geometry',async()=>{
  let calls=0;const scene={primitives:{remove(){}},requestRender(){}};
  const layer=new VWorldBuildingLayer({C:{Cartesian3:{}},scene,load:async()=>{calls++;return {buildings:[]};}});
  layer.enabled=true;layer.focusPending=true;const focus={longitude:127.005,latitude:37.505,range:900};
  layer.update(350,null,1000,focus,{focusPending:true});assert.equal(calls,0);assert.ok(layer.queue.length>0);
  layer.update(350,null,1300,focus,{focusPending:false});assert.ok(calls>0);
  await new Promise(resolve=>setImmediate(resolve));layer.destroy();
});

class Collection{values=[];add(item){this.values.push(item);return item;}remove(item){this.values=this.values.filter(n=>n!==item);item.destroy?.();}}
const colour={withAlpha(){return this;}};
function modelScene(){
  const C={PointPrimitiveCollection:Collection,LabelCollection:Collection,PrimitiveCollection:Collection,
    Color:{BLACK:colour,WHITE:colour,fromCssColorString:()=>colour},Cartesian3:{fromArray:(a,_offset,r={})=>Object.assign(r,{x:a[0],y:a[1],z:a[2]})},
    Axis:{X:0,Y:1},Model:{fromGltfAsync:async()=>({ready:false,destroy(){this.destroyed=true;},errorEvent:{addEventListener(){}}})}};
  const scene=new EntityScene(C,{scene:{primitives:new Collection(),requestRender(){}}});scene.matrix=()=>({});
  scene.setAssets({assets:[{asset_id:'plane',uri:'/visual-assets/plane.glb'}]});
  scene.replace({sequence:1,state_time:1,entities:Array.from({length:4},(_,i)=>({entity_id:String(i),kind:'aircraft',name:String(i),position_ecef_m:[1,2,3],visual_asset_id:'plane'}))});
  for(const item of scene.items.values())item.lod='model';return scene;
}

test('leaving an unready model frees its slot while a ready warm model is retained',async()=>{
  const scene=modelScene(),a=scene.items.get('0');await scene.loadModel(a);const model=a.model;a.lod='hidden';
  scene.retirePreparation(1000);scene.retirePreparation(1800);assert.equal(a.model,null);assert.ok(model.destroyed);assert.equal(scene.preparingModels(),0);
  await scene.loadModel(a);a.model.ready=true;const ready=a.model;scene.retirePreparation(30000);assert.equal(a.model,ready);scene.destroy();
});

test('a model asked for by a camera still on its way is not retired for being invisible',async()=>{
  // Arriving at an aircraft asks for its model while the camera is still
  // gliding, because the load is the longer half and does not need the camera.
  // The target is 'hidden' for most of that glide, so the rule above would
  // cancel the very load the glide was meant to cover, and the next beat would
  // start it over -- the model never finishing while the camera flew.
  const scene=modelScene(),a=scene.items.get('0');a.lod='hidden';
  scene.prepareFocus(a,0);
  for(let i=0;i<10&&!a.model;i++)await new Promise(resolve=>setTimeout(resolve,0));
  assert.ok(a.model,'요청이 실제로 걸렸다');
  scene.retirePreparation(1000);scene.retirePreparation(1800);
  assert.ok(a.model,'글라이드가 끝나기 전에는 유지된다');
  // And it lapses on its own: an arrival that was given up on must not hold a
  // preparation slot for the rest of the session.
  scene.retirePreparation(2100);scene.retirePreparation(2900);
  assert.equal(a.model,null,'요청이 끊기면 스스로 풀린다');
  scene.destroy();
});

test('GPU readiness has a separate deadline and never leaves all subsequent aircraft blocked',async()=>{
  const scene=modelScene(),a=scene.items.get('0');await scene.loadModel(a);a.modelPreparedAt=1000;a.selected=true;
  scene.retirePreparation(11001);assert.equal(a.model,null);assert.equal(a.failed,true);assert.equal(a.point.show,true);
  await scene.loadModel(scene.items.get('1'));assert.ok(scene.items.get('1').model);scene.destroy();
});

test('a newly selected craft reclaims the obsolete selected preparation slot within the same budget',async()=>{
  const scene=modelScene(),[a,b,c,d]=[...scene.items.values()];await scene.loadModel(a);await scene.loadModel(b);await scene.loadModel(c,true);
  assert.equal(scene.preparingModels(),3);c.selected=false;d.selected=true;await scene.loadModel(d,true);
  assert.equal(c.model,null);assert.ok(d.model);assert.equal(scene.preparingModels(),3);scene.destroy();
});
