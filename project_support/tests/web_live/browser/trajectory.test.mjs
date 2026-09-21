import test from 'node:test';
import assert from 'node:assert/strict';
import {TrajectoryLayer} from '../../../../digital_twin/visualization/web/trajectory_layer.js';
import {describeTrajectory} from '../../../../user_application/web/entity_details.js';

class Collection {
  values=[];
  add(item){this.values.push(item);return item;}
  remove(item){const before=this.values.length;this.values=this.values.filter(value=>value!==item);return before!==this.values.length;}
  removeAll(){this.values=[];}
}
const material={};
const C={PolylineCollection:Collection,
  Cartesian3:{fromArray:value=>({x:value[0],y:value[1],z:value[2]})},
  Color:{fromCssColorString:value=>({value,alpha:1,withAlpha(alpha){return {...this,alpha};}}),
    BLACK:{alpha:1,withAlpha(alpha){return {...this,alpha};}}},
  Material:{fromType:(type,options)=>({type,options,...material})}};
const entity=(id='s',kind='satellite')=>({entity_id:id,kind,name:'TEST'});
const path=(points=3,kind='satellite')=>({schema_version:1,kind,reference_frame:'ecef_m',
  derivation:kind==='satellite'?'gp_propagated':'constant_velocity',span_seconds:60,
  points:Array.from({length:points},(_,i)=>[100+i,7000000+i,i,i]),summary:{period_minutes:92.9}});

function harness(load){
  const scene={primitives:new Collection()};
  const summaries=[];const clock={value:0};
  const layer=new TrajectoryLayer(C,{scene},{load,onSummary:value=>summaries.push(value),now:()=>clock.value});
  return {layer,scene,summaries,clock,lines:()=>layer.polylines.values};
}

test('layer teardown is idempotent and safe after its shared viewer is destroyed',()=>{
 const {layer}=harness(async()=>path());
 layer.comparison.records.set('pending',{});
 layer.comparison.labels={};layer.comparison.flow={};
 layer.viewer.isDestroyed=()=>true;
 Object.defineProperty(layer.viewer,'scene',{get(){throw Error('destroyed viewer scene getter');}});
 layer.polylines.removeAll=()=>{throw Error('viewer already released GPU objects');};
 assert.doesNotThrow(()=>layer.destroy());
 assert.equal(layer.disposed,true);assert.equal(layer.comparison.records.size,0);
 assert.equal(layer.comparison.labels,null);assert.equal(layer.comparison.flow,null);
 const token=layer.token;assert.doesNotThrow(()=>layer.destroy());assert.equal(layer.token,token);
});

// One path is two lines: the solid one, which is behind whatever is in front
// of it, and a faint copy that shows through. See the drawing test below.
const PER_PATH=2;

for(const fails of ['missing','network'])test(`unavailable UAM forecasts back off in wall time and recover (${fails})`,async()=>{
  let calls=0,ready=false;
  const {layer,clock}=harness(async()=>{calls++;if(ready)return prediction();
    if(fails==='network')throw new Error('offline');return null;});
  layer.supports=()=>true;layer.anchor=()=>({clockRate:10});
  await layer.show(entity('u','uam'));
  for(clock.value=200;clock.value<1000;clock.value+=200)await layer.update(clock.value);
  assert.equal(calls,1,'a 404/offline response must not retry at 5 Hz or 10x playback speed');
  await layer.update(clock.value);assert.equal(calls,2);
  clock.value=2000;await layer.update(clock.value);assert.equal(calls,2);
  ready=true;clock.value=3000;await layer.update(clock.value);assert.equal(calls,3);
  clock.value=3200;await layer.update(clock.value);assert.equal(calls,4,'success restores normal cadence');
  layer.clear();clock.value=90000;await layer.update(clock.value);assert.equal(calls,4);
});

test('selection and flight-context changes release an unavailable forecast backoff',async()=>{
  let calls=0;const at={epoch:1,phase:'cruise',continuity_id:1};
  const {layer,clock}=harness(async()=>{calls++;return null;});layer.supports=()=>true;layer.anchor=()=>at;
  await layer.show(entity('a','uam'));await layer.show(entity('b','uam'));assert.equal(calls,2);
  at.continuity_id=2;clock.value=200;await layer.update(clock.value);assert.equal(calls,3);
});

test('unavailable forecasts keep bounded retries instead of stopping forever',async()=>{
  let calls=0;const {layer,clock}=harness(async()=>{calls++;return null;});layer.supports=()=>true;
  await layer.show(entity('u','uam'));
  for(const wait of [1000,2000,4000,8000,15000,15000]){
    const before=calls;clock.value+=wait-1;await layer.update(clock.value);assert.equal(calls,before);
    clock.value++;await layer.update(clock.value);assert.equal(calls,before+1);
  }
});

