import test from 'node:test';
import assert from 'node:assert/strict';
import * as details from '../../../../user_application/web/entity_details.js';

const flight={state:{aircraft_id:'UAM57',flight_id:'F1',phase:'descent',airborne:true,
  holding:false,speed_mps:1,hold_seconds:0,instruction:{}},clearance:null};
const describe=value=>{
  assert.equal(typeof details.describePilotDecision,'function','selection needs an authoritative decision projection');
  return details.describePilotDecision(value);
};
const text=view=>JSON.stringify(view);

test('PSU blocker cause reaches the mission and pilot cards without losing the bay context',()=>{
  const reason='UAM0003 (VP001 F1) 이륙 경로와 접근 경로 분리 대기 · PSU VP001 R3-H1 · 지정 위치 대기';
  const detail={...flight,state:{...flight.state,phase:'hold',holding:true,
    instruction:{clearance:'hold',clearance_reason:reason}},clearance:{reason:'예측 접근 가능',sequence:1}};
  const view=describe(detail);
  assert.equal(view.reason,reason);assert.equal(view.source,'PSU');
  assert.match(text(details.describeMissionOverview(detail)),/UAM0003/);
  assert.match(text(view),/VP001 F1/);assert.match(text(view),/R3-H1/);
  assert.doesNotMatch(view.reason,/예측 접근 가능/);
});

test('separation confirmation uses the actual pilot reason ahead of a generic PSU slot',()=>{
  const view=describe({...flight,state:{...flight.state,phase:'hold',holding:true,
    instruction:{action:'wait_clear',reason:'후속기 분리 이동 확인',clearance:'hold',clearance_reason:'예측 슬롯 대기'}}});
  assert.equal(view.title,'분리 확인 대기');assert.equal(view.waiting,true);
  assert.equal(view.reason,'후속기 분리 이동 확인');
});

test('a slow approach never invents a hold or a stabilization reason',()=>{
  const view=describe(flight);
  assert.equal(view.waiting,false);assert.match(view.title,/접근/);
  assert.match(view.reason,/상세 사유 미제공/);
  assert.doesNotMatch(text(view),/패드 점유|기수 정렬|역천이 안정화/);
});
test('traffic yield takes priority over a generic PSU slot reply',()=>{
  const view=describe({...flight,state:{...flight.state,phase:'hold',holding:true,hold_seconds:21,
    instruction:{action:'yield',reason:'접근 전방 교통 · 감속 대기',traffic_id:'UAM45',
      cpa_s:0,miss_m:35,clearance:'hold',clearance_reason:'착륙 순서 배정'}},
    clearance:{sequence:2,approach_s:23400,cleared_s:23490}});
  assert.equal(view.waiting,true);assert.equal(view.reason,'접근 전방 교통 · 감속 대기');
  assert.match(view.source,/조종사/);assert.match(text(view),/UAM45/);
  assert.match(text(view),/누적 체공/);assert.match(text(view),/21초/);
  assert.match(text(view),/06:31:30/);assert.match(text(view),/0초/);
});
test('current hold instruction is preferred over old clearance reason',()=>{
  const view=describe({...flight,state:{...flight.state,holding:true,phase:'hold',
    instruction:{clearance:'hold',clearance_reason:'최종 패드 점유 확인'}},
    clearance:{reason:'예측 슬롯 배정'}});
  assert.equal(view.reason,'최종 패드 점유 확인');assert.equal(view.source,'PSU');
});
test('hold release clears the waiting decision instead of using the historical wait total',()=>{
  const view=describe({...flight,state:{...flight.state,hold_seconds:80,
    instruction:{clearance:'approach',clearance_reason:'예측 도착 슬롯에 맞춰 접근'}}});
  assert.equal(view.waiting,false);assert.match(view.title,/접근/);
  assert.equal(view.reason,'예측 도착 슬롯에 맞춰 접근');
  assert.doesNotMatch(view.title,/체공|대기/);
});

