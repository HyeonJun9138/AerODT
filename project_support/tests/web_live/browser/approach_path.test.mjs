import test from 'node:test';
import assert from 'node:assert/strict';
import {offsetFromHeadingPitchRange,approachOffset,departureOffset,approachDuration,localOffset,approachPose,approachView} from '../../../../digital_twin/visualization/web/approach_path.js';
const near=(a,b,eps=1e-9)=>Math.abs(a-b)<=eps;
const magnitude=v=>Math.hypot(v.x,v.y,v.z);

test('heading and pitch place the camera behind and above the object as Camera.lookAt does',()=>{
 const above=offsetFromHeadingPitchRange(0,-Math.PI/2,100);
 assert.ok(near(above.x,0) && near(above.y,0) && near(above.z,100),'straight down looks from above');
 const north=offsetFromHeadingPitchRange(0,0,100);
 assert.ok(near(north.x,0) && near(north.y,-100) && near(north.z,0),'looking north means standing south');
 const east=offsetFromHeadingPitchRange(Math.PI/2,0,100);
 assert.ok(near(east.x,-100) && near(east.y,0) && near(east.z,0),'looking east means standing west');
 const oblique=offsetFromHeadingPitchRange(.3,-.5,600);
 assert.ok(near(magnitude(oblique),600) && oblique.z>0,'range is preserved and the camera stays above');
});

test('the approach starts where the camera is, ends at the framing, and closes distance exponentially',()=>{
 const start={x:0,y:0,z:120000},end=offsetFromHeadingPitchRange(0,-.5,600);
 const first=approachOffset(start,end,0),last=approachOffset(start,end,1),mid=approachOffset(start,end,.5);
 assert.ok(near(magnitude(first),120000,1e-6) && near(first.z,120000,1e-6));
 assert.ok(near(last.x,end.x,1e-6) && near(last.y,end.y,1e-6) && near(last.z,end.z,1e-6));
 assert.ok(near(magnitude(mid),Math.sqrt(120000*600),1e-6),'half way is the geometric mean of the distances');
 let previous=Infinity;
 for(let i=0;i<=20;i++){const range=magnitude(approachOffset(start,end,i/20));assert.ok(range<=previous+1e-6,'distance never grows again');previous=range;}
});

test('opposite directions still produce a usable path',()=>{
 const offset=approachOffset({x:0,y:0,z:1000},{x:0,y:0,z:-500},.5);
 assert.ok(Number.isFinite(offset.x) && Number.isFinite(offset.y) && Number.isFinite(offset.z));
 assert.ok(magnitude(offset)>0);
});

test('cockpit departure rises first and then translates without orbiting the aircraft',()=>{
 const start={x:2,y:1,z:3},end={x:-120,y:-500,z:260};
 const lifted=departureOffset(start,end,.32,60),first=departureOffset(start,end,.16,60);
 assert.equal(first.x,start.x);assert.equal(first.y,start.y);
 assert.equal(lifted.x,start.x);assert.equal(lifted.y,start.y);
 assert.ok(first.z>start.z&&first.z<lifted.z,'first phase only climbs');
 assert.deepEqual(departureOffset(start,end,1,60),end,'lands at normal external framing');
 let moved=false,previousZ=start.z;
 for(let i=0;i<=32;i++){
  const p=departureOffset(start,end,i/100,60);
  assert.equal(p.x,start.x);assert.equal(p.y,start.y);
  assert.ok(p.z>=previousZ-1e-9);previousZ=p.z;
 }
 for(let i=33;i<=100;i++){
  const p=departureOffset(start,end,i/100,60);
  if(Math.hypot(p.x-start.x,p.y-start.y)>1e-6)moved=true;
 }
 assert.equal(moved,true);
});

test('cockpit departure holds its view while rising, then aligns without a roll orbit',()=>{
 const target={x:0,y:0,z:0},start={x:2,y:1,z:3},end={x:-120,y:-500,z:260};
 const direction={x:1,y:0,z:0},up={x:0,y:0,z:1};
 const view=approachView(start,direction,up,target,{x:0,y:0,z:1});
 const approach={start,end,...view,departure:true,clearance:60};
 const scratch={offset:{},position:{},aim:{},upAtAim:{},right:{},axis:{},direction:{},up:{}};
 const pose=t=>approachPose(approach,t,target,(o,r)=>Object.assign(r,o),{x:0,y:0,z:1},scratch);
 for(const t of [0,.1,.2,.32]){
  const p=pose(t);assert.deepEqual({...p.direction},direction);assert.deepEqual({...p.up},up);
 }
 const last=pose(1);assert.ok(offCentre(last,target)<1e-6);assert.ok(perpendicular(last.up,last.direction));
});

test('duration grows with the distance ratio and stays bounded',()=>{
 assert.equal(approachDuration(600,600),1200);
 assert.ok(approachDuration(120000,600)>approachDuration(5000,600));
 assert.ok(approachDuration(1e9,1)<=3200);
 assert.equal(approachDuration(0,0),1200,'degenerate ranges do not produce NaN');
});