test('a late missing response cannot delay the newly selected aircraft',async()=>{
  let resolve,calls=0;
  const {layer,clock}=harness(id=>{calls++;return id==='old'?new Promise(r=>resolve=r):Promise.resolve(prediction());});
  layer.supports=()=>true;
  const pending=layer.show(entity('old','uam'));await layer.show(entity('new','uam'));
  resolve(null);await pending;clock.value=200;await layer.update(clock.value);
  assert.equal(layer.entityId,'new');assert.equal(calls,3);assert.equal(layer.failures,0);
});

test('selecting an object draws exactly one path and reports its summary',async()=>{
  const {layer,lines,summaries}=harness(async()=>path());
  await layer.show(entity());
  assert.equal(lines().length,PER_PATH);
  assert.equal(lines()[0].positions.length,3);
  assert.equal(summaries.at(-1).summary.period_minutes,92.9);
  await layer.show(entity());
  assert.equal(lines().length,PER_PATH,'re-selecting the same object does not stack paths');
});

test('a path behind a building shows through it rather than disappearing into it',async()=>{
  // Drawn only with depth testing, a line among tall buildings vanishes into
  // them; drawn only without, it claims to be in front of things it is behind.
  // So the hidden stretch is left showing faintly.
  const {layer,lines}=harness(async()=>path());
  await layer.show(entity());
  const [ghost,solid]=lines();
  assert.equal(ghost.disableDepthTestDistance,Number.POSITIVE_INFINITY,'the copy ignores what is in front');
  assert.equal(solid.disableDepthTestDistance,undefined,'the line itself does not');
  assert.deepEqual(ghost.positions,solid.positions,'the same path, twice');
  assert.ok(ghost.material.options.color.alpha<solid.material.options.color.alpha,
    'and faint enough not to be mistaken for the line');
  layer.clear();
  assert.equal(lines().length,0,'both go together');
});

// A prediction the twin served for something being flown now: it carries a
// window in its summary, which is the stretch the display draws of it.
const prediction=(points=6,seconds=15)=>({schema_version:1,kind:'aircraft',reference_frame:'ecef_m',
  derivation:'constant_velocity',span_seconds:seconds,summary:{seconds},
  points:Array.from({length:points},(_,i)=>[100+i,7000000+i*10,0,0])});

test("a UAM's predicted path keeps up with it, as an aircraft's does",async()=>{
  // The twin serves every prediction as kind 'aircraft'. Deciding whether to
  // slide the window from the *entity's* kind left a UAM's path standing where
  // it was first drawn while the vehicle flew on, until it was selected again.
  const at={time:100,position:[7000000,0,0]};
  const scene={primitives:new Collection()};
  const layer=new TrajectoryLayer(C,{scene},{load:async()=>prediction(),anchor:()=>at,
    supports:item=>item?.kind==='uam',now:()=>0});
  await layer.show({entity_id:'scenario:UAM0003',kind:'uam',name:'UAM0003'});
  assert.deepEqual(layer.polylines.values.at(-1).positions[0],{x:7000000,y:0,z:0},
    'the line starts on the vehicle, not a hair off it');
  // It flies on. Nothing is fetched; the drawn window slides along the served
  // points with it.
  at.time=103;at.position=[7000030,0,0];
  assert.equal(layer.follow(),true);
  assert.deepEqual(layer.polylines.values.at(-1).positions[0],{x:7000030,y:0,z:0},
    'and stays on it');
  // And it is asked for again on the prediction's schedule, not an orbit's.
  assert.equal(layer.refreshMs,200);
  layer.destroy();
});

test('clearing the selection removes the path and reports no summary',async()=>{
  const {layer,lines,summaries}=harness(async()=>path());
  await layer.show(entity());
  layer.clear();
  assert.equal(lines().length,0);
  assert.equal(summaries.at(-1),null);
});

test('a late response for a previous selection never draws over the current one',async()=>{
  const pending=new Map();
  const {layer,lines}=harness(id=>new Promise(resolve=>pending.set(id,resolve)));
  const first=layer.show(entity('a'));
  const second=layer.show(entity('b'));
  pending.get('b')(path(4));await second;
  pending.get('a')(path(9));await first;
  assert.equal(lines().length,PER_PATH);
  assert.equal(lines()[0].positions.length,4,'the current selection keeps its own path');
});

