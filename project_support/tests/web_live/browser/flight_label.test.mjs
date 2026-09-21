import test from 'node:test';
import assert from 'node:assert/strict';
import {flightLabelOffset,flightLabelScale,FlightLayer,LABEL_FAR_METRES,VISIBLE_METRES} from '../../../../digital_twin/visualization/web/flight_layer.js';
class V {constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z});} static fromDegrees(x,y,z){return new V(x,y,z);}}
const C={Cartesian2:V,Cartesian3:V,SceneTransforms:{worldToWindowCoordinates:(_scene,p,out)=>Object.assign(out,{x:400+p.x*100/p.z,y:300-p.y*100/p.z})}};
const scene={camera:{rightWC:new V(1,0,0),upWC:new V(0,1,0),directionWC:new V(0,0,1)}};
test('flight label: fixed screen size stays readable at every distance',()=>{
 const near=flightLabelScale(C,scene,new V(0,0,10));
 const far=flightLabelScale(C,scene,new V(0,0,20));
 assert.equal(near,1);assert.equal(far,1);
 assert.equal(flightLabelScale(C,scene,new V(0,0,1)),1);
 assert.equal(flightLabelScale(C,scene,new V(0,0,100000)),1);
});
test('orthographic map labels keep the same screen size',()=>{
 const ortho={...C,SceneTransforms:{worldToWindowCoordinates:(_s,p,o)=>Object.assign(o,{x:p.x*10,y:p.y*10})}};
 assert.equal(flightLabelScale(ortho,scene,new V(0,0,10)),1);
 assert.equal(flightLabelScale(ortho,scene,new V(0,0,100)),1);
});
test('flight name follows projected model bounds when zoom changes without moving the flight',()=>{
 const model={ready:true,show:true,boundingSphere:{center:new V(0,0,10),radius:2}};
 const far=flightLabelOffset(C,scene,model,new V(0,0,10));
 model.boundingSphere.center.z=5;
 const close=flightLabelOffset(C,scene,model,new V(0,0,5));
 assert.ok(close.y<far.y && far.y<-16);
 assert.equal(close.x,0);
 model.boundingSphere.center.y=2;
 const shifted=flightLabelOffset(C,scene,model,new V(0,0,5));
 assert.ok(shifted.y<close.y,'bounds centre is not assumed to equal the model origin');
});

test('planned UAM names cover the network view and only obey explicit label toggles',()=>{
 assert.equal(LABEL_FAR_METRES,VISIBLE_METRES);assert.equal(LABEL_FAR_METRES,260000);
 const marker={label:{}},layer={C,scene,vehicle:{marker},visible:true,sample:{position:{longitude:0,latitude:0,altitude_m:120000}},model:null,labelScratch:{},labelOffset:new V()};
 FlightLayer.prototype.updateLabelLayout.call(layer);assert.equal(marker.label.scale,1);assert.equal(marker.label.show,true);
 layer.display={labels:false};FlightLayer.prototype.updateLabelLayout.call(layer);assert.equal(marker.label.show,false);
});

test('single-flight status appears below the name and toggles without advancing replay',()=>{
 const marker={label:{}},layer=Object.assign(Object.create(FlightLayer.prototype),{
  C,scene,owned:[marker],vehicle:{marker},visible:true,plan:{vehicle:{id:'UAM1'}},
  sample:{stage:'takeoff',stage_label:'수직 이륙',time_s:10,position:{longitude:0,latitude:0,altitude_m:100}},
  labelScratch:{},labelOffset:new V()});
 layer.setDisplayOptions({labels:true,status:true});
 assert.equal(marker.label.text,'UAM1\n수직 이륙');
 layer.setDisplayOptions({labels:false});assert.equal(marker.label.text,'수직 이륙');assert.equal(marker.label.show,true);
 layer.setDisplayOptions({status:false});assert.equal(marker.label.show,false);
 layer.setDisplayOptions({labels:true});assert.equal(marker.label.text,'UAM1');
 assert.equal(layer.sample.time_s,10);
});

test('reloading the same plan writes its status into the new marker',()=>{
 const layer=Object.assign(Object.create(FlightLayer.prototype),{owned:[],visible:true,entities:{remove(){}},
  plan:{vehicle:{id:'UAM1'}},sample:{stage:'cruise'},vehicle:{marker:{label:{}}}});
 layer.updateLabelText();assert.equal(layer.vehicle.marker.label.text,'UAM1\n순항');
 layer.clear();layer.sample={stage:'cruise'};layer.vehicle={marker:{label:{}}};
 layer.updateLabelText();assert.equal(layer.vehicle.marker.label.text,'UAM1\n순항');
});
test('point fallback remains compact; top edge leaves room for the box',()=>{
 assert.equal(flightLabelOffset(C,scene,null,new V()).y,-16);
 const model={ready:true,show:true,boundingSphere:{center:new V(0,8,3),radius:2}};
 const offset=flightLabelOffset(C,scene,model,new V(0,0,3));
 assert.equal(300+offset.y,30);
});

test('two-line replay label leaves room for both rows at the top viewport edge',()=>{
 const model={ready:true,show:true,boundingSphere:{center:new V(0,8,3),radius:2}};
 const offset=flightLabelOffset(C,scene,model,new V(0,0,3),new V(),{},null,1,2);
 assert.ok(300+offset.y>=48,'name and status must both fit above the bottom anchor');
});
test('flight label camera listener is removed on layer destruction',()=>{
 let removed=0;
 const layer=new FlightLayer({...C,PrimitiveCollection:class {}},{entities:{},scene:{primitives:{add:x=>x,remove(){}},preRender:{addEventListener(){return ()=>removed++;}}}});
 layer.destroy();assert.equal(removed,1);
});
test('label refresh passes scratch position as the result argument, never as an ellipsoid',()=>{
 const scratch=new V(),marker={label:{}};
 const stub={...C,Cartesian3:class extends V {static fromDegrees(lon,lat,h,ellipsoid,result){assert.equal(ellipsoid,undefined);assert.equal(result,scratch);return Object.assign(result,{x:lon,y:lat,z:h});}}};
 const layer={C:stub,scene,vehicle:{marker},visible:true,sample:{position:{longitude:0,latitude:0,altitude_m:10}},model:null,labelScratch:{anchor:scratch},labelOffset:new V()};
 FlightLayer.prototype.updateLabelLayout.call(layer);
 assert.equal(marker.label.pixelOffset.y,-16);
 assert.equal(marker.label.scale,1);
});
test('metadata extent is applied only to the model that requested it',async()=>{
 const saved=globalThis.fetch;
 try {
  const model={},extent={length:6,width:8,height:3};
  globalThis.fetch=async()=>({ok:true,json:async()=>({display:{extent_m:extent}})});
  const layer={model,scene:{requestRender(){}}};
  await FlightLayer.prototype.loadLabelExtent.call(layer,{metadata_uri:'/asset.json'},model);
  assert.deepEqual(layer.labelExtent,extent);
  layer.labelExtent=null;layer.model={};
  await FlightLayer.prototype.loadLabelExtent.call(layer,{metadata_uri:'/asset.json'},model);
  assert.equal(layer.labelExtent,null);
 } finally {globalThis.fetch=saved;}
});
