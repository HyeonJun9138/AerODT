import test from 'node:test';
import assert from 'node:assert/strict';
import {nextGpsRenderState,modelToEnuRotation,TwinningPreview,DEFAULT_DISPLAY_HEIGHT_M,DEFAULT_TEST_POSITION} from '../../../../digital_twin/visualization/web/twinning_map.js';
const fix=(alt=120,time=1,session=1)=>({session_id:session,gps_height_above_start_m:alt-120,gps:{latitude_deg:37,longitude_deg:127,altitude_m:alt,observed_at_unix_ms:time},sensors:{gps:{status:'receiving'}}});
test('no synthetic GPS position; stale first fix stays hidden',()=>{
 assert.equal(nextGpsRenderState(null,{}).position,null);
 const s=fix();s.sensors.gps.status='stale';assert.equal(nextGpsRenderState(null,s).position,null);
});
test('altitude is relative to first fix and negative delta clamps only drawing',()=>{
 let s=nextGpsRenderState(null,fix());assert.equal(s.position.height,0);
 s=nextGpsRenderState(s,fix(125,2));assert.equal(s.position.height,5);
 s=nextGpsRenderState(s,fix(118,3));assert.equal(s.heightDelta,-2);assert.equal(s.position.height,0);
});
test('stale freezes position and repeated timestamps do not append track',()=>{
 const s=nextGpsRenderState(null,fix());assert.equal(nextGpsRenderState(s,fix()).track.length,1);
 const stale=fix(300,2);stale.sensors.gps.status='stale';const frozen=nextGpsRenderState(s,stale);
 assert.deepEqual(frozen.position,s.position);assert.equal(frozen.track.length,1);
});
test('session resets track and uses server relative height, history bounded to 300',()=>{
 let s=nextGpsRenderState(null,fix());for(let i=2;i<400;i++)s=nextGpsRenderState(s,fix(120+i,i));
 assert.equal(s.track.length,300);const reset=fix(400,1,2);reset.gps_height_above_start_m=0;s=nextGpsRenderState(s,reset);assert.equal(s.position.height,0);assert.equal(s.track.length,1);
});
test('invalid GPS cannot create a point',()=>{const s=fix();s.gps.latitude_deg=100;assert.equal(nextGpsRenderState(null,s).position,null);});
test('canonical model nose north, left west and up up at identity FRD',()=>{
 const r=modelToEnuRotation([1,0,0,0]);assert.deepEqual(r.map(v=>Math.round(v)||0),[0,1,0,-1,0,0,0,0,1]);
 const east=modelToEnuRotation([1,0,0,0],90);assert.ok(Math.abs(east[0]-1)<1e-10);assert.ok(Math.abs(east[1])<1e-10);
});
test('close invalidates pending work and is idempotent',()=>{
 let destroyed=0;const p=new TwinningPreview({},{});p.widget={destroy(){destroyed++;}};p.close();p.close();assert.equal(destroyed,1);assert.equal(p.widget,null);
});
test('backend signed relative height is respected, including zero',()=>{
 const sample=fix(200);sample.gps_height_above_start_m=-5;
 let s=nextGpsRenderState(null,sample);assert.equal(s.heightDelta,-5);assert.equal(s.position.height,0);
 sample.gps.observed_at_unix_ms=2;sample.gps_height_above_start_m=0;s=nextGpsRenderState(s,sample);assert.equal(s.heightDelta,0);
});
test('unknown relative altitude never falls back to absolute GPS altitude',()=>{
 const missing=fix();missing.gps_height_above_start_m=null;
 assert.equal(nextGpsRenderState(null,missing).position,null);
 const valid=nextGpsRenderState(null,fix());missing.gps.observed_at_unix_ms=2;missing.gps.altitude_m=500;
 assert.equal(nextGpsRenderState(valid,missing),valid);
 delete missing.gps_height_above_start_m;assert.equal(nextGpsRenderState(null,missing).position,null);
});
test('attitude-only updates do not reset camera zoom; fresh fix preserves camera offset',()=>{
 class Matrix4{}Matrix4.fromRotationTranslation=()=>({});Matrix4.multiply=()=>({});Matrix4.IDENTITY={};
 let moves=0;const C={Cartesian3:{fromDegrees:(x,y,z)=>({x,y,z})},Matrix3:{fromArray:()=>({})},Matrix4,Transforms:{eastNorthUpToFixedFrame:()=>({})}};
 const p=new TwinningPreview(C,{});p.ready=true;p.model={};p.widget={scene:{requestRender(){}}};p.trackLine={};p.clearance=1;
 p.recenter=()=>moves++;p.followPosition=()=>moves++;
 p.update(fix());assert.equal(moves,1);p.update(fix());assert.equal(moves,1);
 p.update(fix(121,2));assert.equal(moves,2);p.setView('free');p.update(fix(122,3));assert.equal(moves,2);
});
test('follow transports actual camera offset instead of fixed heading/range',()=>{
 class Cartesian3{}class Matrix4{}
 const oldCenter={old:true},newCenter={new:true},actualCamera={zoom:321},offset={x:17,y:-200,z:250};let observed;
 Matrix4.IDENTITY={identity:true};Matrix4.inverseTransformation=matrix=>{assert.equal(matrix,oldCenter);return {inverse:true};};
 Matrix4.multiplyByPoint=(_matrix,point)=>{assert.equal(point,actualCamera);return offset;};
 const camera={positionWC:actualCamera,lookAt:(center,value)=>{observed={center,value};},lookAtTransform:matrix=>assert.equal(matrix,Matrix4.IDENTITY)};
 const p=new TwinningPreview({Cartesian3,Matrix4,Transforms:{eastNorthUpToFixedFrame:p=>p}},{});
 p.widget={scene:{camera}};p.center=newCenter;p.followPosition(oldCenter);assert.deepEqual(observed,{center:newCenter,value:offset});
});
test('session reconnect forgets camera center even in free view',()=>{
 const p=new TwinningPreview({},{});p.setView('free');p.update(fix());p.center={old:true};p.update({session_id:2});assert.equal(p.center,null);
});
test('late async model is destroyed after close; all lifecycle observers detached',async()=>{
 const saved={ResizeObserver:globalThis.ResizeObserver,document:globalThis.document};let disconnected=0,removed=0,destroyed=0,modelDestroyed=0,resolveModel;
 const event={addEventListener:()=>()=>{removed++;}};
 globalThis.ResizeObserver=class{observe(){}disconnect(){disconnected++;}};
 globalThis.document={hidden:false,addEventListener(){},removeEventListener(){removed++;}};
 const C={CesiumWidget:class{constructor(){this.scene={globe:{},renderError:event,primitives:{add:x=>x},requestRender(){}};this.imageryLayers={addImageryProvider(){}};}destroy(){destroyed++;}},
 EllipsoidTerrainProvider:class{},ArcGisMapServerImageryProvider:{fromUrl:async()=>({errorEvent:event})},
 PolylineCollection:class{add(x){return x;}},Material:{fromType:()=>({})},Color:{CYAN:{withAlpha:()=>({})}},Matrix4:{IDENTITY:{}}};
 try{
  const p=new TwinningPreview(C,{},()=>{},{loadModel:()=>new Promise(resolve=>{resolveModel=resolve;})});
  const showing=p.show({asset_id:'test',uri:'/visual-assets/test.glb'});p.close();resolveModel({destroy(){modelDestroyed++;}});await showing;
  assert.equal(destroyed,1);assert.equal(modelDestroyed,1);assert.equal(disconnected,1);assert.equal(removed,2);assert.equal(p.model,null);
 }finally{Object.assign(globalThis,saved);}
});

