import test from 'node:test';
import assert from 'node:assert/strict';
import {VWorldImagery, VWORLD_SOURCES, createProvider, tileUrl, KOREA} from '../../../../digital_twin/visualization/web/vworld_imagery.js';
import {VWorldBuildingLayer, cellsFor, buildingCellQuotas, colourFor, centroidOf, fetchCell, CELLS_KEPT, CELL_DEGREES, NEAR_METRES, FAR_METRES,MAX_BUILDINGS,MAX_VERTICES,CELL_BUILDINGS,CONCURRENT_LOADS,CONCURRENT_FETCHES,MOVING_FETCHES,REQUEST_RETENTION_MS} from '../../../../digital_twin/visualization/web/vworld_building_layer.js';

const flush = () => new Promise(resolve => setImmediate(resolve));

test('footprint attribution remains visible without relying on the selected imagery source',()=>{
 const credits=new Set(),C={Credit:class{constructor(text,onScreen){Object.assign(this,{text,onScreen});}}};
 const layer=new VWorldBuildingLayer({C,scene:{frameState:{creditDisplay:{addStaticCredit:c=>credits.add(c),removeStaticCredit:c=>credits.delete(c)}}}});
 layer.showCredit(true);layer.showCredit(true);assert.equal(credits.size,1);assert.equal([...credits][0].onScreen,true);
 layer.destroy();assert.equal(credits.size,0);
});

// ---------------------------------------------------------------- imagery

function imageryHarness() {
  const created = [];
  const C = {
    UrlTemplateImageryProvider: class {constructor(options) {this.options = options; created.push(options);}},
    ImageryLayer: class {constructor(provider) {this.provider = provider;}},
    Rectangle: {fromDegrees: (west, south, east, north) => ({west, south, east, north})},
    WebMercatorTilingScheme: class {},
    Credit: class {constructor(text) {this.text = text;}},
  };
  const layers = {items: [], get length() {return this.items.length;},
    add(layer, index) {this.items.splice(index ?? this.items.length, 0, layer);},
    remove(layer) {this.items = this.items.filter(item => item !== layer);}};
  let renders = 0;
  const viewer = {imageryLayers: layers, scene: {requestRender() {renders++;}}};
  return {C, viewer, layers, created, renders: () => renders};
}

test('a V-World provider asks the dashboard relay for Korea only, at the levels the service has', () => {
  const {C, created} = imageryHarness();
  createProvider(C, 'Satellite', 'jpeg');
  const options = created[0];
  assert.equal(options.url, '/api/visualization/vworld/tiles/Satellite/{z}/{y}/{x}.jpeg');
  assert.equal(tileUrl('Base', 'png'), '/api/visualization/vworld/tiles/Base/{z}/{y}/{x}.png');
  assert.equal(options.minimumLevel, 6); assert.equal(options.maximumLevel, 19);
  assert.deepEqual(options.rectangle, {west: KOREA.west, south: KOREA.south, east: KOREA.east, north: KOREA.north});
  assert.ok(options.hasAlphaChannel, 'a clear tile lets the world imagery through');
  assert.match(options.credit.text, /브이월드/);
  assert.ok(!options.url.includes('vworld.kr'), 'the browser never talks to V-World itself');
});

test('the chosen layers sit right above the base imagery and below what came after it', () => {
  const {C, viewer, layers} = imageryHarness();
  const styled = [];
  const imagery = new VWorldImagery(C, viewer, {style: layer => styled.push(layer)});
  assert.equal(imagery.apply('vworld_satellite'), true, 'remembered before the base exists');
  assert.equal(layers.length, 0, 'nothing is placed on an empty stack');
  const base = {name: 'base'}, labels = {name: 'labels'};
  layers.add(base); layers.add(labels);
  imagery.apply(imagery.source, {force: true});
  assert.deepEqual(layers.items.map(item => item.name ?? item.provider.options.url.split('/')[5]), ['base', 'Satellite', 'labels']);
  assert.equal(styled.length, 1, 'the overlay takes the same look as the base');
  assert.equal(imagery.apply('vworld_satellite'), false, 'the same choice again changes nothing');
  imagery.apply('vworld_hybrid');
  assert.deepEqual(layers.items.map(item => item.name ?? item.provider.options.url.split('/')[5]), ['base', 'Satellite', 'Hybrid', 'labels']);
  imagery.apply('world_imagery');
  assert.deepEqual(layers.items.map(item => item.name), ['base', 'labels'], 'back to the world imagery alone');
  imagery.apply('nonsense');
  assert.equal(imagery.source, 'world_imagery');
  assert.deepEqual(Object.keys(VWORLD_SOURCES), ['vworld_satellite', 'vworld_hybrid', 'vworld_base', 'vworld_midnight']);
});

// ---------------------------------------------------------------- building cells

test('the cells of a view are the nearest ones inside Korea, on the fixed grid', () => {
  const seoul = {lomin: 126.97, lomax: 127.0, lamin: 37.55, lamax: 37.58};
  const cells = cellsFor(seoul);
  assert.equal(cells.length, 16, 'four by four cells of 0.01 degree');
  assert.deepEqual(cells[0], {column: 12698, row: 3756}, 'the centre cell comes first');
  assert.equal(cellsFor(seoul, 3).length, 3);
  assert.deepEqual(cellsFor({lomin: 139.6, lomax: 139.8, lamin: 35.6, lamax: 35.8}), [], 'Tokyo has no V-World');
  assert.deepEqual(cellsFor(null), []);
  const edge = cellsFor({lomin: 123.5, lomax: 124.05, lamin: 33, lamax: 33.02});
  assert.ok(edge.every(cell => cell.column * CELL_DEGREES >= KOREA.west - CELL_DEGREES), 'clipped to the service area');
});

