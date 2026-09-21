// Map and hover labels stay short; detailed selection retains the full name.
export function mapEntityName(entity) {
  const id=entity.entity_id || '';
  if(entity.source==='scenario' && id.startsWith('scenario:'))return id.slice('scenario:'.length);
  return entity.name || id;
}

// Use the published mission phase, never infer flight intent from speed/tilt.
const UAM_PHASES={parked:'주기',gate_out:'지상 이동 · 출발',takeoff:'이륙',climb:'상승',
  cruise:'순항',descent:'접근',hold_exit:'체공 진입',hold:'체공',hold_return:'접근 재개',
  landing:'착륙',gate_in:'지상 이동 · 도착',charge:'충전'};
export function uamPhaseName(phase,state={}) {
  if(phase==='parked'&&state.charging_connection)return state.charging_connection.state==='complete'?'충전 완료':'충전 중';
  if(['parked','gate_out','gate_in','charge'].includes(phase)){
    if(state.ground_waiting===true)return '지상 대기';
    if(state.ground_action==='ground_wait')return '지상 이동 · 감속';
  }
  return UAM_PHASES[phase]??'';
}
export function composeAircraftLabel(name,status,{labels=true,status:showStatus=true}={}) {
  return [labels?name:'',showStatus?status:''].filter(Boolean).join('\n');
}
export function mapEntityLabel(entity,options={}) {
  const name=mapEntityName(entity);
  if(entity.kind!=='uam')return options.labels===false?'':name;
  return composeAircraftLabel(name,uamPhaseName(entity.flight_phase,entity),options);
}
