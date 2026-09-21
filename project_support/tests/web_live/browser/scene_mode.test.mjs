import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveGlobe} from '../../../../digital_twin/visualization/web/globe.js';
import {CameraRangeMotion} from '../../../../digital_twin/visualization/web/camera_motion.js';
import {CameraEnvironment} from '../../../../digital_twin/visualization/web/camera_environment.js';
import {FrameTiming} from '../../../../digital_twin/visualization/web/frame_timing.js';
import {mapOffset,mapWidthForRange,morphPromise,lockMapControls} from '../../../../digital_twin/visualization/web/scene_mode.js';

const SceneMode={MORPHING:0,SCENE2D:2,SCENE3D:3};
class Cartesian3 {
 constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z});}
 static clone(from,result={}){return Object.assign(result,{x:from.x,y:from.y,z:from.z});}
 static distance(a,b){return Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);}
 static magnitude(v){return Math.hypot(v.x,v.y,v.z);}
 static fromRadians(longitude,latitude,height){return {longitude,latitude,height};}
 static fromDegrees(longitude,latitude,height){return {longitude,latitude,height};}
}
class Matrix4 {
 constructor(){this.t={x:0,y:0,z:0};}
 static inverseTransformation(m,result){result.t={x:-m.t.x,y:-m.t.y,z:-m.t.z};return result;}
 static multiplyByPoint(m,p,result){result.x=p.x+m.t.x;result.y=p.y+m.t.y;result.z=p.z+m.t.z;return result;}
}
Matrix4.IDENTITY={identity:true};

// A scene that morphs the way Cesium 1.143 does from the outside: morphTo2D
// enters MORPHING at once; morphTo3D first flies in SCENE2D and only that
// flight's completion enters MORPHING; completeMorph settles either at once.
function harness({mode=SceneMode.SCENE3D,selected=null,tracking=false,pitch=-.5,now=()=>0}={}) {
 const globe=Object.create(LiveGlobe.prototype);
 const listeners=new Set();let pendingTarget=null;
 const flights=[];
 const camera={heading:.3,pitch,roll:0,transform:'world',frustum:{left:-500,right:500,bottom:-281,top:281},
   positionCartographic:{height:5000,longitude:.1,latitude:.2},position:{x:0,y:0,z:5000},positionWC:{x:0,y:0,z:5000},
   direction:null,up:null,right:null,
   getPickRay(){return undefined;},pickEllipsoid(){return undefined;},
   cancelFlight(){const pending=flights.filter(f=>!f.done);for(const f of pending){f.done=true;f.cancel?.();}},
   lookAtTransform(matrix){this.transform=matrix;},
   lookAt(target,offset){this.transform='object';this.lastTarget={...target};this.lastOffset={...offset};this.lookAts=(this.lookAts ?? 0)+1;},
   directionWC:{x:0,y:0,z:-1},upWC:{x:0,y:1,z:0},
   computeViewRectangle(){return undefined;},
   setView({destination,orientation}){this.lastSetView=destination;this.lastOrientation=orientation;},
   flyTo(options){const flight={...options,done:false};flights.push(flight);if(scene.mode===SceneMode.SCENE2D && scene.pending3D){flight.morphFlight=true;}},
   moveForward(delta){this.frustum.right-=delta/2;this.frustum.left+=delta/2;}};
 const scene={mode,pending3D:false,completeMorphOnUserInput:true,
   screenSpaceCameraController:{enableRotate:true,enableTilt:true,enableLook:true},
   globe:{tilesLoaded:true,getHeight:()=>0,pick:()=>undefined},
   morphComplete:{addEventListener(callback){listeners.add(callback);return ()=>listeners.delete(callback);}},
   completeMorph(){if(pendingTarget===null)return;camera.cancelFlight();this.mode=pendingTarget;pendingTarget=null;this.pending3D=false;for(const callback of [...listeners])callback();},
   morphTo2D(duration){this.completeMorph();if(this.mode===SceneMode.SCENE2D)return;this.lastDuration=duration;pendingTarget=SceneMode.SCENE2D;this.mode=SceneMode.MORPHING;},
   morphTo3D(duration){this.completeMorph();if(this.mode===SceneMode.SCENE3D)return;this.lastDuration=duration;pendingTarget=SceneMode.SCENE3D;this.pending3D=true;
     camera.flyTo({complete:()=>{scene.mode=SceneMode.MORPHING;}});},
   mapProjection:{project:(c,r={})=>{r.x=c.longitude*1e6;r.y=c.latitude*1e6;r.z=0;return r;}},
   pick(){return undefined;}};
 const C={Cartesian3,Matrix4,SceneMode,Ellipsoid:{WGS84:{geodeticSurfaceNormal:(_p,r={})=>Object.assign(r,{x:0,y:0,z:1})}},EasingFunction:{QUADRATIC_IN_OUT:'ease'},
   Cartographic:class{static fromCartesian(p,_e,result={}){result.longitude=.1;result.latitude=.2;result.height=p.z ?? 0;return result;}},
   Transforms:{eastNorthUpToFixedFrame(center,_e,result){result.t={x:center.x,y:center.y,z:center.z};return result;}},
   HeadingPitchRange:class{constructor(heading,pitch,range){Object.assign(this,{heading,pitch,range});}}};
 const modes=[],selections=[];
 Object.assign(globe,{C,timing:new FrameTiming(),cameraEnvironment:new CameraEnvironment(),buildingAppearance:{},onMode:m=>modes.push(m),
   viewer:{camera,canvas:{style:{},clientWidth:1000,clientHeight:562},scene},
   surface:{update:()=>true,anchor:{x:0,y:0,z:0}},buildings:{setSurfaceReady(){},update(){}},
   items:new Map([['a',{entity:{kind:'aircraft',entity_id:'a'},position:{x:0,y:0,z:0}}],
     ['s',{entity:{kind:'satellite',entity_id:'s'},position:{x:0,y:1000,z:0}}]]),
   selected,tracking,motion:new CameraRangeMotion({now}),scratch:{},center:{},lastLod:0,
   sceneMode:mode===SceneMode.SCENE2D?'2d':'3d',modeToken:0,modeTransition:null,focusSize:0,focusRange:0,
   onView(){},
   onSelect(entity){selections.push(entity);},onHover(){},trajectory:{show(){},update(){},follow(){return false;},clear(){},destroy(){}},
   entityScene:{assets:new Map(),refreshPosition(){},updatePositions(){},updateLod(){},updateManualGround(){},applyVisibility(){},setHovered(){},lodScan:null}});
 const finishFlights=()=>{for(const f of flights)if(!f.done){f.done=true;f.complete?.();}};
 const flush=()=>new Promise(resolve=>setImmediate(resolve));
 return {globe,camera,scene,C,flights,listeners,modes,finishFlights,flush};
}

