import test from 'node:test';
import assert from 'node:assert/strict';
import {CockpitView} from '../../../../user_application/web/domains/uam/cockpit/cockpit_view.js';
import {CockpitCamera} from '../../../../digital_twin/visualization/web/cockpit_camera.js';
import {CockpitConsole} from '../../../../user_application/web/domains/uam/cockpit/cockpit_console.js';
import {screenCorners,screenTransform} from '../../../../digital_twin/visualization/web/cockpit_projection.js';
import {fakeDocument} from './fake_dom.mjs';
const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
class V {
 constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z});}
 static clone(p){return new V(p.x,p.y,p.z);}
 static subtract(a,b){return new V(a.x-b.x,a.y-b.y,a.z-b.z);}
 static dot(a,b){return a.x*b.x+a.y*b.y+a.z*b.z;}
 static cross(a,b){return new V(a.y*b.z-a.z*b.y,a.z*b.x-a.x*b.z,a.x*b.y-a.y*b.x);}
}
function fixture(){
 let projections=0,writes=0,external=0;
 const rect={left:17,top:29,width:800,height:600},shelf={top:450,height:100};
 const camera={positionWC:new V(),directionWC:new V(1,0,0),upWC:new V(0,0,1),transform:identity,
  frustum:{near:.02,far:1e8,fov:1.2,aspectRatio:4/3,clone(){return {...this};}},cancelFlight(){},
  setView({destination,orientation}){this.positionWC=destination;Object.assign(this,{directionWC:orientation.direction,upWC:orientation.up});}};
 const viewer={camera,canvas:{getBoundingClientRect:()=>rect},scene:{mode:3,screenSpaceCameraController:{},requestRender(){}}};
 const C={Cartesian3:V,SceneMode:{SCENE3D:3},Matrix4:{IDENTITY:identity,clone:m=>[...m],multiplyByPoint:(m,p)=>new V(m[0]*p.x+m[4]*p.y+m[8]*p.z+m[12],m[1]*p.x+m[5]*p.y+m[9]*p.z+m[13],m[2]*p.x+m[6]*p.y+m[10]*p.z+m[14])},
  SceneTransforms:{worldToWindowCoordinates:(_s,p)=>{
   projections++;const d=V.subtract(p,camera.positionWC),z=V.dot(d,camera.directionWC),f=300/Math.tan(camera.frustum.fov/2);
   return {x:400+f*V.dot(d,V.cross(camera.directionWC,camera.upWC))/z,y:300-f*V.dot(d,camera.upWC)/z};
  }}};
 const node={style:new Proxy({},{set(o,k,v){writes++;o[k]=v;return true;}})};
 const profile={eye:[0,0,0],forward:[1,0,0],up:[0,1,0],screens:[{id:'pfd',center:[2,0,0],width:1,height:1}]};
 const v=Object.create(CockpitView.prototype);
 Object.assign(v,{globe:{C,viewer,items:new Map()},profile,matrix:[...identity],scale:1,screenCorners,screenTransform,
  panel:{screens:{pfd:node}},document:{getElementById:()=>({hidden:false,getBoundingClientRect:()=>shelf})},
  camera:new CockpitCamera(C,viewer),externalCamera:{enabled:true,update(){external++;}}});
 v.camera.enter({entityId:'own',profile});v.camera.update({matrix:v.matrix,scale:1});
 return {v,node,rect,shelf,counts:()=>({projections,writes,external})};
}

test('rigid cruise and aircraft yaw reuse glass projection but still update external video',()=>{
 const {v,node,counts}=fixture();v.project(0);v.project(600);const before=counts(),transform=node.style.transform;
 for(let i=0;i<120;i++){
  const a=i*.01,c=Math.cos(a),s=Math.sin(a);
  v.matrix=[c,s,0,0,-s,c,0,0,0,0,1,0,6370000+i,100+i,300+i,1];
  v.camera.update({matrix:v.matrix,scale:1});v.project(700+i*16);
 }
 assert.equal(counts().projections,before.projections);assert.equal(counts().writes,before.writes);
 assert.equal(counts().external,before.external+120);assert.equal(node.style.transform,transform);
 // Independently redo the old world-space projection at the final pose.
 v.projectionCache=null;v.project(3000);
 const values=s=>s.slice(9,-1).split(',').map(Number);
 values(node.style.transform).forEach((x,i)=>assert.ok(Math.abs(x-values(transform)[i])<1e-5));
});

test('head look, FOV, canvas layout, scale and authored screen edits invalidate immediately',()=>{
 const {v,rect,counts}=fixture();v.project(0);
 for(const change of [()=>v.camera.look(10,0),()=>v.camera.zoom(5),()=>rect.width+=10,()=>rect.left+=20,
  ()=>v.scale=2,()=>v.profile.screens[0].center[0]+=.1]){
  const n=counts().projections;change();v.camera.update({matrix:v.matrix,scale:v.scale});v.project(100);
  assert.ok(counts().projections>n);
 }
});

test('focus shelf changes, fade, passenger seat and re-entry remain responsive',()=>{
 const {v,node,shelf}=fixture();v.project(0);v.project(300);assert.equal(node.style.opacity,'0.5');
 v.project(600);assert.equal(node.style.opacity,'1');v.panel.focusScreen='pfd';v.project(700);
 const transform=node.style.transform;shelf.top-=80;v.project(701);assert.notEqual(node.style.transform,transform);
 v.panel.focusScreen=null;v.camera.viewpoint='seat_01';v.project(702);assert.equal(node.hidden,true);
 v.camera.viewpoint='pilot';v.hideScreens();v.project(800);assert.equal(node.hidden,false);assert.equal(node.style.opacity,'0');
});

test('non-rigid poses do not reuse a rigid projection',()=>{
 const {v,counts}=fixture();v.project(0);v.matrix[0]=2;v.camera.update({matrix:v.matrix,scale:1});v.project(700);
 const n=counts().projections;v.project(710);assert.ok(counts().projections>n);
});

test('console text coalesces frames but permission, pending, phase and time rewind repaint immediately',()=>{
 const v=Object.create(CockpitView.prototype);let paints=0;
 v.camera={entityId:'own'};v.console={update(){paints++;}};
 const state={controls:{active:true,enabled:true},telemetry:{airborne:true},psu:{procedure:{stage:'준비'}}};
 for(let t=0;t<1000;t+=10)v.paintConsole(t,state);
 assert.equal(paints,10);
 for(const change of [()=>state.controls.enabled=false,()=>state.controls.pending=true,
  ()=>state.psu.pending=true,()=>state.psu.procedure.stage='착륙 허가',()=>state.telemetry.airborne=false]){
  const n=paints;change();v.paintConsole(991,state);assert.equal(paints,n+1);
 }
 const n=paints;v.paintConsole(0,state);assert.equal(paints,n+1);
});

test('control text skips identical updates without keeping stale input state',()=>{
 const c=new CockpitConsole({document:fakeDocument});
 c.updateControls({enabled:true,active:true,source:'keyboard',throttle:.2});
 let writes=0;Object.defineProperty(c.controlsRoot,'hidden',{get:()=>false,set:()=>writes++});
 const next={enabled:true,active:true,source:'keyboard',throttle:.8};c.updateControls(next);
 assert.equal(writes,0);assert.equal(c.state,next);
 c.updateControls(null);assert.equal(writes,1);
});
