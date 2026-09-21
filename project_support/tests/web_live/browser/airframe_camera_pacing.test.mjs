// The external camera is a second Cesium context drawn on the same thread as
// the map. What it costs, how often it is allowed to cost it, and which city it
// draws - the three things measured live when the image out of the window was
// empty of buildings and the aircraft under it surged and stalled.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {framePacing,buildingSourceFor,FRAME_MIN_MS,FRAME_MAX_MS,DUTY_BUDGET,MAP_FRAME_MULTIPLE,FOOTPRINT_RANGE_M,FOOTPRINT_REFOCUS_M,AirframeCamera} from '../../../../digital_twin/visualization/web/airframe_camera.js';
import {encodeJpeg,AircraftCameraPanel} from '../../../../user_application/web/aircraft_camera_panel.js';
import {FakeElement,fakeDocument} from './fake_dom.mjs';

const camera=readFileSync('digital_twin/visualization/web/airframe_camera.js','utf-8');
const panel=readFileSync('user_application/web/aircraft_camera_panel.js','utf-8');

test('the wait between frames is set by floors that do not cancel',()=>{
  // The old law was `cost*2.5`. Its duty is cost/(2.5*cost) = 40% for EVERY
  // cost: a frame made twice as cheap was simply asked for twice as often and
  // the map got nothing back. Measured live at 40% of the main thread while
  // the aircraft under the window surged and stalled. These floors do not
  // cancel, so a cheaper frame is idle time the map actually keeps.
  assert.equal(framePacing(50,62),250,'the wait is cost/DUTY_BUDGET');
  assert.equal(50/framePacing(50,62),DUTY_BUDGET,'and the budget is the budget');
  assert.equal(80/framePacing(80,62),DUTY_BUDGET,'at any cost the budget can hold');
  assert.equal(framePacing(20,150),150*MAP_FRAME_MULTIPLE,'a map in trouble sheds the camera first');
  assert.equal(framePacing(10,62),FRAME_MIN_MS,'never faster than the detector will read');
  assert.equal(framePacing(500,62),FRAME_MAX_MS,'an expensive frame overshoots the budget rather than freezing the image');
  assert.equal(framePacing(NaN,62),FRAME_MAX_MS,'no measurement yet is treated as expensive');
  assert.equal(framePacing(50),250,'an unmeasured host does not raise the floor');
  assert.ok(DUTY_BUDGET<=.25,'never more than a quarter of the thread');
});

test('the camera is paced to the period the detector will accept a frame at',()=>{
  // The panel refuses to submit a frame less than FRAME_MIN_MS after the last.
  // Paced below that, a frame is rendered and thrown away: at 186 ms on a 62 ms
  // host grid the detector ran at 2.7 Hz while the camera drew 5.4 images a
  // second. Rendering exactly as often as a frame can be read costs less AND
  // detects more, so the two periods are one number.
  assert.match(panel,new RegExp('this\\.session\\.last>='+FRAME_MIN_MS),'the panel submits at exactly this period');
});

test('the host frame time is measured from the gap between update calls',()=>{
  // `update` is called once per host frame, so the gap between calls is the
  // map's own frame time - the thing the camera has to stay underneath. It is
  // measured here because this is the only place that can see it.
  const c=new AirframeCamera({C:{}},{getContext:()=>null,ownerDocument:{hidden:true}},()=>{});
  c.update(null,1000);
  assert.ok(!Number.isFinite(c.hostFrameMs),'one call is not yet a gap');
  c.update(null,1062);
  assert.equal(Math.round(c.hostFrameMs),62);
  c.update(null,1062+9000);
  assert.equal(Math.round(c.hostFrameMs),62,'a gap the size of a pause is not a frame time');
});

test('the wait is a timer of its own, not the host frame grid',()=>{
  // Gating on `now` inside update() rounded every interval up to the next host
  // frame: a 125 ms wait on a 62 ms grid is really 186 ms, so the share the
  // camera took never matched the share the law asked for.
  const update=camera.slice(camera.indexOf('update(frame,now){'),camera.indexOf('cancelFrame(){'));
  assert.doesNotMatch(update,/now-this\.last<this\.interval\)return;/,'the host grid no longer decides when a frame is due');
  assert.match(update,/wait=Math\.max\(0,this\.interval-\(now-this\.last\)\)/);
  assert.match(update,/\},wait\);/,'the render task waits out the remainder itself');
});

