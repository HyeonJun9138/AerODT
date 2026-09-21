import test from 'node:test';
import assert from 'node:assert/strict';
import {CockpitView} from '../../../../user_application/web/domains/uam/cockpit/cockpit_view.js';
import {screenCorners,screenTransform} from '../../../../digital_twin/visualization/web/cockpit_projection.js';
const noop=()=>{};
import {CockpitConsole} from '../../../../user_application/web/domains/uam/cockpit/cockpit_console.js';
import {fakeDocument} from './fake_dom.mjs';
import {ManualFlightSession} from '../../../../user_application/web/domains/uam/cockpit/manual_flight_session.js';
function fixture(){
 const profile={eye:[1,1,0],forward:[1,0,0],up:[0,1,0],screens:[]};
 const item={assetId:'a',entity:{entity_id:'u1',kind:'uam',source:'scenario',continuity_id:1},model:{show:true,ready:true,scale:2},lod:'model'};
 const matrix=[1,0,0,0,0,1,0,0,0,0,1,0,100,200,300,1];item.model.modelMatrix=matrix;
 const v=Object.create(CockpitView.prototype),g={selected:'u1',sceneMode:'3d',items:new Map([['u1',item]]),stopTracking:noop,
  entityScene:{assets:new Map([['a',{cockpit:profile,flight_visual:{uri:'flight.glb'}}]]),layers:{uam:{visible:true,showModels:true}},
   refreshPosition:noop,matrix:()=>matrix,scaleOf:()=>1,applyVisibility:noop,
   samples:{epoch:1,renderTime:()=>10,telemetryAt:()=>({}),headingAt:()=>0}}};
 Object.assign(v,{globe:g,profile,continuity:1,readMission:()=>null,document:{body:{classList:{add:noop,remove:noop}}},
  button:{setAttribute:noop},panel:{active:false,screens:{},open(){this.active=true;},close(){this.active=false;},update:noop},
  camera:{active:false,entityId:null,enter({entityId}){this.active=true;this.entityId=entityId;return true;},
   update(frame){this.frame=frame;return true;},exit(){this.active=false;this.entityId=null;}}});
 return {v,g,item,profile,matrix};
}
test('another cockpit preserves the assigned manual settings without granting its MFD controls',()=>{
 const {v}=fixture();let manualMode;const actions=[];
 v.console=new CockpitConsole({document:fakeDocument,onControl:kind=>actions.push(kind)});
 v.panel.setManualMode=value=>{manualMode=value;};
 v.readControls=()=>({entity_id:'scenario:MINE',active:true,enabled:true,source:'keyboard',mode:'multirotor'});
 v.enter();v.update(1000);
 assert.equal(v.manualControls(),null,'the viewed aircraft never borrows the lease');
 assert.equal(manualMode,true,'the application dock belongs to the manual session');
 assert.equal(v.console.controlsRoot.hidden,false);
 assert.equal(v.console.controlOwner.textContent,'배정 기체 · MINE');
 assert.match(v.console.controlState.textContent,/다른 기체 관찰 중/);
 assert.equal(v.console.ground.disabled,true);
 v.console.tune.click();v.console.findAircraft.click();assert.deepEqual(actions,['tune','find_aircraft']);
 v.readControls=()=>null;v.update(2000);
 assert.equal(manualMode,false);assert.equal(v.console.controlsRoot.hidden,true);
});
test('missing first manual frame does not erase a connected owners dock',()=>{
 const {v}=fixture();v.console=new CockpitConsole({document:fakeDocument});
 v.readControls=()=>({entity_id:'u1',active:false,enabled:false,source:'keyboard',mode:'multirotor'});
 v.readManual=()=>null;v.enter();v.update(1000);
 assert.equal(v.console.controlsRoot.hidden,false);assert.equal(v.console.tune.disabled,false);
 assert.equal(v.console.pause.textContent,'입력 재개');
});
test('find aircraft delegates existing navigation even while paused, never after lease loss',()=>{
 const actions=[],session=Object.create(ManualFlightSession.prototype);
 session.onAction=kind=>actions.push(kind);session.readControls=()=>({active:false,enabled:false});
 session.control('find_aircraft');assert.deepEqual(actions,['find_aircraft']);
 session.readControls=()=>null;session.control('find_aircraft');assert.equal(actions.length,1);
});
test('manual fleet dock shares existing simulation transport without permitting speed changes',()=>{
 const {v}=fixture();let playing=false,played=0,paused=0,rateClicks=0;
 v.camera.active=true;v.readControls=()=>({entity_id:'scenario:MINE',enabled:true});
 const nodes={'scenario-console':{getAttribute:()=>playing?'playing':'ready'},
  'scenario-play':{disabled:false,click(){playing=true;played++;}},
  'scenario-pause':{disabled:false,click(){playing=false;paused++;}},
  'scenario-mini-speed':{textContent:'×1',click(){rateClicks++;}},'scenario-clock':{textContent:'06:30:00'}};
 v.document.getElementById=id=>nodes[id];
 v.panel.setPlayback=state=>{v.playback=state;};
 v.syncPlayback(100);assert.equal(v.playback.manualFleet,true);assert.equal(v.playback.canRate,false);
 v.playbackAction('toggle');assert.equal(played,1);
 v.syncPlayback(300);assert.equal(v.playback.playing,true);
 v.playbackAction('toggle');assert.equal(paused,1);v.playbackAction('rate');assert.equal(rateClicks,0);
 nodes['scenario-play'].disabled=true;v.playbackAction('toggle');assert.equal(played,1);
});
test('coordinator uses selected displayed model scale and frame and exits on continuity or selection change',()=>{
 const {v,g,item,matrix}=fixture();assert.equal(v.enter(),true);assert.equal(v.camera.frame.matrix,matrix);assert.equal(v.camera.frame.scale,2);
 item.entity.continuity_id=2;v.update(200);assert.equal(v.active,false);
 item.entity.continuity_id=1;v.enter();g.selected='u2';v.update(300);assert.equal(v.active,false);
});
test('GPU-unready visible placeholder cannot enter cockpit',()=>{
 const {v,item}=fixture();item.model.ready=false;assert.equal(v.enter(),false);assert.equal(v.panel.active,false);
});
test('model failure removal or invisibility exits instead of drawing floating instruments',()=>{
 for(const change of [i=>i.model=null,i=>i.model.show=false,i=>i.failed=true,i=>i.model.ready=false]){
  const {v,item}=fixture();v.enter();change(item);v.update(200);assert.equal(v.active,false);
 }
});
test('model asset replacement cannot retain previous cockpit profile',()=>{
 const {v,g,item}=fixture();v.enter();item.assetId='b';g.entityScene.assets.set('b',{cockpit:{eye:[99,99,99]}});
 v.update(200);assert.equal(v.active,false);
});
test('base model cannot use metadata explicitly authored for a separate flight variant',()=>{
 const {v,item}=fixture();item.entity.source='adsb';assert.equal(v.enter(),false);
});
test('postRender projection follows canvas CSS offset and hides behind/near/backface screens',()=>{
 class V {constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z});}
  static subtract(a,b){return new V(a.x-b.x,a.y-b.y,a.z-b.z);}
  static dot(a,b){return a.x*b.x+a.y*b.y+a.z*b.z;}
  static cross(a,b){return new V(a.y*b.z-a.z*b.y,a.z*b.x-a.x*b.z,a.x*b.y-a.y*b.x);}}
 const {v,g}=fixture();v.enter();v.scale=1;v.screenCorners=screenCorners;v.screenTransform=screenTransform;
 const screen={id:'pfd',center:[2,0,0],width:1,height:1};v.profile.screens=[screen];
 const node={style:{}};v.panel.screens={pfd:node};
 g.C={Cartesian3:V,Matrix4:{multiplyByPoint:(_m,p)=>p},SceneTransforms:{worldToWindowCoordinates:(_s,p)=>({x:200-p.y*100/p.x,y:100-p.z*100/p.x})}};
 g.viewer={scene:{},camera:{positionWC:new V(),directionWC:new V(1,0,0),frustum:{near:.02}},canvas:{getBoundingClientRect:()=>({left:17,top:29})}};
 v.project();assert.equal(node.hidden,false);assert.match(node.style.transform,/matrix3d/);
 const values=node.style.transform.slice(9,-1).split(',').map(Number);assert.equal(values[12],192);assert.equal(values[13],104);
 for(const x of [-2,.021]){screen.center=[x,0,0];v.project();assert.equal(node.hidden,true);}
 screen.center=[2,0,0];screen.right=[0,0,-1];v.project();assert.equal(node.hidden,true);
});

