import test from 'node:test';
import assert from 'node:assert/strict';
import {SharedViewCamera,cropForAspect,frustumFovForCrop,shouldRenderNow,LENS_FOV_DEG,MAX_WAIT_MS,FIT_MARGIN_MS} from '../../../../digital_twin/visualization/web/shared_view_camera.js';

class V{constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z});}static clone(v,r){r=r??new V();r.x=v.x;r.y=v.y;r.z=v.z;return r;}}
const IDENTITY=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const matrix=[1,0,0,0,0,1,0,0,0,0,1,0,100,200,300,1];
const profile={forward:[1,0,0],up:[0,1,0]};

// A map scene the way the camera sees it: a canvas with pixels, a camera with
// a pose, listeners that must not hear the extra render, and a render that
// records what state it ran under. `frame()` is one map frame the way the
// widget runs it: preUpdate first (where an armed lens is drawn), then the
// map's own render.
function scene({width=3000,height=1200,timing=null}={}){
  const events={};for(const key of ['_preUpdate','_postUpdate','_preRender','_postRender'])events[key]={raiseEvent(){calls.push('event:'+key);},numberOfListeners:1};
  const calls=[];
  const camera={positionWC:new V(1,2,3),directionWC:new V(0,0,-1),upWC:new V(0,1,0),transform:IDENTITY.slice(),
    frustum:{fov:1.2,near:.02},_changed:{raiseEvent(){calls.push('camera:changed');},numberOfListeners:1},_changedPosition:'p0',_changedHeading:.5,
    setView({destination,orientation,endTransform}){camera.positionWC=destination;camera.directionWC=orientation.direction;camera.upWC=orientation.up;camera.transform=endTransform;calls.push('setView');}};
  const sc={...events,mode:3,camera,globe:{ellipsoid:{geodeticSurfaceNormal:()=>new V(0,0,1)},getHeight:()=>0},
    preRender:{addEventListener(fn){sc.preRenderListener=fn;return ()=>{sc.preRenderListener=null;};}},
    preUpdate:{addEventListener(fn){sc.preUpdateListener=fn;return ()=>{sc.preUpdateListener=null;};}},
    initializeFrame(){calls.push('initializeFrame');},
    render(time){calls.push('render:'+time);sc.renderedWith={position:{...camera.positionWC},direction:{...camera.directionWC},fov:camera.frustum.fov,near:camera.frustum.near,time,
      eventsSilent:['_preUpdate','_postUpdate','_preRender','_postRender'].every(k=>sc[k].numberOfListeners===0),changedSilent:camera._changed.numberOfListeners===0};
      if(sc.fail)throw new Error(sc.fail);}};
  // One map frame as the widget makes it: the scene's own render raises
  // preUpdate first, then draws with the listeners live.
  sc.frame=(time='t')=>{sc.preUpdateListener?.(sc,time);sc.preRenderListener?.();sc.render(time);calls.push('map:'+time);};
  const C={Cartesian3:V,Matrix4:{clone:m=>m.slice(),IDENTITY:IDENTITY.slice()},SceneMode:{SCENE3D:3},Cartographic:null};
  const canvas={width,height};
  const viewer={scene:sc,camera,canvas,clock:{currentTime:'t0'}};
  const globe={C,viewer,items:new Map(),timing:timing??{summary:()=>({p50Ms:33.3})}};
  const drawn=[];
  const panel={width:576,height:360,ownerDocument:{hidden:false},getContext:()=>({fillStyle:'',fillRect(){},fillText(){},font:'',drawImage(source,sx,sy,sw,sh,dx,dy,dw,dh){drawn.push({sx,sy,sw,sh,dx,dy,dw,dh,source});}})};
  return {globe,sc,camera,canvas,panel,calls,drawn,events};
}

test('the crop keeps the panel aspect centred and the frustum angle gives the crop the authored lens',()=>{
  assert.deepEqual(cropForAspect(3000,1200,576,360),{sx:540,sy:0,sw:1920,sh:1200});
  assert.deepEqual(cropForAspect(1000,1000,576,360),{sx:0,sy:187,sw:1000,sh:625});
  assert.equal(cropForAspect(0,1200,576,360),null);
  const crop=cropForAspect(3000,1200,576,360),fov=frustumFovForCrop(LENS_FOV_DEG,3000,1200,crop);
  // The crop is 1920 of 3000 pixels wide: its own horizontal angle must be 95 degrees.
  const cropAngle=2*Math.atan(Math.tan(fov/2)*crop.sw/3000)*180/Math.PI;
  assert.ok(Math.abs(cropAngle-LENS_FOV_DEG)<1e-9,`crop angle ${cropAngle}`);
  assert.ok(fov<Math.PI*.75);
  assert.ok(Math.abs(frustumFovForCrop(LENS_FOV_DEG,0,0,null)-LENS_FOV_DEG*Math.PI/180)<1e-12);
});

