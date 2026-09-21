import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {FakeElement,fakeDocument} from './fake_dom.mjs';
import {describeEntity,describeFlightReadouts,describeMissionOverview,describeMission} from '../../../../user_application/web/entity_details.js';

const web=new URL('../../../../user_application/web/',import.meta.url);
const visual=new URL('../../../../digital_twin/visualization/web/',import.meta.url);
const html=readFileSync(new URL('index.html',web),'utf8');
const source=readFileSync(new URL('selection_panel.js',web),'utf8').replace(/from '([^']+)'/g,(_,path)=>
  `from '${path.startsWith('/visualization/')?new URL(path.slice(15),visual).href:new URL(path,web).href}'`);
const {SelectionPanel}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const entity={entity_id:'scenario:UAM7',name:'UAM7 · FPL42',source:'scenario',kind:'uam',quality:'nominal',
  provenance:'simulation',derivation:'simulated',orientation_source:'attitude',latitude_deg:37.5,longitude_deg:126.9,
  altitude_m:304.8,velocity_ecef_mps:[30,40,0],heading_deg:55,pitch_deg:1,roll_deg:-2,tilt_deg:90,
  rotor_radps:200,flight_phase:'cruise',state_time:100,observation_time:100};
const mission={state:{aircraft_id:'UAM7',flight_id:'FPL42',phase:'cruise',flight_mode:'fixed_wing',airborne:true,
  passengers:3,on_board:2,seats:4,adherence:{progress:.42,plan_share:.5,remaining_s:300,delay_s:95}},
  flight:{origin_name:'여의도',destination_name:'목동'},remaining:12};
const card=(view,key)=>view.cards.find(item=>item.key===key);

test('readouts use snapshot values, distinguish body heading, and explicitly label ECEF speed',()=>{
  const view=describeFlightReadouts(entity);
  assert.equal(view.source,'시뮬레이션');assert.equal(view.quality,'상태 수신');
  assert.equal(card(view,'altitude').value,'305');assert.match(card(view,'altitude').sub,/1,000 ft/);
  assert.equal(card(view,'speed').value,'180');assert.match(card(view,'speed').label,/ECEF/);
  assert.equal(card(view,'heading').label,'기수 방위');assert.equal(card(view,'heading').angle,55);
  assert.equal(card(view,'rotor').value,'1,910');assert.equal(view.mode,'고정익');
  assert.equal(view.attitude[1].value,'-2.0°');assert.equal(view.tilt,90);
  assert.equal(describeEntity(entity).kind,'UAM');assert.equal(describeEntity(entity).quality,'유효 상태');
});

test('zero telemetry survives, unknowns remain unknown, ground track never becomes attitude',()=>{
  const zero=describeFlightReadouts({...entity,altitude_m:0,heading_deg:360,velocity_ecef_mps:[0,0,0],rotor_radps:0,tilt_deg:0,flight_phase:'parked'});
  for(const key of ['altitude','speed','heading','rotor'])assert.equal(card(zero,key).value,'0');
  assert.equal(zero.mode,'지상');assert.equal(card(zero,'heading').angle,0);
  const live=describeFlightReadouts({...entity,kind:'aircraft',orientation_source:'ground_track',provenance:'live',derivation:'observed'});
  assert.equal(card(live,'heading').label,'지상 진행 방향');assert.deepEqual(live.attitude,[]);assert.equal(live.tilt,null);
  const missing=describeFlightReadouts({kind:'uam',heading_deg:0,pitch_deg:0,velocity_ecef_mps:[NaN,0,0],rotor_radps:Infinity});
  assert.ok(missing.cards.every(item=>item.value==='—'));assert.deepEqual(missing.attitude,[]);
  assert.equal(missing.source,'출처 확인 필요');assert.doesNotMatch(JSON.stringify(missing),/NaN|Infinity/);
});

test('satellites use appropriate units and do not masquerade as observed aircraft or normal telemetry',()=>{
  const view=describeFlightReadouts({kind:'satellite',altitude_m:420000,velocity_ecef_mps:[7000,0,0],
    heading_deg:30,state_time:7200,orbit_epoch:0,quality:'stale',provenance:'cached',derivation:'sgp4'});
  assert.equal(card(view,'speed').value,'7.00');assert.equal(card(view,'speed').unit,'km/s');
  assert.equal(card(view,'altitude').value,'420.0');assert.equal(card(view,'epoch').value,'2.0');
  assert.equal(card(view,'heading').value,'—');assert.equal(view.quality,'오래된 상태');assert.equal(view.source,'궤도 계산');
  assert.equal(describeFlightReadouts({...entity,provenance:'fixture'}).source,'시험 입력');
});

