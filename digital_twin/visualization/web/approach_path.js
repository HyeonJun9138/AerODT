// Camera approach flown in the picked object's own east-north-up frame. The
// object keeps moving while the camera closes in, so the path is expressed as
// an offset from the object and re-anchored every frame; a flight towards the
// position at click time would land beside the object and snap. Pure geometry:
// nothing here reads or changes Live Twin state.

// Camera position expressed in the object's east-north-up frame.
export function localOffset(C,center,positionWC,result=new C.Cartesian3()) {
  const frame=C.Transforms.eastNorthUpToFixedFrame(center,C.Ellipsoid.WGS84,new C.Matrix4());
  const inverse=C.Matrix4.inverseTransformation(frame,frame);
  return C.Matrix4.multiplyByPoint(inverse,positionWC,result);
}

// The offset Camera.lookAt derives from a HeadingPitchRange: heading clockwise
// from north, pitch below the horizon negative, so the camera sits behind and
// above the object looking along that heading.
export function offsetFromHeadingPitchRange(heading,pitch,range,result={}) {
  const flat=Math.cos(pitch)*range;
  result.x=-Math.sin(heading)*flat;
  result.y=-Math.cos(heading)*flat;
  result.z=-Math.sin(pitch)*range;
  return result;
}

// Offset at progress t in [0,1]: the distance closes exponentially, so a long
// approach spends its time near the object instead of racing the last metres,
// while the viewing direction turns steadily between the two.
export function approachOffset(start,end,t,result={}) {
  const r0=Math.max(1,Math.hypot(start.x,start.y,start.z)),r1=Math.max(1,Math.hypot(end.x,end.y,end.z));
  const range=Math.exp(Math.log(r0)+(Math.log(r1)-Math.log(r0))*t);
  let x=start.x/r0+(end.x/r1-start.x/r0)*t,y=start.y/r0+(end.y/r1-start.y/r0)*t,z=start.z/r0+(end.z/r1-start.z/r0)*t;
  let length=Math.hypot(x,y,z);
  // Opposite directions have no midpoint; take the destination's.
  if(length<1e-6){x=end.x/r1;y=end.y/r1;z=end.z/r1;length=1;}
  result.x=x/length*range;result.y=y/length*range;result.z=z/length*range;
  return result;
}

// Leaving an aircraft is not an approach in reverse. Starting at the pilot's
// eye and interpolating directions around the model makes the camera corkscrew
// through a large heading change. Rise clear of the airframe first, then move
// in a straight line to the ordinary external framing.
export function departureOffset(start,end,t,clearance=60,result={}) {
  const split=.32,lift={x:start.x,y:start.y,z:Math.max(start.z,end.z,clearance)};
  if(t<=split){
    const u=t/split,e=u*u*(3-2*u);
    result.x=start.x;result.y=start.y;result.z=start.z+(lift.z-start.z)*e;
  }else{
    const u=(t-split)/(1-split),e=u*u*(3-2*u);
    result.x=lift.x+(end.x-lift.x)*e;result.y=lift.y+(end.y-lift.y)*e;result.z=lift.z+(end.z-lift.z)*e;
  }
  return result;
}

// Longer when the distance changes more, bounded so a pick always answers
// soon. A long descent crosses many tile levels; the extra time lets more of
// them arrive while the camera is still moving rather than after it stops.
export function approachDuration(startRange,endRange) {
  const ratio=Math.abs(Math.log(Math.max(1,startRange)/Math.max(1,endRange)));
  return Math.min(3200,1200+300*ratio);
}