test('heights take the same neutral ramp as the OSM style and centroids are plain means', () => {
  assert.equal(colourFor(200), '#b7c0c9'); assert.equal(colourFor(80), '#a5b1bd'); assert.equal(colourFor(30), '#929fac'); assert.equal(colourFor(3), '#81909f');
  assert.deepEqual(centroidOf([[0, 0], [2, 0], [2, 2], [0, 2]]), {longitude: 1, latitude: 1});
});

function fakeCesium() {
  const primitives = [];
  const C = {
    Color: {fromCssColorString: css => ({css})},
    Cartesian3: {fromDegreesArray: flat => ({flat})},
    PolygonHierarchy: class {constructor(positions, holes = []) {this.positions = positions; this.holes = holes;}},
    PolygonGeometry: class {constructor(options) {Object.assign(this, options);}},
    PerInstanceColorAppearance: Object.assign(class {constructor(options) {this.options = options;}}, {VERTEX_FORMAT: 'vf'}),
    ColorGeometryInstanceAttribute: {fromColor: colour => colour},
    GeometryInstance: class {constructor(options) {Object.assign(this, options);}},
    Primitive: class {constructor(options) {Object.assign(this, options);this.ready=true; primitives.push(this);} update(){} destroy(){this.destroyed=true;}},
    ShadowMode: {DISABLED: 0},
  };
  let frameNumber=0;
  const scene = {primitives: {items: [], add(p) {this.items.push(p);}, remove(p) {this.items = this.items.filter(item => item !== p);p.destroy?.();}}, requestRender() {},
    render(){const state={frameNumber:frameNumber++,passes:{render:true}};for(const p of this.primitives.items)p.update?.(state);}};
  return {C, scene, primitives};
}

const square = (column, row) => {
  const west = column * CELL_DEGREES + .001, south = row * CELL_DEGREES + .001;
  return [[west, south], [west + .0002, south], [west + .0002, south + .0002], [west, south + .0002], [west, south]];
};
const cellData = (column, row, count = 2) => ({buildings: Array.from({length: count}, (_, i) => ({
  id: `${column},${row}:${i}`, height_m: 10 * (i + 1), floors: 3, rings: [{outer: square(column, row), holes: []}]}))});

test('unchanged ground focus reuses cell/frustum selection without stopping the loading pump',async()=>{
 const {C,scene}=fakeCesium();let tested=0,loads=0;
 const layer=new VWorldBuildingLayer({C,scene,load:async(c,r)=>{loads++;return cellData(c,r,1);}});
 layer.setEnabled(true);
 const focus={longitude:126.978,latitude:37.56,accepts:()=>{tested++;return true;}};
 layer.update(500,null,0,focus);const initial=tested;
 for(let now=200;now<2000;now+=200){layer.update(500,null,now,focus);await flush();}
 assert.equal(tested,initial);assert.equal(layer.selectionScans,1);assert.ok(loads>2);
 layer.update(500,null,2000,{...focus,longitude:126.98});assert.ok(tested>initial);
 layer.setEnabled(false);layer.update(500,null,2100,focus);assert.equal(layer.wanted.size,0);
 layer.destroy();
});

test('short yaw excursion retains pending geometry, expiry still abandons offscreen work',()=>{
 const {C,scene}=fakeCesium();
 const layer=new VWorldBuildingLayer({C,scene,load:async()=>({buildings:[]})});
 layer.pump=()=>{};layer.setEnabled(true);layer.setAppearance({distance:'metro'});
 const focus={longitude:127,latitude:37.5,range:1400,hazeStrength:.92,offset:0};
 layer.update(400,null,0,focus);
 assert.ok(layer.wanted.size<20);assert.equal(layer.uniforms.u_buildingRange,1400);
 assert.equal(layer.uniforms.u_buildingHazeStrength,.92);
 const key=[...layer.wanted][0],cell=layer.cells.get(key);
 const old={show:true},pending={ready:false};scene.primitives.add(old);scene.primitives.add(pending);
 Object.assign(cell,{primitive:old,pendingPrimitive:pending,pendingCount:10,pendingVertices:40,state:'ready'});
 layer.update(400,null,200,{...focus,longitude:128});
 assert.equal(cell.pendingPrimitive,pending,'briefly hidden GPU work is not restarted');
 assert.equal(old.show,false);
 layer.update(400,null,400,focus);
 assert.equal(cell.pendingPrimitive,pending,'return reuses the exact pending primitive');
 layer.update(400,null,600,{...focus,longitude:128});
 layer.update(400,null,400+REQUEST_RETENTION_MS,{...focus,longitude:128});
 assert.equal(cell.pendingPrimitive,null);assert.equal(cell.state,'waiting');assert.equal(cell.primitive,old);
 assert.ok(!scene.primitives.items.includes(pending));
 layer.update(400,null,1800,focus);assert.equal(cell.state,'queued','expired detail is prepared again');
 layer.destroy();
});

test('yaw during terrain preparation retains the work but disabling still cancels it',async()=>{
 const {C,scene}=fakeCesium();let release;
 const layer=new VWorldBuildingLayer({C,scene,load:async(c,r)=>cellData(c,r,1),
  groundHeights:points=>new Promise(resolve=>{release=()=>resolve(points.map(()=>0));})});
 const a={lomin:126.971,lomax:126.972,lamin:37.561,lamax:37.562};
 layer.setEnabled(true);layer.update(500,a,0);await flush();
 const cell=[...layer.cells.values()][0],controller=cell.controller;
 layer.pump=()=>{};
 layer.update(500,{...a,lomin:127.171,lomax:127.172},200,null,{moving:true});
 assert.equal(controller.signal.aborted,false);
 release();await flush();assert.equal(layer.geometryBuilds,1);
 assert.equal(cell.primitive.show,false,'retained geometry remains invisible outside the view');
 layer.update(500,a,400,null,{moving:true});assert.equal(cell.primitive.show,true);
 assert.equal(layer.geometryBuilds,1);
 cell.controller=new AbortController();layer.setEnabled(false);
 assert.equal(cell.controller.signal.aborted,true);layer.destroy();
});