test('mission overview separates route, stage, load, progress and planned marker',()=>{
  const view=describeMissionOverview(mission);
  assert.equal(view.from,'여의도');assert.equal(view.to,'목동');
  assert.equal(view.steps.filter(step=>step.state==='current').length,1);
  assert.equal(view.steps[3].state,'current');assert.equal(view.progress,'42%');
  assert.equal(view.planned,'│ 계획 50%');assert.equal(view.eta,'착륙까지 5분');
  assert.equal(view.passengers,'2 / 4명');assert.equal(view.occupancy,.5);
  assert.equal(view.sequence,'미배정');assert.equal(view.remaining,'12편');assert.equal(view.warning,'');
  assert.equal(view.timingLevel,'late');
});

test('all known mission phases have one active step, unknown phases are not a fabricated stage',()=>{
  for(const phase of ['parked','gate_out','takeoff','climb','cruise','descent','hold_exit','hold','hold_return','landing','gate_in','charge']){
    assert.equal(describeMissionOverview({state:{phase}}).steps.filter(step=>step.state==='current').length,1,phase);
  }
  assert.equal(describeMissionOverview({state:{phase:'external'}}).steps.filter(step=>step.state==='current').length,0);
  assert.equal(describeMissionOverview(null),null);
});

test('hold, pilot failure, direct route and passenger flow remain explicit, not a green all-clear',()=>{
  const view=describeMissionOverview({...mission,state:{...mission.state,phase:'hold',holding:true,hold_seconds:143,sequence:4},clearance:{reason:'FATO 혼잡'}});
  assert.equal(view.steps[4].state,'current');assert.match(view.warning,/FATO 혼잡.*4순위.*143초/);assert.equal(view.holding,true);
  assert.match(describeMissionOverview({...mission,state:{...mission.state,pilot_failed:true}}).warning,/오류/);
  assert.match(describeMissionOverview({...mission,state:{...mission.state,direct:true}}).warning,/직항 회랑/);
  const boarding=describeMissionOverview({...mission,state:{...mission.state,passenger_flow:{phase:'boarding',moved:0,count:4}}});
  assert.equal(boarding.flow,'탑승 중 · 0 / 4명');
});

test('parked and incomplete responses neither invent occupied seats nor flight timing',()=>{
  const view=describeMissionOverview({state:{phase:'parked',vertiport:'VP001',stand:'G1',seats:0,on_board:0},remaining:0});
  assert.equal(view.routeLabel,'주기 위치');assert.equal(view.to,'G1');assert.equal(view.progress,'다음 임무 대기');
  assert.equal(view.eta,'');assert.equal(view.passengers,'0 / 0명');assert.equal(view.occupancy,null);assert.equal(view.remaining,'0편');
  const absent=describeMissionOverview({state:{flight_id:'f'}});
  assert.equal(absent.passengers,'미제공');assert.equal(absent.progress,'진행률 미제공');assert.equal(absent.remaining,'미제공');
  assert.match(describeMission({state:{}}).fields.find(row=>row.key==='seats').value,/미제공/);
  assert.equal(describeMissionOverview({...mission,state:{...mission.state,adherence:{progress:1.5,plan_share:-1}}}).progress,'100%');
});

function panelHarness(){
  const nodes=Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(([,id])=>[id,new FakeElement('div')]));
  nodes['physical-sensor-detail']=new FakeElement('section');
  for(const n of Object.values(nodes))n.focus=()=>{};
  const preview={close(){},onStatus(){}};
  const panel=Object.assign(Object.create(SelectionPanel.prototype),{$:id=>nodes[id],assets:new Map(),rows:new Map(),revision:0,fieldsKey:'',preview,
    queuePreview(){},loadThumbnail(){}});
  nodes.mission.hidden=true;
  return {panel,nodes};
}

test('physical telemetry and missing scenario mission updates do not toggle the placeholder',()=>{
  const saved=globalThis.document,raf=globalThis.requestAnimationFrame;
  globalThis.document=fakeDocument;globalThis.requestAnimationFrame=callback=>callback();
  const {panel,nodes}=panelHarness();
  try{
    const physical={...entity,entity_id:'physical:UAM7',source:'physical_uam'};
    panel.show(physical);
    for(let tick=0;tick<8;tick++){
      panel.setMission(null);
      assert.equal(nodes['mission-empty'].hidden,true,'a physical aircraft does not await a scenario mission');
      panel.show({...physical,state_time:tick});
      assert.equal(nodes['mission-empty'].hidden,true);
    }
    panel.show(entity);panel.setMission(null);
    assert.equal(nodes['mission-empty'].hidden,true,'missing mission must not insert a transient row');
  }finally{panel.destroy();globalThis.document=saved;globalThis.requestAnimationFrame=raf;}
});

