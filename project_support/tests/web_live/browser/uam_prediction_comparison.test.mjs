import test from 'node:test';
import assert from 'node:assert/strict';
import {TrajectoryLayer} from '../../../../digital_twin/visualization/web/trajectory_layer.js';
import {describeTrajectory} from '../../../../user_application/web/entity_details.js';
import {LiveGlobe,defaultTrajectory} from '../../../../digital_twin/visualization/web/globe.js';
import {readFileSync} from 'node:fs';
import {FakeElement,fakeDocument} from './fake_dom.mjs';

const web=new URL('../../../../user_application/web/',import.meta.url),visual=new URL('../../../../digital_twin/visualization/web/',import.meta.url);
const source=readFileSync(new URL('selection_panel.js',web),'utf8').replace(/from '([^']+)'/g,(_,path)=>
  `from '${path.startsWith('/visualization/')?new URL(path.slice(15),visual).href:new URL(path,web).href}'`);
const {SelectionPanel}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

class Collection {
  values=[];
  add(item){this.values.push(item);return item;}
  remove(item){this.values=this.values.filter(value=>value!==item);}
  removeAll(){this.values=[];}
}
const color=value=>({value,withAlpha(alpha){return {...this,alpha};}});
const C={PolylineCollection:Collection,LabelCollection:Collection,
  Cartesian2:class {constructor(x,y){Object.assign(this,{x,y});}},
  Cartesian3:{fromArray:p=>({x:p[0],y:p[1],z:p[2]})},
  Color:{fromCssColorString:color,BLACK:color('black'),TRANSPARENT:color('transparent')},
  Material:{fromType:(type,uniforms)=>({type,uniforms})}};
const models=[['short',10,'#2dd4bf'],['mid',90,'#fb923c'],['long',240,'#c084fc']];
const entity=id=>({entity_id:id,kind:'uam'});
function comparison({id='u',time=100,epoch=1,continuity=1,phase='cruise',status={}}={}) {
  const context={entity_id:id,epoch,continuity_id:continuity,flight_phase:phase};
  return {schema_version:2,kind:'uam_prediction_comparison',...context,name:id,generated_at:time,
    predictions:models.map(([key,seconds,color],i)=>({model_id:`uam_route_mlp_${key}`,
      label:['단기','중기','장기'][i],horizon_seconds:seconds,color,status:status[key]??'ready',
      reason:status[key]==='warming_up'?'실제 상태 이력 부족':status[key]==='unavailable'?'모델 파일 없음':null,
      history_seconds:i?28.8:9.6,available_history_seconds:status[key]?4:30,
      path:status[key]?null:{kind:'aircraft',...context,reference_frame:'ecef_m',summary:{seconds,model:`uam_route_mlp_${key}`},
        points:[[time,7000000,0,0],[time+seconds/2,7000000+seconds/2,i+1,0],[time+seconds,7000000+seconds,(i+1)*2,0]]}}))};
}
function harness(load=async()=>comparison()) {
  const scene={primitives:new Collection()},clock={value:0},summaries=[];
  const at={time:100,epoch:1,continuity_id:1,phase:'cruise',position:[7000999,40,50],displayPosition:[7000999,40,55]};
  const layer=new TrajectoryLayer(C,{scene},{load,onSummary:p=>summaries.push(p),now:()=>clock.value,supports:()=>true,anchor:()=>at});
  return {layer,scene,clock,at,summaries,lines:()=>layer.polylines.values.filter(p=>p.show!==false),
    labels:()=>scene.primitives.values.filter(p=>p===layer.comparison.labels).flatMap(p=>p.values).filter(p=>p.show!==false)};
}