test('helpers: a map offset is a width, a framing width follows the range, controls lock north-up',()=>{
 assert.deepEqual(mapOffset(1500),{x:0,y:0,z:1500});
 assert.equal(mapOffset(5).z,20,'a floor keeps the map from collapsing');
 assert.equal(mapWidthForRange(600),1200);assert.equal(mapWidthForRange(1),40);
 const controller={};lockMapControls(controller,true);
 assert.deepEqual(controller,{enableRotate:false,enableTilt:false,enableLook:false});
 lockMapControls(controller,false);assert.deepEqual(controller,{enableRotate:true,enableTilt:true,enableLook:true});
});

test('morphPromise settles on morphComplete and leaves no listener behind',async()=>{
 const listeners=new Set();let started=0;
 const scene={morphComplete:{addEventListener(cb){listeners.add(cb);return ()=>listeners.delete(cb);}}};
 const pending=morphPromise(scene,()=>{started++;});
 assert.equal(started,1);assert.equal(listeners.size,1);
 for(const cb of [...listeners])cb();
 await pending;assert.equal(listeners.size,0);
});

test('3D to 2D levels the camera first, then morphs, locks the map north-up and reports the mode',async()=>{
 const {globe,camera,scene,flights,modes,finishFlights,flush}=harness();
 const pending=globe.setSceneMode('2d');
 assert.equal(globe.transitioning,true);
 assert.equal(flights.length,1,'the camera is levelled before the globe unwraps');
 const level=flights[0];
 assert.equal(level.orientation.heading,0);assert.ok(Math.abs(level.orientation.pitch+Math.PI/2)<1e-9);
 assert.equal(level.destination.height,5000,'top-down at the distance already on screen: the camera height when nothing is picked under the centre');
 assert.equal(scene.mode,SceneMode.SCENE3D,'no morph until the camera is vertical');
 finishFlights();await flush();
 assert.equal(scene.mode,SceneMode.MORPHING);assert.equal(scene.lastDuration,1.1);
 scene.completeMorph();
 assert.equal(await pending,true);
 assert.equal(globe.sceneMode,'2d');assert.equal(globe.transitioning,false);
 assert.equal(scene.screenSpaceCameraController.enableRotate,false);assert.equal(scene.screenSpaceCameraController.enableTilt,false);
 assert.deepEqual({...camera.up},{x:0,y:1,z:0});assert.deepEqual({...camera.direction},{x:0,y:0,z:-1});
 assert.deepEqual(modes,['2d']);
 assert.equal(globe.surface.anchor,null,'the building gate waits for the map terrain, not the globe anchor');
});

test('an already vertical camera skips the levelling flight',async()=>{
 const {globe,scene,flights,finishFlights,flush}=harness({pitch:-Math.PI/2});
 const pending=globe.setSceneMode('2d');
 await flush();
 assert.equal(flights.length,0);assert.equal(scene.mode,SceneMode.MORPHING);
 scene.completeMorph();assert.equal(await pending,true);
});

