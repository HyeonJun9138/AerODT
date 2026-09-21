import test from 'node:test';
import assert from 'node:assert/strict';
import {FakeElement,fakeDocument} from './fake_dom.mjs';
import {paintPhysicalSensors} from '../../../../user_application/web/domains/uam/live_twinning/physical_uam_panel.js';

const detail=(phase,operations)=>({sequence:70,flight_id:'FPL70',mission_id:'M70',
  route:{origin:'VP1',destination:'VP2'},transport_latency_s:0.02,clock_offset_s:0,
  clock_uncertainty_s:0.001,estimator:'sensor-observation',server_time:100,report_hz:10,
  sensors:{vehicle:{sample_time:100,nominal_hz:10,sequence:70,uncertainty:{},
    values:{flight_phase:phase,tilt_deg:0,rotor_radps:0,grounded:['gate_in','gate_out'].includes(phase)}}},operations});
const paint=value=>{
  const previous=globalThis.document;globalThis.document=fakeDocument;
  const host=new FakeElement('section');
  try{paintPhysicalSensors(host,value);return host;}finally{globalThis.document=previous;}
};

test('buffered map timing is disclosed separately from sensor transport and current estimation',()=>{
  const value={...detail('cruise',null),display_mode:'buffered_observations',display_timing:{age_s:1.234},
    latency_breakdown:{sender_age_s:.1,transport_s:.2,receiver_age_s:.3}};
  const before=structuredClone(value),host=paint(value);
  assert.match(host.textContent,/지도 표시 1\.23초 전 관측/);
  assert.match(host.textContent,/관측→송신 0\.10s · 전송 0\.20s · 수신 후 0\.30s/);
  assert.deepEqual(value,before);
});

test('Physical detail shows the actual native guidance and distinguishes the planned and assigned gate',()=>{
  const value=detail('descent',{instruction:{clearance:'approach',clearance_reason:'PSU 접근 허가'},
    clearance:{sequence:2,stand:'G3'},ground_waiting:false,state_source:'native-airborne',
    guidance:{available:true,reason:'approach_altitude_adjustment',waypoint_index:4,landing_yaw_mutable:true},
    gate_assignment:{planned_stand:'G1',assigned_stand:'G4',revision:2,reason:'계획 Gate 실제 점유'}});
  const before=structuredClone(value),host=paint(value);
  assert.match(host.textContent,/접근 고도 조절/);assert.match(host.textContent,/FPL70/);
  assert.match(host.textContent,/계획 Gate.*G1/);assert.match(host.textContent,/배정 Gate.*G4/);
  assert.match(host.textContent,/계획 Gate 실제 점유/);assert.doesNotMatch(host.textContent,/G3/);
  assert.match(host.textContent,/10 Hz/);assert.deepEqual(value,before);
});

test('Physical ground detail reports the received blocker instead of old airborne permission',()=>{
  const operations={instruction:{action:'ground_wait',reason:'도착 기체 통과 대기',blocked_by:['UAM0080'],
    distance_m:25,stop_distance_m:27.5,wait_seconds:8,updated_s:100,clearance:'hold',clearance_reason:'이전 체공 대기'},
    clearance:{reason:'이전 착륙 허가'},ground_waiting:true,
    guidance:{available:true,reason:'vertical_landing'},state_source:'shared-kinematic-ground',
    gate_assignment:{planned_stand:'G1',assigned_stand:'G4',revision:1,reason:'계획 Gate 점유'}};
  const host=paint(detail('gate_in',operations));
  assert.match(host.textContent,/지상 대기/);assert.match(host.textContent,/도착 기체 통과 대기/);
  assert.match(host.textContent,/UAM0080/);assert.match(host.textContent,/27\.5 m/);assert.match(host.textContent,/8초/);
  assert.doesNotMatch(host.textContent,/이전 체공|이전 착륙|수직 착륙/);
  const braking=paint(detail('gate_in',{...operations,ground_waiting:false}));
  assert.match(braking.textContent,/지상 이동 · 감속/);
});

test('Physical unavailable native guidance does not invent a cause from a stopped vehicle report',()=>{
  const host=paint(detail('descent',{instruction:{},guidance:{available:false,reason:'approach_altitude_adjustment'},
    gate_assignment:{planned_stand:'G1',assigned_stand:null,revision:0,reason:'가용 Gate 없음'}}));
  assert.doesNotMatch(host.textContent,/접근 고도 조절|기수 정렬|역천이 안정화/);
  assert.match(host.textContent,/상세 사유 미제공/);assert.match(host.textContent,/배정 Gate.*미확보/);
});

test('Physical actual traffic wait stays ahead of generic clearance and native approach guidance',()=>{
  const host=paint(detail('descent',{instruction:{action:'wait_clear',reason:'선행기 실제 분리 확인',
    clearance:'approach',clearance_reason:'일반 접근 허가'},guidance:{available:true,reason:'approach_altitude_adjustment'}}));
  assert.match(host.textContent,/분리 확인 대기/);assert.match(host.textContent,/선행기 실제 분리 확인/);
  assert.match(host.textContent,/접근 고도 조절/);
});

test('Physical sensor rendering retains legacy packets without operations and hides missing detail',()=>{
  const host=paint(detail('cruise',undefined));
  assert.match(host.textContent,/Physical 센서 관측/);assert.match(host.textContent,/순항/);
  assert.equal(host.querySelectorAll('.physical-operations').length,0);
  assert.equal(paint(null).hidden,true);
});