test('three learned forecasts keep their original ECEF positions and distinct horizons, patterns and endpoint labels',async()=>{
  const h=harness();await h.layer.show(entity('u'));h.clock.value=350;h.layer.follow();
  assert.equal(h.lines().length,6);
  const main=h.lines().filter(p=>p.disableDepthTestDistance===undefined);
  assert.deepEqual(main.map(p=>p.positions.at(-1).x),[7000010,7000090,7000240]);
  assert.deepEqual(main.map(p=>p.positions[0]),Array(3).fill({x:7000000,y:0,z:0}),'no anchor translation or display lift');
  assert.deepEqual(main.map(p=>p.material.uniforms.color.value),['#2dd4bf','#fb923c','#c084fc']);
  assert.equal(new Set(main.map(p=>`${p.material.type}:${p.material.uniforms.dashPattern??'solid'}`)).size,3);
  assert.deepEqual(h.labels().map(p=>p.text),['+10초','+90초','+240초']);
  assert.deepEqual(h.labels().map(p=>p.position.x),[7000010,7000090,7000240]);
  h.at.time=105;h.at.position=[9000000,900,99];h.layer.follow();
  assert.deepEqual(main[0].positions[0],{x:7000005,y:1,z:0},'only the elapsed portion is clipped, at its original timestamp');
  assert.deepEqual(main.map(p=>p.positions.at(-1).x),[7000010,7000090,7000240],'future endpoints do not follow the aircraft');
  assert.ok(h.layer.path.predictions.every(p=>p.path.points[0][1]===7000000),'source predictions remain immutable');
});

test('warming and unavailable models report honest per-model status without suppressing ready paths',async()=>{
  const h=harness(async()=>comparison({status:{mid:'warming_up',long:'unavailable'}}));await h.layer.show(entity('u'));
  assert.equal(h.lines().length,2);assert.equal(h.labels().length,1);
  assert.deepEqual(h.summaries.at(-1).predictions.map(p=>p.status),['ready','warming_up','unavailable']);
  const view=describeTrajectory(h.summaries.at(-1));
  assert.ok(view);assert.match(view.note,/학습|예측/);assert.match(view.fields.find(p=>p.key==='uam_route_mlp_mid').value,/4.*28\.8|28\.8.*4/);
  assert.match(view.fields.find(p=>p.key==='uam_route_mlp_long').value,/모델 파일 없음/);
});

test('comparison flow connects the displayed aircraft without translating forecasts and reuses moving glow objects',async()=>{
  const h=harness();await h.layer.show(entity('u'));h.clock.value=350;h.layer.follow();
  const fx=h.layer.comparison.flow;
  assert.ok(fx,'dedicated bounded flow collection');
  const connector=fx.values.find(p=>p.id==='uam_route_mlp_short:connector');
  assert.deepEqual(connector.positions[0],{x:7000999,y:40,z:55});
  assert.equal(connector.positions.at(-1).x,7000000);
  const pulse=fx.values.find(p=>p.id==='uam_route_mlp_short:pulse:0');
  const before=JSON.stringify(pulse.positions),count=fx.values.length;
  h.clock.value=650;h.at.displayPosition=[7000998,40,55];h.layer.follow();
  assert.notEqual(JSON.stringify(pulse.positions),before);
  assert.equal(fx.values.length,count);assert.equal(connector.positions[0].x,7000998);
  h.layer.setComparisonVisibility({model:'uam_route_mlp_comparison',short_enabled:false});
  assert.ok(fx.values.filter(p=>p.id.startsWith('uam_route_mlp_short:')).every(p=>!p.show));
  h.layer.clear();assert.equal(fx.values.length,0);
});

test('model visibility toggles only hide the chosen comparison lines and endpoints without inference',async()=>{
  let calls=0;const h=harness(async()=>{calls++;return comparison();});await h.layer.show(entity('u'));
  h.layer.setComparisonVisibility({model:'uam_route_mlp_comparison',mid_enabled:false});
  assert.equal(h.lines().length,4);assert.deepEqual(h.labels().map(p=>p.text),['+10초','+240초']);
  assert.equal(calls,1);assert.equal(h.summaries.at(-1).predictions[1].visible,false);
  h.layer.setComparisonVisibility({model:'uam_route_mlp_comparison',short_enabled:false,mid_enabled:false,long_enabled:false});
  assert.equal(h.lines().length,0);assert.equal(h.labels().length,0);
  h.layer.setComparisonVisibility({model:'uam_route_mlp_short',short_enabled:false});
  assert.equal(h.lines().length,6,'comparison filters do not hide individually selected models');
});

