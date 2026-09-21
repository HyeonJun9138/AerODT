import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {startStartupResources,loadStartupEngine} from '../../../../user_application/web/startup_resources.js';

test('initial API requests start while the renderer is still downloading',async()=>{
  const calls=[];let ready;
  const controller=new AbortController();
  const resources=startStartupResources({signal:controller.signal,
    loadEngine:({signal})=>{assert.equal(signal,controller.signal);calls.push('engine');return new Promise(r=>ready=r);},
    loadJSON:async(url,{signal})=>{assert.equal(signal,controller.signal);calls.push(url);return url;}});
  const result=await resources.data;
  assert.deepEqual(calls,['engine','/api/visual-assets','/api/live/snapshot']);
  assert.ok(result.every(item=>item.status==='fulfilled'));
  ready();await resources.engine;
});

test('an unavailable catalogue does not discard live data or hide an engine failure',async()=>{
  const engineError=new Error('engine offline');
  const resources=startStartupResources({loadEngine:()=>{throw engineError;},
    loadJSON:url=>url.includes('visual-assets')?Promise.reject(new Error('catalogue offline')):{entities:[]}});
  const [catalogue,snapshot]=await resources.data;
  assert.equal(catalogue.status,'rejected');assert.equal(snapshot.status,'fulfilled');
  await assert.rejects(resources.engine,error=>error===engineError);
});

function harness(){
  let timer,cleared=0,appended=0,removed=0;
  const script={remove(){removed++;}},scope={},controller=new AbortController();
  const document={createElement:()=>script,head:{append(){appended++;}}};
  const start=()=>loadStartupEngine({document,scope,signal:controller.signal,
    setTimer:fn=>{timer=fn;return 1;},clearTimer:()=>{cleared++;}});
  return {script,scope,controller,start,timeout:()=>timer(),state:()=>({cleared,appended,removed})};
}

test('engine success cleans its callbacks and timeout before returning',async()=>{
  const h=harness(),pending=h.start();h.scope.Cesium={};h.script.onload();await pending;
  assert.equal(h.script.onload,null);assert.equal(h.script.onerror,null);
  assert.deepEqual(h.state(),{cleared:1,appended:1,removed:0});
  h.controller.abort();assert.equal(h.state().cleared,1);
});

test('timeout, abort and network errors clean up; late success cannot recover a failed load',async()=>{
  for(const reason of ['timeout','abort','network']){
    const h=harness(),pending=h.start(),late=h.script.onload;
    const rejected=assert.rejects(pending,/시간이 초과|취소|불러오지/);
    if(reason==='timeout')h.timeout();else if(reason==='abort')h.controller.abort();else h.script.onerror();
    await rejected;h.scope.Cesium={};late();
    assert.deepEqual(h.state(),{cleared:1,appended:1,removed:1});
    assert.equal(h.script.onload,null);assert.equal(h.script.onerror,null);
  }
});

test('an already aborted page never inserts an engine script',async()=>{
  const h=harness();h.controller.abort();await assert.rejects(h.start(),/취소/);
  assert.equal(h.state().appended,0);
});

test('a downloaded script without the engine global is reported as initialization failure',async()=>{
  const h=harness(),pending=h.start();h.script.onload();await assert.rejects(pending,/초기화/);
});

test('module download failure shows a working retry even before app.js runs',async()=>{
  const html=readFileSync(new URL('../../../../user_application/web/index.html',import.meta.url),'utf8');
  const code=html.match(/<script type="module" id="app-bootstrap">([\s\S]*?)<\/script>/)[1];
  const elements={loading:{hidden:true,dataset:{},setAttribute(k,v){this[k]=v;}},'loading-step':{},retry:{hidden:true}};
  let reloads=0;
  new Function('load','document','location','console',code.replace('import(', 'load('))(
    ()=>Promise.reject(new Error('module missing')),{getElementById:id=>elements[id]},
    {reload(){reloads++;}},{error(){}});
  await Promise.resolve();
  assert.equal(elements.loading.hidden,false);assert.equal(elements.loading.dataset.phase,'error');
  assert.equal(elements.retry.hidden,false);elements.retry.onclick();assert.equal(reloads,1);
  assert.match(elements['loading-step'].textContent,/다시 시도/);
});

import {loadStartupStylesheet} from '../../../../user_application/web/startup_resources.js';

function stylesheetHarness({aborted=false,appendError}={}){
  let timer,cleared=0,appended=0,removed=0,created=0;
  const link={remove(){removed++;}},controller=new AbortController();
  if(aborted)controller.abort();
  const document={createElement(tag){assert.equal(tag,'link');created++;return link;},
    head:{append(value){assert.equal(value,link);if(appendError)throw appendError;appended++;}}};
  const start=()=>loadStartupStylesheet({document,signal:controller.signal,
    setTimer(fn,ms){assert.equal(ms,30000);timer=fn;return 1;},clearTimer:()=>{cleared++;}});
  return {link,controller,start,timeout:()=>timer(),state:()=>({cleared,appended,removed,created})};
}

test('stylesheet success retains applied CSS and releases callbacks, timeout and abort listener',async()=>{
  const h=stylesheetHarness(),pending=h.start();
  assert.equal(h.link.rel,'stylesheet');
  assert.equal(h.link.href,'https://cesium.com/downloads/cesiumjs/releases/1.143/Build/Cesium/Widgets/widgets.css');
  const lateError=h.link.onerror;h.link.onload();await pending;
  assert.equal(h.link.onload,null);assert.equal(h.link.onerror,null);
  h.controller.abort();lateError();h.timeout();
  assert.deepEqual(h.state(),{cleared:1,appended:1,removed:0,created:1});
});

for(const reason of ['network','abort','timeout']){
  test(`stylesheet ${reason} failure removes the link; late onload cannot restore an abandoned boot`,async()=>{
    const h=stylesheetHarness(),pending=h.start(),lateLoad=h.link.onload;
    const expected={network:/스타일을 불러오지/,abort:/취소/,timeout:/스타일 연결 시간이 초과/};
    const rejected=assert.rejects(pending,expected[reason]);
    if(reason==='network')h.link.onerror();else if(reason==='abort')h.controller.abort();else h.timeout();
    await rejected;lateLoad();h.controller.abort();h.timeout();
    assert.equal(h.link.onload,null);assert.equal(h.link.onerror,null);
    assert.deepEqual(h.state(),{cleared:1,appended:1,removed:1,created:1});
  });
}

test('an already aborted page creates no stylesheet or timer',async()=>{
  const h=stylesheetHarness({aborted:true});await assert.rejects(h.start(),/취소/);
  assert.deepEqual(h.state(),{cleared:0,appended:0,removed:0,created:0});
});

test('a stylesheet insertion error cleans its timer and leaves no late success path',async()=>{
  const error=new Error('head unavailable'),h=stylesheetHarness({appendError:error});
  await assert.rejects(h.start(),value=>value===error);
  assert.equal(h.link.onload,null);assert.equal(h.link.onerror,null);
  assert.deepEqual(h.state(),{cleared:1,appended:0,removed:1,created:1});
});
