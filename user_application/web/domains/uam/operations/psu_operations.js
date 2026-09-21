import {buildElement} from '../../../dom_builder.js';
import {describePilotDecision} from './pilot_decision.js';

const onGround=row=>['parked','gate_out','gate_in','charge'].includes(row.phase);

export const clock = value => Number.isFinite(value)
  ? [Math.floor(value/3600)%24,Math.floor(value/60)%60,Math.floor(value)%60].map(n=>String(n).padStart(2,'0')).join(':') : '—';
export const until = (value,now) => {
  if(!Number.isFinite(value))return '미정';
  const seconds=Math.ceil(value-now);
  const span=Math.abs(seconds),label=span<60?`${span}초`:`${Math.floor(span/60)}분 ${span%60}초`;
  return seconds< -5?`${label} 경과`:seconds<=0?'지금':`${label} 후`;
};
export function clearanceState(row) {
  if(row.state==='refused')return {id:'refused',label:'허가 보류'};
  if(onGround(row)){
    if(row.ground_waiting===true)return {id:'ground_wait',label:'지상 대기'};
    if(row.instruction?.action==='ground_wait')return {id:'taxi',label:'지상 이동 · 감속'};
    if(row.phase==='gate_out')return {id:'taxi',label:'출발 지상 이동'};
    if(row.phase!=='gate_in')return {id:'ground',label:row.phase==='charge'?'충전 중':'주기 중'};
  }
  if(row.phase==='gate_in')return {id:'taxi',label:'패드 이탈'};
  if(row.phase==='hold'||row.instruction?.clearance==='hold')return {id:'hold',label:
    ({yield:'교통 분리 대기',wait_clear:'분리 확인 대기'}[row.instruction?.action]??'대기 유지')};
  if(row.phase==='landing'||row.instruction?.clearance==='land')return {id:'land',label:'최종 착륙'};
  if(row.instruction?.clearance==='approach')return {id:'approach',label:'접근 진행'};
  return {id:'queued',label:'접근 대기'};
}
export function groundForecast(row,now) {
  if(!row.gate_release_aircraft_id || !Number.isFinite(row.gate_available_s))return '';
  return `${row.landing_staging?'선착륙 · FATO 대기 준비':'게이트 선예약'} · ${row.gate_release_aircraft_id} 출발 후 ${row.stand??'Gate'} · 출구 해제 예상 ${until(row.gate_available_s,now)}`;
}
export function rankedDecks(data) {
  return [...(data?.vertiports??[])].sort((a,b)=>(b.holding-a.holding)||(b.inbound-a.inbound)
    ||String(a.vertiport_id).localeCompare(String(b.vertiport_id)));
}
export function blockingArrival(row,rows) {
  if(clearanceState(row).id!=='hold')return null;
  return rows.filter(other=>other.flight_id!==row.flight_id&&other.vertiport===row.vertiport
    &&other.fato===row.fato&&other.approach_started_s!=null&&other.released_s==null
    &&Number.isFinite(other.cleared_s)&&Number.isFinite(row.cleared_s)&&other.cleared_s<row.cleared_s
    &&['yield','wait_clear'].includes(other.instruction?.action))
    .sort((a,b)=>a.cleared_s-b.cleared_s)[0]??null;
}
export function operationTotals(data) {
  const rows=data?.vertiports??[],arrivals=data?.arrivals??[];
  return {decks:rows.length,holding:rows.reduce((n,r)=>n+(r.holding??0),0),
    approach:arrivals.filter(r=>clearanceState(r).id==='approach').length,
    final:arrivals.filter(r=>clearanceState(r).id==='land').length,
    pads:rows.reduce((n,r)=>n+(r.pads_busy?.length??0),0),standing:rows.reduce((n,r)=>n+(r.standing??0),0),
    attention:rows.filter(r=>r.holding>0).length};
}

