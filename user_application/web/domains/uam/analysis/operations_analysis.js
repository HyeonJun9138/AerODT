import {renderFatos,renderFlows,loadFlows} from './operations_flows.js';
import {buildElement as el} from '../../../dom_builder.js';
import {hourlyChart,rankingChart,value,minutes,percent,clock} from './operations_charts.js';

const BASE='/api/simulation/analysis';
const STATES={completed:'착륙 완료',active:'운항 중',scheduled:'예정',overdue:'출발 미이행',cancelled:'취소',failed:'비행 오류'};
const TABS=[['overview','전체 평가'],['ports','버티포트'],['fleet','비행체'],['sorties','소티 상세'],['fatos','FATO 운영'],['flows','판단·입출력']];
const EVENT_NAMES={battery_low:'배터리 잔량 낮음 (기록만)',battery_critical:'배터리 임계 잔량 (기록만)',battery_depleted:'배터리 소진 (가상 비행 유지)',battery_flight_start:'출발 배터리',battery_flight_end:'도착 배터리',battery_sample:'에너지 표본',charging_connected:'충전기 연결',charging_disconnected:'충전기 분리',charging_complete:'충전 완료',charging_unavailable:'충전기 없음',psu_decision:'PSU 판단',takeoff:'이륙 개시',off_block:'주기장 출발',touchdown:'착륙',in_block:'주기장 도착',hold:'공중 대기',hold_released:'대기 해제',cancelled:'취소',pilot_failed:'비행 오류',arrival_request:'접근 요청',traffic_advisory:'교통 안내'};
const EMPTY_FILTERS=()=>({vertiport:'',aircraft:'',status:'',query:'',fato:'',decision_reason:'',hour:-1,hold_hour:-1,delay_bin:-1,page:1});

