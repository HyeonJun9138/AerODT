// The cockpit's external camera, drawn from the map's own scene.
//
// The first external camera was a second Cesium context: its own terrain
// cache, its own imagery, its own copies of the buildings and the aircraft,
// its own compiled programs. Everything the map had already loaded was loaded
// again, decoded again and uploaded again for a 576-pixel window, and every
// new program it met was a Direct3D link wait on the main thread (measured at
// 1.8 s of links and 3 s of long tasks for one opening). It also never quite
// caught up: a lens moving at forty metres a second over a city needs the
// tiles under it now, and by the time they arrived it was somewhere else, so
// the window showed a coarse, half-empty ground with the wrong buildings.
//
// WebGL cannot share a texture or a buffer between two contexts, so the only
// way to reuse what the map has is to draw the camera view with the map's own
// scene: move its camera to the lens, render once, copy the pixels out, put
// the camera back. Every tile, building, deck and aircraft the map holds is
// in the image at once, and nothing is loaded twice.
//
// That render costs what one map frame costs, and it runs on the main thread.
// So it is scheduled, not timed: the cockpit asks for it after the map's
// postRender, and only when the last map frame left enough of the display
// interval to fit it. When nothing fits for a while it is drawn anyway, so an
// image that stops is never the outcome, just a slower one.
//
// Where it is drawn matters as much as when. The lens image goes into the
// map's own canvas, and whatever is in that canvas when the browser composes
// the frame is what the operator sees. Drawing it in an animation frame of
// its own let it reach the screen: the map's loop does not draw on every
// display frame (globe.js sets `targetFrameRate` below the display rate on a
// slow machine, and hides the loop while the page is hidden), so a lens image
// drawn in a frame the map skipped stayed on the main screen until the next
// map frame -- a flicker of the camera view over the map. The lens is now
// drawn at the head of the map's own frame, in the `preUpdate` the scene
// raises first thing inside its render, so the map's own render follows in
// the same task and the canvas never leaves that task showing the lens.
//
// Nothing here changes what the map shows. The scene's own listeners are kept
// out of the extra render, the map's input step (`initializeFrame`) is not run
// a second time, the camera is put back exactly, and a model hidden for a
// belly view is shown again before the map draws.
import {airframeCameraPose,protectCameraSurface,cockpitFramePacing,FRAME_MIN_MS} from './airframe_camera.js';

const LABELS={front:'FWD',right:'RGT',rear:'AFT',left:'LFT',down:'DOWN',around:'TOP'};
// The lens as authored: the same wide angle the second context drew with.
export const LENS_FOV_DEG=95;
// The camera may not be put off for longer than this whatever the frames are
// doing: past it, a frame is spent on it even if that frame runs long.
export const MAX_WAIT_MS=1500;
// Room left in the display interval after the map's own render for the extra
// one to fit without the frame running over. Frame times are a little noisy,
// so a small margin is kept.
export const FIT_MARGIN_MS=1.5;
export const DEFAULT_FRAME_BUDGET_MS=1000/60;