test('dashboard reuses nodes on telemetry ticks, retains folded state, and clears mission on identity change',()=>{
  const saved=globalThis.document,raf=globalThis.requestAnimationFrame;
  globalThis.document=fakeDocument;globalThis.requestAnimationFrame=callback=>callback();
  const {panel,nodes}=panelHarness();
  try{
    panel.show(entity);panel.setMission(mission);nodes['selection-data'].open=true;
    const cards=nodes['flight-readouts'].children,steps=nodes['mission-steps'].children;
    const details=nodes['selected-detail'].children;
    panel.show({...entity,altitude_m:400});panel.setMission({...mission,state:{...mission.state,on_board:3}});
    assert.equal(nodes['flight-readouts'].children,cards);assert.equal(nodes['mission-steps'].children,steps);
    assert.equal(nodes['selected-detail'].children,details);assert.equal(nodes['selection-data'].open,true);
    assert.equal(panel.readoutNodes.get('altitude').value.textContent,'400');
    assert.equal(nodes['mission-passengers'].textContent,'3 / 4명');
    assert.equal(nodes['selected-name'].textContent,'UAM7');assert.equal(nodes['mission-percent'].textContent,'42%');
    assert.equal(nodes['mission-steps'].children[3].getAttribute('aria-current'),'step');
    panel.show({...entity,entity_id:'scenario:UAM8'});
    assert.equal(nodes.mission.hidden,true);assert.equal(nodes['mission-empty'].hidden,true);
    panel.setMission(mission);assert.equal(nodes.mission.hidden,true,'an old aircraft cannot populate the new selection');
    panel.show({...entity,entity_id:'aircraft:a',kind:'aircraft',orientation_source:'ground_track'});
    assert.equal(nodes['mission-empty'].hidden,true);assert.equal(nodes['selected-attitude'].hidden,true);
    panel.show(null);assert.equal(nodes.selection.inert,true);assert.equal(nodes.mission.hidden,true);
  }finally{panel.destroy();globalThis.document=saved;globalThis.requestAnimationFrame=raf;}
});

