// Read-only projection of received instructions. Low speed is NOT evidence of
// a hold, heading alignment or rotor settling; never infer those from telemetry.
const AIR_PHASES=new Set(['takeoff','climb','cruise','descent','hold_exit','hold','hold_return','landing']);
const GROUND_PHASES=new Set(['parked','gate_out','gate_in','charge']);
const PHASES={parked:'주기 중',gate_out:'출발 지상 이동',takeoff:'이륙 중',climb:'상승 중',
  cruise:'순항 중',descent:'접근 중',hold_exit:'체공 진입',hold:'체공 대기',hold_return:'접근 재개',
  landing:'착륙 중',gate_in:'도착 지상 이동',charge:'충전 중'};
const ACTIONS={yield:'교통 대기',wait_clear:'분리 확인 대기',avoid_right:'우측 회피',slow:'속도 조정',monitor:'근접 주시',recover:'교통 해소 확인'};
const CLEARANCES={hold:'체공 대기',approach:'접근 허가',land:'최종 착륙'};
const GUIDANCE={
  route_tracking:['경로 추종','지정된 경로를 따라 비행하고 있습니다.'],
  clearance_hold:['허가 대기 유도','받은 대기 지시에 따라 비행을 유도하고 있습니다.'],
  reverse_transition:['멀티로터 복귀','접근을 위해 멀티로터 모드로 복귀하고 있습니다.'],
  approach_altitude_adjustment:['접근 고도 조절','접근 경로의 목표 고도를 맞추고 있습니다.'],
  approach_path_capture:['접근 경로 포착','다음 접근 구간에 맞춰 경로를 포착하고 있습니다.'],
  final_alignment:['최종 기수 정렬','착륙 지점에서 최종 기수 방향을 맞추고 있습니다.'],
  vertical_landing:['수직 착륙','착륙 지점에서 수직으로 내려가고 있습니다.'],
  departure_alignment:['출발 기수 정렬','이륙 전 출발 기수 방향을 맞추고 있습니다.'],
  takeoff:['이륙 유도','설정된 이륙 목표를 따라 상승하고 있습니다.'],
  complete:['유도 완료','조종사의 경로 유도가 완료되었습니다.'],
};
const finite=value=>Number.isFinite(value)&&value>=0;
const words=value=>typeof value==='string'?value.trim():'';
const decimal=value=>value.toLocaleString('ko-KR',{maximumFractionDigits:1});
const clock=value=>[Math.floor(value/3600)%24,Math.floor(value/60)%60,Math.floor(value)%60]
  .map(part=>String(part).padStart(2,'0')).join(':');

