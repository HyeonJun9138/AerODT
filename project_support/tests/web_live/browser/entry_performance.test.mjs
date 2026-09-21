import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {LiveGlobe} from '../../../../digital_twin/visualization/web/globe.js';
import {ENTRY} from '../../../../digital_twin/visualization/web/entry_flight.js';
import {CameraRenderBudget} from '../../../../digital_twin/visualization/web/render_budget.js';

test('covered preparation does not restore layers before the visible flight',async()=>{
 const original=ENTRY.fly;let calls=0,release;const gate=new Promise(r=>release=r),states=[];
 const layer={visible:true,setVisible(value){this.visible=value;}};
 const g={motion:{cancel(){}},stopTracking(){},entityScene:{layers:{}},routeLayer:layer,
  startArrivalFade(){},onEntry:active=>states.push(active),
  viewer:{camera:{},scene:{screenSpaceCameraController:{enableInputs:true},requestRender(){}}}};
 try{
  ENTRY.fly=async()=>{calls++;assert.equal(g.entryActive,true);assert.equal(layer.visible,false);return 'complete';};
  const flight=LiveGlobe.prototype.entry.call(g,{prepare:true,beforeReveal:()=>gate});
  await Promise.resolve();await Promise.resolve();assert.equal(calls,1);assert.equal(layer.visible,false);
  assert.deepEqual(states,[true]);release();await flight;
  assert.equal(calls,2);assert.equal(layer.visible,true);assert.deepEqual(states,[true,false]);
 }finally{ENTRY.fly=original;}
});

test('entry uses the approach pixel budget and bounded terrain refinement',()=>{
 const camera={positionWC:{x:1,y:2,z:3},directionWC:{x:0,y:0,z:-1},upWC:{x:0,y:1,z:0}};
 const budget=new CameraRenderBudget();budget.configure();
 const globe={entryActive:true,timing:{record(){},recentMs:40},renderBudget:budget,
  detail:{value:2},viewer:{camera,scene:{globe:{maximumScreenSpaceError:2}},resolutionScale:1}};
 LiveGlobe.prototype.frame.call(globe);
 assert.equal(budget.moving,true);assert.equal(globe.viewer.resolutionScale,.85);
 assert.equal(globe.viewer.scene.globe.maximumScreenSpaceError,8);
 globe.detail.value=12;LiveGlobe.prototype.frame.call(globe);
 assert.equal(globe.viewer.scene.globe.maximumScreenSpaceError,12);
});

test('entry frames do not start live LOD/model loads, building work, or camera clamps',()=>{
 {
  let measured=false;
  const globe={entryActive:true,timing:{record(){measured=true;}},viewer:{},
   entityScene:{updatePositions(){throw new Error('Live render work during entry');}}};
  LiveGlobe.prototype.frame.call(globe);assert.equal(measured,true);
 }
});
test('entry completion and teardown restore input and visibility without changing layer choices',async()=>{
 const original=ENTRY.fly;
 try{
  for(const failed of [false,true]){
   let finish;const labelSuppression=[];
   ENTRY.fly=()=>new Promise((resolve,reject)=>{finish=()=>failed?reject(new Error('render failed')):resolve('complete');});
   const collection=show=>({show,isDestroyed:()=>false});
   const layer={visible:false,points:collection(false),labels:collection(false),models:collection(false),billboards:collection(true)};
   // The order of the hand-over is the whole point: what the arrival held back
   // becomes visible, the fade is run over it so it stands at nothing, and only
   // then is a frame asked for. A frame in between is drawn at full strength,
   // which is the flash that used to be seen before the network faded in.
   const order=[];
   const infrastructure=visible=>({visible,setVisible(v){this.visible=v;order.push('visibility restored');}});
   const g={motion:{cancel(){}},stopTracking(){},entityScene:{layers:{aircraft:layer}},
    placeLabels:{setSuspended(value){labelSuppression.push(value);}},
    routeLayer:infrastructure(true),vertiportLayer:infrastructure(false),
    startArrivalFade(){order.push('faded to nothing');},
    viewer:{camera:{},scene:{globe:{maximumScreenSpaceError:3},screenSpaceCameraController:{enableInputs:true},requestRender(){order.push('rendered');}}}};
   const pending=LiveGlobe.prototype.entry.call(g);
   assert.equal(g.routeLayer.visible,false);assert.equal(g.viewer.scene.screenSpaceCameraController.enableInputs,false);
   assert.equal(layer.visible,false);assert.equal(g.entryActive,true);
   assert.equal(layer.billboards.show,false,'glyphs are also suppressed during the camera arrival');
   assert.deepEqual(labelSuppression,[true]);
   // Only the hand-over is being ordered; hiding on the way in is already
   // asserted above by what the layers and collections hold.
   order.length=0;
   g.viewer.scene.globe.maximumScreenSpaceError=8;
   finish();if(failed)await assert.rejects(pending,/render failed/);else await pending;
   assert.equal(g.viewer.scene.globe.maximumScreenSpaceError,3);
   assert.equal(g.routeLayer.visible,true);assert.equal(g.vertiportLayer.visible,false);
   assert.equal(layer.points.show,false);assert.equal(layer.visible,false);
   assert.equal(layer.billboards.show,true,'original collection choices are restored');
   assert.equal(g.viewer.scene.screenSpaceCameraController.enableInputs,true);
   assert.equal(g.entryActive,false);
   assert.deepEqual(labelSuppression,[true,false]);
   assert.deepEqual(order,['visibility restored','visibility restored','faded to nothing','rendered']);
  }
 }finally{ENTRY.fly=original;}
});

