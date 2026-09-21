import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveGlobe} from '../../../../digital_twin/visualization/web/globe.js';
import {CameraRangeMotion} from '../../../../digital_twin/visualization/web/camera_motion.js';
import {FrameTiming} from '../../../../digital_twin/visualization/web/frame_timing.js';
import {CameraEnvironment} from '../../../../digital_twin/visualization/web/camera_environment.js';

const magnitude=v=>Math.hypot(v.x,v.y,v.z);
// The east-north-up frame is a pure translation here: enough for the camera
// logic, which only needs the offset to invert exactly.
class Cartesian3 {
 constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z});}
 static clone(from,result={}){return Object.assign(result,{x:from.x,y:from.y,z:from.z});}
 static distance(a,b){return Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);}
 static magnitude(v){return magnitude(v);}
 static fromRadians(longitude,latitude,height){return {longitude,latitude,height};}
 static fromDegrees(longitude,latitude,height){return {longitude,latitude,height};}
}
class Matrix4 {
 constructor(){this.t={x:0,y:0,z:0};}
 static inverseTransformation(m,result){result.t={x:-m.t.x,y:-m.t.y,z:-m.t.z};return result;}
 static multiplyByPoint(m,p,result){result.x=p.x+m.t.x;result.y=p.y+m.t.y;result.z=p.z+m.t.z;return result;}
}
Matrix4.IDENTITY={identity:true};

function cameraHarness({height=50000,heading=0,pitch=-.5,groundHeight=0,selected='a',tracking=true,now=()=>0}={}) {
 const globe=Object.create(LiveGlobe.prototype);
 const camera={heading,pitch,roll:0,transform:'world',
   positionCartographic:{height,longitude:.1,latitude:.2},position:{x:0,y:0,z:600},positionWC:{x:0,y:0,z:600},
   cancelFlight(){},
   lookAtTransform(matrix){this.transform=matrix;},
   directionWC:{x:0,y:0,z:-1},upWC:{x:0,y:1,z:0},
   computeViewRectangle(){return undefined;},getPickRay(){return undefined;},pickEllipsoid(){return undefined;},
   lookAt(target,offset){this.transform='object';this.lastTarget={...target};this.lastOffset={...offset};this.lookAts=(this.lookAts ?? 0)+1;if('z' in offset)this.position={x:offset.x,y:offset.y,z:offset.z};},
   setView({destination,orientation}){this.lastSetView={...destination};this.lastOrientation=orientation;this.setViews=(this.setViews ?? 0)+1;},
   flyTo(){},
   moveForward(delta){this.position.z-=delta;this.positionWC.z=this.position.z;}};
 const C={Cartesian3,Matrix4,Ellipsoid:{WGS84:{geodeticSurfaceNormal:(_p,r={})=>Object.assign(r,{x:0,y:0,z:1})}},
   Transforms:{eastNorthUpToFixedFrame(center,_e,result){result.t={x:center.x,y:center.y,z:center.z};return result;}},
   HeadingPitchRange:class{constructor(heading,pitch,range){Object.assign(this,{heading,pitch,range});}}};
 const selections=[];
 Object.assign(globe,{C,timing:new FrameTiming(),cameraEnvironment:new CameraEnvironment(),buildingAppearance:{},
   viewer:{camera,canvas:{style:{}},scene:{globe:{tilesLoaded:true,getHeight:()=>groundHeight}}},
   surface:{update:()=>true},buildings:{setSurfaceReady(){},update(){}},
   items:new Map([['a',{entity:{kind:'aircraft',entity_id:'a'},position:{x:0,y:0,z:0}}],
     ['s',{entity:{kind:'satellite',entity_id:'s'},position:{x:0,y:1000,z:0}}]]),
   selected,tracking,motion:new CameraRangeMotion({now}),scratch:{},center:{},lastLod:0,lastHoverPick:-Infinity,
   sceneMode:'3d',modeToken:0,modeTransition:null,approachDetail:0,pendingTiles:0,lastDetail:0,terrainFlat:false,savedTerrainProvider:null,onMode(){},onTerrainFlat(){},
   onView(){},
   onSelect(entity){selections.push(entity);},onHover(){},trajectory:{show(){},update(){},follow(){return false;},clear(){},destroy(){}},
   entityScene:{assets:new Map(),refreshPosition(){},updatePositions(){},updateLod(){},updateManualGround(){},applyVisibility(){},setHovered(){}}});
 return {globe,camera,C,selections};
}
// Completes the approach in a few frames, as the render loop would.
function land(globe,steps=4){
 const approach=globe.approach;if(!approach)return;
 for(let i=1;i<=steps;i++)globe.stepApproach(approach.startedAt+approach.duration*i/steps);
}

test('right click reopens tracked details without selecting or moving the camera',()=>{
 const {globe,camera}=cameraHarness(),opened=[];
 globe.pickEntity=()=>null;globe.onSelect=(entity,options)=>opened.push({entity,options});
 globe.handleRightClick({x:20,y:30});
 assert.equal(opened[0]?.entity.entity_id,'a');assert.equal(opened[0]?.options?.reopen,true);
 assert.equal(globe.selected,'a');assert.equal(globe.tracking,true);assert.equal(camera.lookAts,undefined);
 assert.equal(globe.approach,undefined);
});