test('comparison smoothly transitions display geometry and labels without modifying model output',async()=>{
 const h=harness();await h.layer.show(entity('u'));h.clock.value=500;
 const next=comparison({time:101});next.predictions.forEach(p=>p.path.points.forEach(row=>row[2]+=100));const original=JSON.stringify(next);
 h.layer.load=async()=>next;await h.layer.show(entity('u'));
 assert.equal(h.lines()[0].positions[0].y,0,'replacement starts at the displayed geometry');
 h.clock.value=650;h.layer.follow();
 assert.ok(h.lines()[0].positions[0].y>0&&h.lines()[0].positions[0].y<100);
 assert.ok(h.labels()[0].position.y>2&&h.labels()[0].position.y<102);
 assert.deepEqual(h.labels()[0].position,h.lines()[0].positions.at(-1));
 assert.deepEqual(h.layer.comparison.flow.values[0].positions[1],h.lines()[0].positions[0]);
 h.clock.value=850;h.layer.follow();assert.equal(h.lines().length,6);
 assert.equal(h.lines()[0].positions[0].y,100);assert.equal(JSON.stringify(next),original);
});

test('interrupted display transitions start from the currently visible line',async()=>{
 const h=harness();await h.layer.show(entity('u'));
 const load=(time,y)=>{const p=comparison({time});p.predictions.forEach(v=>v.path.points.forEach(r=>r[2]+=y));h.layer.load=async()=>p;return h.layer.show(entity('u'));};
 h.clock.value=200;await load(100.2,100);h.clock.value=350;h.layer.follow();const before=h.lines()[0].positions.map(p=>({...p}));
 await load(100.4,200);assert.deepEqual(h.lines()[0].positions,before);
 h.clock.value=700;h.layer.follow();assert.equal(h.lines()[0].positions[0].y,200);
});

test('old generated_at responses are ignored and malformed members fail independently',async()=>{
  const h=harness();await h.layer.show(entity('u'));
  h.layer.load=async()=>comparison({time:99});await h.layer.show(entity('u'));assert.equal(h.layer.path.generated_at,100);
  const next=comparison({time:101});next.predictions[1].path.points[1][1]=NaN;
  h.layer.load=async()=>next;await h.layer.show(entity('u'));h.clock.value=400;h.layer.follow();
  assert.equal(h.lines().length,4);assert.equal(h.summaries.at(-1).predictions[1].status,'unavailable');
});

test('foreign entity or mismatched model clocks cannot appear as a valid comparison',async()=>{
  const h=harness(async()=>comparison({id:'other'}));await h.layer.show(entity('u'));assert.equal(h.lines().length,0);
  const next=comparison();next.predictions[1].path.points[2][0]=191;
  h.layer.load=async()=>next;await h.layer.show(entity('u'));assert.equal(h.lines().length,4);
  assert.equal(h.summaries.at(-1).predictions[1].status,'unavailable');
});

test('comparison epochs, mission continuity and flight phase invalidate every path even during warmup',async()=>{
  for(const [field,value] of [['epoch',2],['continuity_id',2],['phase','hold']]) {
    const h=harness();await h.layer.show(entity('u'));h.at[field]=value;h.layer.follow();
    assert.equal(h.lines().length,0);assert.equal(h.labels().length,0);assert.equal(h.layer.path,null);
    await h.layer.show(entity('u'));assert.equal(h.layer.path,null,'old context response cannot return');
  }
  const h=harness(async()=>comparison({status:{short:'warming_up',mid:'warming_up',long:'warming_up'}}));
  await h.layer.show(entity('u'));assert.ok(h.layer.path);h.at.epoch=2;h.layer.follow();assert.equal(h.layer.path,null);
});

