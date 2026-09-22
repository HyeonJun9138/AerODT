// Presentation of the server-owned procedure; the browser never issues a clearance.
export function operationClock(value){
 if(!Number.isFinite(value))return '미정';
 const day=Math.floor(value/86400),s=((Math.floor(value)%86400)+86400)%86400;
 return `${day>0?`+${day}일 `:''}${[Math.floor(s/3600),Math.floor(s/60)%60,s%60].map(n=>String(n).padStart(2,'0')).join(':')}`;
}
// The whole procedure, in the order it is flown, with the request each step
// sends. The cockpit draws this as a strip so a pilot can see where they are
// without remembering the sequence -- which was the complaint: every step told
// you what to press *now* and nothing told you what this was one of.
export const PSU_STEPS=[['departure','출발'],['takeoff','이륙'],['report_airborne','상승'],
 ['arrival','순번'],['approach','접근'],['landing','착륙'],['report_landed','접지'],['report_gate','GATE']];

// A retained bay reservation is not a new hold after explicit approach clearance.
export function manualArrivalHolding(psu){
 if(psu?.procedure?.version>=2){
  return ['접근 대기','접근 요청 가능','접근 보류','착륙 허가 보류','위치 수신 대기'].includes(psu.procedure.stage);
 }
 return Boolean(psu?.hold||psu?.instruction?.clearance==='hold');
}
// Distance can enrich an already-issued pilot cue, but it must never create the
// cue. Request readiness comes from the server-side pilot procedure.
const BOOK_LATE_M=6000;