test('moving-camera geometry uses smaller CPU batches without dropping buildings',async()=>{
 const {C,scene}=fakeCesium();let yields=0;
 const layer=new VWorldBuildingLayer({C,scene,yieldWork:async()=>{yields++;}});
 layer.moving=true;
 const data=cellData(12697,3756,240).buildings;
 const primitive=await layer.build(data,Array(240).fill(0));
 assert.equal(primitive.parts.flatMap(p=>p.geometryInstances).length,240);
 assert.ok(primitive.parts.every(p=>p.geometryInstances.length<=128));
 assert.ok(yields>=2,'yield at least every 80 buildings during rotation');
 layer.destroy();
});

test('default geometry yield waits past the animation callback before resuming work',async()=>{
 const {C,scene}=fakeCesium();
 const raf=Object.getOwnPropertyDescriptor(globalThis,'requestAnimationFrame');
 const cancel=Object.getOwnPropertyDescriptor(globalThis,'cancelAnimationFrame');
 let callback,finished=false;
 Object.defineProperty(globalThis,'requestAnimationFrame',{configurable:true,value:fn=>{callback=fn;return 1;}});
 Object.defineProperty(globalThis,'cancelAnimationFrame',{configurable:true,value:()=>{}});
 try{
  const layer=new VWorldBuildingLayer({C,scene});
  const pending=layer.yieldWork().then(()=>{finished=true;});
  assert.equal(finished,false);callback();
  await Promise.resolve();assert.equal(finished,false,'do not consume the current paint with the next batch');
  await pending;assert.equal(finished,true);layer.destroy();
 }finally{
  if(raf)Object.defineProperty(globalThis,'requestAnimationFrame',raf);else delete globalThis.requestAnimationFrame;
  if(cancel)Object.defineProperty(globalThis,'cancelAnimationFrame',cancel);else delete globalThis.cancelAnimationFrame;
 }
});

test('multipart footprints also respect upload vertex limits without losing holes',async()=>{
 const {C,scene}=fakeCesium();
 const layer=new VWorldBuildingLayer({C,scene,yieldWork:async()=>{}});
 const outer=Array.from({length:1800},(_,i)=>[127+Math.cos(i/1800*Math.PI*2)*.001,37.5+Math.sin(i/1800*Math.PI*2)*.001]);
 const hole=Array.from({length:300},(_,i)=>[127+Math.cos(i/300*Math.PI*2)*.0001,37.5+Math.sin(i/300*Math.PI*2)*.0001]);
 const result=await layer.build([{height_m:20,rings:Array.from({length:3},()=>({outer,holes:[hole]}))}],[45]);
 assert.equal(result.parts.length,3);
 assert.ok(result.parts.every(p=>p.geometryInstances.length===1));
 assert.ok(result.parts.every(p=>p.geometryInstances[0].geometry.polygonHierarchy.holes.length===1));
 result.destroy();layer.destroy();
});

test('cancelled chunk construction destroys already prepared primitives',async()=>{
 const {C,scene,primitives}=fakeCesium();let active=true;
 const layer=new VWorldBuildingLayer({C,scene,yieldWork:async()=>{if(primitives.length)active=false;}});
 const result=await layer.build(cellData(12697,3756,300).buildings,Array(300).fill(10),()=>active);
 assert.equal(result,null);assert.ok(primitives.length>0);assert.ok(primitives.every(p=>p.destroyed));layer.destroy();
});

test('dense cell samples exact ground in bounded batches and retains previous visible mesh',async()=>{
 const {C,scene}=fakeCesium(),batches=[];
 const layer=new VWorldBuildingLayer({C,scene,yieldWork:async()=>{},groundHeights:async points=>{batches.push(points.length);return points.map(()=>17);}});
 const cell={key:'12697,3756',column:12697,row:3756,limit:250,data:cellData(12697,3756,250).buildings,primitive:{show:true},count:2,vertices:10};
 cell.centroids=cell.data.map(b=>centroidOf(b.rings[0].outer));cell.vertexCounts=cell.data.map(()=>5);
 layer.enabled=layer.near=true;layer.wanted.add(cell.key);layer.cells.set(cell.key,cell);
 await layer.fill(cell,layer.generation,new AbortController().signal);
 assert.deepEqual(batches,[96,96,58]);assert.equal(cell.bases.length,250);assert.ok(cell.bases.every(x=>x===17));
 layer.apply();assert.equal(cell.primitive.show,true);assert.equal(cell.pendingPrimitive.ready,false);
 for(let n=0;n<3;n++){scene.render();layer.apply();}
 assert.equal(cell.pendingPrimitive,null);assert.equal(cell.count,250);assert.equal(cell.primitive.show,true);layer.destroy();
});