test('a malformed or empty path is ignored instead of drawing a broken line',async()=>{
  for(const bad of [null,{points:[]},{points:[[1,2,3]]},{points:[[1,NaN,0,0],[2,0,0,0]]},{points:'x'}]) {
    const {layer,lines,summaries}=harness(async()=>bad);
    await layer.show(entity());
    assert.equal(lines().length,0);
    assert.equal(summaries.at(-1),null);
  }
});

test('an oversized path is truncated rather than pushed to the renderer whole',async()=>{
  const many={points:Array.from({length:5000},(_,i)=>[i,7000000+i,0,0]),summary:{}};
  const {layer,lines}=harness(async()=>many);
  await layer.show(entity());
  assert.ok(lines()[0].positions.length<=layer.maximumPoints);
  assert.ok(lines()[0].positions.length>=100);
});

test('a failed request leaves the scene clean and warns once',async()=>{
  const warnings=[];
  const scene={primitives:new Collection()};
  const layer=new TrajectoryLayer(C,{scene},{load:async()=>{throw new Error('offline');},
    onWarning:message=>warnings.push(message)});
  await layer.show(entity());
  assert.equal(layer.polylines.values.length,0);
  assert.equal(warnings.length,1);
});

test('the path is refreshed on its own bounded schedule, not every frame',async()=>{
  let calls=0;
  const {layer}=harness(async()=>{calls++;return path();});
  await layer.show(entity('a','satellite'));
  assert.equal(calls,1);
  let now=0;const due=()=>layer.update(now);
  due();assert.equal(calls,1);
  now=layer.refreshMs-1;due();assert.equal(calls,1);
  now=layer.refreshMs+1;await due();assert.equal(calls,2);
  layer.clear();now=10*layer.refreshMs;await due();
  assert.equal(calls,2,'a cleared selection stops refreshing');
});

test('destroying the layer removes its primitive collection',async()=>{
  const {layer,scene}=harness(async()=>path());
  await layer.show(entity());
  assert.equal(scene.primitives.values.length,1);
  layer.destroy();
  assert.equal(scene.primitives.values.length,0);
});

test('satellite trajectory details state the orbit shape and that it is computed',()=>{
  const view=describeTrajectory({kind:'satellite',derivation:'gp_propagated',span_seconds:5574,
    summary:{period_minutes:92.94,apogee_km:409.7,perigee_km:401.2,inclination_deg:51.64,epoch_age_hours:12.5}});
  const value=key=>view.fields.find(field=>field.key===key).value;
  assert.match(value('period'),/92\.9/);
  assert.match(value('apogee'),/410|409/);
  assert.match(value('perigee'),/401/);
  assert.match(value('inclination'),/51\.6/);
  assert.match(value('epoch_age'),/12\.5|12/);
  assert.match(view.note,/계산|전파/);
  assert.match(view.note,/실제 측정 궤적이 아닙니다/,'the computed path disclaims being a measurement');
});

test('only objects with a propagated orbit get a path, and none is requested for the rest',async()=>{
  let calls=0;
  const {layer,lines}=harness(async()=>{calls++;return path();});
  await layer.show(entity('s','satellite'));
  assert.equal(calls,1);assert.equal(lines().length,PER_PATH);
  await layer.show(entity('a','aircraft'));
  assert.equal(calls,1,'a provider state without a route is never requested');
  assert.equal(lines().length,0,'the previous path is cleared with the selection');
  assert.equal(layer.entityId,null);
});

test('details exist only for a path that was actually served',()=>{
  assert.equal(describeTrajectory(null),null);
  assert.equal(describeTrajectory({kind:'aircraft'}),null,'a path with no summary describes nothing');
  assert.equal(describeTrajectory({kind:'uam',summary:{}}),null,'a kind the twin serves no path for');
});

test('following reuses primitives and distributes anchor correction without a first-segment elbow',async()=>{
  const {layer,lines}=harness(async()=>prediction(30));
  layer.supports=()=>true;
  const at={time:100,position:[7000000,20,0]};layer.anchor=()=>at;
  await layer.show(entity('u','uam'));const original=lines().slice();
  for(let t=100.1;t<101;t+=.1){at.time=t;at.position=[7000000+(t-100)*10,20,0];layer.follow();}
  assert.deepEqual(lines(),original,'same two primitive objects survive all frames');
  const p=layer.line.positions;
  assert.equal(p[0].y,20);assert.equal(p[1].y,20,'no abrupt sideways rejoin after the first point');
  assert.equal(p.at(-1).y,0,'correction ends before the far forecast');
});