test('fade hook is registered before Cesium installs its entity visualizer tick',()=>{
 const source=readFileSync(new URL('../../../../digital_twin/visualization/web/globe.js',import.meta.url),'utf8');
 assert.ok(source.indexOf('this.removeAnnotationTick=clock.onTick.addEventListener')<source.indexOf('this.viewer = new C.Viewer'));
 assert.match(source,/clockViewModel:this\.annotationClock/);
 assert.match(source,/this\.removeAnnotationTick\?\.\(\);this\.annotationClock\?\.destroy\(\)/);
});

test('initial network waits for port heights and superseded networks never draw',async()=>{
 let ready;const calls=[];
 const g={portsReady:new Promise(r=>ready=r),routeLayer:{async show(network){calls.push(network);}},
  viewer:{scene:{requestRender(){}},isDestroyed:()=>false},updateGroundScale(){}};
 const first=LiveGlobe.prototype.showRoutes.call(g,'old');
 const second=LiveGlobe.prototype.showRoutes.call(g,'new');
 await Promise.resolve();assert.deepEqual(calls,[]);
 ready();await Promise.all([first,second]);assert.deepEqual(calls,['new']);
});
test('setting a catalogue only configures live assets; it does not preload intro GLBs',()=>{
 let received;
 const g={entityScene:{setAssets(catalog){received=catalog;}}},catalog={schema_version:1,assets:[]};
 LiveGlobe.prototype.setAssets.call(g,catalog);assert.equal(received,catalog);
 assert.deepEqual(Object.keys(g),['entityScene']);
});
test('the app no longer blocks startup on intro models or exposes an intro-model badge',()=>{
 const read=name=>readFileSync(new URL(`../../../../${name}`,import.meta.url),'utf8');
 const app=read('user_application/web/app.js'),globe=read('digital_twin/visualization/web/globe.js');
 const html=read('user_application/web/index.html');
 assert.doesNotMatch(app+globe,/entryFlyby|EntryFlyby|entry_flyby|onWarmup|도입부 3D 모델|prepareEntry|entryGroundHeight/);
 assert.doesNotMatch(html,/entry-cinematic|연출용 모델/);
 const assetsBranch=app.slice(app.indexOf("if(results[0].status"),app.indexOf("if(results[1].status"));
 assert.doesNotMatch(assetsBranch,/throw new Error/);
 assert.match(assetsBranch,/report\('assets'/);assert.match(assetsBranch,/warning\(/);
});

test('entry restores shared UAM/drone/bird collections exactly once on success and failure',async()=>{
 const original=ENTRY.fly;
 try{
  for(const fail of [false,true]){
   ENTRY.fly=()=>fail?Promise.reject(new Error('entry interrupted')):Promise.resolve();
   let restores=0;
   const collection=show=>({get show(){return show;},set show(v){show=v;if(v)restores++;},isDestroyed:()=>false});
   const layer={visible:true,points:collection(true),billboards:collection(true),labels:collection(true),models:collection(true)};
   const g={motion:{cancel(){}},stopTracking(){},entityScene:{layers:{uam:layer,drone:layer,bird:layer}},
    startArrivalFade(){},viewer:{camera:{},scene:{screenSpaceCameraController:{enableInputs:true},requestRender(){}}}};
   const pending=LiveGlobe.prototype.entry.call(g);
   for(const key of ['points','billboards','labels','models'])assert.equal(layer[key].show,false);
   if(fail)await assert.rejects(pending,/entry interrupted/);else await pending;
   for(const key of ['points','billboards','labels','models'])assert.equal(layer[key].show,true,`${key} must be visible without a manual UAM toggle`);
   assert.equal(restores,4);
  }
 }finally{ENTRY.fly=original;}
});
