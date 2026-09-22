import test from 'node:test';
import assert from 'node:assert/strict';
import {LocalTerrainProvider,mergeHeightTile,mergeHeightTileSliced,loadLocalTerrain} from '../../../../digital_twin/visualization/web/local_terrain_provider.js';
import {LiveGlobe} from '../../../../digital_twin/visualization/web/globe.js';

const rect={west:0,south:0,east:1,north:1};
const meta={bounds:[[0,0,60,60]],width:65,height:65,min_level:6,max_level:14,credit:'user',version:'v1'};
const C={HeightmapTerrainData:class {constructor(o){Object.assign(this,o);}},
  TerrainProvider:{getEstimatedLevelZeroGeometricErrorForAHeightmap:()=>100}};
function buffer(height=80,weight=1,size=65) {const v=new Float32Array(size*size*2);v.fill(height,0,size*size);v.fill(weight,size*size);return v.buffer;}
function world() {return {calls:0,tilingScheme:{tileXYToRectangle:()=>rect,ellipsoid:{},getNumberOfXTilesAtLevel:()=>2,positionToTileXY:()=>({x:0,y:0})},
  availability:{computeMaximumLevelAtPosition:()=>18},errorEvent:{},getTileDataAvailable:()=>true,
  getLevelMaximumGeometricError:()=>10,
  requestTileGeometry(){this.calls++;return Promise.resolve({interpolateHeight:()=>20});}};}

test('height layout, blending, missing pixels and invalid wire values',()=>{
  const original={interpolateHeight:(r,x,y)=>10+x+y};
  assert.equal(mergeHeightTile(C,original,rect,buffer(80,1,2),2,0).buffer[0],80);
  assert.equal(mergeHeightTile(C,original,rect,buffer(80,0,2),2,0).buffer[0],11);
  assert.equal(mergeHeightTile(C,original,rect,buffer(80,.5,2),2,0).buffer[0],45.5);
  assert.throws(()=>mergeHeightTile(C,original,rect,new ArrayBuffer(4),2,0));
  assert.throws(()=>mergeHeightTile(C,original,rect,buffer(NaN,1,2),2,0));
});

test('sliced DEM blending preserves every height, coordinate, mask and credit',async()=>{
  const data=buffer(),view=new Float32Array(data),count=65*65;
  for(let i=0;i<count;i++){view[i]=i/10;view[count+i]=(i%5)/4;}
  let yields=0,samples=0,lastSamples=0;
  const original={interpolateHeight:(_r,x,y)=>{samples++;return 10+x+2*y;}};
  const expected=mergeHeightTile(C,original,rect,data,65,13,'credit');samples=0;
  const actual=await mergeHeightTileSliced(C,original,rect,data,65,13,'credit',{
    now:()=>0,yieldWork:async()=>{assert.ok(samples-lastSamples<=256);lastSamples=samples;yields++;}});
  assert.deepEqual(actual,expected);
  assert.equal(yields,Math.ceil(samples/256));
});

test('fully covered local heights do not incur an artificial per-pixel batch delay',async()=>{
  let yields=0;
  const tile=await mergeHeightTileSliced(C,null,rect,buffer(),65,0,null,{
    now:()=>0,yieldWork:async()=>{yields++;}});
  assert.equal(yields,1);assert.ok(tile.buffer.every(h=>h===80));
});

test('terrain CPU work yields to the time budget even before the sample cap',async()=>{
  let clock=0,yields=0;
  await mergeHeightTileSliced(C,{interpolateHeight:()=>20},rect,buffer(80,.5,2),2,0,null,{
    now:()=>clock++,yieldWork:async()=>{yields++;}});
  assert.equal(yields,2);
});

test('cancelled local terrain stops after yielding without world fallback or pending leaks',async()=>{
  const request={cancelled:false},w=world();let yields=0,fallbacks=0;
  const p=new LocalTerrainProvider(C,w,meta,{fetchTile:()=>buffer(80,.5),onFallback:()=>fallbacks++,
    yieldWork:async()=>{if(++yields===2)request.cancelled=true;}});
  await assert.rejects(p.requestTileGeometry(0,0,10,request),/cancelled/);
  assert.equal(yields,2);assert.equal(w.calls,1);assert.equal(fallbacks,0);assert.equal(p.pending,0);
});

test('covered local interior does not fetch world data, terminates at native-detail limit',async()=>{
  const w=world(),p=new LocalTerrainProvider(C,w,meta,{fetchTile:()=>Promise.resolve(buffer())});
  const tile=await p.requestTileGeometry(0,0,14);
  assert.equal(w.calls,0);assert.equal(tile.buffer[0],80);assert.equal(tile.childTileMask,0);
  assert.equal(p.getTileDataAvailable(0,0,15),false);
  assert.equal(p.availability.computeMaximumLevelAtPosition({}),14);
  assert.equal(p.pending,0);
});

test('boundary blends with the original world mesh; distant views stay untouched',async()=>{
  const w=world(),p=new LocalTerrainProvider(C,w,meta,{fetchTile:()=>Promise.resolve(buffer(80,.5))});
  assert.equal((await p.requestTileGeometry(0,0,10)).buffer[0],50);assert.equal(w.calls,1);
  assert.equal((await p.requestTileGeometry(0,0,5)).interpolateHeight(),20);assert.equal(w.calls,2);
  const outside=new LocalTerrainProvider(C,w,{...meta,bounds:[[100,20,101,21]]},{fetchTile:()=>{throw Error('must not fetch');}});
  assert.equal((await outside.requestTileGeometry(0,0,10)).interpolateHeight(),20);
});

