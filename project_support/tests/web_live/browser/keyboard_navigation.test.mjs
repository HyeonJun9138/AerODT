import test from 'node:test';
import assert from 'node:assert/strict';
import {KeyboardNavigation} from '../../../../digital_twin/visualization/web/keyboard_navigation.js';
import {LiveGlobe} from '../../../../digital_twin/visualization/web/globe.js';

function harness(){
 const handlers=new Map(),moves=[];let enabled=true,height=100,time=0;
 const target={addEventListener:(k,f)=>handlers.set(k,f),removeEventListener:k=>handlers.delete(k)};
 const document={...target,hidden:false,activeElement:null,querySelector:()=>null};
 const win={addEventListener:(k,f)=>handlers.set('window:'+k,f),removeEventListener:k=>handlers.delete('window:'+k)};
 const nav=new KeyboardNavigation({document,window:win,enabled:()=>enabled,height:()=>height,move:v=>moves.push(v),now:()=>time});
 const key=(code,type='keydown',extra={})=>{const e={code,target:{closest:()=>null},preventDefault(){this.prevented=true;},...extra};handlers.get(type)(e);return e;};
 const tick=(dt=16)=>{time+=dt;nav.update(time);};
 return {nav,handlers,moves,document,key,tick,setEnabled:v=>enabled=v,setHeight:v=>height=v};
}
test('WASD/QE/ZX hold produces smooth signed motion and release stops it',()=>{
 for(const [code,axis,sign] of [['KeyW','forward',1],['KeyS','forward',-1],['KeyA','right',-1],['KeyD','right',1],['KeyQ','yaw',-1],['KeyE','yaw',1],['KeyZ','up',1],['KeyX','up',-1]]){
  const h=harness();assert.equal(h.key(code).prevented,true);h.tick();h.tick();
  assert.ok(h.moves.at(-1)[axis]*sign>0,code);h.key(code,'keyup');h.tick(500);
  const count=h.moves.length;h.tick();assert.equal(h.moves.length,count);h.nav.destroy();
 }
});
test('typing, shortcuts, modal, selection and background never move the camera',()=>{
 const h=harness();h.setEnabled(false);assert.equal(h.key('KeyW').prevented,undefined);h.tick();assert.equal(h.moves.length,0);
 h.setEnabled(true);
 for(const extra of [{ctrlKey:true},{altKey:true},{metaKey:true},{isComposing:true},{target:{closest:()=>({})}}]){h.key('KeyW','keydown',extra);h.tick();}
 assert.equal(h.moves.length,0);h.document.querySelector=()=>({});h.key('KeyW');h.tick();assert.equal(h.moves.length,0);
 h.document.querySelector=()=>null;h.key('KeyW');h.tick();h.setEnabled(false);h.tick();const count=h.moves.length;
 h.setEnabled(true);h.tick();assert.equal(h.moves.length,count,'held keys must not resume after selection ends');
 h.key('KeyW');h.handlers.get('window:blur')();h.tick();assert.equal(h.moves.length,count);
 h.key('KeyW');h.document.hidden=true;h.handlers.get('visibilitychange')();h.tick();assert.equal(h.moves.length,count);h.nav.destroy();assert.equal(h.handlers.size,0);
});
test('speed scales with height; long frame gaps are bounded and diagonal speed is normalized',()=>{
 const a=harness(),b=harness();b.setHeight(10000);a.key('KeyW');b.key('KeyW');a.tick();b.tick();assert.ok(b.moves[0].forward>a.moves[0].forward);
 const c=harness();c.key('KeyW');c.key('KeyD');c.tick();assert.ok(Math.abs(Math.hypot(c.moves[0].forward,c.moves[0].right)-a.moves[0].forward)<1e-10);
 const d=harness(),e=harness();d.key('KeyW');e.key('KeyW');d.tick(5000);e.tick(50);assert.deepEqual(d.moves,e.moves);
 for(const h of [a,b,c,d,e])h.nav.destroy();
});

test('globe enables free navigation only in unselected idle 3D mode',()=>{
 const g=Object.assign(Object.create(LiveGlobe.prototype),{is2D:()=>false,viewer:{scene:{screenSpaceCameraController:{enableInputs:true}}}});
 Object.defineProperty(g,'transitioning',{value:false,writable:true});
 assert.equal(g.keyboardAvailable(),true);
 for(const field of ['selected','detailId','tracking','approaching','entryActive','transitioning','flightAnchor','groundPick','routeEditor','vertiportEditor','demandEditor','scrap','recorder']){
  g[field]=true;assert.equal(g.keyboardAvailable(),false,field);g[field]=null;
 }
 g.destinationPreparation={active:{arrivedAt:null}};assert.equal(g.keyboardAvailable(),false);
 g.destinationPreparation=null;g.viewer.scene.screenSpaceCameraController.enableInputs=false;assert.equal(g.keyboardAvailable(),false);
});

test('keyboard translation uses heading-aligned ground axes and yaw does not orbit a target',()=>{
 const moves=[],views=[];const camera={heading:Math.PI/2,pitch:-.8,roll:0,positionWC:{},cancelFlight(){},lookAtTransform(){},move:(_d,n)=>moves.push(n),setView:v=>views.push(v)};
 class V{constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z});}static magnitude(v){return Math.hypot(v.x,v.y,v.z);}static normalize(v,r){const m=this.magnitude(v);return Object.assign(r,{x:v.x/m,y:v.y/m,z:v.z/m});}}
 const C={Cartesian3:V,Matrix4:class {static IDENTITY={};static multiplyByPointAsVector(_f,v,r){return Object.assign(r,v);}},Transforms:{eastNorthUpToFixedFrame:(_p,_e,r)=>r}};
 const g=Object.assign(Object.create(LiveGlobe.prototype),{C,viewer:{camera,scene:{requestRender(){}}},motion:{cancel(){}}});
 g.moveKeyboard({forward:10,right:0,up:3,yaw:.1});
 assert.ok(Math.abs(g.keyboardVector.x-10/Math.hypot(10,3))<1e-9);assert.ok(Math.abs(g.keyboardVector.y)<1e-9);
 assert.equal(moves[0],Math.hypot(10,3));assert.equal(views[0].orientation.heading,Math.PI/2+.1);assert.equal(views[0].orientation.pitch,-.8);
});
