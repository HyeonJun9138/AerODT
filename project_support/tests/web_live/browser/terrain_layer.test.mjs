import test from 'node:test';
import assert from 'node:assert/strict';
import {TerrainLayer, loadWorldTerrain, configureTerrainStreaming, configureRequestBudget, motionScreenSpaceError, TERRAIN_SCREEN_SPACE_ERROR} from '../../../../digital_twin/visualization/web/terrain_layer.js';

const flush=()=>new Promise(resolve=>setImmediate(resolve));
function event() {
  const listeners=new Set();
  return {addEventListener(fn){listeners.add(fn);return ()=>listeners.delete(fn);},
    raise(value){for(const fn of listeners)fn(value);},get size(){return listeners.size;}};
}
function setup(load, clock=()=>0) {
  const states=[],attached=[];
  return {layer:new TerrainLayer({load,attach:p=>attached.push(p),onStatus:s=>states.push(s),clock}),states,attached};
}

test('terrain starts once, coalesces pending loads, attaches before becoming ready',async()=>{
  let done,calls=0;
  const {layer,states,attached}=setup(()=>{calls++;return new Promise(resolve=>done=resolve);});
  assert.equal(calls,0);
  assert.equal(layer.ready,false);
  const first=layer.start();const second=layer.start();
  await flush();
  assert.equal(calls,1);assert.equal(layer.ready,false);assert.equal(states.at(-1),'loading');
  const provider={errorEvent:event()};done(provider);
  assert.equal(await first,provider);assert.equal(await second,provider);
  assert.deepEqual(attached,[provider]);assert.equal(layer.provider,provider);
  assert.equal(layer.ready,true);assert.equal(states.at(-1),'ready');
  await layer.start();layer.update(1e6);assert.equal(calls,1);
  layer.destroy();
});

test('failure preserves ellipsoid and backs off from failure time before retry',async()=>{
  let now=0,fail,calls=0;
  const provider={};
  const {layer,states,attached}=setup(()=>{
    calls++;return calls===1?new Promise((_,reject)=>fail=reject):Promise.resolve(provider);
  },()=>now);
  const pending=layer.start();await flush();now=10000;fail(new Error('private URL'));
  assert.equal(await pending,null);assert.equal(layer.ready,false);assert.deepEqual(attached,[]);
  now=69999;layer.update();await flush();assert.equal(calls,1);
  now=70001;layer.update();await flush();assert.equal(calls,2);assert.equal(layer.ready,true);
  assert.deepEqual(states,['loading','error','loading','ready']);
  layer.destroy();
});

test('repeated failures increase retry delay and disabled endpoint stops retries',async()=>{
  let now=0,calls=0;
  const failed=setup(async()=>{calls++;throw Error('provider');},()=>now);
  await failed.layer.start();now=60001;await failed.layer.start();
  now=180000;await failed.layer.start();assert.equal(calls,2);
  now=180002;await failed.layer.start();assert.equal(calls,3);
  now=420003;await failed.layer.start();assert.equal(calls,4);
  now=720002;await failed.layer.start();assert.equal(calls,4);
  now=720004;await failed.layer.start();assert.equal(calls,5);
  now=1020005;await failed.layer.start();assert.equal(calls,6);
  failed.layer.destroy();
  let disabledCalls=0;
  const disabled=setup(async()=>{disabledCalls++;throw Object.assign(Error('disabled'),{disabled:true});});
  await disabled.layer.start();disabled.layer.update(1e9);await flush();
  assert.equal(disabledCalls,1);assert.equal(disabled.states.at(-1),'unavailable');
  disabled.layer.destroy();
});

test('synchronous loading failure is handled and late completion after disposal is discarded',async()=>{
  const failed=setup(()=>{throw Error('private URL');});
  assert.equal(await failed.layer.start(),null);assert.equal(failed.states.at(-1),'error');
  failed.layer.destroy();
  let done,signal,destroyed=0;
  const {layer,attached,states}=setup(options=>{signal=options.signal;return new Promise(resolve=>done=resolve);});
  const pending=layer.start();await flush();layer.destroy();
  assert.equal(signal.aborted,true);
  const statuses=states.length;done({destroy(){destroyed++;}});await pending;
  assert.deepEqual(attached,[]);assert.equal(destroyed,1);assert.equal(layer.ready,false);
  layer.update(1e9);layer.setTilesLoading(true);await layer.start();
  assert.equal(states.length,statuses);
});

test('streaming and tile errors are visible without discarding terrain; listeners are disposed',async()=>{
  const errorEvent=event(),provider={errorEvent};
  const {layer,states}=setup(async()=>provider);
  await layer.start();layer.setTilesLoading(true);assert.equal(states.at(-1),'streaming');
  errorEvent.raise({message:'sensitive upstream URL'});assert.equal(states.at(-1),'error');
  layer.setTilesLoading(false);assert.equal(states.at(-1),'error');assert.equal(layer.ready,true);
  layer.setTilesLoading(true);layer.setTilesLoading(false);assert.equal(states.at(-1),'ready');
  assert.equal(errorEvent.size,1);layer.destroy();assert.equal(errorEvent.size,0);
  assert.equal(layer.provider,null);
});

test('terrain cache policy bounds retained offscreen tiles without changing lighting',()=>{
  const globe={enableLighting:false,tileCacheSize:1000,maximumScreenSpaceError:16,preloadSiblings:true};
  configureTerrainStreaming(globe);
  assert.equal(globe.tileCacheSize,400,'a pursuit must not evict and re-download the tiles it just left');assert.equal(globe.maximumScreenSpaceError,2);
  assert.equal(globe.loadingDescendantLimit,20);assert.equal(globe.preloadSiblings,false);
  assert.equal(globe.depthTestAgainstTerrain,true);assert.equal(globe.enableLighting,false);
});