test('hold_return is approach resumption even when the legacy hold-family flag remains true',()=>{
  const detail={...flight,state:{...flight.state,phase:'hold_return',holding:true,hold_seconds:40},
    clearance:{reason:'이전 순번 대기',sequence:2}};
  const view=describe(detail);
  assert.equal(view.title,'접근 재개');assert.equal(view.waiting,false);
  assert.doesNotMatch(view.reason,/이전 순번 대기/);
  assert.equal(details.describeMissionOverview(detail).holding,false);
  assert.equal(details.describeMission(detail).holding,false);
});
test('empty diagnostics, ground phases and released permissions cannot masquerade as active commands',()=>{
  assert.equal(describe(null),null);
  const unknown=describe({...flight,state:{...flight.state,phase:'unrecognized',speed_mps:0}});
  assert.equal(unknown.level,'unknown');assert.equal(unknown.waiting,false);
  const ground=describe({...flight,state:{...flight.state,phase:'gate_in',airborne:false,
    instruction:{clearance:'land',action:'yield',reason:'old traffic'}},
    clearance:{released_s:0,cleared_s:23000,reason:'old permission'}});
  assert.doesNotMatch(text(ground),/old traffic|old permission|최종 착륙|06:23/);
  assert.equal(ground.waiting,false);
});
test('unexplained hold and pilot failure stay explicit; malformed numbers never render',()=>{
  const hold=describe({...flight,state:{...flight.state,phase:'hold',holding:true,
    hold_seconds:NaN,instruction:{cpa_s:Infinity,miss_m:NaN}}});
  assert.equal(hold.waiting,true);assert.match(hold.reason,/상세 사유 미제공/);
  assert.doesNotMatch(text(hold),/NaN|Infinity/);
  const failed=describe({...flight,state:{...flight.state,pilot_failed:true,
    instruction:{clearance:'approach',clearance_reason:'허가'}}});
  assert.equal(failed.level,'error');assert.match(failed.title,/오류/);
});
test('the decision distinguishes observed traffic responses without promising safe separation',()=>{
  for(const [action,title] of [['avoid_right','우측 회피'],['slow','속도 조정'],['monitor','근접 주시'],['recover','교통 해소 확인']]){
    const view=describe({...flight,state:{...flight.state,phase:'cruise',
      instruction:{action,reason:'관측 교통 대응',traffic_id:'B'}}});
    assert.equal(view.title,title);assert.equal(view.waiting,false);
    assert.equal(view.reason,'관측 교통 대응');assert.doesNotMatch(text(view),/안전 보장/);
  }
});

test('kinematic rehearsal planned waits are not reported as elapsed native holding',()=>{
  const view=describe({...flight,state:{...flight.state,engine:'kinematic-rehearsal',phase:'hold',holding:true,hold_seconds:120}});
  assert.match(text(view),/배정 체공/);assert.doesNotMatch(text(view),/누적 체공/);
});

test('ground restriction reports its actual blocker and distinguishes braking from stopped waiting',()=>{
  const state={...flight.state,phase:'gate_in',airborne:false,holding:true,hold_seconds:42,
    ground_waiting:true,instruction:{action:'ground_wait',reason:'도착 기체 통과 대기',blocked_by:['UAM0070'],
      distance_m:25,stop_distance_m:27.5,wait_seconds:8,route_id:'VP1:F1:G2',updated_s:0}};
  const before=structuredClone(state),view=describe({state});
  assert.equal(view.title,'지상 대기');assert.equal(view.waiting,true);
  assert.equal(view.reason,'도착 기체 통과 대기');assert.match(text(view),/UAM0070/);
  assert.match(text(view),/27\.5 m/);assert.match(text(view),/8초/);assert.match(text(view),/00:00:00/);
  assert.doesNotMatch(text(view),/체공|착륙 허가/);assert.deepEqual(state,before);
  const braking=describe({state:{...state,ground_waiting:false,speed_mps:2}});
  assert.equal(braking.title,'지상 이동 · 감속');assert.equal(braking.waiting,false);
  const unspecified=describe({state:{...state,ground_waiting:undefined,speed_mps:0}});
  assert.equal(unspecified.waiting,false,'zero speed cannot prove a stopped ground wait');
  const noInstruction=describe({state:{phase:'gate_in',ground_waiting:true}});
  assert.equal(noInstruction.title,'지상 대기');assert.equal(noInstruction.reason,'상세 사유 미제공');
});

test('an explicit ground taxi permission resumes movement and hides stale airborne diagnostics',()=>{
  const view=describe({state:{...flight.state,phase:'gate_out',airborne:false,ground_waiting:false,
    instruction:{action:'ground_taxi',reason:'유도로 이동 허가',clearance:'hold',clearance_reason:'이전 공중 대기'},
    guidance:{available:true,reason:'vertical_landing'}}});
  assert.equal(view.title,'지상 이동 허가');assert.equal(view.waiting,false);
  assert.equal(view.reason,'유도로 이동 허가');assert.doesNotMatch(text(view),/이전 공중 대기|수직 착륙|체공/);
  assert.equal(describe({instruction:{action:'ground_wait'}}),null);
});