test('right click inspects another object while keeping the tracked aircraft and live detail updates',()=>{
 const {globe,camera,selections}=cameraHarness();globe.pickEntity=()=> 's';
 globe.handleRightClick({x:20,y:30});
 assert.equal(selections.at(-1)?.entity_id,'s');assert.equal(globe.detailId,'s');
 assert.equal(globe.selected,'a');assert.equal(globe.tracking,true);assert.equal(camera.lookAts,undefined);
 globe.entityScene.replace=()=>{globe.items.get('s').entity={entity_id:'s',kind:'satellite',altitude_m:420000};};
 globe.replace({});assert.equal(selections.at(-1)?.altitude_m,420000);
 globe.focusDetail(true);assert.equal(globe.selected,'s');assert.ok(globe.approach);
});

test('empty right click without tracking does nothing and placement/editor tools retain priority',()=>{
 const {globe,selections}=cameraHarness({tracking:false});globe.pickEntity=()=>null;
 globe.handleRightClick({x:1,y:2});assert.equal(selections.length,0);
 globe.groundPick={};globe.pickEntity=()=> 'a';globe.handleRightClick({x:1,y:2});assert.equal(selections.length,0);
 globe.groundPick=null;let tools=0;globe.vertiportEditor={onContextMenu:()=>tools++};
 globe.viewer.scene.pick=()=>({id:'port'});globe.vertiportLayer={pick:()=>({id:'port'})};
 globe.handleRightClick({x:1,y:2});assert.equal(tools,1);assert.equal(selections.length,0);
});

test('removed inspected entity does not cancel camera tracking and normal selection clears inspection',()=>{
 const {globe,selections}=cameraHarness();globe.pickEntity=()=> 's';globe.handleRightClick({x:1,y:2});
 globe.entityScene.replace=()=>globe.items.delete('s');globe.replace({});
 assert.equal(globe.detailId,null);assert.equal(globe.tracking,true);assert.equal(selections.at(-1)?.entity_id,'a');
 globe.detailId='s';globe.select('a');assert.equal(globe.detailId,null);
});

test('removing a tracked aircraft keeps the separately inspected entity open',()=>{
 for(const drop of [false,true]){
  const {globe,selections}=cameraHarness();globe.pickEntity=()=> 's';globe.handleRightClick({x:1,y:2});
  globe.entityScene.replace=globe.entityScene.dropSource=()=>globe.items.delete('a');
  if(drop)globe.dropSource('scenario');else globe.replace({});
  assert.equal(globe.selected,null);assert.equal(globe.tracking,false);
  assert.equal(globe.detailId,'s');assert.equal(selections.at(-1)?.entity_id,'s');
 }
});

