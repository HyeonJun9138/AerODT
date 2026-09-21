import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveGlobe} from '../../../../digital_twin/visualization/web/globe.js';

function harness(specs=[{}]) {
  const items=specs.map((s,i)=>({entity:{entity_id:`u${i}`,kind:'uam'},position:{x:100,y:100,z:0},
    lod:'billboard',billboard:{show:true},...s}));
  const calls=[],scene={canvas:{clientWidth:800,clientHeight:600},
    camera:{getPixelSize:()=>1},pick(p,w=3,h=w){calls.push({p:{...p},w,h});
      const item=items.find(i=>i.lod!=='hidden'&&!i.occluded&&i.billboard?.show&&Math.hypot(i.position.x-p.x,i.position.y-p.y)<=w/2);
      return item?{id:item.entity.entity_id,primitive:item.billboard}:undefined;}};
  const g=Object.create(LiveGlobe.prototype);
  g.C={SceneTransforms:{worldToWindowCoordinates:(_s,p)=>({...p})},Cartesian3:{fromDegrees:(x,y,z)=>({x,y,z})}};
  g.viewer={scene};g.items=new Map(items.map(i=>[i.entity.entity_id,i]));
  g.entityScene={items:g.items,frameItems:items,layers:{uam:{visible:true},aircraft:{visible:true},satellite:{visible:true}}};
  return {g,scene,items,calls};
}

