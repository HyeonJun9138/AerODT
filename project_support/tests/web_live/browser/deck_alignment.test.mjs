import test from 'node:test';
import assert from 'node:assert/strict';
import {deckSurfaceOffset,VertiportLayer} from '../../../../digital_twin/visualization/web/vertiport_layer.js';
import {DisplaySamples} from '../../../../digital_twin/visualization/web/display_samples.js';
import {EntityScene} from '../../../../digital_twin/visualization/web/entity_scene.js';

const rad=Math.PI/180;
const layout={frame:{latitude:37.55833,longitude:126.970144},
  platform:{height_m:35,corners_m:[[-40,-30],[40,-30],[40,30],[-40,30]]}};
const at=(height,east=0)=>({longitude:(layout.frame.longitude+east/(111320*Math.cos(layout.frame.latitude*rad)))*rad,
  latitude:layout.frame.latitude*rad,height});
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);

test('the measured Gwanghwamun DEM/World Terrain mismatch lands exactly on the painted deck',()=>{
  const physical=93.96865063033704,rendered=95.09194543178367;
  near(physical+deckSurfaceOffset(layout,rendered,physical,at(physical)),rendered+.03);
});

test('registration works on higher, lower, zero and manual-height decks, without changing dimensions',()=>{
  for(const top of [0,30,95.09,300,-5]){
    near(94+deckSurfaceOffset(layout,top,94,at(94)),top+.03);
    near(99+deckSurfaceOffset(layout,top,94,at(99)),top+5+.03);
  }
  const manual={...layout,ground_reference:'manual',frame:{...layout.frame,altitude_m:60}};
  near(95+deckSurfaceOffset(manual,95,95,at(95)),95.03);
  assert.equal(layout.platform.height_m,35);
});

test('vertical and horizontal departure blend continuously back to reported altitude',()=>{
  let previous=Infinity;
  for(let height=104;height<=244;height+=.1){
    const offset=deckSurfaceOffset(layout,100,94,at(height));
    assert.ok(offset>=0&&offset<=previous+1e-9);previous=offset;
  }
  near(deckSurfaceOffset(layout,100,94,at(244)),0);
  near(deckSurfaceOffset(layout,100,94,at(94,50)),6.03);
  assert.ok(deckSurfaceOffset(layout,100,94,at(94,175))>0);
  near(deckSurfaceOffset(layout,100,94,at(94,301)),0);
  near(deckSurfaceOffset(layout,100,94,at(500)),0,'cruise is not clamped to a nearby deck');
});

test('unknown or not-yet-placed decks never fabricate a ground altitude',()=>{
  for(const top of [null,undefined,NaN])assert.equal(deckSurfaceOffset(layout,top,94,at(94)),0);
  assert.equal(deckSurfaceOffset(null,100,94,at(94)),0);
  assert.equal(deckSurfaceOffset(layout,100,undefined,at(94)),0);
  assert.equal(deckSurfaceOffset(layout,100,94,{...at(94),height:NaN}),0);
});

test('a large regional height mismatch cannot reverse the displayed vertical climb',()=>{
  for(const top of [200,500,1000]){
    let previous=-Infinity;
    for(let physical=94;physical<2200;physical+=1){
      const shown=physical+deckSurfaceOffset(layout,top,94,at(physical));
      assert.ok(shown>=previous);assert.ok(shown>=top);previous=shown;
    }
  }
});

test('deck height is a constant-time scalar read and re-placement is visible immediately',()=>{
  const layer=Object.create(VertiportLayer.prototype);
  layer.records=new Map([['VP012',{layout}]]);layer.grounds=new Map([['VP012',{top:60.091945431783664}]]);
  layer.geometryState=()=>{throw Error('per-frame geometry rebuild');};
  const ref={vertiport_id:'VP012',altitude_m:94};
  near(layer.deckTop('VP012'),95.09194543178367);
  assert.equal(layer.deckTop('unknown'),null);assert.equal(layer.surfaceOffset(null,at(94)),0);
  layer.grounds.set('VP012',{top:0});near(layer.surfaceOffset(ref,at(94)),35.03-94);
  layer.grounds.delete('VP012');assert.equal(layer.surfaceOffset(ref,at(94)),0);
});

const reference=(vertiport_id,altitude_m)=>Object.freeze({vertiport_id,altitude_m});
const source=Object.freeze({entity_id:'scenario:A',kind:'uam',source:'scenario',flight_phase:'parked',
  position_ecef_m:Object.freeze([126.97,37.55,94]),altitude_m:94,visual_asset_id:'kp2a'});
const snap=(sequence,ref,epoch=0)=>({sequence,state_time:sequence,epoch,clock_rate:10,
  entities:[{...source,surface_reference:ref}]});

