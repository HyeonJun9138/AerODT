import {controlMesh} from './cockpit_control_mesh.js';
// The thrust lever, as a thing in the cabin rather than a slider on a page.
//
// It is one control with three hands on it: the keyboard integrates throttle
// with W and S, a joystick reports where its own lever sits, and the mouse can
// take hold of this one. All three write the same number, and this draws that
// number -- so the lever is never a fourth opinion about the power setting, it
// is the picture of the one that exists.
//
// Placement is derived from the NAV screen's own frame, not from metres: the
// airframes differ in size and are unitless, and the screen is the one thing in
// the profile that is already sized to the cabin it sits in.
const ID = 'cockpit-throttle';
const DIGITS=['abcdef','bc','abdeg','abcdg','bcfg','acdfg','acdefg','abc','abcdefg','abcdfg'];
// Geometry shares the stationary base batch: no floating HUD or extra draw call.
function readoutMesh(C,m,w,h){
 const parts=[m.box([w*.32,h*.035,h*.15],[0,-h*.012,h*.285],'#303b42'),
  m.box([w*.285,h*.006,h*.12],[0,h*.009,h*.285],'#07151b')];
 const segments={a:[0,-.035,.036,.007],b:[.019,-.018,.007,.027],c:[.019,.018,.007,.027],
  d:[0,.035,.036,.007],e:[-.019,.018,.007,.027],f:[-.019,-.018,.007,.027],g:[0,0,.036,.007]};
 for(let digit=0;digit<3;digit++)for(const [segment,[x,z,dx,dz]] of Object.entries(segments)){
  const part=m.box([w*dx,h*.004,h*dz],[w*(-.09+digit*.063+x),h*.015,h*(.285+z)],'#122b31');
  part.id=`${ID}-readout-${digit}-${segment}`;parts.push(part);
 }
 // Percent sign engraved as luminous pixels in the same panel plane.
 for(const [x,z] of [[.098,-.029],[.13,.029],[.128,-.03],[.12,-.015],[.112,0],[.104,.015],[.096,.03]])
  parts.push(m.box([w*.009,h*.004,h*.011],[w*x,h*.015,h*(.285+z)],'#71e0c4'));
 return parts;
}
// Idle is tilted back toward the pilot, full power is pushed away.
// Local +Z faces the pilot; positive X rotation bends an upright grip toward +Z.
// Therefore increasing power must decrease the rotation angle.
const IDLE_DEGREES = 30, FULL_DEGREES = -28;
// Pixels of vertical drag for the full sweep. Measured against the console
// slider it replaces: a shorter pull made small corrections impossible.
const DRAG_PIXELS = 190;

const finite3 = v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const add = (...vectors) => vectors.reduce((sum, v) => sum.map((x, i) => x + v[i]), [0, 0, 0]);
const times = (v, k) => v.map(x => x * k);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = v => {const n = Math.hypot(...v); return n > 1e-10 ? v.map(x => x / n) : null;};
// Same axis correction the cockpit camera and the screen projection use:
// the authored GLB [x,y,z] reaches the model matrix as [x,-z,y].
const corrected = v => [v[0], -v[2], v[1]];

export function leverAngle(throttle) {
  const value = clamp(Number.isFinite(throttle) ? throttle : 0, 0, 1);
  return (IDLE_DEGREES + (FULL_DEGREES - IDLE_DEGREES) * value) * Math.PI / 180;
}

// Dragging up is more power: on screen the lever's far end is up, and that is
// the direction it travels when it is pushed forward.
export function throttleFromDrag(start, dy) {
  if (!Number.isFinite(start) || !Number.isFinite(dy)) return null;
  return clamp(start - dy / DRAG_PIXELS, 0, 1);
}

// Where the quadrant sits, and the axes it swings in, in cabin coordinates.
// The console occupies `up * height * 0.96` below the NAV screen and is
// `height * 0.72` tall, so its lower edge is at 1.32 heights; the quadrant
// occupies the left edge; the stick is independently centred on NAV.
export function throttleFrame(profile) {
  const screen = profile?.screens?.find(s => s.id === 'nav');
  if (!finite3(screen?.center) || !(screen.width > 0) || !(screen.height > 0)) return null;
  const right = unit(screen.right ?? [0, 0, 1]);
  const up = unit(screen.up ?? [0, 1, 0]);
  if (!right || !up) return null;
  // `right x up` faces the pilot: the projection rejects a screen whose normal
  // points the other way, so this is the same convention, not a guess.
  const toward = unit(cross(right, up));
  if (!toward) return null;
  const anchor = add(screen.center,
    times(up, -screen.height * 1.20),
    times(toward, screen.height * 0.40),
    times(right, -screen.width * 1.10));
  return {anchor, right, up, toward, span: screen.width, rise: screen.height};
}

// Cabin frame -> the space the model matrix expects, with the model's scale
// folded in, so geometry below can be written in plain cabin units.
export function leverMatrix(C, frame, scale, angle) {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const [x, y, z] = [frame.right, frame.up, frame.toward].map(v => times(corrected(v), s));
  const o = times(corrected(frame.anchor), s);
  const base = new C.Matrix4(x[0], y[0], z[0], o[0], x[1], y[1], z[1], o[1], x[2], y[2], z[2], o[2], 0, 0, 0, 1);
  if (!Number.isFinite(angle)) return base;
  const spin = C.Matrix4.fromRotationTranslation(C.Matrix3.fromRotationX(angle), C.Cartesian3.ZERO, new C.Matrix4());
  return C.Matrix4.multiply(base, spin, new C.Matrix4());
}

