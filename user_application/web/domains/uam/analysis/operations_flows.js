import {rankingChart,value,minutes,clock} from './operations_charts.js';

const BASE='/api/simulation/analysis';
const ROLE={both:'이착륙 공용',takeoff:'이륙 전용',landing:'착륙 전용',unknown:'기록 없음'};
const OUTCOME={selected:'배정',hold:'대기',holding:'슬롯 대기',granted:'허가',released:'해제',refused:'거절'};
const NODE={allocate:'FATO 배정',terminal_departure:'이륙 경로',terminal_arrival:'접근 경로',slot_arrival:'도착 슬롯',slot_departure:'출발 슬롯',departure_slot:'공용 패드 간격'};
const IO={cancelled:'중단',request_started:'요청 시작',received:'수신 완료',accepted_by_data:'저장 접수',failed:'실패',not_modified:'변경 없음',local_response_sent:'로컬 응답 전송',local_send_batch:'로컬 상태 전송',transport_failed:'전송 실패',transport_closed_or_failed:'연결 종료·실패',closed:'연결 종료'};
const KIND={source_cancelled:'수집 중단',source_request:'외부 자료 요청',source_received:'외부 자료 수신',source_registered:'Data 저장 접수',source_error:'수집 오류',source_unchanged:'자료 변경 없음',http_request:'운영 요청 수신',http_result:'운영 응답 전송',stream_delivery:'화면 상태 전송',rehearsal_request:'운영 연습 요청',rehearsal_decision:'운영 연습 판단'};

export function renderFatos(view){
  const rows=view.report.fatos||[];
  const label=p=>`${view.portName(p.vertiport)} · ${p.fato}`;
  view.content.append(view.card('FATO별 진입 대기','출발 또는 접근 경로 허가를 기다린 누적 기체 시간입니다. 공중 대기와 중복될 수 있습니다.',
    rankingChart(view.doc,[...rows].sort((a,b)=>b.terminal_wait_s-a.terminal_wait_s),{
      label,metric:p=>p.terminal_wait_s,format:minutes,limit:12,onPick:p=>view.drill({vertiport:p.vertiport,fato:p.fato})})),
    view.card('공용·다중 FATO 운항 결과','이륙은 native 이륙 개시, 착륙은 접지 이벤트 기준입니다. 과거 기록에 없는 실제 이륙은 추정하지 않습니다.',
      view.table(['버티포트 / FATO','용도','계획 출발 / 도착','배정 출발 / 도착','관측 이륙 / 착륙','진입 대기','경로 보호 시간'],rows.map(p=>[
        view.button(label(p),()=>view.drill({vertiport:p.vertiport,fato:p.fato}),{class:'oa-text-button'}),ROLE[p.role]||p.role,
        `${value(p.planned_departures)} / ${value(p.planned_arrivals)}`,`${value(p.assigned_departures)} / ${value(p.assigned_arrivals)}`,
        `${value(p.takeoffs)} / ${value(p.landings)}`,minutes(p.terminal_wait_s),minutes(p.protected_s)]))),
    view.note('보호 시간은 패드 점유율이 아닙니다. 같은 FATO의 연속 접근은 허용된 간격을 유지하고, 다른 FATO와 경로가 겹치면 실제 구간 이탈까지 대기합니다.'));
}

export function renderFlows(view){
  const decisions=view.report?.decisions||{};
  view.content.append(view.kpis([
    ['기록된 운항 판단',value(decisions.total),'배정·대기·허가·해제'],
    ['FATO 변경',value(decisions.fato_reassignments),'출발·도착 배정 각각 집계'],
  ]),view.card('대기 판단 이유','같은 사유의 연속 대기는 한 번 기록합니다. 판단 횟수와 대기 기체 수는 다릅니다.',
    rankingChart(view.doc,decisions.hold_reasons||[],{label:r=>r.reason,metric:r=>r.count,limit:12,
      onPick:r=>view.drill({decision_reason:r.reason})})),
    view.card('운항 의사결정 이력','최근 150건 · 소티를 누르면 해당 운항의 전체 이벤트를 확인합니다.',
      view.table(['운항 시각','소티','판단 / 결과','FATO','이유 / 차단 기체'],(decisions.recent||[]).map(r=>[
        clock(r.time_s),view.button(r.flight_id,()=>view.drill({query:r.flight_id}),{class:'oa-text-button'}),
        `${NODE[r.node]||r.node} · ${OUTCOME[r.outcome]||r.outcome}`,r.fato||`${r.departure_fato||'—'} → ${r.arrival_fato||'—'}`,
        `${r.reason||''}${r.blockers?.length?' · '+r.blockers.map(b=>b.flight_id).join(', '):''}`]))));
  view.content.querySelectorAll('.oa-table-wrap').forEach(node=>node.setAttribute('class','oa-table-wrap oa-flow-table'));
  const previous=view.flowHost;
  view.flowHost=previous||view.e('section',{class:'oa-card'});
  view.content.append(view.flowHost);
  if(!previous)paintIO(view);
}