// Plain {x,y,z} vector helpers: no engine objects, no allocation beyond result.
const sub=(a,b,r)=>{r.x=a.x-b.x;r.y=a.y-b.y;r.z=a.z-b.z;return r;};
const dot=(a,b)=>a.x*b.x+a.y*b.y+a.z*b.z;
const cross=(a,b,r)=>{const x=a.y*b.z-a.z*b.y,y=a.z*b.x-a.x*b.z,z=a.x*b.y-a.y*b.x;r.x=x;r.y=y;r.z=z;return r;};
function normalize(v,r,fallback) {
  const length=Math.hypot(v.x,v.y,v.z);
  if(length<1e-12){r.x=fallback.x;r.y=fallback.y;r.z=fallback.z;return r;}
  r.x=v.x/length;r.y=v.y/length;r.z=v.z/length;return r;
}
// The part of v perpendicular to the unit vector d, normalised.
function orthonormal(v,d,r) {
  const k=dot(v,d);r.x=v.x-d.x*k;r.y=v.y-d.y*k;r.z=v.z-d.z*k;
  // v along d has no perpendicular part; any perpendicular will do.
  return normalize(r,r,Math.abs(d.z)<.9?{x:-d.y,y:d.x,z:0}:{x:0,y:-d.z,z:d.y});
}
const blend=(a,b,w,r)=>{r.x=a.x+(b.x-a.x)*w;r.y=a.y+(b.y-a.y)*w;r.z=a.z+(b.z-a.z)*w;return r;};
const scratchA={},scratchB={},scratchC={};

// How far off the view centre the object sits when the approach starts: an
// angle, and the axis of that offset expressed in the frame of the line of
// sight (up and right around the aim), so the same screen direction can be
// reproduced from any later camera position.
export function approachView(position,direction,up,target,upReference) {
  const aim=normalize(sub(target,position,scratchA),scratchA,direction);
  const theta=Math.acos(Math.max(-1,Math.min(1,dot(aim,direction))));
  const upAtAim=orthonormal(upReference,aim,scratchB);
  const right=cross(aim,upAtAim,scratchC);
  const axis=normalize(cross(aim,direction,{}),{},{x:0,y:0,z:0});
  return {theta,axisUp:dot(axis,upAtAim),axisRight:dot(axis,right),
    direction0:{x:direction.x,y:direction.y,z:direction.z},up0:{x:up.x,y:up.y,z:up.z}};
}

// Camera pose at progress t. The position follows the offset path around the
// object. The view keeps the object at its starting screen offset shrunk by
// (1-t): it slides in a straight line to the centre while the camera closes
// in, instead of being swung there on the first frame, and at t=1 the pose is
// exactly the anchored one, so the orbit takes over without a snap.
export function approachPose(approach,t,target,toWorld,upReference,result) {
  const offset=approach.departure
    ?departureOffset(approach.start,approach.end,t,approach.clearance,result.offset)
    :approachOffset(approach.start,approach.end,t,result.offset);
  const position=toWorld(offset,result.position);
  const aim=normalize(sub(target,position,result.aim),result.aim,{x:0,y:0,z:-1});
  const upAtAim=orthonormal(upReference,aim,result.upAtAim);
  if(approach.departure){
    const viewT=Math.max(0,Math.min(1,(t-.32)/.68));
    normalize(blend(approach.direction0,aim,viewT,result.direction),result.direction,aim);
    orthonormal(blend(approach.up0,upAtAim,viewT,result.up),result.direction,result.up);
    return {position,direction:result.direction,up:result.up};
  }
  const right=cross(aim,upAtAim,result.right);
  const theta=approach.theta*(1-t);
  const axis=result.axis;
  axis.x=approach.axisUp*upAtAim.x+approach.axisRight*right.x;
  axis.y=approach.axisUp*upAtAim.y+approach.axisRight*right.y;
  axis.z=approach.axisUp*upAtAim.z+approach.axisRight*right.z;
  // Rodrigues about an axis perpendicular to the aim.
  const turned=cross(axis,aim,result.direction),cos=Math.cos(theta),sin=Math.sin(theta);
  const direction=result.direction;
  direction.x=aim.x*cos+turned.x*sin;direction.y=aim.y*cos+turned.y*sin;direction.z=aim.z*cos+turned.z*sin;
  normalize(direction,direction,aim);
  const up=orthonormal(blend(approach.up0,upAtAim,t,result.up),direction,result.up);
  return {position,direction,up};
}