test('a rebuilt cell entirely cleared by a deck removes its old buildings',async()=>{
 const {C,scene}=fakeCesium();
 const layer=new VWorldBuildingLayer({C,scene,load:async(c,r)=>cellData(c,r,1)});
 const view={lomin:126.971,lomax:126.972,lamin:37.561,lamax:37.562};
 layer.setEnabled(true);layer.update(1000,view,0);await flush();await flush();
 const cell=[...layer.cells.values()][0],old=cell.primitive;assert.ok(old);
 layer.isCleared=()=>true;layer.rebuild();layer.update(1000,view,200);await flush();await flush();
 assert.equal(cell.primitive,null);assert.equal(cell.count,0);assert.equal(old.destroyed,true);layer.destroy();
});
test('a moving view narrows the fetch budget and postpones warm-cell quota rebuilds until idle',async()=>{
 const {C,scene}=fakeCesium(),releases=[];
 const layer=new VWorldBuildingLayer({C,scene,load:(c,r)=>new Promise(resolve=>releases.push(()=>resolve(cellData(c,r,1))))});
 const view={lomin:126.975,lomax:126.985,lamin:37.565,lamax:37.575};layer.setEnabled(true);
 layer.update(500,view,0,null,{moving:true});assert.equal(releases.length,MOVING_FETCHES,'fewer requests in flight while the camera moves');
 const cell=[...layer.cells.values()].find(x=>!x.controller);cell.state='ready';cell.limit=10000;
 layer.update(500,view,200,null,{moving:true});assert.equal(cell.limit,10000);assert.equal(releases.length,MOVING_FETCHES);
 layer.update(500,view,500,null,{moving:false});assert.ok(cell.limit<10000);
 assert.equal(releases.length,CONCURRENT_FETCHES,'standing still opens the wider budget');
 assert.ok(MOVING_FETCHES<CONCURRENT_FETCHES);
 layer.destroy();for(const release of releases)release();await flush();assert.equal(layer.loading,0);
});

test('cells in view are fetched together, built on the sampled ground and shown only when near', async () => {
  const {C, scene, primitives} = fakeCesium();
  const loads = [], states = [], grounds = [];
  const layer = new VWorldBuildingLayer({C, scene, onStatus: s => states.push(s),
    load: async (column, row) => {loads.push([column, row]); return cellData(column, row);},
    groundHeights: async points => {grounds.push(points.length); return points.map(() => 40);}});
  const view = {lomin: 126.975, lomax: 126.985, lamin: 37.565, lamax: 37.575};
  layer.update(5000, view, 0);
  assert.equal(states.at(-1), 'off', 'nothing until the provider is chosen');
  layer.setEnabled(true);
  layer.update(FAR_METRES+1, view, 1);
  assert.equal(states.at(-1), 'distant'); assert.equal(loads.length, 0);
  layer.update(5000, view, 2);
  assert.equal(states.at(-1), 'loading');
  assert.equal(loads.length, 4, 'the four cells the view touches, all within the fetch budget');
  await flush(); await flush(); await flush();
  assert.equal(loads.length, 4, 'and none of them asked twice');
  assert.equal(grounds[0], 2, 'one ground sample per building');
  assert.equal(states.at(-1), 'ready');
  assert.equal(scene.primitives.items.length, 4);
  const instance = primitives[0].geometryInstances[0];
  assert.equal(instance.geometry.height, 39.5); assert.equal(instance.geometry.extrudedHeight, 60, 'tallest first, ground plus the building; bottom sealed half a metre');
  assert.equal(instance.attributes.color.css, '#81909f');
  assert.equal(primitives[0].allowPicking, false); assert.equal(primitives[0].appearance.options.closed, true);
  assert.ok(scene.primitives.items.every(p => p.show === true));
  layer.update(FAR_METRES+1, view, 3);
  assert.ok(scene.primitives.items.every(p => p.show === false), 'hidden beyond FAR, kept for the way back');
  assert.equal(states.at(-1), 'distant');
  layer.update((NEAR_METRES+FAR_METRES)/2, view, 4);
  assert.ok(scene.primitives.items.every(p => p.show === false), 'hysteresis: between NEAR and FAR it stays as it was');
  layer.update(8000, view, 5);
  assert.ok(scene.primitives.items.every(p => p.show === true));
  assert.equal(loads.length, 4, 'nothing is asked twice');
  assert.ok(NEAR_METRES < FAR_METRES);
});

test('the ground arriving later rebuilds the cells, and a cell with no ground yet waits', async () => {
  const {C, scene} = fakeCesium();
  let ground = null; const loads = [];
  const layer = new VWorldBuildingLayer({C, scene, load: async (c, r) => {loads.push(1); return cellData(c, r, 1);},
    groundHeights: async points => ground === null ? null : points.map(() => ground)});
  layer.setEnabled(true);
  const view = {lomin: 126.9751, lomax: 126.9752, lamin: 37.5651, lamax: 37.5652};
  layer.update(1000, view, 0); await flush(); await flush();
  assert.equal(scene.primitives.items.length, 0, 'no ground, no building');
  assert.equal([...layer.cells.values()][0].state, 'waiting', 'the cell waits for the next pass');
  assert.equal(loads.length, 1, 'and is not asked again until then');
  ground = 12;
  layer.update(1000, view, 1); await flush(); await flush();
  assert.equal(scene.primitives.items.length, 1);
  assert.equal(scene.primitives.items[0].geometryInstances[0].geometry.height, 11.5);
  layer.rebuild();
  assert.equal(scene.primitives.items.length, 1, 'keep the old cell until its replacement is ready');
  ground = 30;
  layer.update(1000, view, 2); await flush(); await flush();
  assert.equal(scene.primitives.items[0].geometryInstances[0].geometry.height, 29.5);
  assert.equal(loads.length, 1, 'waiting and terrain replacement reuse the footprint response');
});

test('cells the camera left are let go beyond the kept count, farthest first', async () => {
  const {C, scene} = fakeCesium();
  const layer = new VWorldBuildingLayer({C, scene, load: async (c, r) => cellData(c, r, 1), groundHeights: async points => points.map(() => 0)});
  layer.setEnabled(true);
  let now = 0;
  // Walk east across Seoul one cell at a time, each view one cell wide.
  for (let step = 0; step < CELLS_KEPT + 20; step++) {
    const west = 126.5 + step * CELL_DEGREES + .001;
    layer.update(1000, {lomin: west, lomax: west + .002, lamin: 37.5651, lamax: 37.5652}, ++now);
    await flush(); await flush();
  }
  assert.ok(layer.cells.size <= CELLS_KEPT, `held ${layer.cells.size}`);
  assert.equal(scene.primitives.items.length, layer.cells.size, 'dropped cells leave the scene');
  const columns = [...layer.cells.values()].map(cell => cell.column);
  assert.equal(Math.max(...columns), Math.floor((126.5 + (CELLS_KEPT + 19) * CELL_DEGREES + .001) / CELL_DEGREES), 'the newest stays');
  assert.ok(!columns.includes(Math.floor(126.501 / CELL_DEGREES)), 'the first, farthest, went');
  layer.destroy();
  assert.equal(scene.primitives.items.length, 0);
});

