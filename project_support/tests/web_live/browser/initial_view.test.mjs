import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {waitForInitialView} from '../../../../digital_twin/visualization/web/initial_view.js';

function event(){const listeners=new Set();return {listeners,addEventListener(fn){listeners.add(fn);return ()=>listeners.delete(fn);},emit(){for(const fn of [...listeners])fn();}};}
function setup(options={}){
  let time=0,expire,visible=true,requests=0;
  const visibility=event();
  const scene={postRender:event(),renderError:event(),camera:{changed:event()},requestRender(){requests++;}},controller=new AbortController();
  const state={imagery:'ready',terrain:'ready',tilesLoaded:true};const messages=[];
  const promise=waitForInitialView({scene,read:()=>state,onStatus:m=>messages.push(m),signal:controller.signal,now:()=>time,
    isVisible:()=>visible,onVisibilityChange:fn=>visibility.addEventListener(fn),
    setTimer:fn=>{expire=fn;return 1;},clearTimer:()=>{expire=null;},...options});
  return {scene,state,messages,promise,controller,frame(ms=200){time+=ms;scene.postRender.emit();},timeout(){expire?.();},get timer(){return expire;},
    visibility,hide(){visible=false;visibility.emit();},show(){visible=true;visibility.emit();},elapse(ms){time+=ms;},get requests(){return requests;}};
}
test('provider readiness alone is not enough; require stable rendered view',async()=>{
  const s=setup();let done=false;s.promise.then(()=>done=true);
  s.state.terrain='loading';s.frame();s.frame(1000);await Promise.resolve();assert.equal(done,false);
  s.state.terrain='ready';s.state.tilesLoaded=false;s.frame();await Promise.resolve();assert.equal(done,false);
  s.state.tilesLoaded=true;s.frame();s.frame();await Promise.resolve();assert.equal(done,false);
  s.frame(400);await s.promise;assert.equal(done,true);assert.equal(s.scene.postRender.listeners.size,0);assert.equal(s.timer,null);
});
test('new tile requests reset the stable frame window',async()=>{
  const s=setup();let done=false;s.promise.then(()=>done=true);
  s.frame();s.frame();s.state.tilesLoaded=false;s.frame();s.state.tilesLoaded=true;s.frame();s.frame();
  await Promise.resolve();assert.equal(done,false);s.frame(400);await s.promise;
});
test('timeouts never resolve as successful map readiness',async()=>{
  const s=setup();s.state.tilesLoaded=false;s.frame();const rejected=assert.rejects(s.promise,/시간/);s.timeout();await rejected;
  assert.equal(s.scene.postRender.listeners.size,0);assert.equal(s.scene.renderError.listeners.size,0);
});
test('provider failure, imagery tile failure and WebGL failure cannot claim completion',async()=>{
  for(const bad of [{imagery:'error'},{terrain:'error'},{terrain:'unavailable'}]){
    const s=setup();Object.assign(s.state,bad);const rejected=assert.rejects(s.promise);s.frame();await rejected;assert.equal(s.timer,null);
  }
  const s=setup();const rejected=assert.rejects(s.promise,/렌더링/);s.scene.renderError.emit();await rejected;
});
test('cached tiles still require several rendered frames; abort disposes listeners',async()=>{
  const s=setup();let done=false;s.promise.then(()=>done=true);s.frame(2000);await Promise.resolve();assert.equal(done,false);
  s.frame(300);s.frame(300);await s.promise;
  const b=setup();const rejected=assert.rejects(b.promise,/취소/);b.controller.abort();await rejected;
  assert.equal(b.scene.postRender.listeners.size,0);assert.equal(b.timer,null);
});
test('hidden tabs pause the deadline without any postRender and recheck fresh frames on return',async()=>{
  const s=setup();let done=false;s.promise.then(()=>done=true);
  s.frame();s.frame();s.hide();assert.equal(s.timer,null);
  s.elapse(60000);s.show();assert.notEqual(s.timer,null);
  s.frame();await Promise.resolve();assert.equal(done,false);
  s.frame(300);s.frame(300);await s.promise;assert.equal(s.visibility.listeners.size,0);
});
test('boot waits for view readiness before marking globe ready, without timeout-success escape',()=>{
  const app=readFileSync(new URL('../../../../user_application/web/app.js',import.meta.url),'utf8');
  assert.match(app,/await globe\.waitForInitialView\(/);
  assert.ok(app.indexOf('await globe.waitForInitialView(')<app.indexOf("report('globe'"));
  assert.doesNotMatch(app,/else \{warning\('일부 지구 영상 타일/);
});

test('cached views keep requesting frames until stable in explicit rendering mode',async()=>{
  const s=setup();let rendered=0;
  while(rendered<s.requests){rendered++;s.frame(200);}
  await s.promise;
  assert.equal(rendered,4);assert.equal(s.scene.camera.changed.listeners.size,0);
});

test('camera changes restart readiness instead of combining frames from different views',async()=>{
  const s=setup();let done=false;s.promise.then(()=>done=true);
  s.frame();s.frame();s.scene.camera.changed.emit();s.frame(600);
  await Promise.resolve();assert.equal(done,false);
  s.frame(300);s.frame(300);await s.promise;assert.equal(s.scene.camera.changed.listeners.size,0);
});

test('a readiness reader or status callback failure rejects promptly and disposes listeners',async()=>{
  for(const callback of ['read','onStatus']){
    const error=new Error(`${callback} failed`),s=setup({[callback]:()=>{throw error;}});
    const rejected=assert.rejects(s.promise,e=>e===error);s.frame();await rejected;
    assert.equal(s.scene.postRender.listeners.size,0);assert.equal(s.scene.renderError.listeners.size,0);
    assert.equal(s.scene.camera.changed.listeners.size,0);assert.equal(s.visibility.listeners.size,0);assert.equal(s.timer,null);
  }
});

test('a postRender callback retained by dispatch cannot keep requesting work after cancellation',async()=>{
  const s=setup(),late=[...s.scene.postRender.listeners][0];
  const rejected=assert.rejects(s.promise,/취소/);s.controller.abort();await rejected;
  const requests=s.requests;late();assert.equal(s.requests,requests);
});
