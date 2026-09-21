import {waitingReport} from './console_stream.js';
const $=id=>document.getElementById(id),el=(tag,value)=>{const e=document.createElement(tag);e.textContent=value;return e;};
const phase={parked:'주기',gate_out:'출발 지상',takeoff:'이륙',climb:'상승',cruise:'순항',descent:'접근',landing:'착륙',gate_in:'도착 지상',charge:'회항 준비',hold:'공중 대기',hold_exit:'대기 진입',hold_return:'접근 복귀'};
const statusNames={preparing:'시작 지점 계산 중',waiting:'첫 운항 대기',running:'전체 운항 중',paused:'전체 일시정지',stopped:'전체 중지 · 마지막 상태',error:'운항 오류',landed:'전체 일정 완료'};
let selected='',positions=[];
export const selectedAircraft=()=>selected;
export const fleetPositions=()=>positions;
export function mountFleet(){
  let latest={};
  function select(value){selected=value;$('sensor-aircraft').value=value;window.dispatchEvent(new CustomEvent('physical-aircraft-selected'));}
  $('sensor-aircraft').onchange=()=>select($('sensor-aircraft').value);
  function render(){
    const query=$('fleet-search').value.trim().toLowerCase();
    $('fleet-aircraft').replaceChildren(...(latest.aircraft||[]).filter(a=>[a.aircraft_id,a.origin,a.destination,a.flight_id,a.phase].join(' ').toLowerCase().includes(query)).map(a=>{
      const row=el('tr','');row.dataset.failed=String(a.pilot_failed);const cell=el('td','');const button=el('button',a.aircraft_id);button.onclick=()=>{select(a.aircraft_id);document.querySelector('[data-tab=telemetry]').click();};cell.append(button,el('small',a.flight_id||'다음 편 대기'));
      const instruction=a.instruction||{},clearance=a.clearance;const note=instruction.message||instruction.clearance_reason||instruction.reason||({parked:'다음 편 대기',gate_out:'출발 준비 · FATO 이동',gate_in:'착륙 후 주기장 이동',charge:'회항 준비'}[a.phase])||instruction.label||instruction.action||clearance?.reason||'—';
      row.append(cell,el('td',`${a.origin||a.vertiport||'—'} → ${a.destination||'—'}`),el('td',a.pilot_failed?'조종사 오류':phase[a.phase]||a.phase),el('td',`${clearance?.sequence?'#'+clearance.sequence+' · ':''}${note}`),el('td',`${a.altitude_m.toFixed(0)} m / ${a.speed_mps.toFixed(1)} m/s`));return row;
    }));
  }
  $('fleet-search').oninput=render;
  async function refresh(){
    try{
      const r=await fetch('/api/v1/console/operations',{cache:'no-store',signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error();latest=await r.json();positions=latest.aircraft||[];
      if(latest.scope!=='fleet'){
        if(selected)select('');$('sensor-aircraft').replaceChildren(el('option','현재 단일 기체'));$('sensor-aircraft').firstChild.value='';
        $('fleet-summary').textContent='전체 운항 모드로 Play를 시작하면 PSU·버티포트·기체별 실행 현황이 표시됩니다.';return;
      }
      const summary=latest.summary;
      const waits=waitingReport(positions,latest.vertiports),diagnostics=$('fleet-wait-diagnostics');
      if(diagnostics){
        diagnostics.replaceChildren(el('p',`공중 대기 ${waits.holding}대 / 지상 ${waits.ground}대 · 기체별 누적 대기 최대 ${Math.floor(waits.longest_s/60)}분`),
          el('p',waits.reasons.map(([name,count])=>`${name} ${count}대`).join(' · ')||'현재 공중 대기 없음'),
          el('p',waits.destinations.slice(0,3).map(([name,count])=>`${name} ${count}대`).join(' · ')));
        if(waits.cycles.length)diagnostics.append(el('p',`상호 대기 관계 확인 필요: ${waits.cycles.join(' / ')}`));
      }
      $('fleet-summary').textContent=`${summary.aircraft}기체 · ${summary.flights}편 / 비행 ${summary.airborne} · 지상 ${summary.aircraft-summary.airborne} · 공중 대기 ${summary.holding} / 완료 ${summary.flights_completed}편 · 취소 ${summary.cancelled}편`;
      $('fleet-health').textContent=`${statusNames[latest.status]||latest.status} · `+(summary.pilot_failures?`조종사 오류 ${summary.pilot_failures}건`:`실효 ${(latest.real_time_factor||0).toFixed(2)}× · PSU 요청 ${summary.psu.requests}건`);
      const ids=positions.map(a=>a.aircraft_id);if([...$('sensor-aircraft').options].map(o=>o.value).join()!==ids.join()){
        $('sensor-aircraft').replaceChildren(...positions.map(a=>{const o=el('option',a.aircraft_id);o.value=a.aircraft_id;return o;}));
        select(ids.includes(selected)?selected:ids[0]||'');
      }
      $('fleet-ports').replaceChildren(...(latest.vertiports||[]).map(p=>{const box=el('div','');box.className='fleet-port';box.append(el('strong',p.name),el('span',`지상 ${p.ground} · 접근 ${p.inbound}`),el('small',`점유 주기장 ${Object.keys(p.stands).length} · 점유 FATO ${p.pads.map(x=>x.id).join(', ')||'없음'} · 공중 대기 ${p.holding}`));return box;}));
      $('fleet-events').replaceChildren(...[...(latest.events||[])].reverse().map(e=>{const row=el('div','');row.className='fleet-event';const seconds=e.time_s??e.t??0;row.append(el('span',new Date(seconds*1000).toISOString().slice(11,19)),el('span',e.aircraft_id||e.flight_id||'PSU'),el('span',`${e.kind} · ${e.reason||e.outcome||e.node||''}`));return row;}));
      render();
    }catch{$('fleet-health').textContent='운항 현황 갱신 대기';}finally{setTimeout(refresh,1000);}
  }
  refresh();
}