export function describePilotDecision(detail) {
  const state=detail?.state;if(!state)return null;
  const airborne=AIR_PHASES.has(state.phase);
  // Ground/turnaround records may retain the last airborne instruction. It is
  // history, not a current command to land or yield at the stand.
  const ground=GROUND_PHASES.has(state.phase);
  const departureWait=state.phase==='parked'&&state.instruction?.action==='departure_wait';
  const groundInstruction=ground&&['ground_wait','ground_taxi'].includes(state.instruction?.action);
  const instruction=airborne&&state.phase!=='hold_return'||groundInstruction||departureWait?(state.instruction??{}):{};
  const guidance=airborne&&state.guidance?.available===true&&Object.hasOwn(GUIDANCE,state.guidance.reason)
    ?GUIDANCE[state.guidance.reason]:null;
  const c=detail.clearance??state.clearance;
  const clearance=airborne&&c&&!finite(c.released_s)?c:null;
  const holding=airborne&&state.phase!=='hold_return'&&(state.holding===true||['hold','hold_exit'].includes(state.phase)||instruction.clearance==='hold');
  let title=PHASES[state.phase]??'판단 정보 없음',reason='상세 사유 미제공',source='운항 단계';
  let waiting=holding,level=holding?'waiting':PHASES[state.phase]?'normal':'unknown';
  if(departureWait){
    title='출발 대기';reason=words(instruction.reason)||reason;
    source=finite(instruction.entry_s)?'PSU':'운항 일정';waiting=true;level='waiting';
  }else if(groundInstruction||ground&&state.ground_waiting===true){
    waiting=state.ground_waiting===true;
    title=waiting?'지상 대기':instruction.action==='ground_taxi'?'지상 이동 허가':'지상 이동 · 감속';
    reason=words(instruction.reason)||reason;source='버티포트 지상 통제';
    level=waiting?'waiting':instruction.action==='ground_wait'?'caution':'normal';
  }else if(['yield','wait_clear'].includes(instruction.action)){
    title=ACTIONS[instruction.action];reason=words(instruction.reason)||reason;source='조종사 · 교통';
    waiting=true;level='waiting';
  }else if(holding){
    title=state.phase==='hold_exit'?PHASES.hold_exit:CLEARANCES.hold;
    reason=words(instruction.clearance_reason)||words(clearance?.reason)||reason;
    source=instruction.clearance==='hold'||clearance?'PSU':'진단 미제공';
  }else if(ACTIONS[instruction.action]){
    title=ACTIONS[instruction.action];reason=words(instruction.reason)||reason;
    source='조종사 · 교통';level='caution';
  }else if(guidance){
    [title,reason]=guidance;source='실제 조종사 유도';
  }else if(CLEARANCES[instruction.clearance]){
    title=CLEARANCES[instruction.clearance];reason=words(instruction.clearance_reason)||reason;source='PSU';
  }
  const fields=[];
  const add=(key,label,value)=>fields.push({key,label,value});
  if(airborne&&CLEARANCES[instruction.clearance])add('clearance','PSU 지시',
    [CLEARANCES[instruction.clearance],words(instruction.clearance_reason)].filter(Boolean).join(' · '));
  if(ACTIONS[instruction.action]&&words(instruction.reason)&&source==='PSU')add('traffic','교통 대응',instruction.reason);
  if(airborne&&words(instruction.traffic_id)){
    add('traffic_id','관련 기체',instruction.traffic_id);
    if(finite(instruction.cpa_s))add('cpa','예측 최근접까지',`${decimal(instruction.cpa_s)}초`);
    if(finite(instruction.miss_m))add('miss','예측 수평 간격',`${decimal(instruction.miss_m)} m`);
  }
  if(airborne&&finite(state.hold_seconds)&&state.hold_seconds>0)add('hold',
    state.engine==='kinematic-rehearsal'?'배정 체공 시간':'이번 비행 누적 체공',`${decimal(state.hold_seconds)}초`);
  if(groundInstruction){
    const blockers=Array.isArray(instruction.blocked_by)?[...new Set(instruction.blocked_by.map(words).filter(Boolean))]:[];
    if(blockers.length)add('blocked_by','통과 대기 기체',blockers.join(', '));
    if(finite(instruction.wait_seconds)&&instruction.wait_seconds>0)add('ground_wait','누적 지상 대기',`${decimal(instruction.wait_seconds)}초`);
    for(const [key,label] of [['distance_m','현재 위치 (경로 기준)'],['stop_distance_m','허가 종점 (경로 기준)']]){
      if(finite(instruction[key]))add(key,label,`${decimal(instruction[key])} m`);
    }
    if(words(instruction.route_id))add('route_id','지상 경로',instruction.route_id);
    if(finite(instruction.updated_s))add('updated_s','지상 지시 시각',clock(instruction.updated_s));
  }
  const assignment=state.gate_assignment??(c&&!finite(c.released_s)?{
    planned_stand:c.planned_stand,assigned_stand:c.stand,revision:c.gate_revision,reason:c.gate_reason}:null);
  if(assignment){
    if(words(assignment.planned_stand))add('planned_stand','계획 Gate',assignment.planned_stand);
    if(words(assignment.assigned_stand)||state.gate_assignment)add('assigned_stand','배정 Gate',words(assignment.assigned_stand)||'미확보');
    if(Number.isInteger(assignment.revision)&&assignment.revision>=0)add('gate_revision','Gate 배정 변경 번호',String(assignment.revision));
    if(words(assignment.reason))add('gate_reason','Gate 배정 사유',assignment.reason);
  }
  if(guidance)add('guidance','실제 조종사 유도',guidance[0]);
  if(clearance){
    if(finite(clearance.sequence)&&clearance.sequence>0)add('sequence','착륙 순번',`${clearance.sequence}번`);
    for(const [key,label] of [['approach_s','접근 배정 시각'],['eta_s','예측 도착 시각'],['cleared_s','착륙 슬롯 시각']]){
      if(finite(clearance[key]))add(key,label,clock(clearance[key]));
    }
  }
  if(state.pilot_failed){title='조종사 실행 오류';reason='조종사 실행이 실패했습니다. 상태 확인이 필요합니다.';source='실행 진단';level='error';waiting=false;}
  return {title,reason,source,level,waiting,fields};
}