function paintIO(view){
  if(!view.flowHost||view.tab!=='flows')return;
  const data=view.flowData;
  const picker=view.e('select',{'aria-label':'입출력 기록 실행',onchange:e=>{view.flowRun=e.target.value;view.flowBefore=null;view.flowData=null;void loadFlows(view);}},
    view.e('option',{value:'',text:'현재 서버 실행'}),...(view.flowRecords||[]).filter(r=>r.id!==data?.health?.run_id).map(r=>view.e('option',{value:r.id,text:r.id})));
  // Keep an explicitly selected archive even when it is the displayed run.
  if(view.flowRun&&!Array.from(picker.children).some(o=>o.value===view.flowRun))picker.append(view.e('option',{value:view.flowRun,text:view.flowRun}));
  picker.value=view.flowRun||'';
  view.flowHost.replaceChildren(view.heading('데이터 수신·송신 이력'),
    view.note('서버 실행별 기록 · 실제 시각 기준. 외부 자료는 특정 시뮬레이션 소티의 실제 관측값으로 간주하지 않습니다.'),
    picker,view.button('입출력 새로고침',()=>void loadFlows(view)));
  if(view.flowError)view.flowHost.append(view.note(view.flowError));
  if(!data){view.flowHost.append(view.note('입출력 이력을 불러오는 중입니다.'));return;}
  const health=data.health||{};
  view.flowHost.append(view.note(`기록 ${value(health.written)}건 · 기록 대기 ${value(health.pending)}건 · 누락 ${value(health.dropped)}건${health.complete===null?' · 종료 상태 미확인':''}`),
    view.note('전송 성공은 서버의 로컬 전송 완료입니다. 상대 애플리케이션의 수신 확인은 제공되지 않습니다. 상태 스트림은 10초 단위 건수·바이트·해시로 기록합니다.'),
    view.table(['실제 시각','흐름','대상 / 결과','입출력·판단 근거'],(data.rows||[]).map(r=>{
      const detail=view.e('details',{},view.e('summary',{text:'기록 보기'}),
        view.e('pre',{class:'oa-flow-json',text:JSON.stringify(r,null,2)}));
      if(r.payload_ref)detail.append(view.button('수신·요청·응답 내용 보기',async()=>{
        try{const result=await view.get(`${BASE}/flow-payload/${encodeURIComponent(r.payload_ref)}?${new URLSearchParams({run_id:data.health?.run_id||''})}`);
          detail.append(view.e('pre',{class:'oa-flow-json',text:JSON.stringify(result.payload,null,2)}));
        }catch{detail.append(view.note('보관된 내용을 읽지 못했습니다.'));}
      }));
      return [new Date(r.timestamp*1000).toLocaleString('ko-KR'),KIND[r.kind]||r.kind,
        `${r.source||r.path||r.actor?.name||'상태 스트림'} · ${IO[r.outcome]||r.outcome||(r.kind==='source_received'?'수신 완료':'요청')}${r.status!=null?' · HTTP '+r.status:''}${r.locally_sent!=null?' · '+value(r.locally_sent)+'건':''}`,detail];
    })),view.button('이전 입출력 기록',()=>void loadFlows(view,data.next_before),{disabled:!data.next_before}));
}

export async function loadFlows(view,before=null){
  if(!view.window||view.tab!=='flows')return;
  view.flowBefore=before;
  const request=view.flowRequest=(view.flowRequest||0)+1,run=view.flowRun||'';
  try{
    const parameters=new URLSearchParams({run_id:run});if(before)parameters.set('before',before);
    const data=await view.get(`${BASE}/flows?${parameters}`);
    if(request!==view.flowRequest||view.destroyed||!view.window||view.tab!=='flows'||run!==(view.flowRun||''))return;
    const changed=JSON.stringify(data)!==JSON.stringify(view.flowData);
    view.flowData=data;view.flowError='';if(changed||!view.flowHost?.querySelector('table'))paintIO(view);
    if(!view.flowRecords){
      const archived=await view.get(`${BASE}/flow-records`);
      if(request===view.flowRequest&&!view.destroyed){view.flowRecords=archived.records||[];paintIO(view);}
    }
  }catch{if(request===view.flowRequest){view.flowError='입출력 기록에 연결하지 못했습니다. 마지막 기록을 유지합니다.';paintIO(view);}}
}
