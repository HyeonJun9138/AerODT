import test from 'node:test';
import assert from 'node:assert/strict';
import {ENTRY,planEntry} from '../../../../digital_twin/visualization/web/entry_flight.js';

const home={longitude:126.978,latitude:37.5665,height:120000};
function event(){
  const listeners=new Set();
  return {listeners,addEventListener(fn){listeners.add(fn);return ()=>listeners.delete(fn);},
    emit(...args){for(const fn of [...listeners])fn(...args);}};
}
function harness(options={}){
  let time=0,requested=0;
  const scene={preUpdate:event(),postRender:event(),renderError:event(),requestRender(){requested++;}};
  const visibility=new EventTarget();visibility.hidden=false;
  const page=new EventTarget(),views=[],progress=[],controller=new AbortController();
  const camera={setView(view){views.push(view.destination);}};
  const C={Cartesian3:{fromDegrees:(longitude,latitude,height)=>({longitude,latitude,height})}};
  const settings={scene,visibility,page,signal:controller.signal,plan:{...planEntry(home),duration:.1},now:()=>time,
    requestFrame(){throw new Error('A second animation clock must not run alongside Cesium');},
    onProgress:t=>progress.push(t),...options};
  const pending=ENTRY.fly(C,camera,home,settings);
  return {C,camera,scene,views,progress,controller,pending,visibility,page,settings,
    update(ms=50){time+=ms;scene.preUpdate.emit(scene);},render(){scene.postRender.emit(scene);},
    elapse(ms){time+=ms;},get requested(){return requested;}};
}
function disposed(h){
  assert.equal(h.scene.preUpdate.listeners.size,0);
  assert.equal(h.scene.postRender.listeners.size,0);
  assert.equal(h.scene.renderError.listeners.size,0);
}

test('the camera advances in scene update and hand-over waits for its final rendered frame',async()=>{
  const h=harness();let complete=false;h.pending.then(()=>complete=true);
  assert.equal(h.requested,1);
  h.render();await Promise.resolve();assert.equal(complete,false);
  h.update();assert.ok(h.views.at(-1).height>home.height);h.render();
  h.update();assert.deepEqual(h.views.at(-1),home);await Promise.resolve();
  assert.equal(complete,false,'setting the destination does not mean it was rendered');
  assert.equal(h.requested,3,'explicit rendering is requested for every camera pose');
  const count=h.views.length;h.update();assert.equal(h.views.length,count,'do not repeat the final camera mutation');
  h.render();assert.equal(await h.pending,'complete');disposed(h);
});

test('renderer failure rejects the arrival and removes every camera callback',async()=>{
  const h=harness(),error=new Error('WebGL context lost');
  const rejected=assert.rejects(h.pending,e=>e===error);
  h.update();const late=[...h.scene.preUpdate.listeners][0];
  h.scene.renderError.emit(h.scene,error);await rejected;disposed(h);
  const count=h.views.length;late();assert.equal(h.views.length,count);
});

test('aborting after the final pose cannot restore layers through a late completion',async()=>{
  const h=harness();h.update();h.update();
  h.controller.abort();assert.equal(await h.pending,'cancel');disposed(h);h.render();
});

test('hidden time does not advance the scene clock and returning requests a fresh frame',async()=>{
  const h=harness();h.update(20);const before=h.progress.at(-1),requests=h.requested;
  h.visibility.hidden=true;h.visibility.dispatchEvent(new Event('visibilitychange'));
  h.update(60000);h.render();assert.equal(h.progress.at(-1),before);assert.equal(h.requested,requests);
  h.visibility.hidden=false;h.visibility.dispatchEvent(new Event('visibilitychange'));
  assert.equal(h.requested,requests+1);h.update(20);assert.equal(h.progress.at(-1),.4);
  h.page.dispatchEvent(new Event('pagehide'));assert.equal(await h.pending,'cancel');disposed(h);
});

test('one camera has only one entry writer when an arrival is superseded',async()=>{
  const h=harness();h.update();
  const next=ENTRY.fly(h.C,h.camera,home,h.settings);
  assert.equal(await h.pending,'cancel');assert.equal(h.scene.preUpdate.listeners.size,1);
  h.update();h.update();h.render();assert.equal(await next,'complete');disposed(h);
});

test('a pre-aborted request leaves the current camera and its active arrival untouched',async()=>{
  const h=harness(),abort=new AbortController();abort.abort();const count=h.views.length;
  assert.equal(await ENTRY.fly(h.C,h.camera,home,{...h.settings,signal:abort.signal}),'cancel');
  assert.equal(h.views.length,count);assert.equal(h.scene.preUpdate.listeners.size,1);
  h.controller.abort();await h.pending;disposed(h);
});

test('cancel from a progress callback leaves no orphan browser animation frame',async()=>{
  const abort=new AbortController(),frames=new Map();let id=0;
  const C={Cartesian3:{fromDegrees(){return {};}}},camera={setView(){}};
  const pending=ENTRY.fly(C,camera,home,{signal:abort.signal,now:()=>0,
    requestFrame:fn=>{frames.set(++id,fn);return id;},cancelFrame:token=>frames.delete(token),
    onProgress:()=>abort.abort()});
  const tick=[...frames.values()][0];frames.clear();tick(16);
  assert.equal(await pending,'cancel');assert.equal(frames.size,0);
});

test('a camera placement error rejects without retaining a scene listener',async()=>{
  const h=harness();h.controller.abort();await h.pending;
  h.camera.setView=()=>{throw new Error('camera unavailable');};
  await assert.rejects(ENTRY.fly(h.C,h.camera,home,{...h.settings,signal:undefined}),/camera unavailable/);
  disposed(h);
});
