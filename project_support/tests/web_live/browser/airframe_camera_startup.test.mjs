import test from 'node:test';
import assert from 'node:assert/strict';
import {AirframeCamera} from '../../../../digital_twin/visualization/web/airframe_camera.js';

const matrix=[1,0,0,0,0,1,0,0,0,0,1,0,100,200,300,1];
function fixture(count=0){
 class V{constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z});}static distance(){return 10;}}
 const requests=[],pending=[];
 const C={Cartesian3:V,Entity:class{constructor(o){Object.assign(this,o);}},Axis:{X:0,Y:1},Matrix4:{clone:m=>m.slice()},
  Model:{fromGltfAsync:o=>{requests.push(o);return new Promise(resolve=>pending.push(resolve));}}};
 const values=Array.from({length:count},(_,i)=>({id:`vertiport:${i}`,position:{getValue:()=>new V()},box:{clone:()=>({})}}));
 const globe={C,items:new Map(),entityScene:{assets:new Map()},viewer:{clock:{currentTime:0},entities:{values}}};
 const camera=new AirframeCamera(globe,{getContext:()=>null},()=>{},{cockpit:true});
 const removed=[];camera.widget={entities:{add:e=>e,remove:e=>removed.push(e)},scene:{primitives:{add:m=>m,remove:m=>removed.push(m)}}};
 return {camera,globe,requests,pending,removed};
}
test('cockpit stages facilities without dropping detail or rebuilding retained entities',()=>{
 const {camera}=fixture(40),frame={matrix};
 camera.syncObjects(frame);assert.ok(camera.graphics.size>0&&camera.graphics.size<=12);
 const first=camera.graphics.get('vertiport:0');
 for(let i=0;i<40;i++)camera.syncObjects(frame);
 assert.equal(camera.graphics.size,40);assert.equal(camera.graphics.get('vertiport:0'),first);
 const widget=camera.widget;camera.stop();camera.set({enabled:true,mode:'around'});camera.syncObjects(frame);
 assert.equal(camera.widget,widget);assert.equal(camera.graphics.get('vertiport:0'),first);
});
test('own rig takes priority; OFF/ON keeps pending load; ready rig releases traffic loads',async()=>{
 const {camera,globe,requests,pending}=fixture();
 globe.entityScene.assets.set('a',{uri:'a.glb'});
 globe.entityScene.matrix=()=>matrix;
 globe.items.set('near',{entity:{entity_id:'near',kind:'uam'},assetId:'a',position:{}});
 const frame={matrix,assetId:'a',entityId:'self'};
 camera.syncObjects(frame);assert.equal(requests.length,1);
 camera.stop();camera.set({enabled:true,mode:'around'});camera.syncObjects(frame);assert.equal(requests.length,1);
 const model={ready:false};pending[0](model);await Promise.resolve();
 camera.syncObjects(frame);assert.equal(requests.length,1);
 model.ready=true;camera.syncObjects(frame);assert.equal(requests.length,2);
 assert.equal(camera.models.get('own').model,model);
});
test('missing own asset never blocks traffic',()=>{
 const {camera,globe,requests}=fixture();globe.entityScene.assets.set('a',{uri:'a.glb'});
 globe.entityScene.matrix=()=>matrix;globe.items.set('near',{entity:{entity_id:'near',kind:'uam'},assetId:'a',position:{}});
 camera.syncObjects({matrix,entityId:'self'});assert.equal(requests.length,1);
});
test('mode change cancels old paced frame and next update renders without inherited delay',async()=>{
 const {camera,globe}=fixture();camera.canvas.ownerDocument={hidden:false};camera.enabled=true;
 camera.interval=1500;camera.last=performance.now();const frames=[];camera.renderFrame=f=>frames.push(f);
 camera.update({matrix},performance.now());assert.notEqual(camera.renderTask,null);
 camera.set({enabled:true,mode:'around'});assert.equal(camera.renderTask,null);
 camera.update({matrix},performance.now());await new Promise(resolve=>setTimeout(resolve,25));
 assert.equal(frames.length,1);camera.stop();
});