test('the approach starts from the pose the operator had and follows the moving object',()=>{
 const {globe,camera,C}=cameraHarness({tracking:false,selected:null});
 globe.select('a',{focus:true});
 assert.ok(globe.approach,'a pick starts an approach towards the object');
 assert.equal(camera.transform,C.Matrix4.IDENTITY,'the globe stays the frame until the approach lands');
 assert.equal(globe.tracking,false);assert.equal(globe.approaching,true);
 assert.deepEqual(camera.lastSetView,{x:0,y:0,z:600},'the first frame is where the camera already was');
 assert.deepEqual({...camera.lastOrientation.direction},{x:0,y:0,z:-1},'and looks where it looked: the object does not jump to the centre');
 globe.items.get('a').position.x=100;
 globe.stepApproach(globe.approach.duration/2);
 assert.ok(Math.abs(camera.lastSetView.x-100)<1e-9,'each frame is placed relative to the displayed position (heading 0: no east offset)');
 assert.equal(camera.lookAts,undefined,'no anchor while flying');
});
test('the approach lands anchored exactly at the framing on the latest displayed position',()=>{
 const {globe,camera}=cameraHarness({tracking:false,selected:null});
 globe.select('a',{focus:true});
 const end={...globe.approach.end};
 globe.items.get('a').position.x=250;
 land(globe);
 assert.equal(globe.approach,null);assert.equal(globe.tracking,true);assert.equal(globe.approaching,false);
 assert.equal(camera.transform,'object');
 assert.deepEqual(camera.lastTarget,{x:250,y:0,z:0},'the anchor uses the displayed position at arrival');
 for(const axis of ['x','y','z'])assert.ok(Math.abs(camera.lastOffset[axis]-end[axis])<1e-9,'no snap: the anchor offset is the framing itself');
 for(const axis of ['x','y','z'])assert.ok(Math.abs(camera.lastSetView[axis]-(globe.items.get('a').position[axis]+end[axis]))<1e-9,'the last flown pose is the anchored pose');
 assert.ok(Math.abs(magnitude(camera.lastOffset)-600)<1e-9,'aircraft approach distance');
});
test('a cockpit departure climbs in place before moving to external framing',()=>{
 const {globe,camera}=cameraHarness({tracking:false,selected:null});
 camera.positionWC={x:2,y:1,z:3};camera.position={x:2,y:1,z:3};
 globe.selected='a';globe.focus(true,0,{departure:true});
 assert.equal(globe.approach.departure,true);
 const start={...globe.approach.start};
 globe.stepApproach(globe.approach.duration*.16);
 const early=camera.lastSetView;
 assert.ok(Math.abs(early.x-start.x)<1e-9&&Math.abs(early.y-start.y)<1e-9,'no turn around the aircraft while clearing it');
 assert.ok(early.z>start.z,'the first movement is upward');
 land(globe,8);assert.equal(globe.tracking,true);
});
test('the distance closes monotonically and the view turns towards the object without ever turning away',()=>{
 const {globe,camera}=cameraHarness({tracking:false,selected:null,height:120000});
 camera.positionWC={x:-40000,y:0,z:120000};camera.position={x:-40000,y:0,z:120000};
 globe.select('a',{focus:true});
 let previousRange=Infinity,previousAngle=Infinity;
 for(let i=1;i<=30;i++){
  const approach=globe.approach;if(!approach)break;
  globe.stepApproach(approach.startedAt+approach.duration*i/30);
  const p=camera.lastSetView,range=magnitude(p);
  assert.ok(range<=previousRange+1e-6,'never backs away');previousRange=range;
  const d=camera.lastOrientation.direction,toTarget={x:-p.x,y:-p.y,z:-p.z};
  const angle=Math.acos(Math.min(1,(d.x*toTarget.x+d.y*toTarget.y+d.z*toTarget.z)/range));
  assert.ok(angle<=previousAngle+1e-9,'the object glides towards the centre');previousAngle=angle;
 }
 assert.ok(previousAngle<1e-9,'centred at the end');
 assert.ok(Math.abs(magnitude(camera.lastOffset)-600)<1e-9);
});
test('tracking frame and smooth zoom retain finite centered camera offset',()=>{
 let time=0;const {globe,camera}=cameraHarness({now:()=>time});
 globe.motion.moveTo(600,200);
 for(let i=0;i<120;i++){time+=16;globe.frame();assert.ok(Number.isFinite(camera.position.z));assert.ok(camera.position.z>=200);}
 assert.ok(camera.position.z<201);assert.deepEqual(camera.lastTarget,{x:0,y:0,z:0});assert.equal(globe.tracking,true);
});
test('picking the already orbited object toggles the orbit off instead of flying again',()=>{
 const {globe}=cameraHarness({tracking:false,selected:null});
 globe.select('a',{focus:true});land(globe);
 assert.equal(globe.tracking,true);
 globe.select('a',{focus:true});
 assert.equal(globe.approach,null);assert.equal(globe.tracking,false);
 assert.equal(globe.selected,'a','the detail selection is kept');
});
test('picking a different object moves the orbit centre to it',()=>{
 const {globe,camera}=cameraHarness({tracking:false,selected:null});
 globe.select('a',{focus:true});land(globe);
 globe.select('s',{focus:true});
 assert.equal(globe.approach.id,'s');
 land(globe);
 assert.deepEqual(camera.lastTarget,{x:0,y:1000,z:0});
 assert.equal(globe.selected,'s');
});