test('late selection responses and destruction do not leak comparison labels or lines',async()=>{
  const pending=new Map(),h=harness(id=>new Promise(resolve=>pending.set(id,resolve)));
  const first=h.layer.show(entity('a')),second=h.layer.show(entity('b'));
  pending.get('b')(comparison({id:'b'}));await second;pending.get('a')(comparison({id:'a'}));await first;
  assert.equal(h.layer.path.entity_id,'b');assert.equal(h.lines().length,6);
  h.layer.clear();assert.equal(h.lines().length,0);assert.equal(h.labels().length,0);
  const last=h.layer.show(entity('b'));h.layer.destroy();pending.get('b')(comparison({id:'b'}));await last;
  assert.equal(h.scene.primitives.values.length,0);
});

test('failed requests retain only non-expired comparison paths and never invent a fallback',async()=>{
  const h=harness();await h.layer.show(entity('u'));h.layer.load=async()=>{throw Error('offline');};
  await h.layer.show(entity('u'));h.at.time=111;h.clock.value=600;h.layer.follow();
  assert.deepEqual(h.labels().map(p=>p.text),['+90초','+240초']);
  h.at.time=341;h.layer.follow();assert.equal(h.lines().length,0);assert.equal(h.labels().length,0);
});

test('changing the chosen UAM model invalidates an in-flight old model response but visibility does not refetch',async()=>{
  let resolve,calls=0;const h=harness(()=>{calls++;return new Promise(r=>resolve=r);});
  const globe=Object.assign(Object.create(LiveGlobe.prototype),{trajectory:h.layer,predictUam:false,
    selected:'u',items:new Map([['u',{entity:entity('u')}]]),viewer:{scene:{requestRender(){}}}});
  globe.setUamPrediction(true,{model:'constant_velocity_v1',seconds:10});
  const oldResolve=resolve;
  globe.setUamPrediction(true,{model:'uam_route_mlp_comparison',seconds:10,short_enabled:true,mid_enabled:false,long_enabled:true});
  assert.equal(calls,2,'a new model selection starts a new request even though prediction is already enabled');
  resolve(comparison());await new Promise(r=>setImmediate(r));
  oldResolve({kind:'aircraft',points:[[100,1,2,3],[110,4,5,6]],summary:{seconds:10}});await new Promise(r=>setImmediate(r));
  assert.equal(h.layer.path.kind,'uam_prediction_comparison');assert.equal(h.lines().length,4);
  globe.setUamPrediction(true,{model:'uam_route_mlp_comparison',seconds:10,short_enabled:true,mid_enabled:true,long_enabled:true});
  assert.equal(calls,2);assert.equal(h.lines().length,6);
});

test('selected-aircraft details show a matching three-pattern legend and remove it on deselection',async()=>{
  const h=harness();await h.layer.show(entity('u'));
  const nodes=Object.fromEntries(['trajectory','trajectory-title','trajectory-note','trajectory-detail'].map(id=>[id,new FakeElement('div')]));
  const panel=Object.assign(Object.create(SelectionPanel.prototype),{entityId:'u',$:id=>nodes[id]});
  const prior=globalThis.document;globalThis.document=fakeDocument;
  try {
    panel.setTrajectory(h.layer.path);
    const swatches=nodes['trajectory-detail'].querySelectorAll('.prediction-swatch');
    assert.equal(swatches.length,3);assert.deepEqual(swatches.map(n=>n.dataset.pattern),['solid','dashed','dotted']);
    assert.match(nodes['trajectory-detail'].textContent,/단기.*10초/);assert.match(nodes['trajectory-note'].textContent,/정확도를 보장하지/);
    const rows=nodes['trajectory-detail'].children;panel.setTrajectory(h.layer.path);
    assert.equal(nodes['trajectory-detail'].children[0],rows[0],'polling reuses legend rows');
    panel.setTrajectory(null);assert.equal(nodes.trajectory.hidden,true);assert.equal(nodes['trajectory-detail'].children.length,0);
  } finally {globalThis.document=prior;}
});