export class OperationsAnalysis {
  constructor({document=globalThis.document,getJSON,isSideVisible=()=>false,onOpen=()=>{},onAircraft=()=>{},pollMs=5000}){
    this.doc=document;this.get=getJSON;this.isSideVisible=isSideVisible;this.onOpen=onOpen;this.onAircraft=onAircraft;
    this.recording='current';this.records=[];this.report=null;this.filters=EMPTY_FILTERS();this.tab='overview';this.version=0;this.request=0;
    this.recordsRequest=0;this.inspectRequest=0;
    this.timer=setInterval(()=>{if(this.visible())void this.refresh();},pollMs);this.timer?.unref?.();
  }
  e(tag,props,...children){return el(this.doc,tag,props,...children);}
  visible(){return !this.destroyed&&!this.doc.hidden&&(this.window||this.isSideVisible());}
  button(text,onclick,props={}){return this.e('button',{type:'button',text,onclick,'data-focus':text,...props});}
  focusKey(root){const active=this.doc.activeElement;return root?.querySelectorAll('button')&&[...root.querySelectorAll('button')].includes(active)?active.getAttribute('data-focus'):null;}
  restoreFocus(root,key){if(key)[...root.querySelectorAll('button')].find(b=>b.getAttribute('data-focus')===key)?.focus?.({preventScroll:true});}
  note(text){return this.e('p',{class:'oa-note',text});}
  heading(text,aside=''){return this.e('div',{class:'oa-section-head'},this.e('h3',{text}),this.e('span',{text:aside}));}
  query(extra={}){return new URLSearchParams({recording:this.recording,...extra}).toString();}
  async loadRecords(){
    const id=++this.recordsRequest;
    try{const data=await this.get(`${BASE}/records`);if(this.destroyed||id!==this.recordsRequest)return;this.records=data.records||[];this.paintSelectors();}catch{ /* Current analysis remains available when the archive directory cannot be read. */ }
  }
  selector(){
    const select=this.e('select',{'aria-label':'분석 대상 운항 기록',onchange:event=>this.choose(event.target.value)});
    this.fillSelector(select);return select;
  }
  fillSelector(select){
    if(!select)return;
    select.replaceChildren(this.e('option',{value:'current',text:'현재 화면의 운항 · 자동'}),
      this.e('option',{value:'physical',text:'Physical 실시간 운항'}),this.e('option',{value:'simulation',text:'현재 Simulation'}),...this.records.map(r=>this.e('option',{
      value:r.id,text:`${r.date||'날짜 미상'} · ${r.name||'운항 기록'} · ${r.id.slice(-6)}`})));
    select.value=this.recording;
  }
  paintSelectors(){this.fillSelector(this.sideSelect);this.fillSelector(this.mainSelect);}
  choose(id){
    if(id===this.recording)return;
    this.recording=id;this.version++;this.request++;this.report=null;this.selected=null;this.sortieData=null;
    this.filters=EMPTY_FILTERS();this.signature=null;this.error='';this.paintSelectors();this.paintSide();this.paintMain();void this.refresh();
  }
  render(body){
    this.side=this.e('section',{class:'oa-side'});this.sideSelect=this.selector();
    this.sideContent=this.e('div',{class:'oa-side-content'});
    this.side.append(this.e('label',{class:'oa-label',text:'분석 대상'}),this.sideSelect,this.sideContent);
    body.replaceChildren(this.side);this.paintSide();void this.loadRecords();void this.refresh();
  }
  async refresh(){
    if(!this.visible()||this.pending)return;
    this.pending=true;const version=this.version,recording=this.recording;
    try{
      const data=await this.get(`${BASE}?${this.query()}`);
      if(this.destroyed||version!==this.version||recording!==this.recording)return;
      const reset=this.report?.meta?.scenario_id&&this.report.meta.scenario_id!==data.meta?.scenario_id;
      if(reset){this.filters=EMPTY_FILTERS();this.selected=null;this.sortieData=null;this.request++;}
      const changed=JSON.stringify(data)!==this.signature,hadError=Boolean(this.error);this.signature=JSON.stringify(data);this.report=data;this.error='';
      if(changed||hadError)this.paintSide();this.paintStatus();
      if(changed||this.mainError){this.mainError=false;this.paintMain();}
      if(this.window&&this.tab==='sorties')await this.loadSorties();
      if(this.window&&this.tab==='flows'&&!this.flowBefore&&!this.flowHost?.querySelector('details[open]'))await loadFlows(this);
    }catch(error){
      if(version===this.version){this.error=/404/.test(error?.message||'')?
        (recording==='current'?'분석 기능이 아직 실행 중인 서버에 반영되지 않았습니다. 서버 업데이트 후 다시 열어 주세요.':'선택한 저장 기록을 찾을 수 없습니다. 다른 기록을 선택해 주세요.'):
        (this.report?'연결이 지연되고 있습니다. 마지막 수신값을 표시합니다.':'분석 정보에 연결하지 못했습니다. 다시 불러오기를 눌러 주세요.');this.mainError=true;this.paintStatus();this.paintSide();
        if(!this.report)this.paintMain();}
    }finally{this.pending=false;if(!this.destroyed&&version!==this.version&&this.visible())void this.refresh();}
  }
  caption(){
    if(!this.report?.available)return '분석할 비행계획을 불러오세요.';
    const m=this.report.meta,t=this.report.totals;
    const status=m.state==='finished'?(t.completed===t.planned?'운항 종료':'종료 시점까지의 결과'):
      ({playing:'진행 중',paused:'일시정지',ready:'시작 전'}[m.state]||'기록');
    return `${m.source_label||'Simulation'} · ${m.date||'날짜 미상'} · ${clock(m.observed_s)} 기준 · ${status}${m.stale?' · 수신 지연, 마지막 기록':''}${m.legacy?' · 이전 기록':''}`;
  }
  kpis(items,small=false){return this.e('div',{class:`oa-kpis${small?' oa-kpis-small':''}`},...items.map(([label,n,unit,action])=>{
    const tag=action?'button':'div';return this.e(tag,{class:'oa-kpi',...(action?{type:'button',onclick:action,'data-focus':label}:{})},
      this.e('span',{text:label}),this.e('strong',{text:n}),this.e('small',{text:unit}));
  }));}
  paintSide(){
    if(!this.sideContent)return;
    const focused=this.focusKey(this.sideContent);
    const r=this.report;
    this.sideContent.replaceChildren(this.note(this.caption()));
    if(this.error)this.sideContent.append(this.e('p',{class:'oa-error',role:'status',text:this.error}));
    if(!r?.available){this.sideContent.append(this.note(this.error?'분석 연결을 다시 시도할 수 있습니다.':'운항 기록을 읽는 중이거나 선택된 계획이 없습니다.'),this.button('다시 불러오기',()=>void this.refresh()),this.button('수신·송신 기록 보기',()=>this.open('flows')));return;}
    const t=r.totals;
    this.sideContent.append(this.kpis([
      ['착륙 완료',value(t.completed),`일일 계획 ${value(t.planned)}편`,()=>this.drill({status:'completed'})],
      ['도래편 이행률',percent(t.due_arrival_pct),'현재까지 도착 예정편 기준',()=>this.open('overview')],
      ['운송 인원',value(t.transported_passengers),'완료편 계획 탑승객 · 인회',()=>this.open('overview')],
      ['누적 공중 대기',minutes(t.hold_total_s),`${value(t.held_sorties)}편에서 대기 발생`,()=>this.drill({status:'held'})],
    ],true));
    this.sideContent.append(this.button('운항정보 분석 열기 ↗',()=>this.open('overview'),{class:'oa-primary'}),
      this.heading('먼저 확인할 버티포트','혼잡 발생 비율'),
      rankingChart(this.doc,[...r.vertiports].sort((a,b)=>(b.congestion_pct||0)-(a.congestion_pct||0)),{
        label:p=>p.name,metric:p=>p.congestion_pct,format:percent,ceiling:100,limit:3,onPick:p=>this.drill({vertiport:p.id})}),
      this.heading('기체별 대기','누적 상위 3대'),
      rankingChart(this.doc,[...r.aircraft].sort((a,b)=>b.hold_total_s-a.hold_total_s),{
        label:a=>a.id,metric:a=>a.hold_total_s,format:minutes,limit:3,onPick:a=>this.drill({aircraft:a.id})}),
      this.button(`FATO 변경 ${value(r.decisions?.fato_reassignments)}건 · 판단 이력 보기`,()=>this.open('flows'),{class:'oa-text-button'}),
      this.note(`운항 중 ${value(t.in_progress)}편 · 미출발 ${value(t.overdue)}편 · 향후 예정 ${value(t.future)}편`),
      this.note('혼잡: 출발·도착 지연 5분 초과 또는 도착 대기 발생 비율. 그래프를 누르면 해당 소티가 열립니다.'));
    this.restoreFocus(this.sideContent,focused);
  }
  open(tab='overview'){
    if(this.tab!==tab&&this.content)this.content.scrollTop=0;
    this.tab=tab;this.onOpen();
    if(!this.window){
      this.window=this.e('section',{class:'oa-window glass','aria-label':'운항정보 분석 상세'});
      this.mainSelect=this.selector();this.statusNode=this.e('p',{class:'oa-status'});this.errorNode=this.e('p',{class:'oa-error',role:'status'});
      this.tabs=this.e('div',{class:'oa-tabs',role:'tablist','aria-label':'운항 분석 분류'});
      this.content=this.e('div',{class:'oa-content',role:'tabpanel',id:'oa-tab-content'});
      this.window.append(this.e('header',{class:'oa-window-head'},
        this.e('div',{},this.e('span',{class:'oa-eyebrow',text:'OPERATIONS INTELLIGENCE'}),this.e('h2',{text:'운항정보 분석'})),
        this.button('×',()=>this.close(),{'aria-label':'운항 분석 상세 닫기',class:'oa-close'})),
        this.e('div',{class:'oa-toolbar'},this.mainSelect,this.button('새로고침',()=>{void this.loadRecords();void this.refresh();}),
          this.e('a',{class:'oa-export',href:`${BASE}/export?${this.query()}`,text:'CSV 내려받기'})),
        this.statusNode,this.errorNode,this.tabs,this.content);
      this.doc.body.append(this.window);
      this.window.onkeydown=event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();this.close();}};
    }
    this.paintMain();this.paintStatus();void this.refresh();
    if(tab==='sorties')void this.loadSorties();
    if(tab==='flows')void loadFlows(this);
  }
  close(){this.window?.remove();this.window=null;this.flowHost=null;this.request++;this.mainSelect=null;this.content=null;this.selected=null;this.side?.querySelector('.oa-primary')?.focus?.();}
  destroy(){this.destroyed=true;this.version++;clearInterval(this.timer);this.close();this.side=null;}
  paintStatus(){if(!this.window)return;this.statusNode.textContent=this.caption();this.errorNode.textContent=this.error||'';this.errorNode.hidden=!this.error;}
  paintTabs(){
    if(this.paintedTabs===this.tabs&&this.paintedTab===this.tab)return;
    this.paintedTabs=this.tabs;this.paintedTab=this.tab;
    this.tabs.replaceChildren(...TABS.map(([id,label],index)=>this.button(label,()=>this.open(id),{
      role:'tab',id:`oa-tab-${id}`,'aria-selected':String(this.tab===id),'aria-controls':'oa-tab-content',tabindex:this.tab===id?0:-1,
      onkeydown:event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){
        event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?TABS.length-1:(index+(event.key==='ArrowRight'?1:TABS.length-1))%TABS.length;
        this.open(TABS[next][0]);this.tabs.children[next]?.focus?.();}}
    })));
    this.content.setAttribute('aria-labelledby',`oa-tab-${this.tab}`);
  }
  paintMain(){
    if(!this.window)return;
    this.paintTabs();this.paintStatus();
    this.window.querySelector('.oa-export').setAttribute('href',`${BASE}/export?${this.query()}`);
    if(!this.report?.available&&this.tab==='flows'){this.content.replaceChildren();renderFlows(this);return;}
    if(!this.report?.available){this.content.replaceChildren(this.note(this.error||'비행계획이 없거나 분석 정보를 불러오는 중입니다.'));return;}
    if(this.tab==='sorties'){
      // Keep the form and focused inputs stable across the 5-second refresh.
      if(this.formKey!==`${this.recording}/${this.report.meta.scenario_id}`||!this.content.querySelector('.oa-filter-form'))this.renderSorties();
      return;
    }
    const scroll=this.content.scrollTop,focused=this.focusKey(this.content);this.content.replaceChildren();
    if(this.tab==='overview')this.renderOverview();
    if(this.tab==='ports')this.renderPorts();
    if(this.tab==='fleet')this.renderFleet();
    if(this.tab==='fatos')renderFatos(this);
    if(this.tab==='flows')renderFlows(this);
    this.content.scrollTop=scroll||0;
    this.restoreFocus(this.content,focused);
  }
  card(title,subtitle,...children){return this.e('section',{class:'oa-card'},this.heading(title),this.note(subtitle),...children);}
  renderOverview(){
    const r=this.report,t=r.totals;
    this.content.append(this.kpis([
      ['계획 / 완료',`${value(t.planned)} / ${value(t.completed)}`,'비행편 · 착륙 기준'],
      ['정시 도착률',percent(t.on_time_pct),`5분 이내 ${value(t.on_time_count)} / 비교 가능 ${value(t.on_time_denominator)}편`],
      ['평균 도착 지연',minutes(t.arrival_delay.mean_s),`P95 ${minutes(t.arrival_delay.p95_s)} · 조기는 0분`],
      ['운송 인원',value(t.transported_passengers),'완료편 계획 탑승객 · 인회'],
    ]),this.card('시간대별 계획 대비 운항 실적','아직 도래하지 않은 시간대의 실적은 미이행 평가에 포함하지 않습니다.',
      hourlyChart(this.doc,r.hourly,r.meta.observed_s,hour=>this.drill({hour}))),
      this.e('div',{class:'oa-grid-2'},
        this.card('도착 지연 분포','착륙한 비교 가능 편 · 단위 편',rankingChart(this.doc,r.delay_bins.map((b,i)=>({...b,id:i})),{
          label:b=>b.label,metric:b=>b.count,onPick:b=>this.drill({delay_bin:b.id}),limit:5})),
        this.card('대기가 집중된 시간대','공중 대기 이벤트 구간 합계 · 단위 기체·분',rankingChart(this.doc,[...r.hourly].filter(h=>h.hold_aircraft_minutes>0).sort((a,b)=>b.hold_aircraft_minutes-a.hold_aircraft_minutes),{
          label:h=>`${Math.floor(h.hour_s/3600)}시`,metric:h=>h.hold_aircraft_minutes,format:n=>`${value(n,1)}`,onPick:h=>this.drill({hold_hour:Math.floor(h.hour_s/3600)}),limit:6}))),
      this.card('계획 이행 요약','도래편 이행률은 기준 시각까지 예정된 편을 분모로 계산합니다.',
        this.kpis([['도래 출발 이행률',percent(t.due_departure_pct),`예정 ${value(t.due_departures)}편`],
          ['도래 도착 이행률',percent(t.due_arrival_pct),`예정 ${value(t.due_arrivals)}편`],
          ['출발 미이행',value(t.overdue),'예정 시각 경과 · 취소/오류 제외'],
          ['취소 / 오류',`${value(t.cancelled)} / ${value(t.failed)}`,'각각 독립 분류']])));
    const details=this.e('details',{class:'oa-definitions'},this.e('summary',{text:'지표 계산 기준과 기록 범위'}));
    for(const [key,text] of Object.entries(r.definitions))details.append(this.note(text));
    if(r.meta.legacy)details.append(this.note('이전 기록에는 탑승객 자료가 없어 운송 인원을 계산할 수 없습니다.'));
    this.content.append(details);
  }
  table(headers,rows){return this.e('div',{class:'oa-table-wrap'},this.e('table',{class:'oa-table'},
    this.e('thead',{},this.e('tr',{},...headers.map(text=>this.e('th',{scope:'col',text})))),
    this.e('tbody',{},...rows.map(cells=>this.e('tr',{},...cells.map(cell=>this.e('td',{},typeof cell==='object'?cell:this.e('span',{text:cell}))))))));}
  portName(id){return this.report?.vertiports.find(p=>p.id===id)?.name||id;}
  renderPorts(){
    const ports=[...this.report.vertiports].sort((a,b)=>(b.congestion_pct||0)-(a.congestion_pct||0));
    this.content.append(this.card('버티포트별 혼잡 발생 비율','0–100% 고정 축 · 출발 지연 5분 초과 또는 도착 대기·지연 5분 초과. 시설 점유율과 구분합니다.',
      rankingChart(this.doc,ports,{label:p=>p.name,metric:p=>p.congestion_pct,format:percent,ceiling:100,limit:15,onPick:p=>this.drill({vertiport:p.id})})),
      this.card('버티포트별 일일 결과','운항 횟수는 실제 출발+착륙. 승하차 인원은 출발편+도착편 탑승객(인회)입니다.',
      this.table(['버티포트','출발 계획 / 실제','착륙 계획 / 실제','총 운항','승하차 인회','혼잡 발생','도착 대기 평균 / P95','최대 동시 대기'],
        ports.map(p=>[this.button(p.name,()=>this.drill({vertiport:p.id}),{class:'oa-text-button'}),
          `${value(p.departure.planned)} / ${value(p.departure.departed)}`,`${value(p.arrival.planned)} / ${value(p.arrival.completed)}`,
          value(p.movements),value(p.passenger_movements),`${percent(p.congestion_pct)} (${p.affected_movements}/${p.observed_movements})`,
          `${minutes(p.arrival.hold.mean_s)} / ${minutes(p.arrival.hold.p95_s)}`,value(p.peak_holding)]))));
  }
  renderFleet(){
    const fleet=[...this.report.aircraft].sort((a,b)=>b.hold_total_s-a.hold_total_s);
    this.content.append(this.card('기체별 누적 공중 대기시간','상위 15대 · 막대를 누르면 해당 기체의 전체 소티를 확인합니다.',
      rankingChart(this.doc,fleet,{label:a=>a.id,metric:a=>a.hold_total_s,format:minutes,limit:15,onPick:a=>this.drill({aircraft:a.id})})),
      this.card('투입 비행체별 평가','공중 대기와 출발 지연을 별도로 표시합니다. 평균 대기는 대기가 발생한 편 기준입니다.',
      this.table(['비행체','계획 / 완료','운항 중','운송 인회','누적 공중 대기','대기 평균 / P95','평균 출발 지연','정시 도착률'],
      fleet.map(a=>[this.button(a.id,()=>this.drill({aircraft:a.id}),{class:'oa-text-button'}),`${a.planned} / ${a.completed}`,value(a.in_progress),
        value(a.transported_passengers),minutes(a.hold_total_s),`${minutes(a.hold.mean_s)} / ${minutes(a.hold.p95_s)}`,minutes(a.departure_delay.mean_s),percent(a.on_time_pct)]))));
  }
  drill(filters){this.filters={...EMPTY_FILTERS(),...filters};this.selected=null;this.sortieData=null;this.formKey=null;this.open('sorties');}
  renderSorties(){
    this.formKey=`${this.recording}/${this.report.meta.scenario_id}`;
    const field=(label,name,options)=>{
      const select=this.e('select',{name,'aria-label':label},...options.map(([id,text])=>this.e('option',{value:id,text})));
      select.value=this.filters[name];return this.e('label',{class:'oa-filter-label'},this.e('span',{text:label}),select);
    };
    this.form=this.e('form',{class:'oa-filter-form',onsubmit:event=>{event.preventDefault();
      for(const key of ['vertiport','aircraft','status','query'])this.filters[key]=this.form.querySelector(`[name=${key}]`).value;
      this.filters.page=1;this.selected=null;void this.loadSorties();}},
      field('버티포트','vertiport',[['','전체 버티포트'],...this.report.vertiports.map(p=>[p.id,p.name])]),
      field('비행체','aircraft',[['','전체 비행체'],...this.report.aircraft.map(a=>[a.id,a.id])]),
      field('상태','status',[['','전체 상태'],...Object.entries(STATES),['held','대기 발생']]),
      this.e('label',{class:'oa-filter-label'},this.e('span',{text:'검색'}),this.e('input',{name:'query',value:this.filters.query,placeholder:'소티·기체·버티포트',maxlength:100})),
      this.e('button',{type:'submit',text:'조회',class:'oa-primary'}),this.button('필터 초기화',()=>this.drill({})));
    this.rowsNode=this.e('div',{class:'oa-sortie-results',role:'status'});this.inspector=this.e('div',{class:'oa-inspector'});
    this.content.replaceChildren(this.form);
    if(this.filters.fato)this.content.append(this.note(`배정 FATO: ${this.filters.fato}`));
    if(this.filters.decision_reason)this.content.append(this.note(`판단 사유: ${this.filters.decision_reason}`));
    if(this.filters.hour>=0)this.content.append(this.note(`${this.filters.hour}시 계획 또는 실제 착륙편`));
    if(this.filters.hold_hour>=0)this.content.append(this.note(`${this.filters.hold_hour}시에 공중 대기한 소티`));
    if(this.filters.delay_bin>=0)this.content.append(this.note(`도착 지연: ${this.report.delay_bins[this.filters.delay_bin]?.label}`));
    this.content.append(this.rowsNode,this.inspector);this.rowsNode.append(this.note('소티 기록을 불러오는 중입니다.'));
    this.content.scrollTop=0;
  }
  async loadSorties(){
    if(!this.window||this.tab!=='sorties'||!this.report?.available)return;
    const request=++this.request,version=this.version,scenario=this.report.meta.scenario_id;
    try{
      const data=await this.get(`${BASE}/sorties?${this.query(this.filters)}`);
      if(request!==this.request||version!==this.version||!this.window||this.tab!=='sorties')return;
      if(data.meta.scenario_id!==scenario){void this.refresh();return;}
      this.sortieData=data;this.filters.page=data.page;this.paintRows();
      if(this.selected)await this.inspect(this.selected,false);
    }catch{if(request===this.request&&this.rowsNode)this.rowsNode.replaceChildren(this.note('소티 기록을 읽지 못했습니다. 조회를 다시 눌러 주세요.'));}
  }
  paintRows(){
    const data=this.sortieData;if(!data||!this.rowsNode)return;
    const focused=this.focusKey(this.rowsNode);
    const prev=this.button('이전',()=>{this.filters.page--;void this.loadSorties();}),next=this.button('다음',()=>{this.filters.page++;void this.loadSorties();});
    prev.disabled=data.page<=1;next.disabled=data.page>=data.pages;
    this.rowsNode.replaceChildren(this.heading(`소티 ${value(data.total)}편`,`${data.page} / ${data.pages} 페이지`),
      this.table(['소티 / 비행체','구간','상태','계획 / 실제 출발','계획 / 실제 착륙','도착 지연','공중 대기','탑승 인원'],data.rows.map(r=>[
        this.button(`${r.flight_id} · ${r.aircraft_id}`,()=>void this.inspect(r.flight_id),{class:'oa-text-button'}),
        `${this.portName(r.origin)} → ${this.portName(r.destination)}`,STATES[r.status]||r.status,
        `${clock(r.planned_departure_s)} / ${clock(r.actual_departure_s)}`,`${clock(r.planned_arrival_s)} / ${clock(r.actual_arrival_s)}`,
        minutes(r.arrival_delta_s),minutes(r.hold_s),value(r.passengers)])),
      this.e('div',{class:'oa-pagination'},prev,next));
    if(!data.rows.length)this.rowsNode.append(this.note('선택 조건에 해당하는 소티가 없습니다.'));
    this.restoreFocus(this.rowsNode,focused);
  }
  async inspect(id,focus=true){
    this.selected=id;const request=++this.inspectRequest,version=this.version,scenario=this.report.meta.scenario_id;
    try{
      const data=await this.get(`${BASE}/sorties/${encodeURIComponent(id)}?${this.query()}`);
      if(request!==this.inspectRequest||version!==this.version||id!==this.selected||!this.window||data.meta.scenario_id!==scenario)return;
      const r=data.row;
      this.inspector.replaceChildren(this.heading(`${r.flight_id} · ${r.aircraft_id}`,STATES[r.status]),
        this.note(`${this.portName(r.origin)} → ${this.portName(r.destination)} · 계획 탑승 ${value(r.passengers)}명`),
        this.table(['운항 시점','계획','실제','차이'],[
          ['주기장 출발',clock(r.planned_departure_s),clock(r.actual_departure_s),minutes(r.departure_delta_s)],
          ['착륙',clock(r.planned_arrival_s),clock(r.actual_arrival_s),minutes(r.arrival_delta_s)],
          ['주기장 도착',clock(r.planned_in_block_s),clock(r.actual_in_block_s),'—']]),
        this.note(`FATO 계획 → 배정: 출발 ${r.planned_departure_fato||'—'} → ${r.departure_fato||'—'} · 도착 ${r.planned_arrival_fato||'—'} → ${r.arrival_fato||'—'}`),
        this.note(`누적 공중 대기 ${minutes(r.hold_s)} · 음수 지연은 계획보다 빠른 시각입니다.`),
        this.e('ol',{class:'oa-events'},...r.events.map(e=>this.e('li',{},this.e('time',{text:clock(e.time_s)}),
          this.e('strong',{text:EVENT_NAMES[e.kind]||e.kind}),this.e('span',{text:[e.energy?`SOC ${e.energy.soc_pct}% / 사용 ${e.energy.flight_used_kwh} kWh / 부족 ${e.energy.flight_deficit_kwh} kWh / 충전 입력 ${e.energy.flight_grid_kwh} kWh (추정)`:null,e.reason,e.fato, ...(e.blockers||[]).map(b=>b.flight_id)].filter(Boolean).join(' · ')})))));
      if(this.recording==='current')this.inspector.append(this.button('현재 기체 지도에서 보기',()=>this.onAircraft(r.aircraft_id)));
      if(focus)this.inspector.scrollIntoView?.({block:'nearest',behavior:'smooth'});
    }catch{if(request===this.inspectRequest&&version===this.version&&id===this.selected&&this.inspector)this.inspector.replaceChildren(this.note('소티 세부 기록을 읽지 못했습니다. 편명을 다시 눌러 주세요.'));}
  }
}
