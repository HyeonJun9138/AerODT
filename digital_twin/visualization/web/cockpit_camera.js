// Read-only view of the exact displayed model frame; never a spring-arm target.
// Cesium 1.143 ModelUtility.getAxisCorrectionMatrix(Y, X) uses Y_UP_TO_Z_UP:
// the authored flight GLB [x,y,z] becomes [x,-z,y] before modelMatrix.
const RAD=Math.PI/180;
// Desktop render review: a small downward head angle includes the full panel
// while keeping the horizon in view. This never changes the authored eye.
const DEFAULT_PITCH=-22*RAD;
const DEFAULT_FOV=78;
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const finite3=v=>Array.isArray(v)&&v.length===3&&v.every(Number.isFinite);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit=v=>{const n=Math.hypot(...v);return n>1e-10?v.map(x=>x/n):null;};
const corrected=v=>[v[0],-v[2],v[1]];
// Collision adjustment runs even when pointer input is disabled in Cesium.
const inputKeys=['enableInputs','enableRotate','enableZoom','enableTranslate','enableTilt','enableLook','enableCollisionDetection'];

export class CockpitCamera {
  constructor(C,viewer){
    this.C=C;this.viewer=viewer;this.active=false;this.destroyed=false;
    this.entityId=null;this.saved=null;this.epoch=undefined;this.hasEpoch=false;
    this.yaw=0;this.pitch=DEFAULT_PITCH;this.fov=DEFAULT_FOV;
  }
  available(){return !this.destroyed&&!!this.viewer&&!this.viewer.isDestroyed?.();}
  enter({entityId,profile}={}){
    if(!this.available()||this.viewer.scene.mode!==this.C.SceneMode.SCENE3D||
      entityId==null||!finite3(profile?.eye)||!finite3(profile?.forward)||!finite3(profile?.up))return false;
    const forward=unit(corrected(profile.forward));
    const right=forward&&unit(cross(forward,corrected(profile.up)));
    if(!right)return false;
    const camera=this.viewer.camera;
    if(!Number.isFinite(camera.frustum.fov)||typeof camera.frustum.clone!=='function')return false;
    if(this.active)this.exit();
    const inputs=this.viewer.scene.screenSpaceCameraController;
    this.saved={frustum:camera.frustum,inputs:Object.fromEntries(inputKeys.map(k=>[k,inputs[k]])),
      destination:this.C.Cartesian3.clone(camera.positionWC),
      orientation:{direction:this.C.Cartesian3.clone(camera.directionWC),up:this.C.Cartesian3.clone(camera.upWC)},
      endTransform:this.C.Matrix4.clone(camera.transform)};
    camera.cancelFlight();
    camera.frustum=camera.frustum.clone();camera.frustum.near=0.02;
    for(const key of inputKeys)inputs[key]=false;
    this.profile=profile;this.viewpoint='pilot';this.eye=corrected(profile.eye);this.forward=forward;this.right=right;this.up=cross(right,forward);
    this.entityId=entityId;this.active=true;this.hasEpoch=false;this.resetLook();
    return true;
  }
  update({matrix,scale=1,epoch,continuity=true}={}){
    if(!this.active)return false;
    if(!this.available()){this.active=false;this.saved=null;this.entityId=null;return false;}
    if(this.viewer.scene.mode!==this.C.SceneMode.SCENE3D||continuity===false||
      !matrix||!Array.from({length:16},(_,i)=>matrix[i]).every(Number.isFinite)||
      !Number.isFinite(scale)||scale<=0||(this.hasEpoch&&epoch!==this.epoch)){
      this.exit();return false;
    }
    this.epoch=epoch;this.hasEpoch=true;
    const cy=Math.cos(this.yaw),sy=Math.sin(this.yaw),cp=Math.cos(this.pitch),sp=Math.sin(this.pitch);
    const horizontal=this.forward.map((v,i)=>v*cy+this.right[i]*sy);
    const direction=horizontal.map((v,i)=>v*cp+this.up[i]*sp);
    const up=horizontal.map((v,i)=>-v*sp+this.up[i]*cp);
    const transform=(v,position=false)=>{
      const [x,y,z]=v,s=position?scale:1;
      return [s*(matrix[0]*x+matrix[4]*y+matrix[8]*z)+(position?matrix[12]:0),
        s*(matrix[1]*x+matrix[5]*y+matrix[9]*z)+(position?matrix[13]:0),
        s*(matrix[2]*x+matrix[6]*y+matrix[10]*z)+(position?matrix[14]:0)];
    };
    const d=unit(transform(direction)),r=d&&unit(cross(d,transform(up)));
    if(!r){this.exit();return false;}
    const vector=v=>new this.C.Cartesian3(...v);
    this.viewer.camera.setView({destination:vector(transform(this.eye,true)),
      orientation:{direction:vector(d),up:vector(cross(r,d))},endTransform:this.C.Matrix4.IDENTITY});
    return true;
  }
  look(dx,dy){
    if(!this.active||!Number.isFinite(dx)||!Number.isFinite(dy))return;
    this.yaw=((this.yaw+dx*0.003+Math.PI)%(2*Math.PI)+2*Math.PI)%(2*Math.PI)-Math.PI;
    this.pitch=clamp(this.pitch-dy*0.003,-55*RAD,65*RAD);
  }
  zoom(delta,deltaMode=0){
    if(!this.active||!this.available()||!Number.isFinite(delta))return;
    const pixels=delta*(deltaMode===1?16:deltaMode===2?800:1);
    this.fov=clamp(this.fov+pixels*0.025,35,90);
    this.viewer.camera.frustum.fov=this.fov*RAD;
  }
  resetLook(){
    this.yaw=0;this.pitch=DEFAULT_PITCH;this.fov=DEFAULT_FOV;
    if(this.active&&this.available())this.viewer.camera.frustum.fov=this.fov*RAD;
  }
  setViewpoint(id='pilot'){
    if(!this.active)return false;
    const view=id==='pilot'||id==='cabin'?this.profile:(this.profile.viewpoints??[]).find(v=>v.id===id);
    if(!finite3(view?.eye))return false;
    this.eye=corrected(view.eye);this.viewpoint=id;this.resetLook();
    if(id==='cabin'){this.yaw=Math.PI;this.pitch=-8*RAD;}
    return true;
  }
  // `keepPose` leaves the camera where the cockpit had it -- at the aircraft --
  // instead of putting it back where the pilot was standing before they got in.
  // Anyone leaving the cockpit to look at that same aircraft is about to fly the
  // camera there anyway, and putting it back first meant the view jumped to
  // wherever they had been -- the vertiport they were looking at -- and flew in
  // from there. The frustum and the camera inputs are the cockpit's own and are
  // always given back; only the pose is in question.
  exit(keepPose=false){
    if(this.saved&&this.available()){
      const {frustum,inputs,...pose}=this.saved;
      this.viewer.camera.frustum=frustum;
      Object.assign(this.viewer.scene.screenSpaceCameraController,inputs);
      // 2D/morphing owns its own pose; do not restore an ECEF 3D view into it.
      if(!keepPose&&this.viewer.scene.mode===this.C.SceneMode.SCENE3D)this.viewer.camera.setView(pose);
    }
    this.active=false;this.saved=null;this.entityId=null;this.hasEpoch=false;
  }
  destroy(){this.exit();this.destroyed=true;this.viewer=null;}
}
