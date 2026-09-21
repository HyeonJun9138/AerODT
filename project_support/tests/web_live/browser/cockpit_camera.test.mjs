import test from 'node:test';
import assert from 'node:assert/strict';
import {CockpitCamera} from '../../../../digital_twin/visualization/web/cockpit_camera.js';
const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
class V {constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z});} static clone(p){return new V(p.x,p.y,p.z);}}
const C={Cartesian3:V,SceneMode:{SCENE3D:3},Matrix4:{IDENTITY:identity,clone:m=>[...m]}};
function fixture(){
 const inputs={enableInputs:true,enableRotate:false,enableZoom:true,enableTranslate:true,enableTilt:false,enableLook:true,enableCollisionDetection:true};
 const frustum={near:1,far:1e8,fov:1.2,aspectRatio:1.7,clone(){return {...this};}};
 const camera={frustum,positionWC:new V(10,20,30),directionWC:new V(1,0,0),upWC:new V(0,0,1),transform:identity,
 cancelFlight(){this.cancelled=true;},setView(v){this.last=v;}};
 const viewer={camera,scene:{mode:3,screenSpaceCameraController:inputs},isDestroyed:()=>false};
 return {camera,viewer,inputs,frustum,cockpit:new CockpitCamera(C,viewer)};
}
const profile={eye:[2,3,4],forward:[1,0,0],up:[0,1,0]};
const enter=f=>f.cockpit.enter({entityId:'uam1',profile});
const tick=(f,more={})=>f.cockpit.update({matrix:identity,scale:2,now:0,epoch:1,...more});
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-10,`${a} != ${b}`);

test('360 degree head turn reaches cabin; explicit passenger eye keeps aircraft tracking and restores pilot',()=>{
 const f=fixture();f.cockpit.enter({entityId:'uam1',profile:{...profile,viewpoints:[{id:'seat_01',eye:[-1,2,0]}]}});
 f.cockpit.look(Math.PI/.003,0);tick(f);assert.ok(f.camera.last.orientation.direction.x<-.9);
 assert.equal(f.cockpit.setViewpoint('seat_01'),true);tick(f);assert.deepEqual(f.camera.last.destination,new V(-2,0,4));
 assert.equal(f.cockpit.setViewpoint('absent'),false);assert.equal(f.cockpit.setViewpoint('cabin'),true);tick(f);assert.ok(f.camera.last.orientation.direction.x<-.9);
 f.cockpit.setViewpoint('pilot');tick(f);assert.deepEqual(f.camera.last.destination,new V(4,-8,6));assert.ok(f.camera.last.orientation.direction.x>.9);
});
test('authored axis correction, scale, translation and rotation match displayed model',()=>{
 const f=fixture();assert.equal(enter(f),true);tick(f);
 assert.deepEqual(f.camera.last.destination,new V(4,-8,6));
 near(f.camera.last.orientation.direction.x,Math.cos(22*Math.PI/180));near(f.camera.last.orientation.direction.z,-Math.sin(22*Math.PI/180));
 const matrix=[0,1,0,0,-1,0,0,0,0,0,1,0,100,200,300,1];
 tick(f,{matrix});assert.deepEqual(f.camera.last.destination,new V(108,204,306));
 near(f.camera.last.orientation.direction.y,Math.cos(22*Math.PI/180));near(f.camera.last.orientation.direction.z,-Math.sin(22*Math.PI/180));
 assert.deepEqual(matrix,[0,1,0,0,-1,0,0,0,0,0,1,0,100,200,300,1]);
});
test('head look and wheel never move eye; FOV clamps, modes and reset are bounded',()=>{
 const f=fixture();enter(f);tick(f);const eye=f.camera.last.destination;
 f.cockpit.look(1e6,-1e6);tick(f);assert.deepEqual(f.camera.last.destination,eye);
 const d=f.camera.last.orientation.direction,u=f.camera.last.orientation.up;
 near(Math.hypot(d.x,d.y,d.z),1);near(d.x*u.x+d.y*u.y+d.z*u.z,0);
 f.cockpit.zoom(-1e6,0);near(f.camera.frustum.fov,35*Math.PI/180);
 f.cockpit.zoom(1e6,2);near(f.camera.frustum.fov,Math.PI/2);
 f.cockpit.resetLook();tick(f);near(f.camera.frustum.fov,78*Math.PI/180);
 near(f.camera.last.orientation.direction.x,Math.cos(22*Math.PI/180));near(f.camera.last.orientation.direction.z,-Math.sin(22*Math.PI/180));
 f.cockpit.zoom(1,1);const line=f.camera.frustum.fov;f.cockpit.resetLook();f.cockpit.zoom(16,0);near(f.camera.frustum.fov,line);
});
test('repeated enter/exit restores full frustum, external pose and exact input values',()=>{
 const f=fixture(),saved={...f.inputs};enter(f);enter(f);assert.equal(f.inputs.enableInputs,false);
 assert.equal(f.camera.cancelled,true);assert.ok(f.camera.frustum.near<0.1);tick(f);f.cockpit.exit();f.cockpit.exit();
 assert.equal(f.camera.frustum,f.frustum);assert.deepEqual(f.inputs,saved);
 assert.deepEqual(f.camera.last.destination,new V(10,20,30));assert.equal(f.cockpit.active,false);
});
test('no spatial lag; discontinuity, epoch, missing target and 2D cancel',()=>{
 for(const more of [{epoch:2},{continuity:false},{matrix:null},{scale:NaN}]){
  const f=fixture();enter(f);tick(f);assert.equal(tick(f,more),false);assert.equal(f.cockpit.active,false);
 }
 const f=fixture();enter(f);tick(f);const matrix=[...identity];matrix[12]=10000;
 tick(f,{matrix,now:100000});assert.equal(f.camera.last.destination.x,10004);
 f.viewer.scene.mode=2;assert.equal(tick(f),false);
});
test('unprepared profile, nonfinite input and destroyed lifecycle are safe',()=>{
 const f=fixture();assert.equal(f.cockpit.enter({entityId:'a',profile:null}),false);
 assert.equal(f.cockpit.enter({entityId:'a',profile:{...profile,eye:[NaN,0,0]}}),false);
 enter(f);f.cockpit.look(NaN,Infinity);f.cockpit.zoom(NaN,0);tick(f);near(f.camera.frustum.fov,78*Math.PI/180);
 f.viewer.isDestroyed=()=>true;assert.doesNotThrow(()=>f.cockpit.destroy());assert.equal(f.cockpit.active,false);assert.equal(enter(f),false);
});
test('terrain collision correction cannot displace the fixed cockpit eye',()=>{
 const f=fixture();f.inputs.enableCollisionDetection=true;enter(f);
 assert.equal(f.inputs.enableCollisionDetection,false);f.cockpit.exit();
 assert.equal(f.inputs.enableCollisionDetection,true);
});

