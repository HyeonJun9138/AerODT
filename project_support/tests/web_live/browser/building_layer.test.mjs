import test from 'node:test';
import assert from 'node:assert/strict';
import {BuildingLayer,loadOsmBuildings} from '../../../../digital_twin/visualization/web/building_layer.js';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function setup(load){const states=[];const added=[];return {layer:new BuildingLayer({load,attach:t=>added.push(t),onStatus:s=>states.push(s)}),states,added};}
test('buildings are lazy, use altitude hysteresis, reuse hidden tileset',async()=>{
 let calls=0;const tiles={show:false,trimLoadedTiles(){this.trimmed=true;}};
 const {layer,added}=setup(async()=>{calls++;return tiles;});
 layer.update(23000000);assert.equal(calls,0);
 layer.update(15000);layer.update(14000);await flush();assert.equal(calls,1);assert.equal(added.length,1);assert.equal(tiles.show,true);
 layer.update(22000);assert.equal(tiles.show,true);
 layer.update(26000);assert.equal(tiles.show,false);assert.equal(tiles.trimmed,undefined,'a quick overview retains the nearby city');
 layer.update(10000);assert.equal(tiles.show,true);assert.equal(calls,1);
 layer.setEnabled(false);assert.equal(tiles.show,false);assert.equal(tiles.trimmed,true,'explicit disable still releases tiles');
});
test('sustained distant viewing trims once after retention and a return cancels the deadline',async()=>{
 let trims=0;const tiles={show:false,trimLoadedTiles(){trims++;}};
 const {layer}=setup(async()=>tiles);
 layer.update(1000,0);await flush();layer.update(100000,1000);layer.update(1000,14000);
 assert.equal(trims,0);layer.update(100000,20000);layer.update(100000,34999);assert.equal(trims,0);
 layer.update(100000,35000);layer.update(100000,50000);assert.equal(trims,1);
 layer.update(1000,60000);assert.equal(tiles.show,true);
});
test('late completion remains hidden when zoomed out and failures back off',async()=>{
 let done;const {layer}=setup(()=>new Promise(resolve=>done=resolve));
 layer.update(1000);layer.update(100000);done({show:true});await flush();assert.equal(layer.tileset.show,false);
 let calls=0;const failed=setup(async()=>{calls++;throw Error('secret');});
 failed.layer.update(1000,0);await flush();failed.layer.update(1000,1000);assert.equal(calls,1);
 failed.layer.update(1000,61000);await flush();assert.equal(calls,2);assert.equal(failed.states.at(-1),'error');
});

test('terrain gate hides buildings without destroying warm tile cache',async()=>{
 let calls=0;const tiles={show:false,trimLoadedTiles(){this.trimmed=true;}};
 const {layer}=setup(async()=>{calls++;return tiles;});
 layer.setSurfaceReady(false);layer.update(1000);await flush();assert.equal(calls,0);
 layer.setSurfaceReady(true);layer.update(1000);await flush();assert.equal(tiles.show,true);
 layer.setSurfaceReady(false);assert.equal(tiles.show,false);assert.equal(tiles.trimmed,undefined);
 layer.setSurfaceReady(true);assert.equal(tiles.show,true);assert.equal(calls,1);
});

test('building tiles keep streaming while the camera follows an object',async()=>{
 const originalFetch=globalThis.fetch;let options=null;
 globalThis.fetch=async()=>({ok:true,json:async()=>({url:'https://example.invalid/tileset.json',accessToken:'t'})});
 const C={IonResource:class{},Resource:class{},ShadowMode:{DISABLED:0},
  Cesium3DTileset:{fromUrl:async(_resource,given)=>{options=given;return {destroy(){}};}}};
 try {await loadOsmBuildings(C);} finally {globalThis.fetch=originalFetch;}
 assert.equal(options.cullRequestsWhileMoving,false,'a pursuit moves the camera every frame; culling would starve the tileset');
 assert.equal(options.cacheBytes,192*1024*1024);assert.equal(options.maximumCacheOverflowBytes,64*1024*1024);
 assert.equal(options.show,false);assert.equal(options.enableCollision,false);
});
test('failed attachment releases GPU resources and can retry without a stale tileset',async()=>{
 const tiles={destroy(){this.dead=true;}};
 const layer=new BuildingLayer({load:async()=>tiles,attach:()=>{throw Error('attach failed');}});
 layer.update(1000,0);await flush();assert.equal(tiles.dead,true);assert.equal(layer.tileset,null);assert.equal(layer.lastStatus,'error');
});
