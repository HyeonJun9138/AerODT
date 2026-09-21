import {CockpitThrottle,throttleFrame,leverMatrix} from './cockpit_throttle.js?v=20260921-left-throttle';
import {controlMesh} from './cockpit_control_mesh.js';
const ID='cockpit-stick';
const clamp=x=>Math.max(-1,Math.min(1,Number.isFinite(x)?x:0));
export function stickAngles(controls={}){return {pitch:clamp(controls.pitch)*.30,roll:-clamp(controls.roll)*.30,yaw:-clamp(controls.yaw)*.18};}
export function stickFromDrag(start,dx,dy){
 if(!Number.isFinite(dx)||!Number.isFinite(dy))return null;
 const x=clamp((start?.x??0)+dx/110),y=clamp((start?.y??0)+dy/110),length=Math.max(1,Math.hypot(x,y));
 return {x:x/length,y:y/length};
}
export class CockpitStick extends CockpitThrottle {
 placement(profile){const f=throttleFrame(profile);if(!f)return null;return {...f,anchor:f.anchor.map((v,i)=>v+f.right[i]*f.span*1.10)};}
 build(f){
  const m=controlMesh(this.C,ID),w=f.span,h=f.rise;
  const base=[m.box([w*.33,h*.075,h*.33],[0,-h*.05,0],'#263138'),m.cylinder(w*.135,w*.135,h*.035,[0,h*.005,0],'#6f8088')];
  for(let i=0;i<5;i++)base.push(m.cylinder(w*(.12-i*.011),w*(.108-i*.011),h*.028,[0,h*(.032+i*.022),0],i%2?'#29343b':'#11191e'));
  const lever=[m.cylinder(w*.033,w*.026,h*.19,[0,h*.16,0],'#9bafb9'),
    m.oval([w*.068,h*.125,h*.057],[0,h*.285,-h*.013],'#263038'),
    m.oval([w*.083,h*.065,h*.063],[w*.008,h*.386,-h*.02],'#3e4d56'),
    m.box([w*.042,h*.055,h*.02],[0,h*.328,-h*.074],'#b9c8ce'),
    m.cylinder(w*.018,w*.018,h*.015,[w*.048,h*.444,-h*.023],'#df7b57'),
    m.box([w*.035,h*.012,h*.035],[-w*.025,h*.448,-h*.012],'#84d9c1')];
  for(let i=0;i<3;i++)lever.push(m.oval([w*.060,h*.017,h*.060],[0,h*(.22+i*.044),-h*.013],'#141e24'));
  return {base:m.primitive(base,false),lever:m.primitive(lever)};
 }
 update(options={}){
  if(!super.update({...options,throttle:0}))return false;
  const C=this.C,a=stickAngles(options.controls),base=leverMatrix(C,this.frame,options.scale);
  let rotation=C.Matrix3.multiply(C.Matrix3.fromRotationX(a.pitch),C.Matrix3.fromRotationZ(a.roll),new C.Matrix3());
  rotation=C.Matrix3.multiply(rotation,C.Matrix3.fromRotationY(a.yaw),rotation);
  const local=C.Matrix4.multiply(base,C.Matrix4.fromRotationTranslation(rotation,C.Cartesian3.ZERO,new C.Matrix4()),new C.Matrix4());
  C.Matrix4.multiply(options.matrix,local,this.lever.modelMatrix);return true;
 }
 grab(position,controls){
  if(!this.shown||this.scene?.pick(position)?.id!==ID)return false;
  this.drag={x:position.x,y:position.y,start:{x:clamp(controls?.roll),y:clamp(controls?.pitch)}};return true;
 }
 move(position){return this.drag?stickFromDrag(this.drag.start,position.x-this.drag.x,position.y-this.drag.y):null;}
}
