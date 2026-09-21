import test from 'node:test';
import assert from 'node:assert/strict';
import {AirframeCamera,airframeCameraPose,protectCameraSurface,cockpitFramePacing} from '../../../../digital_twin/visualization/web/airframe_camera.js';
import {CockpitPanel} from '../../../../user_application/web/domains/uam/cockpit/cockpit_panel.js';
import {fakeDocument} from './fake_dom.mjs';
const matrix=[1,0,0,0,0,1,0,0,0,0,1,0,100,200,300,1],profile={forward:[1,0,0],up:[0,1,0]};
class V{constructor(x,y,z){Object.assign(this,{x,y,z});}static distance(){return 10;}static fromRadians(x,y,z){return new V(x,y,z);}}
const C={Cartesian3:V,Cartographic:{fromCartesian:p=>({longitude:p.x,latitude:p.y,height:p.z})},Matrix4:{clone:m=>m.slice()},Axis:{X:0,Y:1}};
test('front is raised; down does not mount below the aircraft; around is one centred top view',()=>{
 assert.ok(airframeCameraPose(matrix,profile,'front',6).position[2]>=302);
 assert.equal(airframeCameraPose(matrix,profile,'down',6).position[2],300.5);
 const p=airframeCameraPose(matrix,profile,'around',6,[0,0,1]);
 assert.deepEqual(p.position,[100,200,318]);assert.equal(p.direction[2],-1);
 assert.equal(p.up[0],1);assert.deepEqual(matrix.slice(12,15),[100,200,300]);
});
test('loaded DEM and aircraft centre clamp downward camera without mutating pose or observation',()=>{
 const pose={mode:'down',position:[100,200,296],direction:[0,0,-1],up:[1,0,0]};
 assert.equal(protectCameraSurface(C,pose,{matrix},{getHeight:()=>305},{}).position[2],305.5);
 assert.equal(protectCameraSurface(C,pose,{matrix},{getHeight:()=>undefined},{}).position[2],300.5);
 assert.equal(pose.position[2],296);assert.equal(matrix[14],300);
 const flying={...pose,position:[100,200,500]};assert.equal(protectCameraSurface(C,flying,{matrix},{getHeight:()=>305},{}),flying);
});
test('cockpit pacing sheds expensive frames without changing detection throughput defaults',()=>{
 assert.equal(cockpitFramePacing(12,16),200);
 assert.ok(cockpitFramePacing(120,16)>=1000);
 assert.equal(cockpitFramePacing(10,150),450);
 assert.ok(cockpitFramePacing(NaN,16)>=500);
});
test('top controls include a power toggle, remove capture and explanatory footer',()=>{
 const p=new CockpitPanel({document:fakeDocument});p.open();
 assert.equal(p.root.querySelector('[data-action=camera-capture]'),null);
 assert.equal(p.root.querySelector('.cockpit-camera-bottom'),null);
 assert.equal(p.screens.system.querySelector('.cockpit-camera-modes').children.length,6);
 p.cameraOff.click();assert.equal(p.cameraEnabled,true);assert.equal(p.cameraOff.getAttribute('aria-pressed'),'true');
 p.cameraButtons.around.click();assert.match(p.cameraLabel.textContent,/TOP VIEW/);
 p.cameraOff.click();assert.equal(p.cameraEnabled,false);p.destroy();
});
test('pending model finishes across OFF/ON, down hides and around reuses the same model',async()=>{
 let resolve,loads=0,added=0,destroyed=0;
 const g={C:{...C,Model:{fromGltfAsync:()=>{loads++;return new Promise(r=>resolve=r);}}},items:new Map(),entityScene:{assets:new Map([['a',{uri:'a.glb'}]])},viewer:{clock:{currentTime:0},entities:{values:[]}}};
 const c=new AirframeCamera(g,{getContext:()=>null});c.widget={scene:{primitives:{add(){added++;}}}};
 const frame={matrix,profile,assetId:'a'};c.syncObjects(frame);c.stop();c.set({enabled:true,mode:'down'});
 const model={destroy(){destroyed++;}};resolve(model);await Promise.resolve();
 assert.equal(added,1);assert.equal(destroyed,0);assert.equal(model.show,false);
 c.set({enabled:true,mode:'around'});c.syncObjects(frame);assert.equal(model.show,true);assert.equal(loads,1);
});
test('a model completing after release cannot attach to a replacement context',async()=>{
 let resolve,destroyed=0,added=0;
 const g={C:{...C,Model:{fromGltfAsync:()=>new Promise(r=>resolve=r)}},items:new Map(),entityScene:{assets:new Map([['a',{uri:'a.glb'}]])},viewer:{clock:{currentTime:0},entities:{values:[]}}};
 const c=new AirframeCamera(g,{getContext:()=>null});c.widget={scene:{primitives:{add(){added++;}}}};
 c.syncObjects({matrix,profile,assetId:'a'});c.release();c.widget={};resolve({destroy(){destroyed++;}});await Promise.resolve();
 assert.equal(added,0);assert.equal(destroyed,1);
});
test('around renders exactly one full-canvas top view rather than cycling quadrant channels',()=>{
 let renders=0;const copies=[];
 const ctx={drawImage:(...args)=>copies.push(args)};
 const g={C:{...C,JulianDate:{clone:t=>t}},viewer:{clock:{currentTime:0},scene:{globe:{}}}};
 const c=new AirframeCamera(g,{width:576,height:360,ownerDocument:{hidden:false},getContext:()=>ctx},()=>{},{cleanFrame:true});
 c.widget={canvas:{width:432,height:270},camera:{setView(){}},clock:{},scene:{globe:{tilesLoaded:true}},render(){renders++;}};
 c.enabled=true;c.mode='around';c.syncImagery=()=>{};c.syncObjects=()=>{};c.updateFootprints=()=>{};
 c.renderFrame({matrix,profile,radius:6},1000);c.renderFrame({matrix,profile,radius:6},2000);
 assert.equal(renders,2);assert.equal(copies.length,2);
 for(const args of copies)assert.deepEqual(args.slice(1),[0,0,576,360]);
 assert.equal(c.lastPose.mode,'around');assert.equal(c.lastPose.position[2],318);
});