function cesium(providerLoad) {
  class Resource {constructor(options){this.url=options.url;}}
  class IonResource {constructor(endpoint,refresh){this.endpoint=endpoint;this.refresh=refresh;}}
  return {Resource,IonResource,CesiumTerrainProvider:{fromUrl:providerLoad}};
}
const endpoint={type:'TERRAIN',url:'https://assets.ion.cesium.com/1/',accessToken:'temporary-token',attributions:[]};

test('terrain loader uses same-origin token refresh, preserves credits and requests supported normals',async(t)=>{
  let request;
  t.mock.method(globalThis,'fetch',async(url,options)=>{request={url,options};return new Response(JSON.stringify(endpoint));});
  const provider={};let resource,settings;
  const C=cesium(async(r,s)=>{resource=r;settings=s;return provider;});
  assert.equal(await loadWorldTerrain(C),provider);
  assert.equal(request.url,'/api/visualization/terrain/endpoint');
  assert.equal(request.options.cache,'no-store');
  assert.equal(resource.refresh.url,request.url);assert.deepEqual(resource.endpoint,endpoint);
  assert.deepEqual(settings,{requestVertexNormals:true,requestWaterMask:false});
});

test('terrain loader reports disabled separately and never includes upstream failure bodies',async(t)=>{
  let status=404,calls=0;
  t.mock.method(globalThis,'fetch',async()=>new Response('root-secret',{status}));
  const C=cesium(async()=>{calls++;});
  await assert.rejects(loadWorldTerrain(C),error=>error.disabled===true&&!error.message.includes('root-secret'));
  status=503;
  await assert.rejects(loadWorldTerrain(C),error=>error.disabled===false&&!error.message.includes('root-secret'));
  assert.equal(calls,0);
});

test('terrain metadata timeout aborts fetch and never attaches late providers',async(t)=>{
  let fetchSignal,done,destroyed=0;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    fetchSignal=options.signal;return new Response(JSON.stringify(endpoint));
  });
  const C=cesium(()=>new Promise(resolve=>done=resolve));
  await assert.rejects(loadWorldTerrain(C,{timeoutMs:10}),/timeout/);
  assert.equal(fetchSignal.aborted,true);
  done({destroy(){destroyed++;}});await flush();assert.equal(destroyed,1);
});

test('terrain disposal aborts endpoint and does not start provider from its late response',async(t)=>{
  let respond,calls=0;
  t.mock.method(globalThis,'fetch',()=>new Promise(resolve=>respond=resolve));
  const C=cesium(async()=>{calls++;return {};});
  const controller=new AbortController();
  const pending=loadWorldTerrain(C,{signal:controller.signal});
  controller.abort();await assert.rejects(pending,/cancelled/);
  respond(new Response(JSON.stringify(endpoint)));await flush();assert.equal(calls,0);
  await assert.rejects(loadWorldTerrain(C,{signal:controller.signal}),/cancelled/);
});

test('the request budget leaves HTTP/1 relay capacity for models and live APIs',()=>{
  const scheduler={maximumRequestsPerServer:18,maximumRequests:50};
  configureRequestBudget(scheduler);
  assert.equal(scheduler.maximumRequestsPerServer,18);assert.equal(scheduler.maximumRequests,48);
  const wider={maximumRequestsPerServer:64,maximumRequests:200};
  configureRequestBudget(wider,'http://example.test:8766');
  assert.deepEqual(wider,{maximumRequestsPerServer:18,maximumRequests:48,requestsByServer:{'example.test:8766':4}});
  configureRequestBudget(undefined);
});

test('a transient terrain tile failure is retried before it is reported as an error',async()=>{
  const listeners=new Set();
  const errorEvent={addEventListener(cb){listeners.add(cb);return ()=>listeners.delete(cb);},raise(e){for(const cb of [...listeners])cb(e);}};
  const provider={errorEvent};const states=[];
  const layer=new TerrainLayer({load:async()=>provider,attach(){},onStatus:s=>states.push(s)});
  await layer.start();
  const transient={timesRetried:0,error:{statusCode:503}};
  errorEvent.raise(transient);
  assert.equal(transient.retry,true);assert.equal(layer.tileError,false,'not an error yet');
  errorEvent.raise({timesRetried:2,error:{statusCode:503}});
  assert.equal(layer.tileError,true);assert.equal(states.at(-1),'error');
});

test('detail relaxes through the middle of an approach and is back to full before the landing',()=>{
  assert.equal(motionScreenSpaceError(0),TERRAIN_SCREEN_SPACE_ERROR,'nothing blurs at the click');
  assert.ok(motionScreenSpaceError(.3)>TERRAIN_SCREEN_SPACE_ERROR+5,'coarse through the fast middle');
  assert.ok(motionScreenSpaceError(.7)<motionScreenSpaceError(.3),'refining again on the way down');
  assert.equal(motionScreenSpaceError(.9),TERRAIN_SCREEN_SPACE_ERROR,'full detail before the landing');
  assert.equal(motionScreenSpaceError(1),TERRAIN_SCREEN_SPACE_ERROR);
  let previous=-Infinity;
  for(let i=0;i<=10;i++){const value=motionScreenSpaceError(i/20);assert.ok(value>=previous-1e-12);previous=value;}
  previous=Infinity;
  for(let i=10;i<=20;i++){const value=motionScreenSpaceError(i/20);assert.ok(value<=previous+1e-12);previous=value;}
});