test('hidden forecasts are not described as being drawn and their common reference time remains visible',async()=>{
  const h=harness();await h.layer.show(entity('u'));h.layer.setComparisonVisibility({model:'uam_route_mlp_comparison',mid_enabled:false});
  const view=describeTrajectory(h.layer.path),mid=view.fields.find(p=>p.key==='uam_route_mlp_mid');
  assert.match(mid.value,/숨김/);assert.doesNotMatch(mid.value,/표시 중/);
  assert.ok(view.fields.some(p=>p.key==='generated_at'&&/00:01:40.*UTC/.test(p.value)));
});

test('comparison envelopes missing epoch or using a non-ECEF member do not bypass context safety',async()=>{
  const missing=comparison();delete missing.epoch;
  const h=harness(async()=>missing);await h.layer.show(entity('u'));assert.equal(h.lines().length,0);
  assert.equal(h.layer.path,null,'the invalid envelope is not retained as valid warmup status');
  const wrongFrame=comparison();wrongFrame.predictions[0].path.reference_frame='local_ned_m';
  h.layer.load=async()=>wrongFrame;await h.layer.show(entity('u'));assert.equal(h.lines().length,4);
});

test('switching from learned comparison back to a legacy orbit clears every learned line and endpoint',async()=>{
  const h=harness();await h.layer.show(entity('u'));
  h.layer.load=async()=>({kind:'satellite',points:[[100,1,2,3],[110,4,5,6]],summary:{period_minutes:90}});
  await h.layer.show({entity_id:'s',kind:'satellite'});
  assert.equal(h.lines().length,2);assert.equal(h.labels().length,0);
  assert.equal(h.layer.path.kind,'satellite');
});

test('an individually selected learned model uses its own envelope without comparison visibility filtering',async()=>{
  const one=comparison();one.predictions=one.predictions.slice(1,2);
  const h=harness(async()=>one);h.layer.setComparisonVisibility({model:'uam_route_mlp_mid',mid_enabled:false});
  await h.layer.show(entity('u'));assert.equal(h.lines().length,2);assert.deepEqual(h.labels().map(p=>p.text),['+90초']);
});

test('many comparison refreshes keep primitive and label counts bounded',async()=>{
  const h=harness();await h.layer.show(entity('u'));
  for(let n=1;n<=50;n++) {
    h.clock.value=n*500;h.at.time=100+n/10;h.layer.load=async()=>comparison({time:h.at.time});await h.layer.show(entity('u'));
    assert.ok(h.layer.polylines.values.length<=12);assert.equal(h.labels().length,3);
    h.clock.value+=350;h.layer.follow();assert.equal(h.lines().length,6);
  }
  h.layer.destroy();assert.equal(h.scene.primitives.values.length,0);
});

test('selected UAM refreshes at 5 Hz without accumulating requests, including accelerated playback',async()=>{
  for(const clockRate of [1,8]) {
    let calls=0,finish;const h=harness(async()=>{calls++;return comparison({time:100+calls/10});});
    h.at.clockRate=clockRate;await h.layer.show(entity('u'));
    h.clock.value=199;await h.layer.update();assert.equal(calls,1);
    h.clock.value=200;await h.layer.update();assert.equal(calls,2,'a new forecast is requested within 200 ms');
    h.layer.load=()=>{calls++;return new Promise(resolve=>finish=resolve);};
    h.clock.value=400;const request=h.layer.update();assert.equal(calls,3);
    for(let ms=410;ms<=1100;ms+=10){h.clock.value=ms;h.layer.update();h.layer.follow();}
    assert.equal(calls,3,'one slow inference cannot create a queue');
    finish(comparison({time:100.4}));await request;
    h.layer.clear();h.clock.value=1400;await h.layer.update();assert.equal(calls,3,'deselection stops requests');
  }
});