test('a missing relay reads as unavailable and a failure backs off a minute', async () => {
  const {C, scene} = fakeCesium();
  const states = []; let calls = 0;
  const failing = new VWorldBuildingLayer({C, scene, onStatus: s => states.push(s),
    load: async () => {calls++; throw Object.assign(new Error('secret'), {disabled: true});}});
  failing.setEnabled(true);
  const view = {lomin: 126.9751, lomax: 126.9752, lamin: 37.5651, lamax: 37.5652};
  failing.update(1000, view, 0); await flush(); await flush();
  assert.equal(states.at(-1), 'unavailable');
  failing.update(1000, view, 1); await flush();
  assert.equal(calls, 1, 'not asked again');
  const flaky = new VWorldBuildingLayer({C, scene, onStatus: s => states.push(s), load: async () => {calls++; throw new Error('secret');}});
  flaky.setEnabled(true);
  flaky.update(1000, view, 0); await flush(); await flush();
  assert.equal(states.at(-1), 'error');
  flaky.update(1000, view, 30000); await flush();
  assert.equal(calls, 2, 'still backing off');
  flaky.update(1000, view, 61000); await flush();
  assert.equal(calls, 3, 'tried again after a minute');
  const outside = new VWorldBuildingLayer({C, scene, onStatus: s => states.push(s), load: async () => cellData(1, 1)});
  outside.setEnabled(true);
  outside.update(1000, {lomin: 139.6, lomax: 139.7, lamin: 35.6, lamax: 35.7}, 0);
  assert.equal(states.at(-1), 'outside');
});

test('the cell request goes to the relay and a 404 says the provider is not configured', async (t) => {
  let request;
  t.mock.method(globalThis, 'fetch', async (url, options) => {request = {url, options}; return new Response('{"buildings":[]}', {status: 200});});
  assert.deepEqual(await fetchCell(12697, 3756), {buildings: []});
  assert.equal(request.url, '/api/visualization/vworld/buildings/12697/3756');
  t.mock.method(globalThis, 'fetch', async () => new Response('root-secret', {status: 404}));
  await assert.rejects(fetchCell(1, 1), error => error.disabled === true && !error.message.includes('root-secret'));
  t.mock.method(globalThis, 'fetch', async () => new Response('root-secret', {status: 503}));
  await assert.rejects(fetchCell(1, 1), error => error.disabled === false);
});

test('an oblique horizon rectangle streams around the camera, not its distant centre', () => {
  const focus = {longitude:126.978, latitude:37.5665};
  const huge = {lomin:125, lomax:130, lamin:37.54, lamax:39.1};
  const cells = cellsFor(huge, 16, focus);
  assert.ok(cells.length > 0 && cells.length <= 16);
  assert.ok(cells.every(c => Math.abs(c.column*.01-focus.longitude)<.05 && Math.abs(c.row*.01-focus.latitude)<.05));
  assert.equal(cells[0].column,12697, 'the operator is here, not 100 km north');
  assert.ok(cellsFor(null,16,focus).length > 0, 'a horizon-clipped rectangle still has nearby ground');
});

test('leaving a cell hides it while keeping its warm geometry for the return', async () => {
  const {C,scene}=fakeCesium();
  const layer=new VWorldBuildingLayer({C,scene,load:async(c,r)=>cellData(c,r,1)});
  layer.setEnabled(true);
  const a={lomin:126.9751,lomax:126.9752,lamin:37.5651,lamax:37.5652};
  layer.update(1000,a,1);await flush();await flush();
  const first=scene.primitives.items[0];
  layer.update(1000,{...a,lomin:127.1751,lomax:127.1752},2);await flush();await flush();
  assert.equal(first.show,false,'cached must not mean visible');
  layer.update(1000,a,3);await flush();assert.equal(first.show,true);
});

test('switching off during a request does not drain the old camera queue', async () => {
  const {C,scene}=fakeCesium();let calls=0;const pending=[];
  const layer=new VWorldBuildingLayer({C,scene,load:(c,r)=>{calls++;return new Promise(resolve=>pending.push(()=>resolve(cellData(c,r,1))));}});
  layer.setEnabled(true);layer.update(1000,{lomin:126.97,lomax:127,lamin:37.55,lamax:37.59},0);
  const started=calls;layer.setEnabled(false);pending.forEach(done=>done());await flush();await flush();
  assert.equal(calls,started,'do not fetch dozens of cells after the provider was switched off');
  assert.equal(layer.loading,0);
  assert.ok(scene.primitives.items.every(p=>!p.show));
});

test('boundary footprints and repeated page ids have only one owner',async()=>{
 const {C,scene}=fakeCesium();const data=cellData(12697,3756,1);
 const layer=new VWorldBuildingLayer({C,scene,load:async()=>({buildings:[...data.buildings,...data.buildings]})});
 layer.setEnabled(true);layer.update(1000,{lomin:126.971,lomax:126.989,lamin:37.561,lamax:37.562},0);
 await flush();await flush();assert.equal(layer.stats.buildings,1);assert.equal(scene.primitives.items.length,1);
});