// The pixels of the map canvas that carry the panel's aspect, centred.
export function cropForAspect(width,height,targetWidth,targetHeight){
  if(!(width>0&&height>0&&targetWidth>0&&targetHeight>0))return null;
  const target=targetWidth/targetHeight,source=width/height;
  if(source>target){const sw=Math.round(height*target);return {sx:Math.floor((width-sw)/2),sy:0,sw,sh:height};}
  const sh=Math.round(width/target);return {sx:0,sy:Math.floor((height-sh)/2),sw:width,sh};
}
// The frustum angle that gives the cropped region the authored lens. Cesium
// applies `fov` to the wider side of the canvas; the crop keeps the full
// height (or width) and a fraction of the other, so the full-canvas angle is
// what makes the fraction come out at the lens angle.
export function frustumFovForCrop(lensDeg,width,height,crop){
  const lens=Math.tan(lensDeg*Math.PI/360);
  if(!crop||!(width>0&&height>0))return lensDeg*Math.PI/180;
  const wide=width>=height;
  const fraction=wide?crop.sw/width:crop.sh/height;
  // The lens angle is the crop's wider side. When the crop is wider than
  // tall the lens spans its width, which is `fraction` of the canvas width.
  const cropWide=crop.sw>=crop.sh;
  let full;
  if(wide===cropWide)full=2*Math.atan(lens/Math.max(1e-6,fraction));
  else{
    // The canvas is wide but the crop is tall (or the reverse): the lens spans
    // the crop's other side, which is the canvas's full other side.
    const ratio=wide?crop.sh/crop.sw:crop.sw/crop.sh;
    full=2*Math.atan(lens*ratio/Math.max(1e-6,fraction));
  }
  return Math.min(Math.PI*.75,Math.max(.1,full));
}
// Whether the extra render is made this frame.
export function shouldRenderNow({now,last=-Infinity,interval=FRAME_MIN_MS,mainRenderMs=NaN,costMs=NaN,frameBudgetMs=DEFAULT_FRAME_BUDGET_MS,maxWaitMs=MAX_WAIT_MS}){
  const waited=now-last;
  if(!(waited>=interval))return false;
  if(waited>=maxWaitMs)return true;
  if(!Number.isFinite(mainRenderMs)||!Number.isFinite(costMs))return true;
  return mainRenderMs+costMs+FIT_MARGIN_MS<=frameBudgetMs;
}
const SILENT={raiseEvent(){},numberOfListeners:0};
const EVENTS=['_preUpdate','_postUpdate','_preRender','_postRender'];
const CHANGED=['_changedPosition','_changedDirection','_changedHeading','_changedRoll','_changedFrustum'];