// Read-only operational view. Navigation callbacks never issue flight commands.
export class PsuOperations {
  constructor({document=globalThis.document,onDeck=()=>{},onFlight=()=>{},deckView=null}={}) {
    Object.assign(this,{document,onDeck,onFlight,deckView});
    this.mode='flow';this.filter='all';this.search='';this.deckSearch='';this.page=0;this.pageSize=20;
  }
  el(tag,props={},...children){return buildElement(this.document,tag,props,...children);}
  button(text,onclick,props={}){return this.el('button',{type:'button',text,onclick,...props});}
  name(id){return this.facilities?.[id]??id;}
  render(host) {
    this.host=host;const e=this.el.bind(this);
    this.kpis=e('div',{class:'psu-kpis'});
    this.health=e('p',{class:'psu-health',role:'status'});
    this.deckList=e('div',{class:'psu-port-list','aria-label':'운용 버티포트 목록'});
    this.portSearch=e('input',{type:'search',placeholder:'버티포트 검색','aria-label':'버티포트 검색',
      oninput:event=>{this.deckSearch=event.target.value;this.paintDecks();}});
    this.allDecks=this.button('전체 버티포트',()=>this.onDeck(null),{class:'psu-all-ports'});
    this.scope=e('strong',{text:'전체 버티포트'});
    this.flowTab=this.button('접근 순서',()=>this.setMode('flow'),{role:'tab','aria-selected':'true'});
    this.deckTab=this.button('데크 · 이착륙 예약',()=>this.setMode('deck'),{role:'tab','aria-selected':'false'});
    this.searchBox=e('input',{type:'search',placeholder:'기체 / 비행편 검색','aria-label':'관제 기체 검색',
      oninput:event=>{this.search=event.target.value;this.page=0;this.paintFlights();}});
    this.filters=e('div',{class:'psu-status-filters','aria-label':'운항 상태 필터'});
    for(const [id,label] of [['all','전체'],['hold','대기'],['ground_wait','지상 대기'],['approach','접근'],['land','최종']]) {
      this.filters.append(this.button(label,()=>{this.filter=id;this.page=0;this.paintFlights();},
        {'data-filter':id,'aria-pressed':String(id===this.filter)}));
    }
    this.timeline=e('div',{class:'psu-timeline'});
    this.flightRows=e('tbody');
    const table=e('table',{class:'psu-flight-table'},e('thead',{},e('tr',{},
      ...['순번','기체 / 비행편','버티포트 · 패드','실제 지시','도착 ETA','착륙 슬롯'].map(text=>e('th',{scope:'col',text})))),this.flightRows);
    this.count=e('span',{class:'ops-note'});
    this.prev=this.button('이전',()=>{this.page--;this.paintFlights();},{'aria-label':'이전 관제 기체'});
    this.next=this.button('다음',()=>{this.page++;this.paintFlights();},{'aria-label':'다음 관제 기체'});
    this.empty=e('p',{class:'psu-empty'});
    this.flow=e('div',{class:'psu-flow-view',role:'tabpanel','aria-label':'접근 순서'},
      e('div',{class:'psu-flow-tools'},this.searchBox,this.filters),
      e('details',{class:'psu-timeline-disclosure'},e('summary',{text:'착륙 슬롯 전망 · 다음 10분'}),this.timeline),
      e('div',{class:'psu-table-scroll'},table,this.empty),
      e('div',{class:'psu-pagination'},this.count,e('div',{},this.prev,this.next)));
    this.deckHost=e('div',{class:'psu-resource-view',role:'tabpanel','aria-label':'데크와 예약',hidden:true});
    this.deckPlaceholder=e('p',{class:'psu-empty',text:'왼쪽에서 버티포트를 선택하면 지상 배치와 이착륙 예약을 볼 수 있습니다.'});
    this.deckHost.append(this.deckPlaceholder);
    this.deckView?.render(this.deckHost);
    if(this.deckView)this.deckView.onClose=()=>{this.openedDeck=null;this.setMode('flow');};
    this.inspector=e('aside',{class:'psu-flight-inspector','aria-label':'선택 기체 지시'});
    host.append(this.kpis,this.health,e('div',{class:'psu-control-grid'},
      e('aside',{class:'psu-port-column'},e('div',{class:'psu-section-label',text:'버티포트 · 대기 우선'}),
        this.portSearch,this.allDecks,this.deckList),
      e('section',{class:'psu-flow-column'},e('div',{class:'psu-scope'},this.scope,
        e('div',{class:'psu-view-tabs',role:'tablist','aria-label':'관제 정보 보기'},this.flowTab,this.deckTab)),this.flow,this.deckHost),
      this.inspector));
  }
  update(data,facilities,{deckId=null,error='',receivedAt=0}={}) {
    this.data=data;this.facilities=facilities??{};this.deckId=deckId;this.error=error;
    this.stale=Boolean(data?.stale)||Boolean(error)||(receivedAt>0&&Date.now()-receivedAt>12000);
    if(!this.host)return;
    const e=this.el.bind(this),sum=operationTotals(data),known=Boolean(data);
    this.kpis.replaceChildren(...[['착륙 대기',sum.holding,'hold'],['접근 진행',sum.approach,'approach'],
      ['최종 착륙',sum.final,'land'],['현재 FATO 예약',sum.pads,'reserved']].map(([label,value,state])=>
      e('div',{'data-state':state},e('small',{text:label}),e('strong',{text:known?value:'—'}))),
      e('div',{class:'psu-network-total'},e('small',{text:'운용 버티포트 / 주기 기체'}),
        e('strong',{text:known?`${sum.decks}곳 / ${sum.standing}대`:'—'})));
    this.health.setAttribute('data-stale',String(this.stale));
    this.health.textContent=this.stale?'수신 지연 · 아래 정보는 최근 확인한 상태입니다. 최신 허가를 확인할 수 없습니다.'
      :data?`${data.source==='physical'?'Physical':'시뮬레이션'} ${data.clock??'—'} · ${sum.attention}곳에서 착륙 대기 · FATO 수치는 예약 시간 기준`
      :'불러온 비행계획이 없습니다. Simulation에서 비행계획을 열면 실제 관제 정보가 표시됩니다.';
    this.scope.textContent=deckId?this.name(deckId):'전체 버티포트';
    this.paintDecks();this.paintFlights();this.paintMode();
  }
  replace(host,key,build) {
    if(host._psuKey===key)return;
    host._psuKey=key;const top=host.scrollTop,active=this.document.activeElement;
    const focus=active?.getAttribute?.('data-focus-key');
    host.replaceChildren(...build());host.scrollTop=top;
    if(focus)for(const node of host.querySelectorAll('button'))if(node.getAttribute('data-focus-key')===focus)node.focus?.({preventScroll:true});
  }
  paintDecks() {
    if(!this.deckList)return;const e=this.el.bind(this),query=this.deckSearch.trim().toLowerCase();
    const rows=rankedDecks(this.data).filter(r=>`${this.name(r.vertiport_id)} ${r.vertiport_id}`.toLowerCase().includes(query));
    this.allDecks.setAttribute('aria-pressed',String(!this.deckId));
    this.replace(this.deckList,JSON.stringify([rows,this.deckId,this.facilities]),()=>rows.length?rows.map(r=>{
      const total=(r.inbound??0)+(r.holding??0),button=this.button('',()=>this.onDeck(r.vertiport_id),
        {class:'psu-port-row','aria-pressed':String(r.vertiport_id===this.deckId),'data-focus-key':`port:${r.vertiport_id}`,
         'data-waiting':String(r.holding>0)});
      button.append(e('span',{class:'psu-port-name'},e('strong',{text:this.name(r.vertiport_id)}),
        e('b',{text:r.holding?`대기 ${r.holding}`:'대기 없음'})),
        e('span',{class:'psu-port-counts'},...[
          ['도착편',total],['주기',r.standing??0],['FATO 예약',r.pads_busy?.length??0]
        ].map(([label,value])=>e('span',{text:`${label} ${value}`}))),
        e('span',{class:'psu-port-bar'},e('i',{style:`width:${total?Math.round(100*r.holding/total):0}%`})));
      return button;
    }):[e('p',{class:'psu-empty',text:query?'검색 결과가 없습니다.':'운용 중인 버티포트가 없습니다.'})]);
  }
  arrivals() {return [...(this.data?.arrivals??[])].filter(r=>!this.deckId||r.vertiport===this.deckId)
    .sort((a,b)=>(a.cleared_s??Infinity)-(b.cleared_s??Infinity)||(a.sequence-b.sequence)||String(a.aircraft_id).localeCompare(String(b.aircraft_id)));}
  paintFlights() {
    if(!this.flightRows)return;const e=this.el.bind(this),now=this.data?.time_s??0,query=this.search.trim().toLowerCase();
    const all=this.arrivals(),rows=all.filter(r=>(this.filter==='all'||clearanceState(r).id===this.filter)
      &&`${r.aircraft_id} ${r.flight_id}`.toLowerCase().includes(query));
    this.page=Math.max(0,Math.min(this.page,Math.ceil(rows.length/this.pageSize)-1));
    const page=rows.slice(this.page*this.pageSize,(this.page+1)*this.pageSize);
    for(const b of this.filters.children)b.setAttribute('aria-pressed',String(b.getAttribute('data-filter')===this.filter));
    if(!all.some(r=>r.flight_id===this.selected))this.selected=null;
    const key=JSON.stringify([page,this.selected,now,this.facilities]);
    this.replace(this.flightRows,key,()=>page.map(r=>{
      const status=clearanceState(r),button=this.button(r.aircraft_id,()=>this.selectFlight(r.flight_id),
        {class:'psu-aircraft-button','aria-pressed':String(this.selected===r.flight_id),'data-focus-key':`flight:${r.flight_id}`});
      return e('tr',{'data-selected':String(this.selected===r.flight_id)},
        e('td',{},e('span',{class:'psu-sequence',text:r.sequence?`#${r.sequence}`:'—'})),
        e('td',{},button,e('small',{text:r.flight_id})),
        e('td',{},e('strong',{text:this.name(r.vertiport)}),e('small',{text:`${r.fato} · ${r.stand??'주기장 미확보'}`})),
        e('td',{},e('span',{class:'psu-state','data-state':status.id,text:status.label})),
        e('td',{},e('strong',{text:until(r.eta_s,now)}),e('small',{text:clock(r.eta_s)})),
        e('td',{},e('strong',{text:until(r.cleared_s,now)}),e('small',{text:clock(r.cleared_s)})));
    }));
    this.empty.hidden=rows.length>0;this.empty.textContent=all.length?'조건에 맞는 기체가 없습니다.':'이 범위에 발급된 착륙 요청이 없습니다.';
    this.count.textContent=`${rows.length}편${rows.length?` · ${this.page*this.pageSize+1}–${this.page*this.pageSize+page.length} 표시`:''}`;
    this.prev.disabled=this.page===0;this.next.disabled=(this.page+1)*this.pageSize>=rows.length;
    this.paintTimeline(all,now);this.paintInspector();
  }
  paintTimeline(rows,now) {
    const e=this.el.bind(this),upcoming=rows.filter(r=>r.cleared_s>=now&&r.cleared_s<=now+600),groups=new Map();
    for(const r of upcoming){const key=`${r.vertiport} / ${r.fato}`;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);}
    this.timeline.hidden=!rows.length;
    const shown=[...groups].slice(0,this.deckId?6:3);
    this.timeline.replaceChildren(e('div',{class:'psu-timeline-title'},e('strong',{text:'착륙 슬롯 전망'}),
      e('span',{text:this.deckId?'다음 10분 · 마커는 예정 시각':'다음 10분 · 가까운 슬롯 3개 패드'})),
      e('div',{class:'psu-timeline-axis'},e('span',{text:'지금'}),e('span',{text:'+5분'}),e('span',{text:'+10분'})),
      ...shown.map(([key,flights])=>e('div',{class:'psu-slot-lane'},e('span',{class:'psu-slot-name',text:`${this.name(flights[0].vertiport)} ${flights[0].fato}`}),
        e('div',{class:'psu-slot-track'},...flights.map(r=>this.button('',()=>this.selectFlight(r.flight_id),
          {class:'psu-slot-marker','data-state':clearanceState(r).id,style:`left:${Math.min(99,100*(r.cleared_s-now)/600)}%`,
           title:`${r.aircraft_id} · ${clock(r.cleared_s)} · ${clearanceState(r).label}`,
           'aria-label':`${r.aircraft_id} 착륙 슬롯 ${clock(r.cleared_s)}`}))))),
      ...(shown.length?[]:[e('p',{class:'ops-note',text:'10분 안에 예정된 착륙 슬롯이 없습니다.'})]));
  }
  selectFlight(id){this.selected=id;this.paintFlights();this.inspector.scrollIntoView?.({block:'nearest',behavior:'smooth'});}
  paintInspector() {
    const e=this.el.bind(this),r=this.arrivals().find(r=>r.flight_id===this.selected);
    if(!r){this.inspector._psuKey=null;this.inspector.replaceChildren(e('div',{class:'psu-section-label',text:'기체별 지시'}),
      e('div',{class:'psu-inspector-empty'},e('strong',{text:'기체를 선택하세요'}),e('p',{text:'표의 기체 또는 슬롯 마커를 누르면 접근 허가, 대기 사유와 주변 교통을 확인할 수 있습니다.'})),
      e('div',{class:'psu-status-legend'},...['hold','approach','land','queued'].map((state,i)=>e('span',{class:'psu-state','data-state':state,text:['대기 유지','접근 진행','최종 착륙','접근 대기'][i]}))));return;}
    const s=clearanceState(r),ground=onGround(r),i=ground?{}:r.instruction??{},now=this.data?.time_s??0;
    const decision=describePilotDecision({state:r,clearance:r});
    const reason=!ground&&decision.source==='운항 단계'?r.reason??decision.reason:decision.reason;
    const assignment=r.gate_assignment??{planned_stand:r.planned_stand,assigned_stand:r.stand};
    const diagnosticKeys=new Set(['blocked_by','ground_wait','stop_distance_m','distance_m','route_id','updated_s',
      'gate_revision','gate_reason','guidance']);
    const blocker=blockingArrival(r,this.arrivals());
    this.replace(this.inspector,JSON.stringify([r,blocker,now,this.stale,this.facilities]),()=>[e('div',{class:'psu-section-label',text:'선택 기체 · 최근 지시'}),
      e('div',{class:'psu-aircraft-heading'},e('h3',{text:r.aircraft_id}),e('span',{class:'psu-state','data-state':s.id,text:s.label})),
      e('p',{class:'ops-note',text:`${r.flight_id} · 착륙 순번 #${r.sequence??'—'}`}),
      e('div',{class:'psu-assignment'},...[[this.name(r.vertiport),'도착 버티포트'],[r.fato,'착륙 패드'],
        [assignment.planned_stand??'미제공','계획 Gate'],[assignment.assigned_stand??'미확보','배정 Gate']]
        .map(([value,label])=>e('div',{},e('small',{text:label}),e('strong',{text:value})))),
      e('p',{class:'psu-instruction','data-state':s.id,text:this.stale?`수신 지연 · 최근 확인한 지시: ${reason}`:reason}),
      ...decision.fields.filter(field=>diagnosticKeys.has(field.key)).map(field=>
        e('p',{class:'ops-note',text:`${field.label}: ${field.value}`})),
      ...(groundForecast(r,now)?[e('p',{class:'ops-note',text:groundForecast(r,now)})]:[]),
      ...(r.approach_mode==='initial'?[e('p',{class:'ops-note',text:'초기 접근만 허가 · 공용 최종 구간은 선행 이륙편 이탈 후 재확인'})]:[]),
      ...(blocker?[e('p',{class:'ops-note',text:`선행편 ${blocker.aircraft_id} · ${blocker.instruction.reason??'교통 분리 대기'}. 실제 분리가 확인되면 접근을 재개합니다.`})]:[]),
      e('ol',{class:'psu-clearance-steps'},...[
        ['접근 요청',true,clock(r.requested_s)],
        ['접근 개시',r.approach_started_s!=null,r.approach_started_s!=null?clock(r.approach_started_s):until(r.approach_s,now)],
        ['최종 착륙',s.id==='land'||r.phase==='gate_in',s.id==='land'?'지시 확인':r.phase==='gate_in'?'접지 완료':'실제 점유 재확인']
      ].map(([label,done,value])=>e('li',{'data-done':String(done)},e('strong',{text:label}),e('span',{text:value})))),
      e('div',{class:'psu-traffic-note','data-alert':String(Boolean(i.traffic_id))},e('strong',{text:i.traffic_id?`주변 교통 · ${i.traffic_id}`:'주변 교통'}),
        e('p',{text:i.traffic_id?`${i.reason??''} · 최근접 ${Number.isFinite(i.cpa_s)?i.cpa_s:'—'}초 후 / ${Number.isFinite(i.miss_m)?i.miss_m:'—'}m`:'보고된 교통 지시 없음'})),
      this.button('지도에서 기체 추적 ↗',()=>this.onFlight(r),{class:'psu-track-button','data-focus-key':'track-flight'}),
      this.button('도착 데크 · 예약 보기',()=>{if(this.deckId!==r.vertiport)this.onDeck(r.vertiport);this.setMode('deck');},{class:'psu-resource-button','data-focus-key':'inspect-deck'}),
      e('p',{class:'ops-note',text:'ETA와 슬롯은 예측입니다. 최종 착륙 표시는 조종사에게 전달된 실제 지시를 따릅니다.'})]);
  }
  setMode(mode){this.mode=mode;this.paintMode();}
  paintMode() {
    if(!this.flow)return;const resource=this.mode==='deck';
    this.flow.hidden=resource;this.deckHost.hidden=!resource;this.inspector.hidden=resource;
    this.host.setAttribute('data-resource-view',String(resource));
    this.flowTab.setAttribute('aria-selected',String(!resource));this.deckTab.setAttribute('aria-selected',String(resource));
    this.deckPlaceholder.hidden=Boolean(this.deckId);
    if(resource&&this.deckId&&this.openedDeck!==this.deckId){this.openedDeck=this.deckId;void this.deckView?.open(this.deckId);}
    else if(resource&&this.deckId)this.deckView?.start();
    else {this.deckView?.stop();if(!this.deckId&&this.openedDeck){this.openedDeck=null;this.deckView?.close({notify:false});}}
  }
  destroy(){this.deckView?.destroy();this.host=null;}
}