test('picking something already close keeps that distance instead of standing back',()=>{
 // The camera is 1,166 m from the satellite, inside the 1,500 m framing it
 // would otherwise be given. Backing away from the thing just clicked reads as
 // the view running off, so the pick only brings it to the centre.
 const near=cameraHarness({tracking:false,selected:null});
 near.globe.select('s',{focus:true});
 assert.ok(Math.abs(magnitude(near.globe.approach.end)-Math.hypot(1000,600))<1e-9,
   'the distance the operator had');
 assert.ok(Math.abs(near.globe.focusRange-Math.hypot(1000,600))<1e-9,'and that is the framing now');
 // From further out it still closes in to the framing.
 const far=cameraHarness({tracking:false,selected:null});
 far.camera.positionWC={x:0,y:0,z:50000};
 far.globe.select('s',{focus:true});
 assert.ok(Math.abs(magnitude(far.globe.approach.end)-1500)<1e-9,'satellite approach distance');
});
test('clearing the selection releases the object and returns rotation to the globe',()=>{
 const {globe,camera,C}=cameraHarness({tracking:false,selected:null});
 globe.select('a',{focus:true});land(globe);
 globe.select(null,{focus:true});
 assert.equal(globe.tracking,false);
 assert.equal(camera.transform,C.Matrix4.IDENTITY);
});
test('an interrupted approach anchors on the picked object at the distance reached',()=>{
 let time=0;const {globe,camera,selections}=cameraHarness({tracking:false,selected:null,now:()=>time});
 globe.select('a',{focus:true});
 time=globe.approach.duration/2;globe.stepApproach(time);
 const reached=magnitude(camera.lastSetView);
 globe.settleApproach();
 assert.equal(globe.approach,null);assert.equal(globe.tracking,true);assert.equal(globe.approaching,false);
 assert.equal(camera.transform,'object');
 assert.ok(Math.abs(magnitude(camera.lastOffset)-reached)<1e-6,'the interrupted distance is kept, not reset');
 assert.equal(selections.at(-1).entity_id,'a','the panel learns that the orbit has settled');
});
test('a programmatic selection does not move the camera on its own',()=>{
 const {globe}=cameraHarness({tracking:false,selected:null});
 globe.select('a');
 assert.equal(globe.approach ?? null,null,'no approach is started');
 assert.equal(globe.tracking,false);
});
test('the approach keeps the operator view direction instead of snapping north',()=>{
 const {globe}=cameraHarness({tracking:false,selected:null,heading:1.2,pitch:-Math.PI/2});
 globe.select('a',{focus:true});
 const end=globe.approach.end;
 assert.ok(end.x<0 && end.y<0,'heading 1.2 rad is kept: the camera stands south-west, looking north-east');
 assert.ok(Math.abs(end.z-Math.sin(1.4)*600)<1e-9,'a usable viewing angle, never a pure overhead dot');
});
test('a known model size sets the approach distance and keeps zoom outside the model',()=>{
 const {globe}=cameraHarness({tracking:false,selected:null});
 globe.entityScene.assets=new Map([['plane',{asset_id:'plane',size_m:37.5}]]);
 globe.items.get('a').assetId='plane';
 globe.select('a',{focus:true});
 assert.ok(Math.abs(magnitude(globe.approach.end)-300)<1e-9);
 land(globe);
 assert.equal(globe.focusSize,37.5,'the wheel floor keeps the camera outside the model');
});
test('a pick without orbit approaches and then releases the camera where it arrived',()=>{
 const {globe,camera,C}=cameraHarness({tracking:false,selected:'a'});
 globe.focus(false);
 assert.equal(globe.tracking,false);assert.equal(globe.approaching,false);assert.ok(globe.approach,'flying');
 land(globe);
 assert.equal(globe.tracking,false);assert.equal(camera.transform,C.Matrix4.IDENTITY);
});
test('a terrain clamp raises an orbiting camera without dropping the object anchor',()=>{
 const {globe,camera}=cameraHarness({tracking:false,selected:null,height:100,groundHeight:150});
 globe.select('a',{focus:true});land(globe);
 camera.position={x:10,y:20,z:300};
 const setViews=camera.setViews;
 globe.keepAboveGround();
 assert.equal(globe.tracking,true,'the object stays the rotation centre');
 assert.equal(camera.transform,'object');
 assert.deepEqual(camera.lastOffset,{x:10,y:20,z:370},'raised inside the object frame');
 assert.equal(camera.setViews,setViews,'the camera is not re-seated in world coordinates');
});
test('a terrain clamp without an orbit target still re-seats the free camera',()=>{
 const {globe,camera}=cameraHarness({tracking:false,selected:null,height:100,groundHeight:150});
 globe.keepAboveGround();
 assert.equal(camera.lastSetView.height,170);
});
test('north and top-down re-orient around the object while it is orbited',()=>{
 const {globe,camera}=cameraHarness({tracking:false,selected:null,heading:1.2,pitch:-.6});
 globe.select('a',{focus:true});land(globe);
 camera.positionWC={x:0,y:0,z:800};
 globe.orient(true);
 assert.equal(globe.tracking,true);
 assert.equal(camera.lastOffset.heading,0);
 assert.ok(Math.abs(camera.lastOffset.pitch+Math.PI/2)<1e-9);
 assert.equal(camera.lastOffset.range,800,'orienting does not change the distance');
});
test('home view releases the object and returns to the free camera',()=>{
 const {globe,camera,C}=cameraHarness({tracking:false,selected:null});
 globe.select('a',{focus:true});land(globe);
 globe.reset(true);
 assert.equal(globe.tracking,false);
 assert.equal(camera.transform,C.Matrix4.IDENTITY);
});
test('an approach superseded by a newer pick never anchors on the abandoned object',()=>{
 const {globe,camera}=cameraHarness({tracking:false,selected:null});
 globe.select('a',{focus:true});
 const first=globe.approach;
 globe.select('s',{focus:true});
 assert.notEqual(globe.approach,first);assert.equal(globe.approach.id,'s');
 land(globe);
 assert.equal(globe.tracking,true);
 assert.deepEqual(camera.lastTarget,{x:0,y:1000,z:0});
});
test('the render frame drives the approach and hands over to plain orbiting when it lands',()=>{
 let time=0;const {globe,camera}=cameraHarness({tracking:false,selected:null,now:()=>time});
 globe.select('a',{focus:true});
 const duration=globe.approach.duration;
 const originalNow=performance.now;performance.now=()=>time;
 try {
  for(time=16;time<duration+100;time+=16)globe.frame();
 } finally {performance.now=originalNow;}
 assert.equal(globe.approach,null);assert.equal(globe.tracking,true);
 assert.ok(Math.abs(magnitude(camera.lastOffset)-600)<1e-9);
 assert.deepEqual(camera.lastTarget,{x:0,y:0,z:0});
});