export class SharedViewCamera {
  constructor(globe,canvas,onStatus=()=>{},options={}){
    Object.assign(this,{globe,canvas,onStatus,options});
    this.enabled=false;this.mode='front';this.generation=0;this.frameNumber=0;
    this.last=-Infinity;this.interval=FRAME_MIN_MS;this.cost=NaN;this.hostFrameMs=NaN;this.mainRenderMs=NaN;
    this.frameTimes=[];this.stats={fps:0,ms:0,last:0,duty:0};this.pendingFrame=null;this.armed=false;
    this.now=options.now??(()=>performance.now());
    const scene=globe?.viewer?.scene;
    // When the map's frame began, so the cost of its render is known by the
    // time the camera is asked to fit beside it.
    this.removePreRender=scene?.preRender?.addEventListener?.(()=>{this.frameStartedAt=this.now();});
    // The head of the map's frame: an armed lens is drawn here, and the map's
    // own render of the same frame follows in the same task.
    this.removePreUpdate=scene?.preUpdate?.addEventListener?.((_scene,time)=>this.onFrameStart(time));
  }
  set({enabled,mode='front'}){
    if(!enabled){this.stop();return;}
    if(mode!==this.mode)this.clear();
    this.mode=['front','rear','left','right','down','around'].includes(mode)?mode:'front';
    this.enabled=true;this.last=-Infinity;this.generation++;
    this.onStatus({text:'기체 시점 준비 · 지도 장면 공유',age:'LOADING'});
  }
  clear(){const c=this.canvas.getContext?.('2d');if(c){c.fillStyle='#08131b';c.fillRect(0,0,this.canvas.width,this.canvas.height);}}
  // Called once per map frame, after the map has rendered.
  update(frame,now=this.now()){
    const gap=now-(this.updatedAt??NaN);this.updatedAt=now;
    if(Number.isFinite(gap)&&gap>0&&gap<1000)this.hostFrameMs=Number.isFinite(this.hostFrameMs)?this.hostFrameMs*.8+gap*.2:gap;
    if(Number.isFinite(this.frameStartedAt)){const cost=now-this.frameStartedAt;if(cost>=0&&cost<1000)this.mainRenderMs=Number.isFinite(this.mainRenderMs)?this.mainRenderMs*.7+cost*.3:cost;}
    if(!this.enabled||this.canvas.ownerDocument?.hidden)return;
    this.pendingFrame=frame?.matrix?{...frame,matrix:this.globe.C.Matrix4.clone(frame.matrix)}:frame;
    if(this.armed)return;
    const budget=this.globe.timing?.summary?.()?.p50Ms;
    if(!shouldRenderNow({now,last:this.last,interval:this.interval,mainRenderMs:this.mainRenderMs,costMs:this.cost,
      frameBudgetMs:Number.isFinite(budget)&&budget>0?budget:DEFAULT_FRAME_BUDGET_MS}))return;
    this.armed=true;this.armedGeneration=this.generation;
  }
  // The scene's preUpdate: the first thing its render does, before the map's
  // own frame is drawn.
  onFrameStart(time){
    if(!this.armed)return;
    this.armed=false;
    const next=this.pendingFrame;this.pendingFrame=null;
    if(this.armedGeneration===this.generation&&this.enabled)this.renderFrame(next,this.now(),time);
  }
  cancelScheduled(){this.armed=false;this.pendingFrame=null;}
  // The scene's listeners and the camera's change tracking are kept out of
  // the extra render; both are put back before the map's own frame.
  silence(scene,camera){
    const saved={events:{},changed:{},changedEvent:camera?._changed};
    for(const key of EVENTS){saved.events[key]=scene[key];if(key in scene)scene[key]=SILENT;}
    if(camera&&'_changed' in camera){camera._changed=SILENT;for(const key of CHANGED)saved.changed[key]=camera[key];}
    return saved;
  }
  restore(scene,camera,saved){
    for(const key of EVENTS)if(key in saved.events)scene[key]=saved.events[key];
    if(camera&&'_changed' in camera){camera._changed=saved.changedEvent;for(const key of CHANGED)if(key in saved.changed)camera[key]=saved.changed[key];}
  }
  renderFrame(frame,now,time){
    if(!this.enabled||this.canvas.ownerDocument?.hidden)return;
    if(!frame?.matrix||!frame.profile){this.onStatus({text:'기체 시점 수신 대기',age:'WAITING'});return;}
    const g=this.globe,C=g.C,v=g.viewer,scene=v.scene,camera=v.camera;
    if(C.SceneMode&&scene.mode!==C.SceneMode.SCENE3D){this.onStatus({text:'3D 지구 보기에서만 외부 카메라를 그립니다',age:'WAITING'});return;}
    const source=v.canvas,width=source.width,height=source.height;
    if(!(width>0&&height>0)){this.onStatus({text:'카메라 표시 영역 준비 중',age:'WAITING'});return;}
    const ctx=this.canvas.getContext?.('2d');if(!ctx)return;
    const mode=this.mode,started=this.now();this.last=now;
    const normal=mode==='around'?scene.globe?.ellipsoid?.geodeticSurfaceNormal?.(new C.Cartesian3(frame.matrix[12],frame.matrix[13],frame.matrix[14])):null;
    let pose=airframeCameraPose(frame.matrix,frame.profile,mode,frame.radius,normal?[normal.x,normal.y,normal.z]:null);
    if(!pose){this.onStatus({text:'기체 시점 자세를 만들지 못했습니다',age:'WAITING'});return;}
    pose=protectCameraSurface(C,{...pose,mode},frame,scene.globe,scene.globe);
    const crop=cropForAspect(width,height,this.canvas.width,this.canvas.height);
    const fov=frustumFovForCrop(LENS_FOV_DEG,width,height,crop);
    const saved={position:C.Cartesian3.clone(camera.positionWC),direction:C.Cartesian3.clone(camera.directionWC),up:C.Cartesian3.clone(camera.upWC),
      fov:camera.frustum.fov,near:camera.frustum.near,transform:C.Matrix4.clone(camera.transform)};
    // A belly camera sits inside the fuselage: the own airframe is taken out of
    // that one image and put back before the map draws. Every other mount
    // stands off the airframe and shows it, which is the point of a top view.
    const own=frame.model??g.items?.get(frame.entityId)?.model,hideOwn=mode==='down'&&own&&!own.isDestroyed?.();
    const ownShown=hideOwn?own.show:undefined;
    const silenced=this.silence(scene,camera);
    let ok=false;
    try{
      if(hideOwn)own.show=false;
      camera.setView({destination:new C.Cartesian3(...pose.position),orientation:{direction:new C.Cartesian3(...pose.direction),up:new C.Cartesian3(...pose.up)},endTransform:C.Matrix4.IDENTITY});
      camera.frustum.fov=fov;camera.frustum.near=.15;
      // No `initializeFrame` here: that is the map's input step (tweens, the
      // screen-space controller, camera change events) and it has already run
      // for this frame. Running it again would apply the operator's drag to
      // the lens pose and lose it.
      scene.render(time??v.clock.currentTime);
      ctx.drawImage(source,crop.sx,crop.sy,crop.sw,crop.sh,0,0,this.canvas.width,this.canvas.height);
      ok=true;
    }catch(error){
      console.warn('[SharedViewCamera]',error);
      this.onStatus({text:'영상 오류 · '+String(error?.message??error),age:'NO VIDEO'});
    }finally{
      if(hideOwn)own.show=ownShown;
      camera.frustum.fov=saved.fov;camera.frustum.near=saved.near;
      camera.setView({destination:saved.position,orientation:{direction:saved.direction,up:saved.up},endTransform:saved.transform});
      this.restore(scene,camera,silenced);
    }
    if(!ok)return;
    this.frameNumber++;
    this.lastPose={frame:this.frameNumber,mode,position:pose.position,direction:pose.direction,up:pose.up,at:now};
    if(!this.options.cleanFrame){ctx.fillStyle='#051019d9';ctx.fillRect(0,0,this.canvas.width,20);ctx.font='11px Consolas,monospace';ctx.fillStyle='#d8fff3';ctx.fillText(LABELS[mode],8,14);}
    const ms=this.now()-started;
    this.cost=Number.isFinite(this.cost)?this.cost*.7+ms*.3:ms;
    this.interval=cockpitFramePacing(Math.max(this.cost,ms),this.hostFrameMs);
    this.frameTimes.push(now);while(this.frameTimes.length&&now-this.frameTimes[0]>2000)this.frameTimes.shift();
    const span=now-this.frameTimes[0];
    const fps=this.frameTimes.length>1&&span>0?Math.round((this.frameTimes.length-1)*1000/span):0;
    this.stats={fps,ms:Math.round(this.cost),last:Math.round(ms),duty:Math.round(fps*this.cost/10)};
    this.onStatus({fps:this.stats.fps,ms:this.stats.ms,last:this.stats.last,duty:this.stats.duty,
      age:frame.stale?'HELD POSE':'● 3D LIVE',
      text:frame.stale?'오래된 기체 위치 · 마지막 시점 유지':mode==='around'?'기체 상공 탑뷰 · 지도 장면 공유':'기체 장착 시점 · 지도 장면 공유'});
  }
  stop(){this.cancelScheduled();this.enabled=false;this.generation++;this.last=-Infinity;this.updatedAt=undefined;this.mainRenderMs=NaN;}
  attach(canvas){this.canvas=canvas;this.clear();}
  release(){this.stop();this.removePreRender?.();this.removePreRender=null;this.removePreUpdate?.();this.removePreUpdate=null;this.frameTimes=[];this.stats={fps:0,ms:0,last:0,duty:0};this.cost=NaN;this.hostFrameMs=NaN;this.clear();}
  destroy(){this.release();}
}