test('new predictions blend at the same display time and keep the rendered anchor attached',async()=>{
  let shifted=false;
  const {layer,clock}=harness(async()=>{const p=prediction(30);if(shifted)p.points=p.points.map(v=>[v[0],v[1],100,v[3]]);return p;});
  layer.supports=()=>true;
  layer.anchor=()=>({time:100,position:[7000000,0,0],displayPosition:[7000000,0,3]});
  await layer.show(entity('u','uam'));
  shifted=true;clock.value=500;await layer.show(entity('u','uam'));
  assert.equal(layer.line.positions.at(-1).y,0,'refresh does not snap the far end');
  clock.value=650;layer.follow();assert.ok(layer.line.positions.at(-1).y>40 && layer.line.positions.at(-1).y<60);
  assert.equal(layer.line.positions[0].z,3,'the line starts on the displayed model including its deck registration');
  clock.value=850;layer.follow();assert.equal(layer.line.positions.at(-1).y,100);
});

test('slow refreshes never overlap and an error does not resurrect an expired prediction',async()=>{
  let resolve,calls=0,fail=false;
  const {layer,clock}=harness(()=>{calls++;return fail?Promise.reject(new Error('offline')):new Promise(r=>resolve=r);});
  layer.supports=()=>true;let t=100;layer.anchor=()=>({time:t,position:[7000000,0,0]});
  const pending=layer.show(entity('u','uam'));
  clock.value=600;layer.update();clock.value=1200;layer.update();assert.equal(calls,1);
  resolve(prediction(30));await pending;
  fail=true;clock.value=1800;await layer.update();assert.ok(layer.path,'keeps the last valid forecast through one failed refresh');
  t=200;layer.follow();assert.equal(layer.path,null);assert.equal(layer.polylines.values.length,0);
  assert.equal(layer.follow(),false);
});

test('epoch and phase changes invalidate old predictions immediately',async()=>{
  const {layer}=harness(async()=>({...prediction(30),epoch:1,flight_phase:'cruise'}));
  layer.supports=()=>true;const at={time:100,position:[7000000,0,0],epoch:1,phase:'cruise'};layer.anchor=()=>at;
  await layer.show(entity('u','uam'));at.phase='hold';assert.equal(layer.follow(),true);assert.equal(layer.path,null);
  await layer.show(entity('u','uam'));assert.equal(layer.path,null,'a response from the former phase cannot reappear');
  at.phase='cruise';await layer.show(entity('u','uam'));at.epoch=2;layer.follow();assert.equal(layer.path,null);
});

test('downsampling retains the last endpoint and rejects nonmonotonic timestamps',async()=>{
  const {layer}=harness(async()=>path(5001));await layer.show(entity());
  assert.equal(layer.line.positions.at(-1).x,7005000);
  layer.load=async()=>({points:[[1,1,2,3],[1,2,3,4]],summary:{}});await layer.show(entity());assert.equal(layer.line,null);
});

test('mission prediction details describe intent instead of claiming straight flight',()=>{
  const view=describeTrajectory({kind:'aircraft',note:'현재 임무의 예상입니다.',summary:{basis:'mission_intent',flight_phase:'descent'}});
  assert.equal(view.note,'현재 임무의 예상입니다.');
  assert.ok(view.fields.some(f=>f.key==='phase' && /강하/.test(f.value)));
  assert.ok(!view.fields.some(f=>f.key==='turn'));
});

// The operator asked for no predicted path while a UAM taxis or lifts
// vertically; from the climb-out on it is drawn as before.
test('a UAM taxiing or lifting off has no predicted path, and gets one from the climb-out on',async()=>{
  const scene={primitives:new Collection()};const at={phase:'gate_out'};let loads=0;const summaries=[];
  const layer=new TrajectoryLayer(C,{scene},{load:async()=>{loads++;return path(4,'uam');},anchor:()=>at,
    supports:e=>e?.kind==='uam',onSummary:v=>summaries.push(v),now:()=>clock});
  let clock=0;
  await layer.show(entity('u','uam'));
  assert.equal(loads,0,'nothing is asked for on the ground');assert.equal(layer.polylines.values.length,0);
  assert.equal(layer.entityId,'u','but the aircraft stays selected');
  at.phase='takeoff';clock=100000;await layer.update(clock);
  assert.equal(loads,0,'nor on the vertical');
  at.phase='climb';clock=200000;await layer.update(clock);
  assert.equal(loads,1,'asked for from the climb-out');assert.equal(layer.polylines.values.length,PER_PATH);
  at.phase='gate_in';clock=300000;await layer.update(clock);
  assert.equal(layer.polylines.values.length,0,'and taken away again on the ground at the far end');
  assert.equal(summaries.at(-1),null);
});