test('GPU readiness exchanges terrain replacements atomically, no blank frame or simultaneous drawing',async()=>{
 const {C,scene}=fakeCesium();const layer=new VWorldBuildingLayer({C,scene,load:async(c,r)=>cellData(c,r,1)});
 const view={lomin:126.971,lomax:126.972,lamin:37.561,lamax:37.562};
 layer.setEnabled(true);layer.update(1000,view,0);await flush();await flush();
 const old=scene.primitives.items[0],Original=C.Primitive;
 C.Primitive=class extends Original{constructor(o){super(o);this.ready=false;}};
 layer.rebuild();layer.update(1000,view,1);await flush();await flush();
 assert.equal(scene.primitives.items.length,2);assert.equal(old.show,true);
 const pending=scene.primitives.items[1];assert.equal(pending.show,false);
 pending.ready=true;layer.update(1000,view,2);
 assert.deepEqual(scene.primitives.items,[pending]);assert.equal(pending.show,true);
});

test('dense cells reserve a global geometry budget and yield CPU work instead of one giant task',async()=>{
 const {C,scene}=fakeCesium();let yields=0;
 const layer=new VWorldBuildingLayer({C,scene,load:async(c,r)=>cellData(c,r,CELL_BUILDINGS+500),yieldWork:async()=>{yields++;}});
 layer.setEnabled(true);layer.update(1000,{lomin:126.97,lomax:127,lamin:37.55,lamax:37.58},0);
 for(let n=0;n<24;n++)await flush();
 assert.ok(yields>5);assert.ok(layer.stats.buildings<=MAX_BUILDINGS);assert.ok(layer.stats.vertices<=MAX_VERTICES);
 assert.ok([...layer.cells.values()].every(c=>c.count<=CELL_BUILDINGS));assert.ok(layer.stats.visibleCells<=48);
 layer.destroy();assert.equal(scene.primitives.items.length,0);
});

test('the first error stops queued requests instead of storming every cell',async()=>{
 const {C,scene}=fakeCesium();let calls=0;
 const layer=new VWorldBuildingLayer({C,scene,load:async()=>{calls++;throw Error('private');}});
 layer.setEnabled(true);layer.update(1000,{lomin:126.97,lomax:127,lamin:37.55,lamax:37.58},0);
 await flush();await flush();assert.equal(calls,CONCURRENT_FETCHES);assert.equal(layer.loading,0);assert.equal(layer.lastStatus,'error');
 layer.update(1000,{lomin:126.97,lomax:127,lamin:37.55,lamax:37.58},1);assert.equal(calls,CONCURRENT_FETCHES);
});

test('zoomed-out footprint fallback shares its budget across a wider patch instead of blank cells',async()=>{
 const {C,scene}=fakeCesium();let requests=0;
 const layer=new VWorldBuildingLayer({C,scene,load:async(c,r)=>{requests++;return cellData(c,r,2000);},yieldWork:async()=>{}});
 layer.setEnabled(true);
 const focus={longitude:127.02,latitude:37.61,cameraLongitude:126.98,cameraLatitude:37.56,offset:6000};
 layer.update(20000,{lomin:126,lomax:128,lamin:37,lamax:38},0,focus);
 for(let n=0;n<240&&layer.stats.visibleCells<48;n++){await flush();scene.render();layer.apply();layer.pump();}
 assert.equal(requests,48);assert.equal(layer.stats.visibleCells,48);
 assert.ok([...layer.cells.values()].every(c=>c.count>0&&c.count<400));
 assert.ok(layer.stats.buildings<=MAX_BUILDINGS);assert.ok(layer.stats.vertices<=MAX_VERTICES);
 const displayed=scene.primitives.items[0],appearance=(displayed.parts?.[0]??displayed).appearance;
 assert.equal(appearance.uniforms.u_buildingAltitudeFade,1);
 layer.update(21000,null,1000,focus);await flush();
 assert.equal(requests,48);assert.equal((displayed.parts?.[0]??displayed).appearance,appearance,'camera motion does not recompile shaders');
 layer.destroy();
});

test('slow GPU compilation bounds pending batches as well as network concurrency',async()=>{
 const {C,scene}=fakeCesium();let calls=0;
 const Original=C.Primitive;
 C.Primitive=class extends Original{constructor(o){super(o);this.ready=false;}};
 const layer=new VWorldBuildingLayer({C,scene,load:async(c,r)=>{calls++;return cellData(c,r,5);}});
 layer.setEnabled(true);const view={lomin:126.97,lomax:127,lamin:37.55,lamax:37.58};
 layer.update(1000,view,0);for(let i=0;i<10;i++)await flush();
 assert.equal(calls,CONCURRENT_LOADS+CONCURRENT_FETCHES*2,'downloads fill a bounded buffer ahead of the GPU');
 assert.equal(scene.primitives.items.length,CONCURRENT_LOADS,'network completions do not bypass the GPU budget');
 assert.ok(scene.primitives.items.every(p=>!p.show));
 const stalled=calls;
 layer.update(1000,view,100);for(let i=0;i<10;i++)await flush();
 assert.equal(calls,stalled,'nothing more is asked while the GPU is still busy');
 for(const p of scene.primitives.items)p.ready=true;
 layer.update(1000,view,300);layer.update(1000,view,500);for(let i=0;i<10;i++)await flush();
 assert.equal(scene.primitives.items.filter(p=>p.show).length,CONCURRENT_LOADS);
 assert.equal(layer.stats.buildings,5*CONCURRENT_LOADS,'old/displayed counts only change on the GPU-ready swap');
 assert.ok(CONCURRENT_LOADS<=CONCURRENT_FETCHES);
 layer.destroy();
});

test('close cells keep dense detail while every distant cell shares the same bounded city budget',()=>{
 const close=buildingCellQuotas(48,500),overview=buildingCellQuotas(48,20000);
 assert.ok(close[0]>=1500,'small buildings beside the operator survive, not only the tallest 288');
 assert.ok(close[0]>close.at(-1)*6);assert.ok(close.every(n=>n>=64&&n<=CELL_BUILDINGS));
 assert.ok(close.reduce((sum,n)=>sum+n,0)<=MAX_BUILDINGS*.85);
 assert.equal(new Set(overview).size,1,'overview distributes detail evenly');
 assert.deepEqual(buildingCellQuotas(1,500),[CELL_BUILDINGS]);
 assert.deepEqual(buildingCellQuotas(0,500),[]);
});

