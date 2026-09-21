import test from 'node:test';
import assert from 'node:assert/strict';
import {airframeCameraPose,AirframeCamera} from '../../../../digital_twin/visualization/web/airframe_camera.js';
import {CockpitPanel} from '../../../../user_application/web/domains/uam/cockpit/cockpit_panel.js';
import {fakeDocument} from './fake_dom.mjs';
const matrix=[1,0,0,0,0,1,0,0,0,0,1,0,100,200,300,1];
const profile={forward:[1,0,0],up:[0,1,0]};
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);
test('external mounts use the displayed aircraft frame, orthogonal orientation and outward directions',()=>{
 const before=structuredClone(matrix);
 for(const mode of ['front','rear','left','right','down']){
  const p=airframeCameraPose(matrix,profile,mode,6);assert.ok(p);
  near(Math.hypot(...p.direction),1);near(Math.hypot(...p.up),1);near(p.direction.reduce((n,x,i)=>n+x*p.up[i],0),0);
  if(mode==='front')assert.ok(p.position[0]>100&&p.direction[0]>0);
  if(mode==='rear')assert.ok(p.position[0]<100&&p.direction[0]<0);
  if(mode==='right')assert.ok(p.position[1]<200&&p.direction[1]<0);
  if(mode==='left')assert.ok(p.position[1]>200&&p.direction[1]>0);
  if(mode==='down')assert.ok(p.position[2]>300&&p.direction[2]===-1);
 }
 assert.deepEqual(matrix,before);assert.equal(airframeCameraPose(matrix,{}),null);assert.equal(airframeCameraPose([NaN],profile),null);
});
test('camera controls activate selected mode, power off and cockpit close release it',()=>{
 const calls=[],p=new CockpitPanel({document:fakeDocument,onCameraChange:v=>calls.push(v)});p.open();
 assert.equal(p.cameraEnabled,false);assert.ok(p.screens.pfd.querySelector('[data-readout=rpm]'));assert.equal(p.screens.nav.querySelector('[data-readout=rpm]'),null);assert.equal(p.screens.system.querySelector('[data-readout=rpm]'),null);
 p.root.querySelector('[data-action=camera-power]').click();assert.deepEqual(calls.at(-1),{enabled:true,mode:'front'});
 for(const mode of ['left','right','down','around']){p.root.querySelector(`[data-action=camera-${mode}]`).click();assert.equal(calls.at(-1).mode,mode);assert.equal(p.cameraButtons[mode].getAttribute('aria-pressed'),'true');}
 p.close();assert.equal(calls.at(-1).enabled,false);assert.equal(p.cameraCover.hidden,false);
});
test('stop keeps the render context warm and invalidates queued frames; release destroys only what it owns',()=>{
 let removed=0,destroyed=0,cleared=0;
 const camera=new AirframeCamera({}, {getContext:()=>({fillRect(){cleared++;}})},()=>{});
 const widget={destroy(){destroyed++;}};
 camera.widget=widget;camera.host={remove(){removed++;}};camera.enabled=true;
 camera.stop();assert.equal(camera.enabled,false);assert.equal(camera.widget,widget,'the context, its terrain, city and models are kept for the next start');
 assert.equal(camera.generation,1);assert.equal(destroyed,0);assert.equal(removed,0);
 camera.set({enabled:true});assert.equal(camera.enabled,true,'a restart draws into the same widget');
 camera.release();assert.equal(camera.enabled,false);assert.equal(camera.widget,null);assert.equal(camera.generation,2);assert.equal(removed,1);assert.equal(destroyed,1);assert.equal(cleared,1);
 camera.release();assert.equal(destroyed,1);
 camera.destroy();assert.equal(destroyed,1);
});
test('a failed camera lets its context go; a reopened panel hands the camera its new canvas',()=>{
 let destroyed=0,cleared=0;
 const camera=new AirframeCamera({}, {getContext:()=>({fillRect(){cleared++;}})},()=>{});
 camera.widget={destroy(){destroyed++;}};camera.enabled=true;
 camera.fail('x');assert.equal(camera.widget,null);assert.equal(destroyed,1);
 const next={getContext:()=>({fillRect(){cleared+=10;}})};
 camera.attach(next);assert.equal(camera.canvas,next);assert.equal(cleared,11,'the new canvas is blanked like the first');
});
test('route protection volumes are excluded from camera images; physical port structures remain',()=>{
 class V{constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z});}static distance(){return 10;}}
 const cylinder={clone:()=>({})},position={getValue:()=>new V()};
 const g={C:{Cartesian3:V,Entity:class{constructor(a){Object.assign(this,a);}}},items:new Map(),entityScene:{assets:new Map()},
  viewer:{clock:{currentTime:0},entities:{values:[{id:'route-protection-cylinder',cylinder,position},{id:'vertiport:VP1:platform',cylinder,position}]}}};
 const camera=new AirframeCamera(g,{},()=>{});camera.widget={entities:{add:e=>e,remove(){}},scene:{}};
 camera.syncObjects({matrix,profile,assetId:'none'});
 assert.deepEqual([...camera.graphics.keys()],['vertiport:VP1:platform']);
});

test('standalone camera accepts rear view rather than silently falling back to front',()=>{
 const c=new AirframeCamera({}, {getContext:()=>null});c.widget={};c.set({enabled:true,mode:'rear'});assert.equal(c.mode,'rear');
});