test('gate reassignment preserves both the plan and assignment with its received reason',()=>{
  const view=describe({state:{...flight.state,phase:'gate_in',airborne:false,
    gate_assignment:{planned_stand:'G1',assigned_stand:'G4',revision:2,reason:'계획 Gate 실제 점유'}},
    clearance:{stand:'G2',planned_stand:'G3',gate_revision:1,gate_reason:'이전 배정'}});
  const fields=Object.fromEntries(view.fields.map(field=>[field.key,field.value]));
  assert.equal(fields.planned_stand,'G1');assert.equal(fields.assigned_stand,'G4');
  assert.equal(fields.gate_revision,'2');assert.equal(fields.gate_reason,'계획 Gate 실제 점유');
  assert.doesNotMatch(text(view),/이전 배정/);
  const fallback=describe({...flight,clearance:{planned_stand:'G5',stand:'G6',gate_revision:1,gate_reason:'가용 Gate 배정'}});
  assert.match(text(fallback),/G5/);assert.match(text(fallback),/G6/);assert.match(text(fallback),/가용 Gate 배정/);
});

test('actual native altitude adjustment is visible without overriding a traffic or PSU hold',()=>{
  const guidance={available:true,reason:'approach_altitude_adjustment',waypoint_index:4,landing_yaw_mutable:true};
  const view=describe({...flight,state:{...flight.state,guidance,
    instruction:{clearance:'approach',clearance_reason:'접근 허가'}}});
  assert.match(text(view),/접근 고도 조절/);assert.equal(view.waiting,false);
  const traffic=describe({...flight,state:{...flight.state,guidance,
    instruction:{action:'wait_clear',reason:'선행기 실제 분리 대기'}}});
  assert.equal(traffic.reason,'선행기 실제 분리 대기');assert.equal(traffic.waiting,true);
  assert.match(text(traffic),/접근 고도 조절/);
  const hold=describe({...flight,state:{...flight.state,guidance,phase:'hold',holding:true,
    instruction:{clearance:'hold',clearance_reason:'착륙 순번 대기'}}});
  assert.equal(hold.reason,'착륙 순번 대기');assert.equal(hold.waiting,true);
});

test('unavailable native diagnostics and malformed ground fields never fabricate a cause',()=>{
  const view=describe({...flight,state:{...flight.state,speed_mps:0,
    guidance:{available:false,reason:'approach_altitude_adjustment'}}});
  assert.equal(view.reason,'상세 사유 미제공');assert.doesNotMatch(text(view),/접근 고도 조절/);
  const ground=describe({state:{phase:'gate_in',ground_waiting:true,
    instruction:{action:'ground_wait',reason:'',blocked_by:[null,' B ','',4,'B'],
      distance_m:NaN,stop_distance_m:Infinity,wait_seconds:-1,updated_s:NaN}}});
  assert.equal(ground.reason,'상세 사유 미제공');assert.doesNotMatch(text(ground),/NaN|Infinity|undefined/);
  assert.equal(ground.fields.find(field=>field.key==='blocked_by')?.value,'B');
});

test('an explicitly unassigned gate is not replaced with an older clearance assignment',()=>{
  const view=describe({...flight,state:{...flight.state,
    gate_assignment:{planned_stand:'G1',assigned_stand:null,revision:0,reason:'가용 Gate 없음'}},
    clearance:{stand:'G2',planned_stand:'G1'}});
  assert.equal(view.fields.find(field=>field.key==='assigned_stand')?.value,'미확보');
  assert.match(text(view),/가용 Gate 없음/);assert.doesNotMatch(text(view),/G2/);
});


test('parked PSU admission wait exposes the destination pad reason',()=>{
 const result=describe({state:{phase:'parked',airborne:false,instruction:{action:'departure_wait',entry_s:100,
   reason:'도착 VP2 / F4 진입 순서 대기 (주기장 유지)'}}});
 assert.equal(result.reason,'도착 VP2 / F4 진입 순서 대기 (주기장 유지)');
 assert.equal(result.source,'PSU');
 assert.equal(result.waiting,true);
});