// Cesium loads tiles for wherever the camera is; its flight-preload camera is
// pointed at the landing view so the ground is ready when the approach ends.
test('the approach preloads the landing view and releases the preload when it lands',()=>{
 const {globe,camera}=cameraHarness({tracking:false,selected:null});
 Object.getPrototypeOf(camera).canPreloadFlight=function(){return false;};
 const pre={position:{},direction:{},up:{},right:{},frustum:{clone(result){result.cloned=true;return result;},computeCullingVolume(){return 'volume';}},
   get positionWC(){return this.position;},get directionWC(){return this.direction;},get upWC(){return this.up;}};
 camera.frustum={clone(result){result.cloned=true;return result;}};
 globe.C.Cartesian3.cross=(a,b,r)=>Object.assign(r,{x:a.y*b.z-a.z*b.y,y:a.z*b.x-a.x*b.z,z:a.x*b.y-a.y*b.x});
 globe.viewer.scene.preloadFlightCamera=pre;globe.viewer.scene.preloadFlightCullingVolume=undefined;
 globe.select('a',{focus:true});
 assert.equal(globe.viewer.scene.preloadFlightCullingVolume,'volume','the landing view is being preloaded');
 const end=globe.approach.end;
 for(const axis of ['x','y','z'])assert.ok(Math.abs(pre.position[axis]-end[axis])<1e-9,'the preload camera sits at the landing position');
 assert.ok(Math.abs(Math.hypot(pre.direction.x,pre.direction.y,pre.direction.z)-1)<1e-9);
 assert.equal(camera.canPreloadFlight(),true,'the preload pass runs: this approach counts as a flight');
 land(globe);
 assert.equal(globe.viewer.scene.preloadFlightCullingVolume,undefined,'released on landing');
 assert.equal(camera.canPreloadFlight(),false,'the engine answer is restored afterwards');
 globe.select(null);globe.select('a',{focus:true});
 assert.equal(globe.viewer.scene.preloadFlightCullingVolume,'volume','a new approach preloads again');
 globe.select(null);
 assert.equal(globe.viewer.scene.preloadFlightCullingVolume,undefined,'released when the selection is cleared mid-approach');
 assert.equal(camera.canPreloadFlight(),false);
});
test('a scene without a preload camera is left alone',()=>{
 const {globe}=cameraHarness({tracking:false,selected:null});
 globe.select('a',{focus:true});land(globe);
 assert.equal(globe.tracking,true);
});
test('selected model preparation is bounded and never blocks camera input',()=>{
 const {globe,camera}=cameraHarness({tracking:false,selected:null});
 let prepared=0;globe.entityScene.prepareFocus=item=>{prepared++;item.loading=true;return true;};
 globe.select('a',{focus:true});assert.equal(prepared,1);
 globe.stepApproach(200,{maxStep:50});assert.equal(globe.approach.progress,0);
 assert.deepEqual(camera.lastSetView,{x:0,y:0,z:600});
 globe.stepApproach(260,{maxStep:50});assert.equal(globe.approach.prepareUntil,0);
 globe.stepApproach(276,{maxStep:50});assert.ok(globe.approach.progress>0,'navigation resumes despite a still-loading model');
 globe.stopTracking();assert.equal(globe.approach,null);assert.equal(globe.approaching,false);
});
test('model readiness releases the preparation early and lost targets release all camera state',()=>{
 const {globe}=cameraHarness({tracking:false,selected:null});
 globe.entityScene.prepareFocus=item=>{item.loading=true;return true;};
 globe.select('a',{focus:true});globe.items.get('a').loading=false;
 globe.stepApproach(32,{maxStep:50});globe.stepApproach(48,{maxStep:50});assert.ok(globe.approach.progress>0);
 globe.items.delete('a');assert.equal(globe.stepApproach(64),false);
 assert.equal(globe.approaching,false);assert.equal(globe.approachDetail,0);
});
test('model preparation also allows its first GPU-ready frame, within the same bounded wait',()=>{
 const {globe}=cameraHarness({tracking:false,selected:null});
 const item=globe.items.get('a');item.model={ready:false};globe.entityScene.prepareFocus=()=>true;
 globe.select('a',{focus:true});globe.stepApproach(32,{maxStep:50});assert.ok(globe.approach.prepareUntil);
 item.model.ready=true;globe.stepApproach(48,{maxStep:50});assert.equal(globe.approach.prepareUntil,0);
 globe.stepApproach(64,{maxStep:50});assert.ok(globe.approach.progress>0);
});
test('a missed render cannot jump an approach to its end or corrupt the interrupted distance',()=>{
 const {globe,camera}=cameraHarness({tracking:false,selected:'a',now:()=>20000});
 globe.focus(true,0);globe.stepApproach(16,{maxStep:50});
 globe.stepApproach(20000,{maxStep:50});assert.equal(globe.approach.elapsed,66);
 assert.ok(globe.approach.progress<.01,'animation, not entity/replay time, is bounded');
 const reached=magnitude(camera.lastSetView);globe.settleApproach();
 assert.ok(Math.abs(magnitude(camera.lastOffset)-reached)<1e-6);
});