test('the cost that paces the camera is smoothed, and the spike is still reported',()=>{
  // Found live: single renders of 100-500 ms while a terrain tile or a city
  // cell compiled. One of those must not slow the next second of frames, but
  // it must not disappear from the readout either.
  assert.match(camera,/this\.cost=Number\.isFinite\(this\.cost\)\?this\.cost\*\.7\+ms\*\.3:ms;this\.interval=framePacing\(this\.cost,this\.hostFrameMs\)/);
  assert.match(camera,/last:Math\.round\(ms\)/);
  assert.match(camera,/this\.onStatus\(\{fps:this\.stats\.fps,ms:this\.stats\.ms,last:this\.stats\.last,duty:this\.stats\.duty,/);
  // The share the camera actually took, not the share the law intended. Those
  // two came apart once and nobody could see it, because only the intention
  // was ever written down.
  assert.match(camera,/duty:Math\.round\(fps\*this\.cost\/10\)/);
  assert.doesNotMatch(camera,/Math\.max\(160,Math\.min\(500,ms\*5\)\)/,'the old 2-6 fps clamp is gone');
});

test('the camera draws the same family of buildings the map is drawing',()=>{
  // The map\'s `vworld` is the footprint layer. Answering it with ion\'s OSM
  // tileset put a different, slowly streaming city in the window - or none.
  assert.equal(buildingSourceFor('vworld'),'footprints');
  assert.equal(buildingSourceFor('vworld_3d'),'vworld_3d');
  assert.equal(buildingSourceFor('vworld_hybrid'),'vworld_3d');
  assert.equal(buildingSourceFor('osm'),'osm');
  assert.equal(buildingSourceFor('vworld',false),null,'buildings off on the map is buildings off here');
  assert.ok(FOOTPRINT_RANGE_M>=2000&&FOOTPRINT_RANGE_M<=4000,'a horizon, not a city');
});

test('the city around the lens is selected again only when the lens has moved',()=>{
  // The building layer decides whether it may keep its cell selection by
  // comparing the focus BY IDENTITY. A fresh object literal every half second
  // answered no every time, so the whole grid was re-selected twice a second
  // for a camera that had not left the cell it was in. The cells are about
  // 1.1 km wide; the lens moves tens of metres.
  const seen=[];
  const C={Cartesian3:class{constructor(x,y,z){Object.assign(this,{x,y,z});}},
    Cartographic:{fromCartesian:p=>({longitude:p.x,latitude:p.y,height:100})}};
  const c=new AirframeCamera({C},{getContext:()=>null},()=>{});
  c.footprints={update:(height,view,now,focus)=>{seen.push(focus);}};
  const at=(lon,lat)=>({position:[lon*Math.PI/180,lat*Math.PI/180,0]});
  c.updateFootprints(at(127,37.5),1000);
  c.updateFootprints(at(127.0005,37.5),2000);
  assert.equal(seen.length,2,'both calls reached the layer');
  assert.equal(seen[0],seen[1],'44 m is the same cells: the selection is kept');
  c.updateFootprints(at(127.02,37.5),3000);
  assert.notEqual(seen[2],seen[0],'1.7 km is different cells: it selects again');
  assert.ok(FOOTPRINT_REFOCUS_M<1000,'and the threshold stays well inside one cell');
});

test('the footprint city reuses cells the map has already fetched and is torn down with the camera',()=>{
  assert.match(camera,/const cell=main\?\.cells\?\.get\(cellKey\(column,row\)\);/);
  assert.match(camera,/cell\?\.data\?Promise\.resolve\(\{buildings:cell\.data\}\):fetchCell\(column,row,options\)/);
  // Decks stand where they stand; the camera must not draw a building through one.
  assert.match(camera,/layer\.setCleared\(main\.cleared,main\.overlapsCleared\)/);
  const stop=camera.slice(camera.indexOf('stop(){'),camera.indexOf('destroy(){'));
  assert.match(stop,/this\.footprints\?\.destroy\(\);this\.footprints=null/);
});

test('per-frame work that does not change per frame is not done per frame',()=>{
  // Sizing a fixed 576x288 host, and walking a thousand map entities for the
  // port structures within 3 km, were both being done on every image.
  const update=camera.slice(camera.indexOf('update(frame,now){'),camera.indexOf('fail(text){'));
  assert.match(update,/if\(!w\.canvas\.width\|\|!w\.canvas\.height\)w\.resize\(\)/);
  assert.match(camera,/this\.widget\.resize\(\);this\.syncImagery\(\);if\(!this\.options\.cockpit\)this\.loadBuildings\(\)/,'sized once, when started');
  assert.match(camera,/if\(!this\.objectScan\|\|scanAt-this\.objectScan\.at>1000\)/);
});

test('the port-structure scan is cached across frames and dropped when the camera stops',()=>{
  class V{constructor(x=0,y=0,z=0){Object.assign(this,{x,y,z});}static distance(){return 10;}}
  let walks=0;
  const values=[{id:'vertiport:VP1:platform',cylinder:{clone:()=>({})},position:{getValue:()=>new V()}}];
  const g={C:{Cartesian3:V,Entity:class{constructor(a){Object.assign(this,a);}}},items:new Map(),entityScene:{assets:new Map()},
    viewer:{clock:{currentTime:0},entities:{get values(){walks++;return values;}}}};
  const c=new AirframeCamera(g,{getContext:()=>null},()=>{});c.widget={entities:{add:e=>e,remove(){}},scene:{}};
  const frame={matrix:[1,0,0,0,0,1,0,0,0,0,1,0,100,200,300,1],profile:{forward:[1,0,0],up:[0,1,0]},assetId:'none'};
  c.syncObjects(frame);c.syncObjects(frame);c.syncObjects(frame);
  assert.equal(walks,1,'three frames, one walk');
  assert.deepEqual([...c.graphics.keys()],['vertiport:VP1:platform']);
  c.widget={destroy(){}};c.stop();
  assert.equal(c.objectScan,null);
});

test('the second context takes less terrain per frame and no post-processing',()=>{
  const start=camera.slice(camera.indexOf('start(){'),camera.indexOf('syncImagery(){'));
  assert.match(start,/scene\.globe\.loadingDescendantLimit=4/);
  assert.match(start,/scene\.globe\.preloadSiblings=false;scene\.globe\.preloadAncestors=false/);
  assert.match(start,/postProcessStages\.fxaa\.enabled=false/);
  assert.match(start,/scene\.globe\.showGroundAtmosphere=false/);
});

test('the detector frame is encoded off the main thread, with the synchronous path only as a fallback',async()=>{
  // toDataURL cost 26 ms per submit, five times a second, on the drawing thread.
  const calls=[];
  const blobCanvas={toBlob(done,type,quality){calls.push([type,quality]);done({size:3});}};
  const original=globalThis.FileReader;
  globalThis.FileReader=class{readAsDataURL(){this.result='data:image/jpeg;base64,QUJD';this.onload();}};
  try{
    assert.equal(await encodeJpeg(blobCanvas,.82),'QUJD');
    assert.deepEqual(calls,[['image/jpeg',.82]]);
  }finally{globalThis.FileReader=original;}
  // Without toBlob (a test canvas, an old engine) the old path still works.
  assert.equal(await encodeJpeg({toDataURL:()=>'data:image/jpeg;base64,WFla'}),'WFla');
  await assert.rejects(encodeJpeg({toBlob:done=>done(null)}),/empty frame/);
  // The live canvas is encoded directly: toBlob copies the bitmap when called,
  // so the copy canvas the old path made per submit (five a second) is gone.
  assert.match(panel,/encodeJpeg\(this\.raw,\.82\)\.then\(image_base64=>/);
  assert.doesNotMatch(panel,/image\.toDataURL\('image\/jpeg'/,'no synchronous encode left on the frame path');
  // One encode in flight at a time, so a slow encode cannot pile up frames.
  assert.match(panel,/!this\.encoding&&this\.now\(\)-this\.session\.last>=200/);
});

test('the panel shows the camera\'s own frame rate and cost',()=>{
  const document={...fakeDocument,body:new FakeElement('body'),hidden:false};
  const workspace={manage(){return {minimized:false,shell:{hidden:false}};},release(){},reveal(){}};
  let status=null;
  const Camera=class{constructor(globe,canvas,onStatus){status=onStatus;}stop(){}set(){}clear(){}destroy(){}};
  const p=new AircraftCameraPanel({document,workspace,globe:{},Camera,requestFrame:()=>1,cancelFrame:()=>{}});
  p.select({entity_id:'u1',kind:'uam'},{selected:true});
  assert.ok(p.perf,'a readout exists');
  status({age:'● 3D LIVE',text:'',fps:12,ms:18,last:20});
  assert.equal(p.perf.textContent,'12 fps · 18 ms');
  // The share of the main thread this camera actually took, beside what it
  // cost. Without it the only number on screen was the one the pacing law
  // intended, and the law was wrong about it for as long as it existed.
  status({age:'● 3D LIVE',text:'',fps:4,ms:50,last:52,duty:20});
  assert.equal(p.perf.textContent,'4 fps · 50 ms · 스레드 20%');
  // A camera that has not measured a share yet says nothing about one.
  status({age:'● 3D LIVE',text:'',fps:4,ms:50,last:52});
  assert.equal(p.perf.textContent,'4 fps · 50 ms');
  // A spike well above the average is worth showing next to it.
  status({age:'● 3D LIVE',text:'',fps:9,ms:18,last:307});
  assert.equal(p.perf.textContent,'9 fps · 18 ms (최대 307)');
  status({age:'LOADING',text:'외부 시점 준비'});
  assert.equal(p.perf.textContent,'','no number until there is a frame');
  p.destroy();
});
