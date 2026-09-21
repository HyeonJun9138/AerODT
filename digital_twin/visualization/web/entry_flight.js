// Camera-only arrival from the globe to Seoul, with a cushioned final descent.
const EARTH_RADIUS_M = 6371000;
// Far enough that the whole disc is in frame, and offset so the Earth turns
// under the fall rather than growing straight at the viewer.
const START_HEIGHT_M = 6371000 * 3.4;
const START_EAST_OFFSET_DEG = -34;
const START_SOUTH_OFFSET_DEG = -16;
export const ENTRY_SECONDS=6.4/1.5;
export const ENTRY_BRAKE_START=.7;
export const ENTRY_MAX_FRAME_MS=50;
const activeFlights=new WeakMap();
// Reduced motion is not "no arrival": the operating system's animation setting
// must not silently remove the entry the operator asked for. The descent from
// the globe stays; only the lateral sweep goes.

export function entryStart({longitude, latitude}, {reducedMotion = false} = {}) {
  if (reducedMotion) return {longitude, latitude, height: START_HEIGHT_M};
  return {
    longitude: ((longitude + START_EAST_OFFSET_DEG + 540) % 360) - 180,
    latitude: Math.max(-80, latitude + START_SOUTH_OFFSET_DEG),
    height: START_HEIGHT_M,
  };
}

export function planEntry(home, {reducedMotion=false}={}) {
  return {
    start: entryStart(home, {reducedMotion}),
    destination:{...home},
    duration:ENTRY_SECONDS,
    orientation: {heading: 0, pitch: -Math.PI / 2, roll: 0},
    earthRadius: EARTH_RADIUS_M,
  };
}

// Integrate a smooth velocity taper over the last 30%. Velocity AND acceleration
// meet the preceding constant log-zoom and the final rest without a seam. No
// overshoot, rebound, FOV effect or second flyTo at the end.
export function entryZoomProgress(t) {
  t=Math.min(1,Math.max(0,t));
  const a=ENTRY_BRAKE_START,w=1-a,normalizer=a+w/2;
  if(t<=a)return t/normalizer;
  const u=(t-a)/w;
  return (a+w*(u-u*u*u+.5*u*u*u*u))/normalizer;
}

export function entryView(plan,t) {
  if(t<=0)return {...plan.start};if(t>=1)return {...plan.destination};
  const {start,destination}=plan;
  const zoom=entryZoomProgress(t);
  const height=Math.exp(Math.log(start.height)*(1-zoom)+Math.log(destination.height)*zoom);
  // Finish the sideways sweep early, leaving a straight, gently braked arrival.
  const u=Math.min(1,t/.25),sweep=u*u*(3-2*u);
  const longitudeDelta=((destination.longitude-start.longitude+540)%360)-180;
  return {longitude:sweep===1?destination.longitude:start.longitude+longitudeDelta*sweep,
    latitude:sweep===1?destination.latitude:start.latitude+(destination.latitude-start.latitude)*sweep,height};
}

// Advance before Cesium updates its camera, culling and tile selection. A second
// browser animation loop can run after the scene has already rendered, leaving
// a camera pose and its rendered frame out of step at the hand-over.
// Hidden tabs pause the clock. Cancellation is reserved
// for application teardown; the UI deliberately exposes no skip control.
export const ENTRY = {
  placeStart(C, camera, plan) {
    const {longitude, latitude, height} = plan.start;
    camera.cancelFlight?.();
    camera.setView({destination:C.Cartesian3.fromDegrees(longitude, latitude, height),orientation:plan.orientation});
  },
  fly(C, camera, home, {reducedMotion=false,plan:suppliedPlan,onProgress,signal,scene,visibility=globalThis.document,page=globalThis.window,
    requestFrame=fn=>requestAnimationFrame(fn),cancelFrame=id=>cancelAnimationFrame(id),now=()=>performance.now()}={}) {
    if(signal?.aborted)return Promise.resolve('cancel');
    activeFlights.get(camera)?.();
    const plan = suppliedPlan ?? planEntry(home, {reducedMotion});
    const at = ({longitude, latitude, height}) => C.Cartesian3.fromDegrees(longitude, latitude, height);
    const sceneClock=Boolean(scene?.preUpdate?.addEventListener && scene?.postRender?.addEventListener);
    return new Promise((resolve,reject)=>{
      let ended=false,frame,elapsed=0,last=now(),finalFramePending=false;
      let removeUpdate,removeRendered,removeError;
      const finish=(result,error)=>{
        if(ended)return;ended=true;
        if(frame!==undefined)cancelFrame(frame);
        removeUpdate?.();removeRendered?.();removeError?.();
        visibility?.removeEventListener('visibilitychange',onVisibility);page?.removeEventListener('pagehide',stop);signal?.removeEventListener('abort',stop);
        if(activeFlights.get(camera)===stop)activeFlights.delete(camera);
        error?reject(error):resolve(result);
      };
      const stop=()=>finish('cancel'),onVisibility=()=>{
        last=now();
        if(!visibility?.hidden)scene?.requestRender?.();
      };
      const tick=timestamp=>{
        if(ended)return;
        const dt=Math.min(ENTRY_MAX_FRAME_MS,Math.max(0,timestamp-last));last=timestamp;
        if(!visibility?.hidden && !finalFramePending){
          elapsed+=dt;const t=Math.min(1,elapsed/(plan.duration*1000));
          try{
            const view=entryView(plan,t);
            camera.setView({destination:at(view),orientation:plan.orientation});onProgress?.(t);
          }
          catch(error){finish('error',error);return;}
          if(ended)return;
          if(t===1){
            if(sceneClock)finalFramePending=true;
            else {finish('complete');return;}
          }
        }
        if(sceneClock){if(!visibility?.hidden)scene.requestRender?.();}
        else frame=requestFrame(tick);
      };
      try{
        activeFlights.set(camera,stop);
        visibility?.addEventListener('visibilitychange',onVisibility);
        page?.addEventListener('pagehide',stop);signal?.addEventListener('abort',stop,{once:true});
        ENTRY.placeStart(C, camera, plan);
        if(ended)return;
        if(sceneClock){
          removeUpdate=scene.preUpdate.addEventListener(()=>tick(now()));
          removeRendered=scene.postRender.addEventListener(()=>{
            // Keep live layers and input locked until the destination has
            // actually been drawn, including in explicit rendering mode.
            if(finalFramePending && !visibility?.hidden)finish('complete');
          });
          removeError=scene.renderError?.addEventListener((_scene,error)=>finish('error',
            error instanceof Error?error:new Error('도입부 지도 렌더링에 실패했습니다.')));
          scene.requestRender?.();
        }else frame=requestFrame(tick);
      }catch(error){finish('error',error);}
    });
  },
};
