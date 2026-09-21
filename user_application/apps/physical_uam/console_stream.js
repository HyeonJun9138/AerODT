// Cursor state is display transport only, never a second aircraft simulator.
export function receiveBatch(previous,batch){
  const state=previous.process===batch.process_id?previous:{process:batch.process_id,sequence:0,packet:null};
  const packet=batch.packets?.at(-1);
  return packet && packet.sequence>state.sequence && packet.process_id===state.process
    ? {process:state.process,sequence:packet.sequence,packet}:state;
}
export function sensorRows(packet,now){
  return Object.entries(packet?.sensors??{}).map(([id,sensor])=>({id,...sensor,age:Math.max(0,now-sensor.sample_time)}));
}

export function fleetStateText(summary={}) {
  return `공중 ${summary.airborne??0}대 · 그중 대기 ${summary.holding??0}대`;
}

export function waitingReport(rows=[],ports=[]) {
  const held=rows.filter(a=>a.airborne&&a.holding),reasons=new Map(),destinations=new Map();
  for(const a of held){
    const reason=a.instruction?.clearance_reason||a.instruction?.reason||a.clearance?.reason||'사유 미수신';
    const category=reason.includes('주기장')?'주기장 확보':reason.includes('출구')?'착륙 출구 확보':reason.includes('교통')||reason.includes('분리')?'공중 교통 분리':reason.includes('패드')?'FATO 점유':reason.includes('슬롯')||reason.includes('선행')?'착륙 순서':reason;
    reasons.set(category,(reasons.get(category)||0)+1);
    destinations.set(a.destination,(destinations.get(a.destination)||0)+1);
  }
  const byId=new Map(rows.map(a=>[a.aircraft_id,a])),cycles=new Set();
  for(const a of held){
    const path=[],seen=new Set();let current=a;
    while(current&&current.holding&&['yield','wait_clear'].includes(current.instruction?.action)){
      if(seen.has(current.aircraft_id)){
        const cycle=path.slice(path.indexOf(current.aircraft_id)).sort();
        if(cycle.length>1)cycles.add(cycle.join(' ↔ '));break;
      }
      seen.add(current.aircraft_id);path.push(current.aircraft_id);current=byId.get(current.instruction.traffic_id);
    }
  }
  const sorted=map=>[...map].sort((a,b)=>b[1]-a[1]||String(a[0]).localeCompare(String(b[0])));
  return {holding:held.length,ground:rows.filter(a=>!a.airborne).length,
    longest_s:Math.max(0,...held.map(a=>Number(a.hold_seconds)||0)),
    reasons:sorted(reasons),destinations:sorted(destinations).map(([id,count])=>[ports.find(p=>p.id===id)?.name||id,count]),
    cycles:[...cycles].sort()};
}