export class CockpitThrottle {
  constructor(C, scene) {
    this.C = C; this.scene = scene; this.frame = null; this.drag = null;
    this.base = null; this.lever = null; this.value = 0; this.shown = false;
  }
  // Boxes around the hinge at the origin. A GeometryInstance matrix is baked
  // into the vertices when the primitive is built, which is exactly right here:
  // these offsets are inside the lever's own frame and never move again. What
  // moves is the primitive's own matrix, applied at draw time.
  placement(profile){return throttleFrame(profile);}
  build(frame) {
    const C=this.C,w=frame.span,h=frame.rise,m=controlMesh(C,ID);
    const base=[m.box([w*.32,h*.10,h*.40],[0,-h*.055,0],'#303b42'),
      m.box([w*.21,h*.025,h*.38],[0,h*.002,0],'#10171b')];
    for(const x of [-1,1]){
      base.push(m.box([w*.035,h*.09,h*.43],[x*w*.14,0,0],'#82949d'));
      for(let i=0;i<7;i++)base.push(m.box([w*.05,h*.008,h*.009],[x*w*.105,h*.03,(i-3)*h*.052],i===0?'#71e0c4':'#d1dce1'));
    }
    base.push(...readoutMesh(C,m,w,h));
    this.hasReadout=true;
    const lever=[m.cylinder(w*.065,w*.065,h*.07,[0,h*.01,0],'#667780'),
      m.box([w*.045,h*.25,w*.034],[0,h*.16,0],'#b7c7d0'),
      m.oval([w*.105,h*.064,h*.072],[0,h*.315,0],'#252e34'),
      m.box([w*.13,h*.018,h*.085],[0,h*.37,0],'#78928f')];
    return {base:m.primitive(base,false),lever:m.primitive(lever,true)};
  }
  // Called every cockpit frame: the aircraft has moved, and so may the lever.
  update({matrix, scale, profile, throttle, visible = true} = {}) {
    const C = this.C;
    if (!matrix || !visible || !profile) return this.hide();
    if (this.profile !== profile) {
      this.remove();
      this.profile = profile;
      this.frame = this.placement(profile);
      if (this.frame) {
        const built = this.build(this.frame);
        this.base = built.base; this.lever = built.lever;
        this.scene?.primitives?.add(this.base); this.scene?.primitives?.add(this.lever);
      }
    }
    if (!this.frame || !this.base) return this.hide();
    this.value = clamp(Number.isFinite(throttle) ? throttle : 0, 0, 1);
    C.Matrix4.multiply(matrix, leverMatrix(C, this.frame, scale), this.base.modelMatrix);
    C.Matrix4.multiply(matrix, leverMatrix(C, this.frame, scale, leverAngle(this.value)), this.lever.modelMatrix);
    this.updateReadout(throttle);
    this.base.show = this.lever.show = true; this.shown = true;
    return true;
  }
  updateReadout(throttle){
    if(!this.hasReadout||!this.base?.ready)return;
    const text=Number.isFinite(throttle)?String(Math.round(this.value*100)).padStart(3,' '):'---';
    if(text===this.readoutText)return;
    const C=this.C,on=C.ColorGeometryInstanceAttribute.toValue(C.Color.fromCssColorString('#71e0c4')),
      off=C.ColorGeometryInstanceAttribute.toValue(C.Color.fromCssColorString('#122b31'));
    for(let digit=0;digit<3;digit++){
      const lit=text[digit]==='-'?'g':DIGITS[Number(text[digit])]??'';
      for(const segment of 'abcdefg'){
        const attributes=this.base.getGeometryInstanceAttributes(`${ID}-readout-${digit}-${segment}`);
        attributes.color=text[digit]!==' '&&lit.includes(segment)?on:off;
      }
    }
    this.readoutText=text;
  }
  hide() {if (this.base) this.base.show = false; if (this.lever) this.lever.show = false; this.shown = false; return false;}
  // True when the pointer landed on the lever, which is when the camera must
  // not also start looking around.
  grab(position, throttle) {
    if (!this.shown || !this.scene?.pick) return false;
    const hit = this.scene.pick(position);
    if (hit?.id !== ID) return false;
    this.drag = {y: position.y, start: clamp(Number.isFinite(throttle) ? throttle : this.value, 0, 1)};
    return true;
  }
  move(position) {
    if (!this.drag) return null;
    return throttleFromDrag(this.drag.start, position.y - this.drag.y);
  }
  release() {this.drag = null;}
  remove() {
    for (const primitive of [this.base, this.lever]) if (primitive) this.scene?.primitives?.remove(primitive);
    this.hasReadout=false;this.readoutText=null;
    this.base = this.lever = null; this.shown = false; this.profile=null;this.frame=null;
  }
  destroy() {this.release(); this.remove(); this.profile = null; this.scene = null;}
}
