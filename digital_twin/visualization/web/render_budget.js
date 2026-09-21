// Display-only budget: never cut viewing distance or alter source geometry.
// DOM text is independent of this buffer (map labels are briefly resampled).
// Prepare a smaller buffer for target approaches, adapt to sustained navigation
// load, and restore native resolution at rest. Ignore long scheduling gaps.
//
// A still view is deliberately never softened here, however slow it is: that is
// what `display_resolution` grades the display for. If a held view cannot carry
// its resolution, the base resolution is what is wrong, not this buffer.
//
// But coming back up is a step, not a snap. Handing the full buffer back the
// instant the camera settled, whatever the frames were doing, put the whole cost
// straight back on; the next touch of the camera took it off again 180 ms later,
// and with a nudge every couple of seconds the buffer swung 1.00 - 0.85 - 1.00
// without ever reaching the floor it was heading for. Simulated against this
// class: ten direction changes in twelve seconds, and a mean of 12.5 fps against
// the 15.9 fps the same scene held when the camera never stopped and the buffer
// simply stayed down. The operator sees that as the image surging and stalling.
const RESTORE_STEP_MS=400,RESTORE_STEP=.05;
// Ignore translation of the aircraft, not its rotation: a yaw exposes new
// city geometry even when the pilot never moves their head. Use the rendered
// camera basis so body attitude and head movement share the same budget.
export function cockpitBudgetPose(camera){
  const d=camera.directionWC,u=camera.upWC;
  return d&&u?[0,0,camera.frustum?.fov??0,d.x,d.y,d.z,u.x,u.y,u.z]:null;
}
export class CameraRenderBudget {
  constructor(){this.scale=1;this.pose=new Float64Array(9);this.initial=false;this.lastMove=-Infinity;this.slowSince=null;this.lastChange=-Infinity;this.moving=false;}
  configure({minimumScale=.7,targetFps=60}={}) {
    this.minimumScale=Math.min(1,Math.max(.6,Number(minimumScale)||.7));
    this.slowFrameMs=Math.max(26,1000/(Number(targetFps)||60)*1.4);
    this.scale=Math.max(this.minimumScale,this.scale);this.slowSince=null;
  }
  update(camera,{now,frameMs,enabled=true,relative=false,approaching=false,viewPose=null}={}){
    // An anchored camera follows a moving vehicle even when nobody is orbiting.
    // Its local pose is what determines interaction load, not world translation.
    const p=relative?(camera.position??camera.positionWC):camera.positionWC;
    const d=relative?(camera.direction??camera.directionWC):camera.directionWC;
    const u=relative?(camera.up??camera.upWC):camera.upWC;
    if(!p||!d||!u)return this.scale;
    const values=viewPose??[p.x,p.y,p.z,d.x,d.y,d.z,u.x,u.y,u.z];
    // Lens zoom (cockpit) and orthographic zoom (map) need not translate the
    // camera at all. Track projection separately at angular precision.
    const f=camera.frustum??{},projection=[f.fov,f.width,f.left,f.right,f.top,f.bottom];
    const zoomed=this.projection&&projection.some((value,i)=>Number.isFinite(value)&&Number.isFinite(this.projection[i])&&Math.abs(value-this.projection[i])>1e-6);
    const moved=this.initial&&this.relative===relative&&(zoomed||values.some((value,i)=>Math.abs(value-this.pose[i])>(i<3?.05:1e-6)));
    this.projection=projection;
    this.relative=relative;
    this.pose.set(values);this.initial=true;
    // Scripted entry/morph frames establish the pose but are not user motion.
    // Keeping their lastMove makes the first resting frames shrink the buffer
    // after the arrival, then enlarge it again 700 ms later.
    if(!enabled)this.lastMove=-Infinity;
    else if(moved||approaching)this.lastMove=now;
    this.moving=enabled&&now-this.lastMove<300;
    // A scripted entry or morph owns the frame and is given the whole buffer at
    // once; nobody is interacting and the shot is short.
    if(!enabled){
      this.slowSince=null;
      if(this.scale!==1){this.scale=1;this.lastChange=now;}
      return this.scale;
    }
    if(now-this.lastMove>700){
      this.slowSince=null;
      // Climb back only while the frames can pay for it. A display that could
      // not hold the full buffer a moment ago cannot hold it because the camera
      // stopped, and giving it back anyway is what made the buffer oscillate.
      if(this.scale<1&&now-this.lastChange>=RESTORE_STEP_MS
        &&(!Number.isFinite(frameMs)||frameMs<=(this.slowFrameMs??26))){
        this.scale=Math.min(1,this.scale+RESTORE_STEP);this.lastChange=now;
      }
      return this.scale;
    }
    if(approaching&&this.scale===1){this.scale=Math.max(this.minimumScale??.7,.85);this.lastChange=now;}
    // The upper bound is a scheduling gap, not a slow frame. It used to be
    // 200 ms, inside the range a struggling display delivers, so the very frames
    // that most needed the buffer cut were the ones excluded from cutting it.
    if(now-this.lastMove<250&&frameMs>(this.slowFrameMs??26)&&frameMs<1000){
      this.slowSince??=now;
      if(now-this.slowSince>=180&&now-this.lastChange>=650){
        this.scale=Math.max(this.minimumScale??.7,this.scale===1?.85:this.scale-.15);this.lastChange=now;this.slowSince=now;
      }
    }else this.slowSince=null;
    return this.scale;
  }
}