test('terrain detail relaxes during the approach and is restored when it lands or is abandoned',()=>{
 const {globe}=cameraHarness({tracking:false,selected:null});
 globe.select('a',{focus:true});
 assert.equal(globe.approachDetail,2,'full detail on the first frame');
 globe.stepApproach(globe.approach.duration*.35);
 assert.ok(globe.approachDetail>4,'coarser through the fast middle');
 land(globe);
 assert.equal(globe.approachDetail,0,'released on landing');
 globe.select(null);globe.select('a',{focus:true});globe.stepApproach(globe.approach.duration*.35);
 globe.select(null);
 assert.equal(globe.approachDetail,0,'released when the approach is abandoned');
});
test('the frame applies the adaptive detail, or the approach middle when that is coarser',()=>{
 const {globe}=cameraHarness();
 const terrain=globe.viewer.scene.globe;
 globe.detail={value:2.5,observed:[],observe(pending,height,now){this.observed.push([pending,height]);}};
 globe.pendingTiles=120;globe.approachDetail=0;globe.lastDetail=-1e9; // performance.now() may still be under 200 ms in a fresh Node process
 globe.frame();
 assert.equal(terrain.maximumScreenSpaceError,2.5,'the adaptive level is what the globe renders with');
 assert.deepEqual(globe.detail.observed.at(-1),[120,50000],'fed the pending tile count and the view height');
 globe.approachDetail=9;globe.frame();
 assert.equal(terrain.maximumScreenSpaceError,9,'an approach in its coarse middle overrides');
});
test('navigation defers GPU hover picks, resumes on idle, and never blocks armed editors',()=>{
 const {globe}=cameraHarness({tracking:false,selected:null});let picks=0,clears=0;
 globe.renderBudget={moving:true,update(){return this.moving?.85:1;}};
 globe.hoverPointer={x:10,y:10};globe.hoverDirty=true;
 globe.routeLayer={hovered:null,hover:()=>false,pick:()=>null};globe.vertiportLayer={hovered:null,setHovered:()=>false};
 globe.pickEntity=()=>null;globe.viewer.scene.pick=()=>{picks++;return null;};globe.onHover=()=>{clears++;};
 globe.frame();globe.frame();assert.equal(picks,0);assert.equal(clears,1);assert.equal(globe.hoverDirty,true);
 globe.renderBudget.moving=false;globe.lastHoverPick=-Infinity;globe.frame();assert.equal(picks,1);
 globe.renderBudget.moving=true;globe.routeEditor={};globe.hoverDirty=true;globe.lastHoverPick=-Infinity;
 globe.frame();assert.equal(picks,2,'route editing does not wait for the camera');
});
test('prediction requests are not quantized by the unrelated terrain surface timer',()=>{
 const {globe}=cameraHarness();let requests=0;
 globe.lastSurface=performance.now();globe.trajectory.update=()=>requests++;
 globe.frame();assert.equal(requests,1,'the prediction layer owns its rate limit even between surface scans');
});

test('a still pointer over something hovered is rechecked slowly; a moved pointer is picked at once',()=>{
 const {globe}=cameraHarness({tracking:false,selected:null});let picks=0,t=1000;
 const realNow=performance.now;performance.now=()=>t;
 try{
  globe.renderBudget={moving:false,update(){return 1;}};
  globe.hoverPointer={x:10,y:10};globe.hoverDirty=true;
  globe.routeLayer={hovered:null,hover:()=>false};globe.vertiportLayer={hovered:null,setHovered:()=>false};
  globe.viewer.scene.pick=()=>{picks++;return {id:'flight'};};
  globe.pickEntity=()=>null;globe.flightLayer={pick:()=>({plan:{}})};
  globe.frame();assert.equal(picks,1,'a pointer that moved is answered');
  for(t=1030;t<1300;t+=30)globe.frame();
  assert.equal(picks,1,'a pointer that stays where it is does not read the GPU back twelve times a second');
  t=1500;globe.frame();assert.equal(picks,2,'what is under a still pointer can move, so it is rechecked a few times a second');
  t=1600;globe.hoverDirty=true;globe.frame();assert.equal(picks,3,'a moved pointer is answered within a frame or two');
  t=1650;globe.hoverDirty=true;globe.frame();assert.equal(picks,3,'but never faster than the old 80 ms');
 } finally {performance.now=realNow;}
});

