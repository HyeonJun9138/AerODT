import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {rendererOptions,rendererStartupReady,dismissRendererWelcome} from '../../../tools/web_visualization/renderer_performance_check.mjs';

const readiness=(loading,globe)=>()=>runInNewContext(`(${rendererStartupReady.toString()})()`,{
  document:{hidden:false,getElementById:()=>loading},aerodtDiagnostics:{client:{},globe}});

test('renderer benchmark waits through the delayed loading-to-entry handoff',()=>{
  const loading={hidden:false,dataset:{phase:'ready'}},globe={entityScene:{assets:new Map([['model',{}]])},entryActive:false};
  const ready=readiness(loading,globe);
  assert.equal(ready(),false,'a client/assets handle does not mean the startup camera is finished');
  globe.entryAbort=new AbortController();globe.entryActive=true;loading.dataset.phase='leaving';
  assert.equal(ready(),false);
  loading.hidden=true;assert.equal(ready(),false,'the veil can be hidden during the entry flight');
  globe.entryActive=false;assert.equal(ready(),true);
  globe.transitioning=true;assert.equal(ready(),false);
});

test('an aborted or never-started entry is not accepted as successful startup',()=>{
  const loading={hidden:true,dataset:{phase:'leaving'}},globe={entityScene:{assets:new Map([['model',{}]])},entryActive:false};
  const ready=readiness(loading,globe);
  assert.equal(ready(),false);
  globe.entryAbort=new AbortController();globe.entryAbort.abort();assert.equal(ready(),false);
});

test('building-provider override is opt-in and constrained to real browser providers',()=>{
  const args=['--variants','modified'];
  assert.equal(rendererOptions(args).buildingProvider,null);
  for(const provider of ['osm','vworld','vworld_3d','vworld_hybrid'])
    assert.equal(rendererOptions([...args,'--building-provider',provider]).buildingProvider,provider);
  assert.throws(()=>rendererOptions([...args,'--building-provider','unknown']),/Unknown building provider/);
});

test('renderer benchmark dismisses the blurring welcome modal before sampling',async()=>{
 for(const open of [false,true]){
  const calls=[],dialog={open,dataset:{phase:'ready'}};
  const run=fn=>runInNewContext(`(${fn.toString()})()`,{document:{getElementById:()=>dialog}});
  const page={evaluate:async fn=>run(fn),waitForFunction:async fn=>{assert.equal(run(fn),true);calls.push('wait');},
   click:async selector=>{assert.equal(selector,'#welcome-start');calls.push('click');dialog.open=false;}};
  await dismissRendererWelcome(page);
  assert.deepEqual(calls,open?['wait','click','wait']:[]);assert.equal(dialog.open,false);
 }
});

test('renderer probe accepts an operator viewport and rejects malformed dimensions',()=>{
 const args=['--variants','modified'];
 assert.deepEqual(rendererOptions(args).viewport,{width:1600,height:900});
 assert.equal(rendererOptions([...args,'--cpu-profile']).cpuProfile,true);
 assert.deepEqual(rendererOptions([...args,'--viewport','3440x1384']).viewport,{width:3440,height:1384});
 for(const size of ['0x900','3440x0','9000x900','3440x1384x2','NaNx900'])
  assert.throws(()=>rendererOptions([...args,'--viewport',size]),/Viewport/);
});