test('each rendered frame trims past forecast samples without a network response or coordinate translation',async()=>{
  const h=harness();await h.layer.show(entity('u'));
  const original=JSON.stringify(h.layer.path.predictions),record=h.layer.comparison.records.get('uam_route_mlp_short');
  h.at.time=104.5;h.layer.follow();assert.deepEqual(record.current[1].positions[0],{x:7000004.5,y:.9,z:0});
  h.at.time=104.6;h.layer.follow();assert.ok(Math.abs(record.current[1].positions[0].x-7000004.6)<1e-8);
  assert.deepEqual(record.current[1].positions.at(-1),{x:7000010,y:2,z:0});
  assert.equal(JSON.stringify(h.layer.path.predictions.map(p=>p.path)),JSON.stringify(JSON.parse(original).map(p=>p.path)));
  h.at.time=111;h.layer.follow();assert.equal(record.current[1].show,false,'no extrapolation past the served horizon');
});

test('duplicate and paused results do not restart display transitions or allocate new primitives',async()=>{
  const h=harness();await h.layer.show(entity('u'));const first=h.layer.polylines.values.slice();
  for(let n=1;n<=6;n++){h.clock.value=n*200;await h.layer.show(entity('u'));h.layer.follow();}
  assert.deepEqual(h.layer.polylines.values,first);
  assert.equal(h.lines().length,6);assert.ok(h.lines().every(line=>line.material.uniforms.color.alpha>=.25));
});

test('rapid new forecasts keep opaque lines and reuse a bounded line pool',async()=>{
  const h=harness();await h.layer.show(entity('u'));
  h.clock.value=200;h.layer.load=async()=>comparison({time:100.2});await h.layer.show(entity('u'));
  const pool=h.layer.polylines.values.slice();assert.equal(pool.length,12);
  h.clock.value=390;h.layer.follow();assert.equal(h.lines().length,6,'only one opaque path per model during the transition');
  for(let n=2;n<=20;n++){
    h.clock.value=n*200;h.at.time=100+n*.2;h.layer.load=async()=>comparison({time:h.at.time});await h.layer.show(entity('u'));
    h.clock.value+=190;h.layer.follow();
    assert.equal(h.lines().length,6);assert.equal(h.layer.polylines.values.length,12);
    assert.ok(h.layer.polylines.values.every(line=>pool.includes(line)),'no line recreation after both buffers exist');
  }
  h.layer.clear();assert.equal(h.layer.polylines.values.length,0);
});

test('forecast age and slow requests are disclosed without pretending the old horizon is current',async()=>{
  const h=harness();await h.layer.show(entity('u'));
  h.at.time=102;h.clock.value=2000;h.layer.follow();
  let view=describeTrajectory(h.summaries.at(-1));
  assert.match(view.fields.find(f=>f.key==='refresh')?.value??'',/지연/);
  assert.match(view.fields.find(f=>f.key==='forecast_age')?.value??'',/2\.0/);
  assert.equal(h.labels()[0].text,'+10초','the label stays relative to the disclosed forecast origin');
  h.layer.load=async()=>comparison({time:102});await h.layer.show(entity('u'));
  view=describeTrajectory(h.summaries.at(-1));assert.doesNotMatch(view.fields.find(f=>f.key==='refresh')?.value??'',/지연/);
  let finish;h.layer.load=()=>new Promise(resolve=>finish=resolve);
  h.clock.value=2200;const request=h.layer.update();h.clock.value=3800;h.layer.follow();
  view=describeTrajectory(h.summaries.at(-1));assert.match(view.fields.find(f=>f.key==='refresh')?.value??'',/지연/);
  finish(comparison({time:102}));await request;
});

test('a slow refresh exposes its pending age but does not flood the details panel on every frame',async()=>{
  const h=harness();await h.layer.show(entity('u'));const count=h.summaries.length;
  for(let n=1;n<=60;n++){h.clock.value=n*1000/60;h.at.time=100+n/60;h.layer.follow();}
  assert.ok(h.summaries.length>count,'freshness progresses between responses');
  assert.ok(h.summaries.length-count<=5,'details update at most four times per second, not at render frequency');
});