test('single-flight hover is rechecked under a stationary pointer and clears on leave',()=>{
 const {globe}=cameraHarness({tracking:false,selected:null});let hit=true,picks=0;
 globe.hoverPointer={x:10,y:10};globe.hoverDirty=true;
 globe.routeLayer={hovered:null,hover:()=>false};globe.vertiportLayer={hovered:null,setHovered:()=>false};
 globe.viewer.scene.pick=()=>{picks++;return {id:'flight'};};
 globe.pickEntity=()=>null;globe.flightLayer={pick:()=>hit?{plan:{}}:null};
 globe.frame();assert.equal(globe.viewer.canvas.style.cursor,'pointer');
 hit=false;globe.lastHoverPick=-Infinity;globe.frame();
 assert.equal(picks,2);assert.equal(globe.viewer.canvas.style.cursor,'');
 globe.hoverFlight=true;globe.clearHover();assert.equal(globe.hoverFlight,false);
});

test('flat ground swaps the terrain for the ellipsoid, hides buildings through the terrain gate, and restores on demand',()=>{
 const {globe}=cameraHarness();
 const worldTerrain={world:true};const flats=[];
 globe.C.EllipsoidTerrainProvider=class{constructor(){this.flat=true;}};
 globe.viewer.terrainProvider=worldTerrain;globe.viewer.scene.requestRender=()=>{};
 globe.terrain={ready:true,tileError:false,update(){},setTilesLoading(){}};globe.terrainFlat=false;globe.savedTerrainProvider=null;globe.onTerrainFlat=flat=>flats.push(flat);
 const gates=[];globe.surface={anchor:{},update(){throw Error('global tile-load readiness must not gate a city');}};
 globe.buildings.setSurfaceReady=ready=>gates.push(ready);
 globe.setTerrainEnabled(false);
 assert.equal(globe.viewer.terrainProvider.flat,true);assert.deepEqual(flats,[true],'reported flat');assert.equal(globe.surface.anchor,null);
 globe.lastSurface=-1e9;globe.frame();
 assert.equal(gates.at(-1),false,'buildings are gated off while the ground is flat: their bases are baked to World Terrain');
 globe.setTerrainEnabled(false);assert.deepEqual(flats,[true],'idempotent');
 globe.setTerrainEnabled(true);
 assert.equal(globe.viewer.terrainProvider,worldTerrain,'the World Terrain provider is restored, not recreated');assert.equal(flats.at(-1),false,'reported back on');
 globe.lastSurface=-1e9;globe.frame();assert.equal(gates.at(-1),true);
 globe.terrain.tileError=true;globe.viewer.scene.globe.tilesLoaded=false;
 globe.lastSurface=-1e9;globe.frame();assert.equal(gates.at(-1),true,'one distant failed tile must not hide valid local buildings');
});

// The markers that are drawn at a size on the ground need to know how much
// ground a pixel covers, and only the camera can answer that.
test('how much ground one pixel covers is measured from the camera and handed to the network',()=>{
 const {globe,camera}=cameraHarness();
 const asked=[];
 camera.frustum={getPixelDimensions:(width,height,distance,ratio,result)=>Object.assign(result,{x:distance/width,y:distance/height})};
 globe.viewer.canvas={style:{},clientWidth:1000,clientHeight:500};
 globe.viewer.scene.requestRender=()=>{};
 globe.routeLayer={setPixelScale:value=>{asked.push(value);return true;}};
 globe.pixelScratch={};
 globe.updateGroundScale();
 assert.equal(asked.at(-1),1.2,'600 m away over a 500 px view: 1.2 m to the pixel');
 camera.positionWC.z=6000;
 globe.updateGroundScale();
 assert.equal(asked.at(-1),12,'ten times as far away is ten times as much ground per pixel');
 globe.entryActive=true;
 globe.updateGroundScale();
 assert.equal(asked.length,2,'the arrival owns the camera: nothing is re-sized under it');
 globe.entryActive=false;
 camera.frustum=null;
 globe.updateGroundScale();
 assert.equal(asked.at(-1),0,'no frustum to ask, so nothing is measured; the layer keeps the size it had');
});

test('tracked camera spring smooths anchor only and resets on epoch changes',()=>{
 const {globe}=cameraHarness();globe.entityScene.samples={epoch:1,stateTime:100};
 const target={x:0,y:0,z:0};globe.springTarget(target,'a',0,100);
 target.x=10;const smoothed=globe.springTarget(target,'a',16,100);
 assert.ok(smoothed.x>0&&smoothed.x<10);assert.equal(target.x,10);
 globe.entityScene.samples.epoch=2;
 assert.equal(globe.springTarget(target,'a',32,100).x,10);
 globe.stopTracking();assert.equal(globe.trackingAnchor,null);
});