test('local offset is the inverse of the east-north-up frame',()=>{
 // A stub engine with a translation-only frame is enough to prove the inverse.
 const C={Cartesian3:class{constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z});}},
  Matrix4:class{constructor(){this.t={x:0,y:0,z:0};}
   static inverseTransformation(m,result){result.t={x:-m.t.x,y:-m.t.y,z:-m.t.z};return result;}
   static multiplyByPoint(m,p,result){result.x=p.x+m.t.x;result.y=p.y+m.t.y;result.z=p.z+m.t.z;return result;}},
  Ellipsoid:{WGS84:{}},
  Transforms:{eastNorthUpToFixedFrame(center,_e,result){result.t={x:center.x,y:center.y,z:center.z};return result;}}};
 const offset=localOffset(C,{x:10,y:20,z:30},{x:13,y:24,z:35});
 assert.deepEqual({x:offset.x,y:offset.y,z:offset.z},{x:3,y:4,z:5});
});

// A translation-only world: ENU offset plus the object's position.
const poseHarness=()=>{
 const target={x:1000,y:2000,z:0};
 const start={x:-40000,y:0,z:120000},end=offsetFromHeadingPitchRange(0,-1.4,600);
 const position0={x:target.x+start.x,y:target.y+start.y,z:target.z+start.z};
 const view=approachView(position0,{x:0,y:0,z:-1},{x:0,y:1,z:0},target,{x:0,y:0,z:1});
 const approach={start,end,...view};
 const scratch={offset:{},position:{},aim:{},upAtAim:{},right:{},axis:{},direction:{},up:{}};
 const pose=t=>approachPose(approach,t,target,(o,r)=>{r.x=target.x+o.x;r.y=target.y+o.y;r.z=target.z+o.z;return r;},{x:0,y:0,z:1},scratch);
 return {target,approach,pose};
};
const perpendicular=(a,b)=>near(a.x*b.x+a.y*b.y+a.z*b.z,0);
const offCentre=(p,target)=>{
 const toTarget={x:target.x-p.position.x,y:target.y-p.position.y,z:target.z-p.position.z};const length=magnitude(toTarget);
 return Math.acos(Math.max(-1,Math.min(1,(p.direction.x*toTarget.x+p.direction.y*toTarget.y+p.direction.z*toTarget.z)/length)));
};
test('the approach pose starts exactly where the camera is, looking where it looked',()=>{
 const {pose,approach,target}=poseHarness();
 const p=pose(0);
 assert.ok(near(p.position.x,target.x+approach.start.x,1e-6) && near(p.position.y,target.y,1e-6) && near(p.position.z,target.z+approach.start.z,1e-6));
 assert.ok(near(p.direction.z,-1) && near(p.direction.x,0),'the operator view is kept on the first frame: the object does not jump to the centre');
 assert.ok(near(offCentre(p,target),approach.theta),'the object sits at its original screen offset');
 assert.ok(near(magnitude(p.up),1) && perpendicular(p.up,p.direction),'up is unit and perpendicular');
});
test('the approach pose ends exactly at the anchored framing, aimed at the object',()=>{
 const {pose,approach,target}=poseHarness();
 const p=pose(1);
 assert.ok(near(p.position.x,target.x+approach.end.x,1e-9) && near(p.position.z,target.z+approach.end.z,1e-9));
 assert.ok(offCentre(p,target)<1e-6,'lands looking at the object: no snap when the orbit anchor takes over');
 assert.ok(perpendicular(p.up,p.direction));
});
test('the object slides to the centre in proportion to progress and the frame stays orthonormal',()=>{
 const {pose,approach,target}=poseHarness();
 assert.ok(approach.theta>0.2,'the object starts well off centre');
 for(let i=0;i<=20;i++){
  const t=i/20,p=pose(t);
  assert.ok(near(offCentre(p,target),approach.theta*(1-t),1e-6),`off-centre angle is the start angle times (1-t) at t=${t}`);
  assert.ok(near(magnitude(p.direction),1) && near(magnitude(p.up),1) && perpendicular(p.up,p.direction));
 }
});
test('a pick already at the centre stays centred throughout',()=>{
 const target={x:0,y:0,z:0},start={x:0,y:0,z:600};
 const view=approachView({x:0,y:0,z:600},{x:0,y:0,z:-1},{x:0,y:1,z:0},target,{x:0,y:0,z:1});
 assert.ok(near(view.theta,0));
 const approach={start,end:offsetFromHeadingPitchRange(0,-1.4,300),...view};
 const scratch={offset:{},position:{},aim:{},upAtAim:{},right:{},axis:{},direction:{},up:{}};
 for(const t of [0,.3,.7,1]){
  const p=approachPose(approach,t,target,(o,r)=>{r.x=o.x;r.y=o.y;r.z=o.z;return r;},{x:0,y:0,z:1},scratch);
  assert.ok(offCentre(p,target)<1e-6,'acos near 1 is only good to about 1e-8');
 }
});