test('terrain sampling and CPU construction occupy the build budget before GPU primitives exist',async()=>{
 const {C,scene}=fakeCesium(),release=[];
 const layer=new VWorldBuildingLayer({C,scene,load:async(c,r)=>cellData(c,r,1),
  groundHeights:points=>new Promise(resolve=>release.push(()=>resolve(points.map(()=>10))))});
 layer.setEnabled(true);layer.update(500,{lomin:126.97,lomax:127,lamin:37.55,lamax:37.58},0);
 for(let n=0;n<8;n++)await flush();
 assert.equal(release.length,1);assert.equal(layer.stats.building,1);assert.equal(layer.stats.compiling,0);
 assert.equal(layer.stats.buffered,8,'the fetch lane keeps a bounded buffer without starting extra terrain work');
 release.shift()();await flush();await flush();
 assert.equal(scene.primitives.items.length,1);assert.equal(release.length,1,'the next terrain sample starts when the first completes');
 layer.destroy();for(const done of release)done();await flush();assert.equal(layer.stats.building,0);
});

test('one failed footprint cell does not pause healthy cells for a minute',async()=>{
 const {C,scene}=fakeCesium();let calls=0,failedKey=null;
 const layer=new VWorldBuildingLayer({C,scene,load:async(c,r)=>{
  calls++;if(!failedKey){failedKey=`${c},${r}`;throw Error('cell timeout');}return cellData(c,r,1);
 }});
 const view={lomin:126.97,lomax:127,lamin:37.55,lamax:37.58};
 layer.setEnabled(true);layer.update(500,view,0);
 for(let n=0;n<20;n++)await flush();
 assert.equal(calls,16);assert.equal(layer.stats.visibleCells,15);assert.equal(layer.retryAt,0);
 assert.equal(layer.cells.get(failedKey).retryAt,60000);assert.equal(layer.stats.networkFailures,1);
 layer.update(500,view,59000);await flush();assert.equal(calls,16);
 layer.update(500,view,60001);await flush();assert.equal(calls,17);
 layer.destroy();
});

test('a short view excursion caches its response without constructing an offscreen cell',async()=>{
 const {C,scene}=fakeCesium(),pending=[];let calls=0;
 const layer=new VWorldBuildingLayer({C,scene,load:(c,r,{signal})=>{
  calls++;return new Promise(resolve=>pending.push({signal,done:()=>resolve(cellData(c,r,1))}));
 }});
 const a={lomin:126.971,lomax:126.972,lamin:37.561,lamax:37.562},b={...a,lomin:127.171,lomax:127.172};
 layer.setEnabled(true);layer.update(500,a,0);layer.update(500,b,300);
 assert.equal(pending[0].signal.aborted,false);
 pending[0].done();await flush();assert.equal(scene.primitives.items.length,0);
 layer.update(500,a,600);await flush();await flush();
 assert.equal(calls,2,'return builds from the response cached during the excursion');assert.equal(scene.primitives.items.length,1);
 layer.update(500,a,600+REQUEST_RETENTION_MS);assert.equal(pending[1].signal.aborted,true,'old network work has a finite grace');
 layer.destroy();pending[1].done();await flush();
});

test('quota enrichment reuses exact terrain samples and colour changes reuse resident appearances',async()=>{
 const {C,scene}=fakeCesium();let sampled=0,requests=0;
 const layer=new VWorldBuildingLayer({C,scene,load:async(c,r)=>{requests++;return cellData(c,r,12);},
  groundHeights:async points=>{sampled+=points.length;return points.map(()=>15);}});
 const view={lomin:126.971,lomax:126.972,lamin:37.561,lamax:37.562};
 layer.setEnabled(true);layer.update(500,view,0);await flush();await flush();
 const cell=[...layer.cells.values()][0];assert.equal(sampled,12);
 cell.state='waiting';layer.update(500,view,1000);await flush();await flush();
 assert.equal(sampled,12);assert.equal(requests,1);
 const appearance=cell.primitive.appearance;
 layer.setAppearance({opacity:.6,brightness:1.1});assert.equal(cell.primitive.appearance,appearance);
 assert.equal(appearance.uniforms.u_buildingOpacity,.6);
 layer.rebuild();layer.update(500,view,2000);await flush();await flush();
 assert.equal(sampled,24,'terrain replacement invalidates the sample cache');layer.destroy();
});

test('stationary ready footprint cells do not request redundant idle frames',async()=>{
 const {C,scene}=fakeCesium();let renders=0;scene.requestRender=()=>renders++;
 const layer=new VWorldBuildingLayer({C,scene,load:async(c,r)=>cellData(c,r,1)});
 const view={lomin:126.971,lomax:126.972,lamin:37.561,lamax:37.562};
 layer.setEnabled(true);layer.update(500,view,0);await flush();await flush();const before=renders;
 for(let now=200;now<=2000;now+=200)layer.update(500,view,now);
 assert.equal(renders,before);layer.destroy();
});

test('streaming budgets clamp inputs and independently limit fetches and builds',async()=>{
 const {C,scene}=fakeCesium(),pending=[];
 const layer=new VWorldBuildingLayer({C,scene,load:(c,r)=>new Promise(resolve=>pending.push(()=>resolve(cellData(c,r,1))))});
 layer.setStreamingBudget({fetches:1,builds:2,retainedCells:40});layer.setEnabled(true);
 layer.update(500,{lomin:126.97,lomax:127,lamin:37.55,lamax:37.58},0);assert.equal(pending.length,1);
 layer.setStreamingBudget({fetches:3});assert.equal(pending.length,3);assert.equal(layer.stats.budget.builds,2);
 layer.setStreamingBudget({fetches:100,builds:0,retainedCells:1});assert.deepEqual(layer.stats.budget,{fetches:8,builds:1,retainedCells:32});
 layer.destroy();for(const done of pending)done();await flush();
});