test('render tracking preserves the operator orbit while cushioning target jitter',t=>{
 let now=1000;t.mock.method(performance,'now',()=>now);
 const {globe,camera}=cameraHarness();camera.position={x:40,y:-60,z:80};
 globe.frame();globe.items.get('a').position.x=10;now=1016;globe.frame();
 assert.ok(camera.lastTarget.x>0&&camera.lastTarget.x<10);
 assert.deepEqual(camera.lastOffset,{x:40,y:-60,z:80});
 globe.entityScene.samples={epoch:3,stateTime:20};now=1032;globe.frame();
 assert.equal(camera.lastTarget.x,10);
});
test('single flight follow uses the same damped anchor and releases it cleanly',t=>{
 let frameNow=1000;t.mock.method(performance,'now',()=>frameNow);
 const {globe,camera,C}=cameraHarness({tracking:false,selected:null});
 globe.C={...C,Cartesian3:class extends Cartesian3{static fromDegrees(x,y,z){return {x,y,z};}},
  Matrix4:{...C.Matrix4,IDENTITY:C.Matrix4.IDENTITY,equals:(a,b)=>a===b},Math:{toRadians:d=>d*Math.PI/180}};
 globe.viewer.scene.requestRender=()=>{};
 const sample={position:{longitude:10,latitude:0,altitude_m:0},time_s:100};
 globe.followFlight(sample,{now:1000});assert.equal(globe.flightAnchor.x,10);
 // Feed a deterministic frame interval without a wall-clock sleep.
 sample.position.longitude=20;sample.time_s=101;
 globe.followFlight(sample,{now:1016});assert.ok(globe.flightAnchor.x>10&&globe.flightAnchor.x<20);
 for(frameNow=1032;frameNow<2500;frameNow+=16)globe.frame();
 assert.ok(Math.abs(globe.flightAnchor.x-20)<.001,'paused follow converges without more telemetry callbacks');
 sample.position.longitude=25;globe.followFlight(sample,{now:2510,reset:true});assert.equal(globe.flightAnchor.x,25);
 sample.time_s=0;sample.position.longitude=30;globe.followFlight(sample,{now:2526});assert.equal(globe.flightAnchor.x,30);
 globe.releaseFlight();assert.equal(globe.flightAnchor,null);assert.equal(globe.trackingAnchor,null);
});

test('arm distance is independent of lag to the aircraft',()=>{
 const {globe,camera}=cameraHarness();globe.trackingAnchor={x:0,y:0,z:0};
 camera.position={x:0,y:0,z:600};globe.items.get('a').position={x:100,y:0,z:0};
 assert.equal(globe.range(),600);
});

test('normal hover separates deck, aircraft and single flight without highlighting both',()=>{
 const {globe}=cameraHarness({tracking:false,selected:null});let picked={id:'deck'},entity=null,flight=null,portHover,aircraftHover;
 globe.hoverPointer={x:10,y:10};globe.hoverDirty=true;
 globe.routeLayer={hovered:null,hover:()=>false};
 globe.vertiportLayer={hovered:null,pick:p=>p?.id==='deck'?{id:'VP1'}:null,setHovered:id=>{portHover=id;return false;}};
 globe.viewer.scene.pick=()=>picked;
 globe.pickInteraction=(_p,p)=>{assert.notEqual(p?.id,'deck','nearby UAM selection must not steal a direct deck hover');return p;};
 globe.pickEntity=()=>entity;
 globe.entityScene.setHovered=id=>{aircraftHover=id;};
 globe.flightLayer={pick:()=>flight};
 globe.onHover=()=>{};
 globe.frame();assert.equal(portHover,'VP1');assert.equal(aircraftHover,null);assert.equal(globe.viewer.canvas.style.cursor,'pointer');
 picked={id:'plane'};entity='UAM1';globe.items.set('UAM1',{entity:{}});globe.lastHoverPick=-Infinity;globe.hoverDirty=true;
 globe.frame();assert.equal(aircraftHover,'UAM1');assert.equal(portHover,null);
 entity=null;flight={};globe.lastHoverPick=-Infinity;globe.hoverDirty=true;globe.frame();assert.equal(portHover,null);
 flight=null;picked=null;globe.lastHoverPick=-Infinity;globe.hoverDirty=true;globe.frame();assert.equal(portHover,null);assert.equal(globe.viewer.canvas.style.cursor,'');
});

test('tracking stays near screen centre through acceleration, braking and speed changes',()=>{
 const {globe}=cameraHarness();const range=50,target={x:0,y:0,z:0};
 globe.springTarget(target,'a',0,range);
 let maxError=0;
 for(let i=1;i<=360;i++){
  if(i<120)target.x+=i*.05;else if(i<240)target.x+=12;
  const anchor=globe.springTarget(target,'a',i*1000/60,range);
  maxError=Math.max(maxError,Cartesian3.distance(anchor,target));
 }
 assert.ok(maxError<=range*.003+1e-8,`lag ${maxError}m must be below 0.3% of viewing distance`);
});

test('small position vibration is still damped inside the centre-lock tolerance',()=>{
 const {globe}=cameraHarness();let input=0,output=0;
 globe.springTarget({x:0,y:0,z:0},'a',0,100);
 for(let i=1;i<=240;i++){
  const x=.05*Math.sin(2*Math.PI*8*i/60),anchor=globe.springTarget({x,y:0,z:0},'a',i*1000/60,100);
  if(i>60){input+=x*x;output+=anchor.x*anchor.x;}
 }
 assert.ok(Math.sqrt(output/input)<.1);
});