test('deck references share the position ring clock, including backwards epoch reset',()=>{
  const samples=new DisplaySamples(),a=reference('A',94),b=reference('B',200);
  samples.replace(snap(1,a),1000);samples.replace(snap(2,b),1100);
  const result=samples.surfaceAt(source.entity_id,1.25);
  assert.equal(result.from,a);assert.equal(result.to,b);assert.equal(result.fraction,.25);
  samples.replace(snap(1,a,1),1200);
  assert.equal(samples.surfaceAt(source.entity_id,1).from,a);
  for(let i=2;i<100;i++)samples.replace(snap(i,b,1),1200+i*100);
  assert.equal(samples.entries.get(source.entity_id).surfaces.length,32,'bounded, not a second state history');
  assert.equal(samples.surfaceAt(source.entity_id,99).from,b);
  samples.forget(source.entity_id);assert.equal(samples.surfaceAt(source.entity_id,99).from,null);
});

class Collection {values=[];add(p){this.values.push(p);return p;}remove(p){this.values=this.values.filter(v=>v!==p);}}
const color={withAlpha(){return this;}};
// Transparent geodetic test frame: x/y are lon/lat, z is altitude. The actual
// WGS84 implementation is also exercised in the Cesium QA page.
const C={PointPrimitiveCollection:Collection,LabelCollection:Collection,PrimitiveCollection:Collection,
  Color:{BLACK:color,WHITE:color,fromCssColorString:()=>color},
  Cartesian3:{fromArray:(a,_o,result={})=>Object.assign(result,{x:a[0],y:a[1],z:a[2]})},
  Ellipsoid:{WGS84:{cartesianToCartographic:(p,result={})=>Object.assign(result,{longitude:p.x,latitude:p.y,height:p.z}),
    cartographicToCartesian:(p,result={})=>Object.assign(result,{x:p.longitude,y:p.latitude,z:p.height})}}};

test('all five scenario models use the deck datum once; reported ECEF/altitude stay immutable',()=>{
  let top=100;
  const scene=new EntityScene(C,{scene:{primitives:new Collection()}},()=>{},
    {surfaceOffset:r=>r?top+.03-r.altitude_m:0});
  const ids=['projectairsim_airtaxi','joby_s4','kp2a','amvlab_evtol','x_57'];
  const entities=ids.map(id=>Object.freeze({...source,entity_id:id,visual_asset_id:id,surface_reference:reference('VP012',94)}));
  scene.replace({sequence:1,state_time:1,entities});
  for(const entity of entities){
    const item=scene.items.get(entity.entity_id);
    for(let i=0;i<120;i++)scene.refreshPosition(item,1000+i*16);
    assert.equal(item.position.x,126.97);assert.equal(item.position.y,37.55);near(item.position.z,100.03);
    assert.equal(item.entity.altitude_m,94);assert.deepEqual(item.entity.position_ecef_m,[126.97,37.55,94]);
  }
  top=0;scene.refreshPosition(scene.items.get(ids[0]),4000);near(scene.items.get(ids[0]).position.z,.03);
});

test('a newer landing packet cannot move an older buffered sample onto another deck',()=>{
  const scene=new EntityScene(C,{scene:{primitives:new Collection()}},()=>{},
    {surfaceOffset:r=>r?.vertiport_id==='A'?10:r?.vertiport_id==='B'?20:0});
  const a=reference('A',94),b=reference('B',200);
  scene.samples.replace(snap(1,a),1000);scene.samples.replace(snap(2,b),1100);
  const item={entity:{...source,flight_phase:'landing'},position:{x:1,y:2,z:94}};
  scene.samples.entries.get(source.entity_id).renderT=1.25;
  scene.alignDeck(item);near(item.position.z,106.5);
  scene.samples.entries.get(source.entity_id).renderT=2;
  item.position.z=94;scene.alignDeck(item);near(item.position.z,114);
});

test('physical UAM uses the same buffered deck datum without modifying sensor altitude',()=>{
  const scene=new EntityScene(C,{scene:{primitives:new Collection()}},()=>{},
    {surfaceOffset:r=>r?100.03-r.altitude_m:0});
  const entity=Object.freeze({...source,entity_id:'physical:A',source:'physical_uam',surface_reference:reference('A',94)});
  scene.replace({sequence:1,state_time:1,entities:[entity]});
  const item=scene.items.get(entity.entity_id);
  for(let i=0;i<120;i++)scene.refreshPosition(item,1000+i*16);
  near(item.position.z,100.03);
  assert.equal(entity.altitude_m,94);assert.deepEqual(entity.position_ecef_m,[126.97,37.55,94]);
});

test('old snapshots and non-scenario entities retain their reported positions',()=>{
  const scene=new EntityScene(C,{scene:{primitives:new Collection()}},()=>{}, {surfaceOffset:()=>{throw Error('not a scenario datum');}});
  const entities=[source,{...source,entity_id:'s',kind:'satellite',surface_reference:reference('A',94)},
    {...source,entity_id:'u',source:'live',surface_reference:reference('A',94)}];
  scene.replace({sequence:1,state_time:1,entities});
  for(const entity of entities){const item=scene.items.get(entity.entity_id);scene.refreshPosition(item,2000);near(item.position.z,94);}
});