test('dense overview to close-up finishes quota changes without stranding an underfilled near cell',async()=>{
 const {C,scene}=fakeCesium();
 const layer=new VWorldBuildingLayer({C,scene,load:async(c,r)=>cellData(c,r,2000),yieldWork:async()=>{}});
 const focus={longitude:126.978,latitude:37.565,offset:0};layer.setEnabled(true);
 layer.update(20000,null,0,focus);for(let n=0;n<240;n++){await flush();scene.render();layer.apply();layer.pump();}
 for(let tick=1;tick<=6;tick++){
  layer.update(500,null,tick*200,focus);for(let n=0;n<240;n++){await flush();scene.render();layer.apply();layer.pump();}
  assert.ok(layer.stats.buildings<=MAX_BUILDINGS);assert.ok(layer.stats.vertices<=MAX_VERTICES);
 }
 const near=[...layer.cells.values()].sort((a,b)=>a.order-b.order).slice(0,8);
 assert.ok(near.every(c=>c.count===Math.min(c.limit,c.data.length)),near.map(c=>`${c.count}/${c.limit}`).join(', '));
 layer.destroy();
});

test('the city writes depth at any opacity, so what is behind a building is behind it', () => {
  // Found live: with the operator's 25% city, route lines, FATO columns and
  // their labels were drawn straight through the towers in front of them.
  // They all depth-test (disableDepthTestDistance 0); there was simply nothing
  // in the depth buffer to test against, because alpha-blended surfaces do not
  // write one. Coverage by ordered dither keeps the glass look and restores the
  // near/far cue.
  const {C, scene} = fakeCesium();
  const layer = new VWorldBuildingLayer({C, scene});
  for (const opacity of [1, .9, .5, .25, .1]) {
    layer.setAppearance({opacity});
    const appearance = layer.appearance();
    assert.equal(appearance.options.translucent, false, `opacity ${opacity} must draw in the opaque pass`);
    assert.match(appearance.options.fragmentShaderSource, /if \(coverage < buildingThreshold\(\)\) discard;/);
    assert.match(appearance.options.fragmentShaderSource, /material\.alpha = 1\.0;/);
    assert.doesNotMatch(appearance.options.fragmentShaderSource, /material\.alpha = coverage;/);
  }
  // The opacity still says how much of the city is covered; it is the uniform
  // the dither is compared against, so the slider goes on meaning what it meant.
  layer.setAppearance({opacity: .25});
  assert.equal(layer.uniforms.u_buildingOpacity, .25);
  assert.match(layer.appearance().options.fragmentShaderSource, /coverage = u_buildingOpacity \*/);
});

test('changing the look never rebuilds the geometry, because every primitive draws in the same pass', () => {
  const {C, scene} = fakeCesium();
  const layer = new VWorldBuildingLayer({C, scene});
  const before = layer.generation;
  for (const values of [{opacity: .25}, {opacity: 1}, {brightness: 1.2}, {opacity: .5}])
    layer.setAppearance(values);
  assert.equal(layer.generation, before, 'opacity and tint are uniforms, not geometry');
});

test('a vertiport that moves takes its building with it, at once - and only the cells under it', () => {
  // Found live: dragging a deck across the street left the building it had
  // moved off still hidden, and the one it moved onto still standing through
  // the new deck. A moved deck keeps its shape - the same rings with the same
  // number of points - and the layer was comparing only those counts. Then
  // re-extruding the whole city for one deck took seconds and made every
  // building blink; only the cells under the old and new ground are rebuilt.
  const {C, scene} = fakeCesium();
  const layer = new VWorldBuildingLayer({C, scene});
  const ring = (west, south) => [
    {longitude: west, latitude: south}, {longitude: west + .001, latitude: south},
    {longitude: west + .001, latitude: south + .001}, {longitude: west, latitude: south + .001}];
  const overlaps = () => false;
  // A city of ready cells: the one the deck stands on, the one it moves to,
  // and one across town.
  const cellAt = (column, row) => ({key: `${column},${row}`, column, row, state: 'ready', count: 3, vertices: 30, primitive: {show: true}, data: []});
  const here = cellAt(12700, 3755), there = cellAt(12701, 3755), far = cellAt(12710, 3760);
  for (const cell of [here, there, far]) layer.cells.set(cell.key, cell);
  const generation = layer.generation;
  layer.setCleared([ring(127.0002, 37.5502)], overlaps);
  assert.equal(layer.generation, generation + 1, 'the first word about cleared ground rebuilds everything');
  for (const cell of [here, there, far]) cell.state = 'ready';
  // The same ground again asks for nothing.
  layer.setCleared([ring(127.0002, 37.5502)], overlaps);
  assert.deepEqual([here.state, there.state, far.state], ['ready', 'ready', 'ready'], 'standing still is not a change');
  // Moved one cell east: same count, same points, different place. The cell
  // it left and the cell it reached are built again; the far one is not.
  layer.setCleared([ring(127.0102, 37.5502)], overlaps);
  assert.deepEqual([here.state, there.state, far.state], ['waiting', 'waiting', 'ready']);
  assert.equal(layer.generation, generation + 1, 'no whole-city rebuild for one deck');
  for (const cell of [here, there, far]) cell.state = 'ready';
  // Gone altogether: only the ground it stood on comes back.
  layer.setCleared([], overlaps);
  assert.deepEqual([here.state, there.state, far.state], ['ready', 'waiting', 'ready']);
  layer.setCleared([], overlaps);
  assert.equal(there.state, 'waiting', 'nothing more to do');
});