test('cockpit hides UAM label collection across label recreation and restores its prior visibility',()=>{
 for(const shown of [true,false]){const {v,g,item}=fixture();const labels={show:shown};g.entityScene.layers.uam.labels=labels;
 assert.equal(v.enter(),true);assert.equal(labels.show,false);item.label={show:true};v.update(300);assert.equal(labels.show,false);
 v.exit();assert.equal(labels.show,shown);assert.equal(g.entityScene.layers.uam.showModels,true);}
});

test('dock playback delegates only enabled buttons and does not create a second playback clock',()=>{
 const {v}=fixture();let clicks=0;const play={disabled:false,click(){clicks++;}},rate={disabled:true,click(){clicks++;}};
 v.camera.active=true;v.single=true;v.document.getElementById=id=>({'plan-play':{...play,getAttribute:()=> 'false'},'plan-rate':rate,'plan-clock':{textContent:'01:24 / 20:00'}}[id]);
 v.playbackAction('toggle');assert.equal(clicks,1);v.playbackAction('rate');assert.equal(clicks,1);
 v.camera.active=false;v.playbackAction('toggle');assert.equal(clicks,1);
});

test('entering hides the instrument screens until the first projection places them on the glass',()=>{
 class V {constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z});}
  static subtract(a,b){return new V(a.x-b.x,a.y-b.y,a.z-b.z);}
  static dot(a,b){return a.x*b.x+a.y*b.y+a.z*b.z;}
  static cross(a,b){return new V(a.y*b.z-a.z*b.y,a.z*b.x-a.x*b.z,a.x*b.y-a.y*b.x);}}
 const {v,g}=fixture();
 // A screen straight out of the builder: no place yet, and nothing hiding it.
 const node={style:{}};
 v.panel.screens={pfd:node};
 v.enter();
 assert.equal(node.hidden,true,'opening the panel does not paint the screens at their own layout size');
 v.scale=1;v.screenCorners=screenCorners;v.screenTransform=screenTransform;
 v.profile.screens=[{id:'pfd',center:[2,0,0],width:1,height:1}];
 g.C={Cartesian3:V,Matrix4:{multiplyByPoint:(_m,p)=>p},SceneTransforms:{worldToWindowCoordinates:(_s,p)=>({x:200-p.y*100/p.x,y:100-p.z*100/p.x})}};
 g.viewer={scene:{},camera:{positionWC:new V(),directionWC:new V(1,0,0),frustum:{near:.02}},canvas:{getBoundingClientRect:()=>({left:0,top:0})}};
 v.project(1000);
 assert.equal(node.hidden,false,'the projection is what shows them');
 assert.equal(node.style.opacity,'0','no opaque first frame at the projected position');
 assert.equal(node.style.pointerEvents,'none');
 v.project(1300);assert.equal(node.style.opacity,'0.5');
 v.project(1600);assert.equal(node.style.opacity,'1');assert.equal(node.style.pointerEvents,'auto');
 assert.match(node.style.transform,/matrix3d/);
 // And a second entry hides them again rather than trusting the old matrix.
 v.exit();v.enter();
 assert.equal(node.hidden,true);
 v.project(9000);assert.equal(node.style.opacity,'0','re-entry restarts even after a long external view');
 v.document.defaultView={matchMedia:()=>({matches:true})};v.exit();v.enter();
 v.project(10000);assert.equal(node.style.opacity,'1','reduced motion shows positioned screens immediately');
});


test('hardware receives current cabin pose before draw even when instrument text is throttled',()=>{
 const {v,g,item,matrix}=fixture(),seen=[];v.readControls=()=>({throttle:.9,roll:-1});
 g.entityScene.samples.telemetryAt=()=>({rotor_radps:360,roll_deg:12,pitch_deg:-6});
 v.throttle3d={hide(){},remove(){},update:o=>seen.push(['throttle',o])};
 v.stick3d={hide(){},remove(){},update:o=>seen.push(['stick',o])};
 v.enter();seen.length=0;
 v.lastState=200;matrix[12]+=20;v.update(210);
 assert.equal(seen.length,2);assert.equal(seen[0][1].matrix,v.camera.frame.matrix);
 assert.equal(seen[1][1].matrix[12],120);assert.equal(seen[1][1].controls.roll,.4);assert.equal(seen[0][1].visible,true);assert.equal(seen[0][1].throttle,.6);assert.equal(seen[1][1].controls.enabled,false);
});
