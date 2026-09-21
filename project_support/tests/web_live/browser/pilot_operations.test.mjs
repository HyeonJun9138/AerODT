import test from 'node:test';
import assert from 'node:assert/strict';
import {FakeElement,fakeDocument} from './fake_dom.mjs';
import {PilotOperations} from '../../../../user_application/web/domains/uam/operations/pilot_operations.js';

test('pilot reads the real clearance and does not display a pending ETA as landing permission',async()=>{
 const view=new PilotOperations({document:fakeDocument,api:async()=>({loaded:true,state:'playing',clock:'06:40:00',
  aircraft:[{aircraft_id:'A',flight_id:'F1',origin:'V1',destination:'V2',phase:'descent',speed_mps:10,altitude_m:100,
   clearance:{sequence:2,eta_s:24000,cleared_s:24090},instruction:{clearance:'approach',clearance_reason:'예측 접근 허가',
    action:'avoid_right',traffic_id:'B',cpa_s:20,miss_m:30,right_m:25}}]})});
 const body=new FakeElement('div');view.render(body);await Promise.resolve();await Promise.resolve();
 assert.match(body.textContent,/접근 시작/);assert.match(body.textContent,/B.*최근접/);
 assert.doesNotMatch(body.textContent,/최종 착륙 허가/);view.stop();
});

test('closing then reopening ignores the previous request and clears stale connection data',async()=>{
 let resolve;const old=new Promise(r=>resolve=r);let n=0;
 const view=new PilotOperations({document:fakeDocument,api:()=>++n===1?old:Promise.resolve({aircraft:[],clock:'07:00:00'})});
 const a=new FakeElement('div'),b=new FakeElement('div');view.render(a);view.stop();view.render(b);
 await Promise.resolve();await Promise.resolve();resolve({aircraft:[],clock:'06:00:00'});await Promise.resolve();await Promise.resolve();
 assert.match(b.textContent,/07:00/);assert.doesNotMatch(b.textContent,/06:00/);view.stop();
});

test('temporary request failure does not change the observed aircraft after recovery',async()=>{
 let fail=false;const view=new PilotOperations({document:fakeDocument,api:async()=>{
  if(fail)throw new Error('offline');return {aircraft:[{aircraft_id:'A'},{aircraft_id:'B'}]};
 }});
 const body=new FakeElement('div');view.render(body);await Promise.resolve();await Promise.resolve();
 view.selected='B';view.paint();fail=true;await view.read(view.generation);assert.equal(view.selected,'B');
 fail=false;await view.read(view.generation);assert.equal(body.querySelector('select').value,'B');view.stop();
});

const groundRow=()=>({aircraft_id:'UAM70',flight_id:'FPL70',origin:'VP1',destination:'VP2',
 phase:'gate_in',airborne:false,speed_mps:0,altitude_m:10,hold_seconds:97,ground_waiting:true,
 instruction:{action:'ground_wait',reason:'도착 기체 통과 대기',blocked_by:['UAM80'],
   wait_seconds:8,distance_m:25,stop_distance_m:27.5,updated_s:24000,clearance:'hold',clearance_reason:'이전 체공 허가'},
 clearance:{sequence:2,stand:'G4',reason:'이전 착륙 허가'},
 gate_assignment:{planned_stand:'G1',assigned_stand:'G4',revision:1,reason:'계획 Gate 실제 점유'},
 guidance:{available:true,reason:'vertical_landing'}});
const load=async row=>{
 const view=new PilotOperations({document:fakeDocument,api:async()=>({state:'playing',clock:'06:40:00',aircraft:[row]})});
 const body=new FakeElement('div');view.render(body);await Promise.resolve();await Promise.resolve();return {view,body};
};

test('pilot ground instruction shows actual waiting, blocker and reassigned gate instead of unconditional taxi',async()=>{
 const row=groundRow(),before=structuredClone(row),{view,body}=await load(row);
 try{
  const current=body.querySelector('.po-clearance');
  assert.equal(current.querySelector('strong').textContent,'지상 대기');
  assert.match(current.textContent,/도착 기체 통과 대기/);assert.match(current.textContent,/UAM80/);
  assert.match(current.textContent,/계획 Gate.*G1/);assert.match(current.textContent,/배정 Gate.*G4/);
  assert.match(current.textContent,/계획 Gate 실제 점유/);assert.match(current.textContent,/27\.5 m/);
  assert.doesNotMatch(body.textContent,/주기장으로 이동|이전 체공|이전 착륙|수직 착륙|체공97/);
  assert.deepEqual(row,before);
 }finally{view.stop();}
});

test('pilot distinguishes a restricted moving aircraft and a resumed taxi without estimating from speed',async()=>{
 const row={...groundRow(),ground_waiting:false,speed_mps:0},{view,body}=await load(row);
 try{
  assert.equal(body.querySelector('.po-clearance').querySelector('strong').textContent,'지상 이동 · 감속');
  row.instruction={action:'ground_taxi',reason:'지상 이동 허가'};view.paint();
  assert.equal(body.querySelector('.po-clearance').querySelector('strong').textContent,'지상 이동 허가');
  assert.doesNotMatch(body.textContent,/UAM80/);
 }finally{view.stop();}
});

test('pilot retains PSU approach and landing permissions while actual traffic wait outranks native guidance',async()=>{
 const row={aircraft_id:'UAM70',flight_id:'FPL70',phase:'descent',airborne:true,
  instruction:{clearance:'approach',clearance_reason:'PSU 접근 허가'},
  guidance:{available:true,reason:'approach_altitude_adjustment'}},{view,body}=await load(row);
 try{
  assert.match(body.textContent,/접근 고도 조절/);assert.match(body.textContent,/접근 시작/);
  row.instruction={clearance:'approach',clearance_reason:'PSU 접근 허가',action:'wait_clear',reason:'선행기 실제 분리 확인',traffic_id:'UAM80'};view.paint();
  assert.equal(body.querySelector('.po-clearance').querySelector('strong').textContent,'분리 확인 대기');
  assert.match(body.querySelector('.po-clearance').textContent,/선행기 실제 분리 확인/);
  assert.match(body.textContent,/접근 고도 조절/);assert.match(body.textContent,/UAM80/);
  row.phase='landing';row.instruction={clearance:'land',clearance_reason:'PSU 최종 허가'};
  row.guidance={available:true,reason:'final_alignment'};view.paint();
  assert.match(body.textContent,/최종 착륙/);assert.match(body.textContent,/PSU 최종 허가/);
 }finally{view.stop();}
});

test('pilot summary reuses the existing read and shows ground facts while unavailable guidance stays explicit',async()=>{
 let reads=0;const row=groundRow(),view=new PilotOperations({document:fakeDocument,
  api:async()=>{reads++;return {aircraft:[row]};}});
 const full=new FakeElement('div'),summary=new FakeElement('div');view.mount(full);const timer=view.timer;
 view.mount(summary,{summary:true});await Promise.resolve();await Promise.resolve();
 try{
  assert.equal(reads,1);assert.equal(view.timer,timer);
  assert.match(summary.textContent,/지상 대기/);assert.match(summary.textContent,/UAM80/);
  assert.match(summary.textContent,/계획 Gate.*G1/);assert.match(summary.textContent,/배정 Gate.*G4/);
  row.phase='descent';row.ground_waiting=false;row.instruction={};row.guidance={available:false,reason:'approach_altitude_adjustment'};view.paint();
  assert.match(summary.textContent,/상세 사유 미제공/);
  assert.doesNotMatch(summary.textContent,/접근 고도 조절|기수 정렬|역천이 안정화/);
 }finally{view.stop();}
});