test('long diagnostics and models are collapsed by default, actions and main telemetry are outside those folds',()=>{
  assert.match(html,/<details id="selection-data"[^>]*><summary>/);
  assert.doesNotMatch(html,/<details[^>]+(?:selection-data|trajectory|selection-fold)[^>]*\bopen\b/);
  assert.ok(html.indexOf('id="flight-readouts"')<html.indexOf('id="mission"'));
  assert.ok(html.indexOf('id="mission"')<html.indexOf('id="selected-detail"'));
  assert.match(html,/id="mission-steps"[^>]+aria-label="운항 단계"/);
  const css=readFileSync(new URL('selection_panel.css',web),'utf8');
  assert.match(css,/body\[data-scenario-console\] #selection\[aria-label\]\{[^}]*var\(--scenario-console-height,160px\)/);
});

test('pilot decision reuses nodes, clears on release and never leaks to another selection',()=>{
  const saved=globalThis.document;globalThis.document=fakeDocument;
  const {panel,nodes}=panelHarness();
  panel.entityId='scenario:UAM7';
  const waiting={...mission,state:{...mission.state,phase:'hold',holding:true,hold_seconds:12,
    instruction:{action:'yield',reason:'선행 기체 접근 대기',traffic_id:'UAM8'}}};
  try{
    assert.ok(nodes['mission-decision'],'decision belongs to the existing mission panel');
    panel.setMission(waiting);
    assert.equal(nodes['mission-decision'].hidden,false);
    assert.equal(nodes['mission-decision-reason'].textContent,'선행 기체 접근 대기');
    const rows=nodes['mission-decision-fields'].children;
    nodes['mission-decision-details'].open=true;
    panel.setMission({...waiting,state:{...waiting.state,hold_seconds:13}});
    assert.equal(nodes['mission-decision-fields'].children,rows);
    assert.equal(nodes['mission-decision-details'].open,true);
    panel.setMission({...mission,state:{...mission.state,phase:'descent',instruction:{clearance:'approach',clearance_reason:'접근 재개'}}});
    assert.equal(nodes['mission-decision'].dataset.level,'normal');
    assert.equal(nodes['mission-decision-reason'].textContent,'접근 재개');
    assert.doesNotMatch(nodes['mission-decision-fields'].textContent,/UAM8/);
    panel.setMission(null);assert.equal(nodes['mission-decision'].hidden,true);
    assert.equal(nodes['mission-decision-reason'].textContent,'');
    panel.entityId='scenario:UAM9';panel.setMission(waiting);
    assert.equal(nodes['mission-decision'].hidden,true);
  }finally{globalThis.document=saved;}
});

function requests(){
  const app=readFileSync(new URL('app.js',web),'utf8');
  const snippet=app.slice(app.indexOf('let missionWatch='),app.indexOf("window.addEventListener('pagehide',stopMission"));
  const pending=[],painted=[],intervals=new Map();let next=0;
  const ctx=vm.createContext({scenarioApi:{aircraft:id=>new Promise((resolve,reject)=>pending.push({id,resolve,reject}))},
    selectionPanel:{setMission:value=>painted.push(value),setSensors(){}},liveGlobe:null,
    setInterval:fn=>{intervals.set(++next,fn);return next;},clearInterval:id=>intervals.delete(id)});
  vm.runInContext(snippet+';globalThis.select=followMission;globalThis.read=readMission;globalThis.stop=stopMission;',ctx);
  return {ctx,pending,painted,intervals};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('late A responses cannot overwrite B or a new selection of A, including stale failures',async()=>{
  const {ctx,pending,painted}=requests();
  ctx.select({kind:'uam',entity_id:'A'});ctx.select({kind:'uam',entity_id:'B'});
  pending[1].resolve({state:{aircraft_id:'B'}});await flush();
  const count=painted.length;
  pending[0].resolve({state:{aircraft_id:'A'}});await flush();assert.equal(painted.length,count);
  ctx.select({kind:'uam',entity_id:'A'});ctx.select({kind:'uam',entity_id:'B'});ctx.select({kind:'uam',entity_id:'A'});
  pending[4].resolve({state:{aircraft_id:'A',fresh:true}});await flush();const last=painted.at(-1);
  pending[2].resolve({state:{aircraft_id:'A',fresh:false}});pending[3].reject(new Error('old request'));await flush();
  assert.equal(painted.at(-1),last);assert.equal(last.state.fresh,true);
});

test('only one mission request is pending per selection and a deselection stops polling',async()=>{
  const {ctx,pending,painted,intervals}=requests();
  ctx.select({kind:'uam',entity_id:'A'});void ctx.read();void ctx.read();assert.equal(pending.length,1);
  pending[0].resolve(mission);await flush();void ctx.read();assert.equal(pending.length,2);
  ctx.select(null);assert.equal(intervals.size,0);assert.equal(painted.at(-1),null);
  pending[1].resolve(mission);await flush();assert.equal(painted.at(-1),null);
  ctx.select({kind:'satellite',entity_id:'s'});assert.equal(pending.length,2);
});

test('UAM telemetry gaps keep attitude and tilt slots without showing invented zeroes',()=>{
  const saved=globalThis.document,raf=globalThis.requestAnimationFrame;
  globalThis.document=fakeDocument;globalThis.requestAnimationFrame=callback=>callback();
  const {panel,nodes}=panelHarness();
  try{
    panel.show(entity);const cards=nodes['flight-readouts'].children;
    panel.show({...entity,orientation_source:'ground_track',pitch_deg:null,roll_deg:null,tilt_deg:null});
    assert.equal(nodes['flight-readouts'].children,cards);
    assert.equal(nodes['selected-attitude'].hidden,false);
    assert.match(nodes['selected-attitude'].textContent,/Pitch —.*Roll —/);
    assert.equal(nodes['selected-tilt'].hidden,false);
    assert.equal(nodes['selected-tilt-value'].textContent,'—');
    assert.equal(nodes['selected-tilt-fill'].hidden,true);
    panel.show(entity);
    assert.equal(nodes['selected-tilt-fill'].hidden,false);
    assert.equal(nodes['selected-tilt-value'].textContent,'90°');
  }finally{panel.destroy();globalThis.document=saved;globalThis.requestAnimationFrame=raf;}
});

test('missing mission never inserts a transient notice below flight telemetry',()=>{
  const saved=globalThis.document,raf=globalThis.requestAnimationFrame;
  globalThis.document=fakeDocument;globalThis.requestAnimationFrame=callback=>callback();
  const {panel,nodes}=panelHarness();
  try{
    for(const source of ['scenario','physical_uam']){
      panel.show({...entity,entity_id:source==='scenario'?'scenario:UAM7':'physical:UAM7',source});
      panel.setMission(null);
      assert.equal(nodes['mission-empty'].hidden,true);
      panel.show({...entity,entity_id:panel.entityId,source});
      assert.equal(nodes['mission-empty'].hidden,true);
    }
  }finally{panel.destroy();globalThis.document=saved;globalThis.requestAnimationFrame=raf;}
});