test('UAM glyph centre has a 25 CSS pixel circular target without growing its glyph',()=>{
  const {g,items}=harness();
  assert.equal(g.pickEntity({x:125,y:100}),'u0');
  assert.equal(g.pickEntity({x:125.1,y:100}),null);
  assert.equal(g.pickEntity({x:120,y:120}),null);
  assert.equal(items[0].billboard.width,undefined);
});
test('nearby UAMs resolve by closest screen centre, not collection order',()=>{
  const {g}=harness([{position:{x:100,y:100}},{position:{x:135,y:100}}]);
  assert.equal(g.pickEntity({x:121,y:100}),'u1');
});
test('hidden, disabled, offscreen and occluded UAMs do not gain invisible hit areas',()=>{
  for(const spec of [{lod:'hidden'},{billboard:{show:false}},{position:{x:-5,y:100}},{occluded:true}]){
    const {g}=harness([spec]);assert.equal(g.pickEntity({x:spec.position?10:120,y:100}),null);
  }
  const {g}=harness();g.entityScene.layers.uam.visible=false;
  assert.equal(g.pickEntity({x:120,y:100}),null);
});
test('aircraft and satellite keep the existing narrow selection size',()=>{
  for(const kind of ['aircraft','satellite']){
    const {g}=harness([{entity:{entity_id:kind,kind}}]);
    assert.equal(g.pickEntity({x:120,y:100}),null);
    assert.equal(g.pickEntity({x:100,y:100}),kind);
  }
});
test('direct hits on other objects retain priority over nearby UAMs',()=>{
  const {g}=harness([{},{entity:{entity_id:'air',kind:'aircraft'},position:{x:120,y:100}}]);
  assert.equal(g.pickEntity({x:120,y:100}),'air');
  assert.equal(g.pickEntity({x:120,y:100},{id:{aerodtRoute:{kind:'node',id:'r'}}}),null);
});
test('a vertiport deck background does not consume the expanded UAM target',()=>{
  const {g}=harness();
  assert.equal(g.pickEntity({x:120,y:100},{id:{id:'vertiport:vp:deck'}}),'u0');
  assert.equal(g.pickEntity({x:120,y:100},{id:{id:'vertiport:vp:marker'}}),null);
});
test('large models get edge slack but their empty bounding sphere is not clickable',()=>{
  const {g,scene,items,calls}=harness([{billboard:{show:false},lod:'model',model:{show:true,ready:true,boundingSphere:{center:{x:100,y:100},radius:100}}}]);
  scene.pick=(p,w)=>{calls.push({p,w});return (p.x===100&&p.y===100||w===51&&p.y===100)?{id:'u0',primitive:items[0].model}:undefined;};
  assert.equal(g.pickEntity({x:215,y:100}),'u0');
  assert.equal(g.pickEntity({x:100,y:215}),null);
  assert.equal(items[0].model.scale,undefined);
});
test('ordinary empty-map hover adds no GPU reads when no UAM is near it',()=>{
  const {g,calls}=harness();assert.equal(g.pickEntity({x:500,y:400}),null);assert.equal(calls.length,1);
});
test('empty-map click does not repeat the already-resolved GPU pick',()=>{
  const {g,calls}=harness();g.select=()=>{};g.handleClick({x:500,y:400});assert.equal(calls.length,1);
});
test('enlargement is disabled for all editing/placement modes',()=>{
  for(const mode of ['scrap','groundPick','routeEditor','demandEditor','vertiportEditor']){
    const {g}=harness();g[mode]={};assert.equal(g.pickEntity({x:120,y:100}),null,mode);
  }
});
test('click and externally supplied hover picks use the same enlarged target',()=>{
  const {g}=harness();let selected;
  g.select=id=>selected=id;
  assert.equal(g.pickEntity({x:120,y:100},null),'u0');
  g.handleClick({x:120,y:100});assert.equal(selected,'u0');
});
test('a visible single-flight UAM also gets the wider click target',()=>{
  const {g,scene}=harness([]);const marker={aerodtFlight:{kind:'vehicle'}},model={show:true},flight={plan:{id:'p'},sample:{position:{longitude:100,latitude:100,altitude_m:0}}};
  g.flightLayer={...flight,model,visible:true,vehicle:{marker:{show:true}},pick:p=>p?.id===marker?flight:null};
  scene.pick=(p,w)=>Math.hypot(p.x-100,p.y-100)<=w/2?{id:marker,primitive:model}:undefined;
  let result;g.onFlightPick=v=>result=v;g.select=()=>assert.fail('single-flight must not select a fleet entity');
  g.handleClick({x:124,y:100});assert.equal(result,flight);
  g.flightLayer.display={aircraft:false};assert.equal(g.pickInteraction({x:124,y:100}),undefined);
});
test('large-model pick widths follow drawing-buffer scale, bounds use its dimensions',()=>{
  for(const ratio of [.5,1,2]){
    const {g,scene,items}=harness([{billboard:{show:false},lod:'model',model:{show:true,ready:true,boundingSphere:{center:{x:100,y:100},radius:100}}}]);
    scene.drawingBufferWidth=800*ratio;scene.drawingBufferHeight=600*ratio;
    const dimensions=[];scene.camera.getPixelSize=(_s,w,h)=>{dimensions.push([w,h]);return 1;};
    scene.pick=(p,w)=>p.x===100||w===Math.ceil(51*ratio)?{id:'u0',primitive:items[0].model}:undefined;
    assert.equal(g.pickEntity({x:215,y:100}),'u0',`ratio ${ratio}`);
    assert.deepEqual(dimensions[0],[800*ratio,600*ratio]);
  }
});
test('model edge can pass a deck backdrop, never an opaque building or hidden centre',()=>{
  const {g,scene,items}=harness([{billboard:{show:false},lod:'model',model:{show:true,ready:true,boundingSphere:{center:{x:100,y:100},radius:100}}}]);
  const modelHit={id:'u0',primitive:items[0].model},deck={id:{id:'vertiport:vp:deck'}},building={id:'building'};
  let centre=modelHit,middle=deck;
  scene.pick=p=>p.x===100?centre:deck;
  scene.drillPick=(_p,limit,w,h)=>{assert.equal(limit,4);assert.equal(w,51);assert.equal(h,51);return [deck,middle,modelHit];};
  assert.equal(g.pickEntity({x:215,y:100}),'u0');
  middle=building;assert.equal(g.pickEntity({x:215,y:100}),null);
  centre=deck;middle=deck;assert.equal(g.pickEntity({x:215,y:100}),null);
});
test('a floating label with the same ID is not proof that a UAM is visible',()=>{
  const {g,scene}=harness();scene.pick=(p,w)=>w===3?{id:'u0',primitive:{isLabel:true}}:undefined;
  assert.equal(g.pickEntity({x:120,y:100}),null);
});