test('CesiumWidget camera draws physical structures through its owned data source, not Viewer-only entities',()=>{
 class V{constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z});}static distance(){return 10;}}
 const g={C:{Cartesian3:V,Entity:class{constructor(a){Object.assign(this,a);}}},items:new Map(),entityScene:{assets:new Map()},viewer:{clock:{currentTime:0},entities:{values:[{id:'vertiport:test',position:{getValue:()=>new V()},box:{clone:()=>({})}}]}}};
 const c=new AirframeCamera(g,{});c.widget={scene:{}};const added=[];c.graphicsEntities={add:e=>{added.push(e);return e;},remove(){}};c.syncObjects({matrix,profile});assert.equal(added.length,1);
});

test('the file drawn and the number that scales it come from one decision',async()=>{
 // Found live: the uri was taken unconditionally from the flight rig while the
 // scale came from a different predicate than the map's. An injected intruder
 // was drawn with the 2.1 MB rig at the base model's scale - 1.469x too small -
 // and camera_perception turns apparent size into range, so every detection of
 // one was reported about 47% further away than it actually was.
 class V{constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z});}static distance(){return 100;}}
 const asset={uri:'base.glb',size_m:10.8,flight_visual:{uri:'rig.glb',measured_m:7.352,size_m:10.8}};
 // What the map decides. The camera may not contradict it.
 const visualOf=item=>item.entity.source==='intruder'
  ?{uri:'base.glb',scale:1,flight:false}
  :{uri:'rig.glb',scale:10.8/7.352,flight:true};
 const asked=[];
 for(const [source,uri,scale] of [['intruder','base.glb',1],['scenario','rig.glb',10.8/7.352]]){
  const g={C:{Axis:{X:0,Y:1},Cartesian3:V,Matrix4:{clone:m=>m},
    Model:{fromGltfAsync:async o=>{asked.push([o.url,o.scale]);return {};}}},
   items:new Map([['near',{entity:{entity_id:'near',kind:'uam',source},position:new V(),assetId:'a'}]]),
   entityScene:{assets:new Map([['a',asset]]),matrix:()=>matrix,scaleOf:()=>1,visualOf},
   viewer:{clock:{currentTime:0},entities:{values:[]}}};
  const c=new AirframeCamera(g,{},()=>{},{hideOwn:true});c.widget={scene:{primitives:{add(){}}}};
  c.syncObjects({entityId:'own',matrix,profile});await Promise.resolve();
  assert.deepEqual(asked.at(-1),[uri,scale],source+': the camera draws the pair the map chose');
 }
 assert.notDeepEqual(asked[0],['rig.glb',1],'the rig drawn at the base model scale is exactly the bug');
});

test('camera traffic remains visible when the main map uses hidden or unloaded LOD models',async()=>{
 class V{constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z});}static distance(){return 100;}}
 for(const model of [undefined,{ready:true,show:false,modelMatrix:matrix}]){
  let loaded=0;const g={C:{Axis:{X:0,Y:1},Cartesian3:V,Matrix4:{clone:m=>m},Model:{fromGltfAsync:async options=>{assert.equal(options.forwardAxis,0);assert.equal(options.upAxis,1);loaded++;return {};}}},items:new Map([['near',{entity:{entity_id:'near',kind:'uam'},position:new V(),assetId:'a',model}]]),
   entityScene:{assets:new Map([['a',{uri:'a.glb'}]]),matrix:()=>matrix,scaleOf:()=>1},viewer:{clock:{currentTime:0},entities:{values:[]}}};
  const c=new AirframeCamera(g,{},()=>{},{hideOwn:true});c.widget={scene:{primitives:{add(){}}}};c.syncObjects({entityId:'own',matrix,profile});await Promise.resolve();assert.equal(loaded,1);
 }
});

test('missing aircraft pose waits without destroying the camera',()=>{
 const states=[],c=new AirframeCamera({C:{}},{ownerDocument:{hidden:false}},x=>states.push(x));
 c.widget={};c.enabled=true;c.renderFrame(null,100);
 assert.equal(c.enabled,true);assert.ok(c.widget);assert.equal(states.at(-1).age,'WAITING');
});
test('transient error recovery is bounded and power off cancels recovery',()=>{
 const states=[],c=new AirframeCamera({}, {getContext:()=>null},x=>states.push(x));
 c.release=function(){this.widget=null;this.enabled=false;this.generation++;};
 const warn=console.warn;console.warn=()=>{};
 try{
 c.recover(new Error('fixture'),'objects');assert.equal(c.enabled,true);assert.ok(c.retryAt);
 c.recover(new Error('fixture'),'render');assert.equal(c.enabled,true);
 c.recover(new Error('fixture'),'render');assert.equal(c.enabled,false);assert.equal(states.at(-1).age,'NO VIDEO');
 assert.match(states.at(-1).text,/fixture/);
 c.enabled=true;c.stop();assert.equal(c.enabled,false);
 }finally{console.warn=warn;}
});

test('zero-size source canvas waits without consuming reconnect attempts or copying',()=>{
 const states=[],c=new AirframeCamera({C:{}},{ownerDocument:{hidden:false},getContext(){throw new Error('must not copy');}},x=>states.push(x));
 let resized=0;
 c.widget={canvas:{width:0,height:0},resize(){resized++;}};c.enabled=true;
 c.renderFrame({matrix,profile},100);
 assert.equal(resized,1);assert.equal(c.enabled,true);assert.ok(c.widget);
 assert.equal(c.retryCount,undefined);assert.equal(states.at(-1).age,'WAITING');
});