test('local failure returns world terrain, throttle returns undefined and concurrency is bounded',async()=>{
  const w=world();let warnings=0;
  const p=new LocalTerrainProvider(C,w,meta,{fetchTile:()=>Promise.reject(Error('offline')),onFallback:()=>warnings++});
  assert.equal((await p.requestTileGeometry(0,0,10)).interpolateHeight(),20);assert.equal(warnings,1);
  p.fetchTile=()=>undefined;assert.equal(p.requestTileGeometry(0,0,10),undefined);
  let done;p.fetchTile=()=>new Promise(r=>done=r);
  const first=p.requestTileGeometry(0,0,10);p.pending=6;
  assert.equal(p.requestTileGeometry(0,0,10),undefined);p.pending=1;done(buffer());await first;
  assert.equal(p.pending,0);
});

test('switching back to world invalidates a pending local selection',async()=>{
  let resolve;const w=world();const pending=new Promise(r=>resolve=r),attached=[];
  const g={C,worldTerrain:w,terrainRevision:0,activeTerrainSource:'world_terrain',localTerrainPending:pending,
    attachTerrain:p=>attached.push(p),onTerrainStatus:()=>{},onWarning:()=>{}};
  const local=LiveGlobe.prototype.setTerrainSource.call(g,'local_dem');
  await LiveGlobe.prototype.setTerrainSource.call(g,'world_terrain');
  resolve({local:true});await local;
  assert.equal(g.activeTerrainSource,'world_terrain');assert.deepEqual(attached,[]);
});

test('switching sources while flat updates the saved provider rather than enabling relief',()=>{
  const provider={},g={terrainFlat:true,savedTerrainProvider:null,viewer:{terrainProvider:'flat',scene:{requestRender(){}}},surface:{}};
  LiveGlobe.prototype.attachTerrain.call(g,provider);
  assert.equal(g.viewer.terrainProvider,'flat');assert.equal(g.savedTerrainProvider,provider);
});


test('conditioned DEM uses its own metadata and tile endpoint',async()=>{
  const previous=globalThis.fetch,urls=[];
  globalThis.fetch=async url=>{urls.push(url);return {ok:true,json:async()=>({...meta,enabled:true,schema_version:1})};};
  const Cesium={...C,Request:class{},RequestType:{TERRAIN:0},Resource:class{
    constructor(options){this.options=options;}
    fetchArrayBuffer(){urls.push(this.options.url);return Promise.resolve(buffer());}
  }};
  try {
    const provider=await loadLocalTerrain(Cesium,world(),{source:'conditioned'});
    assert.equal((await provider.requestTileGeometry(0,0,14)).buffer[0],80);
    assert.equal(urls[0],'/api/visualization/terrain/conditioned');
    assert.match(urls[1],/^\/api\/visualization\/terrain\/conditioned\/14\/0\/0\?v=v1$/);
    await assert.rejects(loadLocalTerrain(Cesium,world(),{source:'../private'}));
  } finally {globalThis.fetch=previous;}
});

test('conditioned selection attaches only conditioned heights and can return to world',async()=>{
  const w=world(),conditioned={},local={},attached=[];
  const g={C,worldTerrain:w,terrainRevision:0,activeTerrainSource:'world_terrain',conditionedTerrain:conditioned,localTerrain:local,
    attachTerrain:p=>attached.push(p),onTerrainStatus:()=>{},onWarning:()=>{}};
  await LiveGlobe.prototype.setTerrainSource.call(g,'conditioned_dem');
  assert.equal(g.activeTerrainSource,'conditioned_dem');assert.equal(attached.at(-1),conditioned);
  await LiveGlobe.prototype.setTerrainSource.call(g,'local_dem');
  assert.equal(attached.at(-1),local);
  await LiveGlobe.prototype.setTerrainSource.call(g,'world_terrain');
  assert.equal(g.activeTerrainSource,'world_terrain');assert.equal(attached.at(-1),w);
});

test('stale conditioned load cannot overwrite a newer local selection',async()=>{
  let resolve;const attached=[],local={},pending=new Promise(r=>resolve=r);
  const g={C,worldTerrain:world(),terrainRevision:0,activeTerrainSource:'world_terrain',conditionedTerrainPending:pending,localTerrain:local,
    attachTerrain:p=>attached.push(p),onTerrainStatus:()=>{},onWarning:()=>{}};
  const first=LiveGlobe.prototype.setTerrainSource.call(g,'conditioned_dem');
  await LiveGlobe.prototype.setTerrainSource.call(g,'local_dem');resolve({conditioned:true});await first;
  assert.equal(g.activeTerrainSource,'local_dem');assert.deepEqual(attached,[local]);
});

test('unavailable conditioned package warns and retains world without claiming it is active',async()=>{
  const previous=globalThis.fetch;globalThis.fetch=async()=>({ok:true,json:async()=>({enabled:false})});
  const attached=[],warnings=[],w=world();
  const g={C,worldTerrain:w,terrainRevision:0,activeTerrainSource:'world_terrain',
    attachTerrain:p=>attached.push(p),onTerrainStatus:()=>{},onWarning:m=>warnings.push(m)};
  try {
    await LiveGlobe.prototype.setTerrainSource.call(g,'conditioned_dem');
    assert.equal(g.activeTerrainSource,'world_terrain');assert.equal(attached[0],w);
    assert.match(warnings[0],/보정 DEM 연결 실패/);
  } finally {globalThis.fetch=previous;}
});