test('2D to 3D morphs directly and unlocks rotation',async()=>{
 const {globe,scene,modes,finishFlights,flush}=harness({mode:SceneMode.SCENE2D});
 scene.screenSpaceCameraController.enableRotate=false;
 const pending=globe.setSceneMode('3d');
 await flush();
 finishFlights();
 assert.equal(scene.mode,SceneMode.MORPHING);
 scene.completeMorph();
 assert.equal(await pending,true);
 assert.equal(globe.sceneMode,'3d');assert.equal(scene.screenSpaceCameraController.enableRotate,true);
 assert.deepEqual(modes,['3d']);
});

test('a newer request supersedes an older one without leaving a listener or the old mode behind',async()=>{
 const {globe,scene,listeners,modes,finishFlights,flush}=harness();
 const first=globe.setSceneMode('2d');
 const second=globe.setSceneMode('3d');
 finishFlights();await flush();
 scene.completeMorph();
 assert.equal(await first,false,'the superseded request must not claim the scene');
 assert.equal(await second,true);
 assert.equal(scene.mode,SceneMode.SCENE3D);assert.equal(listeners.size,0);
 assert.equal(globe.transitioning,false);assert.deepEqual(modes,['3d']);
});

test('a pursuit survives the mode change, re-anchored at the scale on screen',async()=>{
 const {globe,camera,scene,finishFlights,flush}=harness({selected:'a',tracking:true});
 const pending=globe.setSceneMode('2d');
 finishFlights();await flush();scene.completeMorph();
 assert.equal(await pending,true);
 assert.equal(globe.tracking,true);
 assert.deepEqual(camera.lastTarget,{x:0,y:0,z:0});
 assert.deepEqual(camera.lastOffset,{x:0,y:0,z:1000},'the map is centred on the object at the current width');
});

test('while a transition runs the frame leaves the camera alone and input is ignored',async()=>{
 const {globe,camera,scene,finishFlights,flush}=harness({selected:'a',tracking:true});
 const pending=globe.setSceneMode('2d');
 const before=camera.lookAts ?? 0;
 globe.frame();
 assert.equal(camera.lookAts ?? 0,before,'no re-anchoring during the transition');
 assert.equal(globe.transitioning,true);
 finishFlights();await flush();scene.completeMorph();await pending;
 globe.frame();
 assert.equal(camera.lookAts,before+2,'the pursuit resumes once the mode settles');
});

test('on the map the range is the width, clamps and orientation are no-ops and a pick zooms by width',()=>{
 const {globe,camera}=harness({mode:SceneMode.SCENE2D});
 assert.equal(globe.range(),1000);
 globe.keepAboveGround();assert.equal(camera.lastSetView,undefined);
 globe.orient(true);assert.equal(camera.lookAts,undefined);
 globe.select('a',{focus:true});
 assert.equal(globe.approach.map,true);assert.equal(globe.approach.width0,1000);
 // 1,000 m across is already tighter than the 1,200 m the aircraft framing
 // would give, so the pick pans to it and leaves the width alone.
 assert.equal(globe.approach.width1,1000,'a tighter view is kept, not widened');
 assert.ok(Math.abs(camera.lastSetView.height-1000)<1e-9,'the pan and zoom starts at the current width');
 assert.ok(Math.abs(camera.lastSetView.longitude-.1)<1e-12,'and at the current centre');
 const approach=globe.approach;
 for(let i=1;i<=4;i++)globe.stepApproach(approach.startedAt+approach.duration*i/4);
 assert.equal(globe.tracking,true);assert.deepEqual(camera.lastOffset,{x:0,y:0,z:1000},'anchored on the object at that width');
});

test('on the map a pick from a wider view still zooms in to the framing',()=>{
 const {globe}=harness({mode:SceneMode.SCENE2D});
 globe.viewer.camera.frustum={left:-5000,right:5000,bottom:-2810,top:2810};
 assert.equal(globe.range(),10000);
 globe.select('a',{focus:true});
 assert.equal(globe.approach.width1,1200,'the framing width follows the aircraft range');
});

test('a 2D pursuit re-anchors at the map width every frame, never at a camera position',()=>{
 const {globe,camera}=harness({mode:SceneMode.SCENE2D,selected:'a',tracking:true});
 camera.position={x:0,y:0,z:12753274};
 globe.frame();
 assert.deepEqual(camera.lastOffset,{x:0,y:0,z:1000});
 assert.deepEqual(camera.lastTarget,{x:0,y:0,z:0});
});

test('the home view and the mode switch ignore each other while a transition runs',async()=>{
 const {globe,camera,scene,finishFlights,flush}=harness();
 const pending=globe.setSceneMode('2d');
 globe.reset();
 assert.equal(camera.lastSetView,undefined);
 finishFlights();await flush();scene.completeMorph();
 assert.equal(await pending,true);
});