test('toy size scales geometry only and frames a sub-metre target',()=>{
 const p=new TwinningPreview({},{});p.model={scale:1,maximumScale:1};p.sourceRadius=20;p.sourceScale=1;
 p.setToySize(.3);
 assert.equal(p.model.scale,.0075);assert.equal(p.model.maximumScale,.0075);
 assert.ok(p.clearance<.03);assert.ok(p.range<2);
 p.setToySize(.6);assert.equal(p.model.scale,.015);
 assert.throws(()=>p.setToySize(0));
});
test('camera defaults locked and free view restores input',()=>{
 const p=new TwinningPreview({},{});assert.equal(p.view,'locked');
 const controller={enableInputs:true};p.widget={scene:{screenSpaceCameraController:controller}};
 p.recenter=()=>{};p.setView('locked');assert.equal(controller.enableInputs,false);
 p.setView('free');assert.equal(controller.enableInputs,true);
 p.setView('locked');assert.equal(controller.enableInputs,false);
});

test('model appears and camera centers at explicit default before GPS, then switches to GPS',()=>{
 class Matrix4{}Matrix4.fromRotationTranslation=()=>({});Matrix4.multiply=()=>({});
 const C={Cartesian3:{fromDegrees:(x,y,z)=>({x,y,z})},Matrix3:{fromArray:()=>({})},Matrix4,Transforms:{eastNorthUpToFixedFrame:()=>({})}};
 const p=new TwinningPreview(C,{});p.ready=true;p.model={};p.widget={scene:{requestRender(){}}};p.trackLine={};p.clearance=.018;
 let moves=0;p.recenter=()=>moves++;
 p.applyPose();assert.equal(p.model.show,true);assert.ok(Math.abs(p.center.y-37.5435)<.001);assert.equal(moves,1);
 assert.deepEqual(p.trackLine.positions,[]);assert.equal(p.gpsState,undefined);
 p.update(fix());assert.equal(p.center.y,37);assert.equal(moves,2);assert.equal(p.trackLine.positions.length,1);
});