test('stale phase responses cannot bypass the 5 Hz limit while the telemetry stream catches up',async()=>{
  let calls=0;const h=harness(async()=>{calls++;return comparison({phase:'hold'});});
  await h.layer.show(entity('u'));
  for(let n=1;n<=60;n++){h.clock.value=n*1000/60;await h.layer.update();}
  assert.ok(calls<=6,`old-context responses requested ${calls} in one second`);
  assert.equal(h.lines().length,0,'the mismatch is still never displayed');
  h.at.phase='hold';h.clock.value=1200;await h.layer.update();assert.equal(h.lines().length,6);
});

test('HTTP failure is disclosed even when the displayed state clock is paused',async t=>{
  const h=harness();await h.layer.show(entity('u'));h.at.clockRate=0;
  t.mock.method(globalThis,'fetch',async()=>({ok:false,status:503}));h.layer.load=defaultTrajectory;
  h.clock.value=200;await h.layer.update();h.layer.follow();
  assert.match(describeTrajectory(h.summaries.at(-1)).fields.find(f=>f.key==='refresh').value,/지연/);
  assert.equal(h.lines().length,6,'failure preserves only the previously served valid geometry');
  h.layer.load=async()=>comparison();h.clock.value=400;await h.layer.update();h.layer.follow();
  assert.match(describeTrajectory(h.summaries.at(-1)).fields.find(f=>f.key==='refresh').value,/지연/,
    'the failed HTTP request is backed off for one real second even while paused');
  h.clock.value=1200;await h.layer.update();h.layer.follow();
  assert.doesNotMatch(describeTrajectory(h.summaries.at(-1)).fields.find(f=>f.key==='refresh').value,/지연/);
});

test('flow expires by horizon, hides without an anchor and is destroyed with the layer',async()=>{
  const h=harness();await h.layer.show(entity('u'));h.clock.value=650;h.layer.follow();
  const fx=h.layer.comparison.flow;assert.equal(fx.values.length,21);
  h.at.time=111;h.layer.follow();
  assert.ok(fx.values.filter(p=>p.id.startsWith('uam_route_mlp_short:')).every(p=>!p.show));
  h.at.displayPosition=null;h.at.position=null;h.layer.follow();
  assert.ok(fx.values.every(p=>!p.show));
  h.layer.destroy();assert.ok(!h.scene.primitives.values.includes(fx));
});

test('reduced motion keeps the connector live but disables flowing pulses',async()=>{
  const previous=globalThis.matchMedia;globalThis.matchMedia=()=>({matches:true});
  try{
    const h=harness();await h.layer.show(entity('u'));h.clock.value=650;
    const fx=h.layer.comparison.flow;
    assert.ok(fx.values.filter(p=>!p.id.endsWith(':connector')).every(p=>!p.show));
    h.at.displayPosition=[7000123,2,3];assert.equal(h.layer.follow(),true);
    assert.deepEqual(fx.values[0].positions[0],{x:7000123,y:2,z:3});
    h.layer.destroy();
  }finally{if(previous===undefined)delete globalThis.matchMedia;else globalThis.matchMedia=previous;}
});

 test('reduced motion replaces forecast geometry immediately without a transition',async()=>{
  const previous=globalThis.matchMedia;globalThis.matchMedia=()=>({matches:true});
  try {
   const h=harness();await h.layer.show(entity('u'));h.clock.value=200;
   const next=comparison({time:100.2});next.predictions.forEach(p=>p.path.points.forEach(row=>row[2]+=100));
   h.layer.load=async()=>next;await h.layer.show(entity('u'));
   assert.equal(h.lines()[0].positions[0].y,100);
   assert.deepEqual(h.labels()[0].position,h.lines()[0].positions.at(-1));
   assert.ok([...h.layer.comparison.records.values()].every(r=>r.morphFrom===null));
  }finally{if(previous===undefined)delete globalThis.matchMedia;else globalThis.matchMedia=previous;}
 });