test('the extra render waits for room in the frame, and never for longer than the ceiling',()=>{
  const base={now:1000,last:0,interval:200,frameBudgetMs:33.3};
  assert.equal(shouldRenderNow({...base,now:150}),false,'not due yet');
  assert.equal(shouldRenderNow({...base,mainRenderMs:20,costMs:10}),true,'20 + 10 + margin fits 33');
  assert.equal(shouldRenderNow({...base,mainRenderMs:25,costMs:10}),false,'25 + 10 does not');
  assert.equal(shouldRenderNow({...base,mainRenderMs:25,costMs:10,now:MAX_WAIT_MS}),true,'the ceiling spends a frame anyway');
  assert.equal(shouldRenderNow({...base,mainRenderMs:NaN,costMs:NaN}),true,'nothing measured yet: draw');
  assert.equal(shouldRenderNow({...base,mainRenderMs:33.3-FIT_MARGIN_MS-10,costMs:10}),true,'exactly fits');
});

test('a camera frame renders the map scene from the lens with listeners silenced, then puts everything back',()=>{
  const {globe,sc,camera,panel,calls,drawn}=scene();
  const states=[];
  let now=0;
  const cam=new SharedViewCamera(globe,panel,s=>states.push(s),{cockpit:true,cleanFrame:true,now:()=>now});
  cam.set({enabled:true,mode:'front'});
  assert.equal(states.at(-1).age,'LOADING');
  // The map frame began 10 ms ago and cost 10 ms; a 33 ms display has room.
  sc.preRenderListener();now=10;
  cam.update({matrix,profile,entityId:'own',radius:5},now);
  assert.equal(cam.armed,true,'armed for the head of the next map frame');
  assert.equal(calls.filter(c=>c.startsWith('render:')).length,0,'nothing drawn in postRender itself');
  const before={position:{...camera.positionWC},direction:{...camera.directionWC},up:{...camera.upWC},fov:camera.frustum.fov,near:camera.frustum.near};
  now=12;sc.frame('t1');
  assert.deepEqual(calls.filter(c=>c.startsWith('event:')),[],'no scene listener heard the extra render');
  assert.deepEqual(calls.filter(c=>c==='camera:changed'),[]);
  assert.deepEqual(calls.filter(c=>c==='initializeFrame'),[],'the map\'s input step is not run a second time');
  const renders=calls.filter(c=>c.startsWith('render:'));
  assert.deepEqual(renders,['render:t1','render:t1'],'the lens render, then the map\'s own, in the same frame');
  assert.equal(calls.indexOf('render:t1')<calls.indexOf('map:t1'),true);
  // What the lens render ran under was recorded by the first render; the map's
  // own render then overwrote it with the restored pose.
  assert.deepEqual({...camera.positionWC},before.position);assert.deepEqual({...camera.directionWC},before.direction);assert.deepEqual({...camera.upWC},before.up);
  assert.equal(camera.frustum.fov,before.fov);assert.equal(camera.frustum.near,before.near);
  assert.equal(camera._changedPosition,'p0');assert.equal(camera._changedHeading,.5);
  assert.equal(camera._changed.numberOfListeners,1);
  for(const key of ['_preUpdate','_postUpdate','_preRender','_postRender'])assert.equal(sc[key].numberOfListeners,1);
  assert.deepEqual(drawn.map(d=>[d.sx,d.sy,d.sw,d.sh,d.dw,d.dh]),[[540,0,1920,1200,576,360]]);
  assert.equal(states.at(-1).age,'● 3D LIVE');assert.equal(cam.frameNumber,1);
  assert.ok(Number.isFinite(cam.cost));
  assert.equal(cam.armed,false);
});

test('the lens render itself runs from the lens pose with the authored frustum and the frame time',()=>{
  const {globe,sc,camera,panel}=scene();
  let now=0;const cam=new SharedViewCamera(globe,panel,()=>{},{now:()=>now});
  cam.set({enabled:true,mode:'front'});sc.preRenderListener();now=10;
  cam.update({matrix,profile,entityId:'own',radius:5},now);
  const before={...camera.positionWC};
  let lens=null;const render=sc.render;sc.render=time=>{render(time);lens??={...sc.renderedWith};};
  sc.preUpdateListener(sc,'t7');
  assert.equal(lens.eventsSilent,true);assert.equal(lens.changedSilent,true);
  assert.notDeepEqual(lens.position,before,'rendered from the lens, not from the pilot seat');
  assert.equal(lens.near,.15);assert.equal(lens.time,'t7','the same instant the map is about to draw');
  assert.ok(Math.abs(lens.fov-frustumFovForCrop(LENS_FOV_DEG,3000,1200,cropForAspect(3000,1200,576,360)))<1e-12);
  assert.deepEqual({...camera.positionWC},before,'put back before the map draws');
});