export function pilotGuidance(psu,{distanceM=null}={}){
 const p=psu?.procedure,t=p?.timeline??{},stale=Boolean(psu?.stale||psu?.error),waiting=!p;
 const stopped=psu?.clock&&psu.clock.state!=='playing';
 const remaining=Number.isFinite(t.ready_s)&&Number.isFinite(t.now_s)?Math.ceil(t.ready_s-t.now_s):null;
 const next=p?.next??{label:'PSU 응답 대기',enabled:false,kind:null};
 // What the service has promised about coming in. The sequencer recomputes its
 // forecast every tick, but `eat_s` is the answer it has actually issued and
 // stands by, so this is a time a pilot can plan against rather than one that
 // slides under them. Everything here is already on the wire; none of it was
 // being read.
 const arrival=psu?.arrival??null;
 const eat=Number.isFinite(arrival?.eat_s)&&!Number.isFinite(arrival?.released_s)?arrival.eat_s:null;
 const countdown=eat!=null&&Number.isFinite(t.now_s)?Math.round(eat-t.now_s):null;
 const gap=s=>s<=0?'지금':s<60?`${s}초 뒤`:`${Math.floor(s/60)}분 ${s%60}초 뒤`;
 // The landing slot has a row of its own, so it is not repeated here: this
 // line is for the one thing that row cannot say, which is when to start down.
 const approach=p?.version>=2
  ?(next.kind==='approach'?(next.enabled?'접근 허가 요청 가능 · 아직 접근 허가 아님':'접근 대기 · 현재 지시 유지')
    :next.kind==='landing'?'접근과 착륙 허가는 별도입니다':'')
  :eat==null?'':[`접근 검토 예상 ${operationClock(eat)} · 허가 아님`,countdown==null?'':gap(countdown),
   Number.isFinite(arrival.sequence)?`순번 ${arrival.sequence}`:''].filter(Boolean).join(' · ');
 const blocked=stale||waiting||Boolean(psu?.pending);
 // Where this flight has got to. `next.kind` is the request the service is
 // waiting for, so everything before it is done and everything after is still
 // to come; a finished flight has them all behind it.
 const done=psu?.procedure?.reports??{};
 const at=PSU_STEPS.findIndex(([kind])=>kind===next.kind);
 const steps=PSU_STEPS.map(([kind,label],index)=>({kind,label,
  state:at<0?(psu?.completed||done.report_gate?'done':'todo')
   :index<at?'done':index===at?'now':'todo'}));
 // Pilot-owned readiness is authoritative. The local distance only makes that
 // active cue easier to read; it cannot enable a request on its own.
 const requestReady=next.kind==='arrival'&&Boolean(next.enabled)&&!blocked&&!stopped;
 const prompt=!requestReady?'':Number.isFinite(distanceM)
  ?(distanceM<=BOOK_LATE_M
    ?`도착 ${(distanceM/1000).toFixed(1)} km · 접근 순번 요청이 늦습니다 · 지금 요청하세요`
    :`도착 ${(distanceM/1000).toFixed(1)} km · 접근 순번을 지금 요청하세요`)
  :'접근 순번 요청 기준 도달 · 지금 요청하세요';
 return {stage:stale?'PSU 연결 확인':p?.stage??'PSU 갱신 필요',tone:blocked?'hold':p.tone,
  text:stale?'새 지시 수신 전 허가를 재확인하세요':p?.text??'서버 재시작 후 단계별 운항 지시를 받습니다',
  // The instruction carries why *this* aircraft is waiting -- which deck and
  // which pad it is queued behind -- while the procedure's own reason is the
  // generic sentence for the stage. Given both, the specific one is the
  // answer to the question the pilot is actually asking.
  reason:psu?.error??(stale?'PSU 수신 지연 · 마지막 지시는 재확인이 필요합니다':stopped?'시뮬레이션 정지 · 상단 SIM 또는 조작의 시뮬레이션 재생을 누르세요':(p?.version>=2?p.reason||'':psu?.instruction?.reason||p?.reason||'')),
  now:`${operationClock(t.now_s)}${stopped?' · 정지':' KST'}`,
 // '미정' is true and useless. Neither slot is issued until its clearance is,
 // but the service has a forecast for both long before that and it is already
 // on the wire -- the departure review time it is holding this aircraft to, and
 // the arrival entry it is being metered for. Shown with the label changed, so
 // a forecast can never be read as the clearance the fixed label promises:
 // these rows say 허가 별도 precisely because they are slots, and a predicted
 // time is not one.
  ...(()=>{
   const held=psu?.instruction??{};
   const slot=(value,predicted,name,forecastName)=>Number.isFinite(value)
    ?{value:operationClock(value),label:name}
    :Number.isFinite(predicted)?{value:`${operationClock(predicted)} 예상`,label:forecastName}
    :{value:'미정',label:name};
   const up=slot(t.takeoff_s,psu?.departed?null:held.ready_s??t.ready_s,
     '이륙 슬롯 · 허가 별도','출발 가능 · 허가 아님');
   const down=slot(t.landing_s,held.entry_s,'예상 접지 · 허가/대기시간 아님','도착 진입 · 예약 아님');
   return {takeoff:up.value,takeoffLabel:up.label,landing:down.value,landingLabel:down.label};
  })(),
  off:operationClock(t.off_block_s),
  // Before departure this line counts down to the next departure review; once
  // airborne it was simply blank, which is where the one thing a holding pilot
  // most wants to know now goes.
  due:psu?.departed?(blocked||stopped?'':approach||''):remaining==null?'출발 허가 미발급':remaining>0?`배정 검토까지 ${Math.floor(remaining/60)}분 ${remaining%60}초 · 출발 허가 아님`: '출발 허가 확인 필요 · 시각만으로 이동 불가',
  approach,approachAt:eat,approachIn:countdown,
  approachRevision:arrival?.eat_revision??0,approachMoved:arrival?.eat_moved_s??0,
  steps,prompt,urgent:requestReady&&Number.isFinite(distanceM)&&distanceM<=BOOK_LATE_M,
  next:{...next,enabled:next.enabled&&!blocked&&!stopped},stopped,blocked,
  route:p?`${p.origin} ${p.departure_gate??'—'} → ${p.departure_fato??'—'} · 도착 ${p.destination} ${p.arrival_fato??'—'} / ${p.arrival_gate??'—'}`:'',
  history:(p?.communications??[]).slice(-6).reverse()};
}
export const PSU_PILOT_HELP='1. 운항 시계(KST)와 계획 GATE 출발을 확인합니다. 시계가 정지했으면 상단 SIM 재생바 또는 조작 창의 시뮬레이션 재생을 누릅니다(다른 기체도 함께 진행).\n2. 출발 준비 · 이동 요청은 한 번만 누릅니다. 대기 응답이면 접수 순서를 유지하고 PSU가 자동 재검토합니다. 배정 검토 시각은 출발 허가가 아닙니다. 지상 이동 허가가 표시되면 지정 FATO까지 이동합니다. 출발 요청 취소는 대기 접수를 취소합니다. 이동 허가는 이륙 허가가 아닙니다.\n3. FATO 중심 정차 → FATO 도착 · 이륙 요청 → 이륙 허가를 확인한 뒤 이륙하고 이륙 완료를 보고합니다.\n4. 접근 순번 배정 후 접근 허가 요청을 누르고 접근 허가를 확인한 뒤 도착 경로로 접근합니다. 최종 접근 구간에서는 최종 착륙 허가 요청 후 착륙 허가를 확인해야 하강·접지할 수 있습니다. 예상 접지 시각은 예측값이며 그 시각까지 기다리라는 지시가 아닙니다. 접근 대기/보류라면 표시된 사유를 확인하고 추가 접근·최종 하강을 하지 않습니다.\n5. 접지 후 착륙 완료 보고 → 지정 GATE 중심 정차 → GATE 도착 보고 → TURNAROUND에서 하차·충전합니다.\nHOLD·거절·수신 지연이면 새 허가를 확인합니다. 대기 요청에 좌표가 없으면 지정 대기점이 발급된 것이 아닙니다. 시각 도달만으로 자동 허가되지 않습니다. 보고 버튼은 기체를 움직이지 않으며 현재 위치와 접지 상태를 검사합니다.';