test('a fix that carries no height at all is drawn at the viewing height, not withheld',()=>{
 // A simulator sends latitude and longitude and nothing else. That is a
 // position, and refusing to draw it leaves the operator with an empty map
 // while data is arriving. It is drawn at the default viewing height and the
 // height stays null, so nothing downstream can read a height never sent -- and
 // it is not put on the ground, which would read as landed.
 assert.equal(DEFAULT_DISPLAY_HEIGHT_M,300);
 assert.equal(DEFAULT_TEST_POSITION.height,DEFAULT_DISPLAY_HEIGHT_M,'the pre-GPS anchor sits there too');
 const flat={session_id:1,gps:{latitude_deg:37.5665,longitude_deg:126.978,observed_at_unix_ms:1},
  sensors:{gps:{status:'receiving'}}};
 const state=nextGpsRenderState(null,flat);
 assert.deepEqual(state.position,{latitude:37.5665,longitude:126.978,height:DEFAULT_DISPLAY_HEIGHT_M});
 assert.equal(state.heightDelta,null,'no height was sent, so none is reported');
 assert.equal(state.track.length,1);
 // An explicit null reads the same as an absent field.
 const explicit={...flat,gps:{...flat.gps,altitude_m:null,observed_at_unix_ms:2}};
 assert.equal(nextGpsRenderState(state,explicit).position.height,DEFAULT_DISPLAY_HEIGHT_M);
 // A sender that does report a height is still drawn at the height it reported.
 const reported={session_id:2,gps:{latitude_deg:37.5,longitude_deg:127,altitude_m:140,observed_at_unix_ms:1},
  gps_height_above_start_m:20,sensors:{gps:{status:'receiving'}}};
 assert.equal(nextGpsRenderState(null,reported).position.height,20,'a reported height is not overridden');
 // But a height that was sent and cannot be referenced is still withheld: that
 // is a baseline in dispute, not a position on the ground.
 const disputed={...flat,gps:{...flat.gps,altitude_m:500,observed_at_unix_ms:3},
  gps_height_above_start_m:null};
 assert.equal(nextGpsRenderState(null,disputed).position,null);
});

test('every sender gets its own model and trail; only the chosen one moves the camera',async()=>{
 // The primary sender is drawn from the top of the snapshot, where it always
 // was. The rest are added beside it, never followed, and removed when they go.
 class Matrix4{}Matrix4.fromRotationTranslation=()=>({});Matrix4.multiply=()=>({});Matrix4.IDENTITY={};
 const added=[],removed=[],lines=[];
 const C={Cartesian3:{fromDegrees:(x,y,z)=>({x,y,z})},Matrix3:{fromArray:()=>({})},Matrix4,
  Transforms:{eastNorthUpToFixedFrame:()=>({})},Material:{fromType:()=>({})},
  Color:{ORANGE:{withAlpha:()=>({})}}};
 let moves=0;
 const p=new TwinningPreview(C,{},()=>{},{loadModel:async(_C,_asset,id)=>({id,show:false})});
 p.ready=true;p.model={};p.trackLine={};p.clearance=1;p.asset={uri:'/visual-assets/a.glb'};
 p.sourceRadius=1;p.sourceScale=1;
 p.widget={scene:{requestRender(){},primitives:{add:m=>added.push(m),remove:m=>removed.push(m)}}};
 p.trackCollection={add:line=>{lines.push(line);return line;},remove:line=>{lines.splice(lines.indexOf(line),1);}};
 p.recenter=()=>moves++;p.followPosition=()=>moves++;

 const device=(id,lat,session=1)=>({device_id:id,session_id:session,quaternion_wxyz:[1,0,0,0],
  gps:{latitude_deg:lat,longitude_deg:127,observed_at_unix_ms:1},sensors:{gps:{status:'receiving'}}});
 const both={...device('A',37.5),devices:[device('A',37.5),device('B',37.6)],selected_device:'A'};
 p.update(both);
 await new Promise(r=>setTimeout(r,0));await new Promise(r=>setTimeout(r,0));
 assert.equal(p.others.size,1,'only the sender that is not primary gets a second model');
 assert.equal(added.length,1);assert.equal(lines.length,1,'and its own trail');
 const twin=p.others.get('B');
 assert.equal(twin.model.show,true);
 assert.ok(twin.gpsState.position,'drawn at its own fix');
 assert.equal(twin.gpsState.position.latitude,37.6);
 const cameraMoves=moves;
 p.update({...both,devices:[device('A',37.5),device('B',37.7)]});
 assert.equal(moves,cameraMoves,'a second sender moving never steals the camera');

 // A sender that stops being reported takes its model and trail with it.
 p.update({...device('A',37.5),devices:[device('A',37.5)],selected_device:'A'});
 assert.equal(p.others.size,0);assert.equal(removed.length,1);assert.equal(lines.length,0);

 // One sender is the shape it always was: nothing extra is created.
 p.update(fix());
 assert.equal(p.others.size,0);assert.equal(added.length,1);
});

test('default restores source scale for primary and other senders',()=>{
 const p=new TwinningPreview({},{});assert.equal(p.toySize,null);
 p.model={scale:.0075};p.sourceRadius=20;p.sourceScale=1;
 const other={model:{scale:.0075}};p.others.set('other',other);
 p.setToySize(null);
 assert.equal(p.model.scale,1);assert.equal(other.model.scale,1);
 assert.equal(p.range,120);assert.equal(p.clearance,2.4);
});
