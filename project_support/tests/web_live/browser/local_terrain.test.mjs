import test from 'node:test';
import assert from 'node:assert/strict';
import {LocalTerrainProvider,mergeHeightTile} from '../../../../digital_twin/visualization/web/local_terrain_provider.js';
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