test('a belly view hides the own airframe for that one image only; a top view keeps it',()=>{
  const {globe,sc,panel}=scene();
  const own={show:true};globe.items.set('own',{model:own});
  let now=0;
  const cam=new SharedViewCamera(globe,panel,()=>{},{now:()=>now});
  let shownDuringRender=null;const render=sc.render;sc.render=t=>{shownDuringRender??=own.show;render(t);};
  cam.set({enabled:true,mode:'down'});sc.preRenderListener();now=5;
  cam.update({matrix,profile,entityId:'own',radius:5,model:own},now);sc.frame();
  assert.equal(shownDuringRender,false);assert.equal(own.show,true,'shown again before the map draws');
  shownDuringRender=null;
  cam.set({enabled:true,mode:'around'});sc.preRenderListener();now=2000;
  cam.update({matrix,profile,entityId:'own',radius:5,model:own},now);sc.frame();
  assert.equal(shownDuringRender,true);assert.equal(own.show,true);
  // A destroyed model is left alone.
  shownDuringRender=null;
  own.isDestroyed=()=>true;cam.set({enabled:true,mode:'down'});sc.preRenderListener();now=4000;
  cam.update({matrix,profile,entityId:'own',radius:5,model:own},now);sc.frame();
  assert.equal(shownDuringRender,true);
});

test('a render that throws still restores the camera and the listeners and reports no video',()=>{
  const {globe,sc,camera,panel}=scene();
  const states=[];let now=0;
  const cam=new SharedViewCamera(globe,panel,s=>states.push(s),{now:()=>now});
  cam.set({enabled:true,mode:'front'});sc.fail='context lost';sc.preRenderListener();now=5;
  const fov=camera.frustum.fov;
  cam.update({matrix,profile,entityId:'own'},now);
  assert.throws(()=>sc.frame(),/context lost/,'the map\'s own render in this stub throws too');
  assert.equal(states.at(-1).age,'NO VIDEO');
  assert.equal(camera.frustum.fov,fov);assert.equal(camera._changed.numberOfListeners,1);
  assert.equal(sc._postRender.numberOfListeners,1);
  assert.equal(cam.frameNumber,0);
});

test('while frames have no room the image is held, then drawn at the ceiling; off disarms a pending frame',()=>{
  const {globe,sc,panel,calls}=scene({timing:{summary:()=>({p50Ms:33})}});
  let now=0;
  const cam=new SharedViewCamera(globe,panel,()=>{},{now:()=>now});
  cam.set({enabled:true,mode:'front'});
  // First frame: nothing measured, so it draws, and its cost becomes known.
  sc.preRenderListener();now=30;cam.update({matrix,profile,entityId:'own'},now);sc.frame();
  assert.equal(cam.frameNumber,1);
  cam.cost=12;
  // The map now takes 30 of 33 ms: no room, and the interval has passed.
  for(let t=300;t<1400;t+=100){sc.preRenderListener();now=t+30;cam.update({matrix,profile,entityId:'own'},now);sc.frame();}
  assert.equal(cam.frameNumber,1,'held while nothing fits');
  now=30+MAX_WAIT_MS+1;sc.preRenderListener();now+=30;cam.update({matrix,profile,entityId:'own'},now);
  assert.equal(cam.armed,true,'drawn anyway at the ceiling');
  cam.stop();
  assert.equal(cam.armed,false);assert.equal(cam.enabled,false);
  const renders=calls.filter(c=>c.startsWith('render:')).length;
  sc.frame();
  assert.equal(cam.frameNumber,1,'a disarmed frame does not render after off');
  assert.equal(calls.filter(c=>c.startsWith('render:')).length,renders+1,'only the map\'s own render');
  cam.destroy();assert.equal(sc.preRenderListener,null);assert.equal(sc.preUpdateListener,null);
});

test('the pose is the same mount the second-context camera used, and a stale frame is said to be held',()=>{
  const {globe,sc,panel}=scene();
  const states=[];let now=0;
  const cam=new SharedViewCamera(globe,panel,s=>states.push(s),{now:()=>now});
  cam.set({enabled:true,mode:'front'});sc.preRenderListener();now=5;
  cam.update({matrix,profile,entityId:'own',radius:5,stale:true},now);sc.frame();
  assert.equal(states.at(-1).age,'HELD POSE');
  assert.ok(cam.lastPose&&cam.lastPose.mode==='front'&&cam.lastPose.position.length===3);
  // Without a profile there is no pose to draw from.
  now=1000;sc.preRenderListener();cam.update({matrix,entityId:'own'},now);sc.frame();
  assert.equal(states.at(-1).age,'WAITING');
});

test('a frame armed before the mode changed is not drawn as the old mode',()=>{
  const {globe,sc,panel,calls}=scene();
  let now=0;const cam=new SharedViewCamera(globe,panel,()=>{},{now:()=>now});
  cam.set({enabled:true,mode:'front'});sc.preRenderListener();now=5;
  cam.update({matrix,profile,entityId:'own'},now);
  cam.set({enabled:true,mode:'rear'});
  sc.frame();
  assert.equal(cam.frameNumber,0,'the frame armed for the old mode was dropped');
  assert.equal(calls.filter(c=>c.startsWith('render:')).length,1);
  sc.preRenderListener();now=400;cam.update({matrix,profile,entityId:'own'},now);sc.frame();
  assert.equal(cam.frameNumber,1);assert.equal(cam.lastPose.mode,'rear');
});
