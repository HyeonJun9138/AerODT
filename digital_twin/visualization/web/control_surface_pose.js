const clamp=(v,lo,hi)=>Math.min(hi,Math.max(lo,v));
const finite=v=>Number.isFinite(v)?v:0;
const smooth=v=>{const t=clamp(v,0,1);return t*t*(3-2*t);};

// Differentiate observations, never render-frame time or the pilot's stick.
// The same observed pair therefore gives the same pose at every playback rate.
export function surfaceRates(before,after,dt,result={}) {
  for(const [angle,rate] of [['roll_deg','roll_rate_deg_s'],['pitch_deg','pitch_rate_deg_s'],['heading_deg','yaw_rate_deg_s']]){
    const a=before?.[angle],b=after?.[angle];
    result[rate]=dt>0&&Number.isFinite(dt)&&Number.isFinite(a)&&Number.isFinite(b)
      ?clamp((((b-a)%360+540)%360-180)/dt,-120,120):0;
  }
  return result;
}

// These are deliberately modest presentation proxies, NOT measured actuator
// deflections or an aerodynamic controller. Deterministic sample input makes
// pause, replay speed and backwards seeking give the same surface pose.
export const validSurfaceAngles=v=>Array.isArray(v)&&v.length===4&&v.every(Number.isFinite);
export function interpolateSurfaceAngles(a,b,f){
  if(!validSurfaceAngles(a)||!validSurfaceAngles(b))return f===0&&validSurfaceAngles(a)?a.slice():null;
  return a.map((v,i)=>v+(b[i]-v)*clamp(f,0,1));
}
export function surfaceCommands(sample, native=true) {
  const demand=sample?.manual_surface_display_deg;
  if(native&&sample?.manual&&validSurfaceAngles(demand))return {roll:(demand[1]-demand[0])/2,pitch:demand[2],yaw:demand[3]};
  const angles=sample?.control_surface_deg;
  if(native&&validSurfaceAngles(angles))return {roll:(angles[1]-angles[0])/2,pitch:angles[2],yaw:angles[3]};
  if(!sample?.airborne)return {roll:0,pitch:0,yaw:0};
  const effectiveness=smooth((finite(sample.tilt_deg)-30)/55)*smooth(finite(sample.speed_mps)/25);
  return {
    roll:clamp(.8*finite(sample.roll_rate_deg_s)+.08*finite(sample.roll_deg),-18,18)*effectiveness,
    pitch:clamp(.8*finite(sample.pitch_rate_deg_s)+.2*finite(sample.pitch_deg),-18,18)*effectiveness,
    yaw:clamp(.5*finite(sample.yaw_rate_deg_s),-12,12)*effectiveness,
  };
}

export class ControlSurfacePose {
  constructor(C,spec) {this.C=C;this.native=spec?.source==="native_actuator_with_visual_yaw";this.spec=spec?.nodes??[];this.parts=[];this.missing=[];}
  attach(model) {
    const C=this.C;this.parts=[];this.missing=[];
    for(const spec of this.spec){
      const node=model.getNode(spec.name);if(!node){this.missing.push(spec.name);continue;}
      const axis=C.Cartesian3.normalize(C.Cartesian3.fromArray(spec.axis),new C.Cartesian3());
      const rest=C.Matrix4.clone(node.originalMatrix??node.matrix,new C.Matrix4());
      this.parts.push({node,spec,axis,origin:C.Matrix4.getTranslation(rest,new C.Cartesian3()),
        basis:C.Matrix4.getMatrix3(rest,new C.Matrix3()),rotation:new C.Matrix3(),out:new C.Matrix4(),angle:null});
    }
    this.q=new C.Quaternion();this.turn=new C.Matrix3();return this.parts.length;
  }
  update(sample) {
    const commands=surfaceCommands(sample,this.native),C=this.C;
    for(const p of this.parts){
      const degrees=Object.entries(p.spec.mix).reduce((v,[key,weight])=>v+commands[key]*weight,0);
      const angle=clamp(degrees,-p.spec.limit_deg,p.spec.limit_deg)*Math.PI/180;
      if(angle===p.angle)continue;p.angle=angle;
      C.Quaternion.fromAxisAngle(p.axis,angle,this.q);C.Matrix3.fromQuaternion(this.q,this.turn);
      C.Matrix3.multiply(this.turn,p.basis,p.rotation);
      p.node.matrix=C.Matrix4.fromRotationTranslation(p.rotation,p.origin,p.out);
    }
  }
}
