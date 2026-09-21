import {buildElement} from '../../../dom_builder.js';
import {roleCard} from './operations_session.js';
import {layoutView,weatherIcon} from '../../../vertiport_layout_view.js';
import {routeMovements,groundRouteLegend,routeMotionEnabled} from '../../../vertiport_ground_routes.js';
import {MINUTE,RESOURCE_NAMES,STATUS,resourcesOf,rehearsalSchedule,resourceState,flightStatus,nearestWeather,weatherSymbol,timeLabel,PSU_REPORTS,reportDraft} from '../../../vertiport_operations.js';
// How many times, and from what delay, the list is asked for again after it
// failed to arrive: 1.5 s, 3 s, 6 s, 12 s covers a server restart.
export const LIST_RETRIES=4,LIST_RETRY_MS=1500;
import {boardFrom,describeMovement,movementsOf,occupancyCounts,occupancyFrom} from '../../../vertiport_occupancy.js';
import {describePilotDecision} from './pilot_decision.js';
const number=(v,suffix='',digits=0)=>Number.isFinite(v)?`${v.toFixed(digits)}${suffix}`:'—';
const REASONS=['시설 점검','지상 작업','장애물 확인','기상 영향','운영 조정'];

export class VertiportPanel {
  constructor({document=globalThis.document,host=document.body,api={},selectInView=()=>null,onFocus=()=>{},onFocusAircraft=()=>{},onOpen=()=>{},now=()=>Date.now(),session=null,listRetryMs=LIST_RETRY_MS}={}) {
    Object.assign(this,{document,host,api,selectInView,onFocus,onFocusAircraft,onOpen,now,session,listRetryMs});
    this.records=[];this.selectedId=null;this.drafts=new Map();this.demo=true;this.weather=null;this.generation=0;this.dead=false;this.expanded=false;
    // What the day being flown says this deck is doing. Null until one is
    // loaded and answering; while it is, it replaces the example projection
    // everywhere rather than sitting beside it, because two pictures of the
    // same deck is worse than either.
    this.live=null;this.liveBusy=false;this.liveAt=0;
    this.unsubscribe=session?.subscribe(()=>this.updateShared());
  }
  el(tag,props={},...children){return buildElement(this.document,tag,props,...children);}
  button(label,action,props={}){return this.el('button',{type:'button',text:label,onclick:action,...props});}
  get record(){return this.records.find(r=>r.id===this.selectedId);}
  get draft(){if(!this.drafts.has(this.selectedId))this.drafts.set(this.selectedId,{closures:{},messages:[],selected:null});return this.drafts.get(this.selectedId);}
  get flights(){
    if(!this.demo||!this.record)return [];
    const hour=Math.floor(this.now()/(60*MINUTE)),cache=this.scheduleCache;
    if(cache?.record!==this.record||cache?.records!==this.records||cache?.hour!==hour)
      this.scheduleCache={record:this.record,records:this.records,hour,flights:rehearsalSchedule(this.record,this.records,this.now())};
    return this.scheduleCache.flights;
  }
  // The resource states in force: the day's if one is being flown, otherwise
  // the example projection (and nothing at all if that is switched off).
  get occupancy(){
    if(!this.live||!this.record)return null;
    return occupancyFrom(this.live,resourcesOf(this.record),this.draft.closures);
  }
  get liveSource(){return this.live?`${this.live.source==='physical'?'Physical':'재생 중'} · ${this.live.clock}${this.live.stale?' · 수신 지연':''}`:null;}
  async readLive(){
    if(this.liveBusy||this.dead||!this.selectedId||typeof this.api.scenarioVertiport!=='function')return;
    this.liveBusy=true;const id=this.selectedId,generation=this.generation;
    try{
      const state=await this.api.scenarioVertiport(id);
      if(this.dead||generation!==this.generation||this.selectedId!==id)return;
      this.live=state&&state.vertiport_id===id?state:null;
    }catch{
      // No day loaded, or it has been closed. The example view is what is left.
      if(!this.dead)this.live=null;
    }finally{
      this.liveBusy=false;this.liveAt=this.now();
      if(this.dead)return;
      // A day starting or ending changes which of the two pictures this panel
      // is showing, and that is written into the form rather than into the
      // cards. Redrawn only when it flips, so a poll every three seconds does
      // not rebuild the form under the operator.
      const showing=Boolean(this.live);
      if(showing!==this.showingLive){this.showingLive=showing;this.drawSide();if(this.console)this.drawConsole();}
      else this.updateLive();
    }
  }
  async showInfo(id){
    this.closeInfo();
    const token=this.infoToken=(this.infoToken??0)+1;
    this.info=this.el('section',{class:'vp-selection-info',role:'dialog','aria-label':'버티포트 실시간 정보'});
    const body=this.el('div',{class:'vp-selection-body'});
    this.info.append(this.el('header',{},this.el('strong',{text:'VERTIPORT · 실시간 이용 정보'}),this.button('×',()=>this.closeInfo(),{'aria-label':'버티포트 정보 닫기'})),body);
    this.host.append(this.info);this.savedSide=this.side;this.side=body;this.demo=false;this.selectedId=id;this.live=null;
    body.append(this.el('p',{text:'버티포트 정보를 불러오는 중입니다.'}));
    await this.refresh();
    if(token!==this.infoToken||!this.info)return;
    this.choose(id);this.start();
    if(this.record?.id===id)this.onFocus(this.record);
  }
  closeInfo(){
    this.infoToken=(this.infoToken??0)+1;
    if(!this.info)return;
    this.info.remove();this.info=null;this.side=this.savedSide??null;this.savedSide=null;
    if(!this.side&&!this.console){clearInterval(this.timer);clearInterval(this.liveTimer);this.timer=null;this.liveTimer=null;}
  }
  render(body){
    this.side=body;this.drawSide();this.start();this.ready=this.refresh();
  }
  deactivate(){this.side=null;}
  start(){
    if(!this.timer)this.timer=setInterval(()=>{
      if(this.dead||this.document.hidden||(!this.side?.isConnected&&!this.console))return;
      this.updateLive();if(!this.weatherBusy&&this.now()-(this.weatherReadAt??0)>MINUTE)void this.readWeather();
    },15000);
    this.timer?.unref?.();
    // A deck's occupancy changes on the scale of a landing, not of a weather
    // report, so it is read on its own clock.
    if(!this.liveTimer)this.liveTimer=setInterval(()=>{
      if(this.dead||this.document.hidden||(!this.side?.isConnected&&!this.console))return;
      void this.readLive();
    },3000);
    this.liveTimer?.unref?.();
    void this.readLive();
  }
  async refresh(){
    const generation=++this.generation;this.error='';
    clearTimeout(this.retryTimer);this.retryTimer=null;
    try{const result=await this.api.list?.();if(this.dead||generation!==this.generation)return;
      this.records=(result?.vertiports??[]).filter(r=>r.id&&r.layout);
      this.retries=0;
      if(!this.record)this.selectedId=this.records[0]?.id??null;
      this.drawSide();if(this.console)this.drawConsole();
    }catch{if(!this.dead&&generation===this.generation){
      // A list that did not arrive is usually a server on its way back up, not
      // a list that does not exist: ask again on a widening clock a few times
      // before leaving it to the operator's own button.
      const retry=(this.retries=(this.retries??0)+1)<=LIST_RETRIES;
      this.error=retry?'버티포트 목록을 받지 못했습니다. 잠시 후 다시 시도합니다.':'버티포트 목록을 받지 못했습니다. 다시 시도해 주세요.';
      this.drawSide();
      if(retry)this.retryTimer=setTimeout(()=>{this.retryTimer=null;if(!this.dead&&(this.side||this.console)&&generation===this.generation)void this.refresh();},this.listRetryMs*2**(this.retries-1));
    }}
    await this.readWeather();
  }
  async readWeather(){
    if(this.weatherBusy||this.dead)return;this.weatherBusy=true;
    try{const weather=await this.api.weather?.();if(!this.dead){this.weather=weather;this.weatherError=false;}}
    catch{this.weatherError=true;}finally{this.weatherBusy=false;this.weatherReadAt=this.now();if(!this.dead)this.updateLive();}
  }
  choose(id){if(!this.records.some(r=>r.id===id))return;this.selectedId=id;this.notice='';this.live=null;this.showingLive=false;void this.readLive();this.drawSide();if(this.console)this.drawConsole();}
  chooseView(){const result=this.selectInView(this.records);if(result)this.choose(typeof result==='string'?result:result.id);
    else{this.notice='현재 시야 안에 버티포트가 없습니다. 지도를 이동하거나 목록에서 선택해 주세요.';this.drawSide();}}
  drawSide(){
    if(!this.side)return;const e=this.el.bind(this);this.side.textContent='';
    const root=e('div',{class:'vp-workspace'});this.side.append(root);
    const select=e('select',{id:'vp-select','aria-label':'관리 버티포트',onchange:event=>this.choose(event.target.value)},
      ...this.records.map(r=>e('option',{value:r.id,...(r.id===this.selectedId?{selected:''}:{}),text:r.name??r.id})));
    root.append(this.button('버티포트 Control Panel 열기 ↗',()=>this.open(),{class:'stakeholder-launch',...(this.record?{}:{disabled:''})}),e('label',{class:'vp-label',for:'vp-select',text:'관리 버티포트'}),select,
      e('div',{class:'vp-actions'},this.button('시점 내 버티포트 선택',()=>this.chooseView()),this.button('↻',()=>void this.refresh(),{'aria-label':'버티포트 목록 새로고침'})));
    if(this.error)root.append(e('p',{role:'alert',class:'vp-warning',text:this.error}));
    if(this.notice)root.append(e('p',{role:'status',class:'vp-note',text:this.notice}));
    if(!this.record){root.append(e('p',{class:'vp-note',text:this.records.length?'버티포트를 선택해 주세요.':'저장된 버티포트가 없습니다. Simulation에서 먼저 배치해 주세요.'}));return;}
    root.append(e('div',{class:'stakeholder-summary-heading'},e('strong',{text:'시설 운항 요약'}),
      this.sideClock=e('span',{class:'ops-tag'})),this.button('지도에서 보기',()=>this.onFocus(this.record),{class:'stakeholder-side-link'}));
    this.sideLayout=e('div');this.sideWeather=e('div');
    root.append(this.sideLayout,this.sideWeather,e('p',{class:'vp-note',text:'레이아웃·시간표·시설 관리와 공유 운영 연습은 Control Panel에서 확인합니다.'}));
    this.updateLive();
  }
  legend(){const e=this.el.bind(this);return e('div',{class:'vp-legend'},...['free','occupied','reserved','closed','conflict','unknown'].map(s=>e('span',{'data-state':s,text:STATUS[s]})));}
  get groundMovements(){return routeMovements(this.live?movementsOf(this.live):null,this.flights,this.now(),this.demo);}
  get routeAnimation(){return routeMotionEnabled(this.document,this.routeMotion);}
  routeLegend(){return groundRouteLegend(this.document,resourcesOf(this.record),this.groundMovements,{demo:!this.live&&this.demo,motion:this.routeAnimation,onMotion:value=>{this.routeMotion=value;this.updateLive();}});}
  diagram(){return layoutView(this.document,this.record,resourcesOf(this.record),this.flights,this.draft.closures,this.now(),{demo:this.demo,selected:this.draft.selected,states:this.occupancy,movements:this.groundMovements,motion:this.routeAnimation,onSelect:key=>{this.draft.selected=key;this.open();}});}
  counts(){
    const e=this.el.bind(this),resources=resourcesOf(this.record),occupancy=this.occupancy;
    const live=occupancy?occupancyCounts(occupancy,resources):null;
    return e('div',{class:'vp-counts'},...Object.entries(RESOURCE_NAMES).map(([kind,label])=>{
      const rows=resources.filter(x=>x.kind===kind);
      if(live){
        const row=live[kind]??{busy:0,total:rows.length,known:0};
        // A kind the day says nothing about is a dash, not a zero: the engine
        // routes nothing along the ground, so a taxiway is unknown, not free.
        const value=row.known?`${row.busy} / ${row.total}`:`— / ${row.total}`;
        return e('div',{},e('span',{text:label}),e('strong',{text:value}),e('small',{text:row.known?'점유 / 전체':'미집계 / 전체'}));
      }
      const busy=rows.filter(x=>['occupied','conflict'].includes(resourceState(x,this.flights,this.draft.closures,this.now(),this.demo).state)).length;
      return e('div',{},e('span',{text:label}),e('strong',{text:`${this.demo?busy:'—'} / ${rows.length}`}),e('small',{text:'점유 / 전체'}));}));}
  updateLive(){
    if(!this.record)return;
    if(this.side){
      const e=this.el.bind(this),live=this.live,rows=boardFrom(live??{});
      this.sideClock.textContent=live?`${live.source==='physical'?'Physical':'재생'} ${live.clock}${live.stale?' · 지연':''}`:this.demo?'예시 일정':'미연결';
      const standing=Array.isArray(live?.standing)?live.standing.length:0;
      const arriving=rows.filter(r=>r.direction==='arrival'&&!r.holding).length;
      const waiting=rows.filter(r=>r.holding).length;
      this.sideLayout?.replaceChildren(e('div',{class:'stakeholder-metrics'},...[
        ['주기',standing],['접근 진행',arriving],['착륙 대기',waiting]].map(([label,n])=>e('div',{},e('strong',{text:live?n:'—'}),e('span',{text:label})))));
      const point=nearestWeather(this.record,this.weather,this.now()),[,label]=weatherSymbol(point);
      if(this.info&&this.sideLayout){this.sideLayout.append(this.counts(),...this.groundCard());const board=this.el('div');this.fillBoard(board);this.sideLayout.append(board);}
      this.sideWeather?.replaceChildren(e('section',{class:'stakeholder-weather'},e('strong',{text:'주변 기상'}),
        e('span',{text:`${label} · ${number(point?.temperature_c,'°C',1)} · 바람 ${number(point?.wind_speed_ms,' m/s',1)}`}),
        e('small',{text:point?`${point.stale?'이전 자료':'모델 추정'} / ${point.distance_km>50?'광역':'근접'} 표본 · 지상 참고값${this.weatherError?' · 갱신 실패':''}`:'수신 대기 · 운항 판단용 아님'})));
    }
    if(this.console){
      this.scenarioDeck?.updateSnapshot(this.live);
      this.consoleClock.textContent=this.liveSource??`${timeLabel(this.now())} KST · 예시`;
      if(!this.collapsed){
        const flowFocused=this.document.activeElement?.matches?.('.vp-route-motion');
        if(flowFocused||!this.consoleLayout.contains?.(this.document.activeElement)){
          this.consoleLayout.replaceChildren(this.diagram(),this.routeLegend(),this.counts(),this.legend(),...this.groundCard());
          if(flowFocused)this.consoleLayout.querySelector('.vp-route-motion')?.focus?.({preventScroll:true});
        }
        if(!this.timeline.contains?.(this.document.activeElement))this.fillTimeline();
        this.updateResourceStatus();this.consoleWeather?.replaceChildren(this.weatherCard());
        if(!this.consoleBoard?.contains?.(this.document.activeElement))this.fillBoard(this.consoleBoard);
      }
    }
  }
  // What is moving on this surface right now: taxiing out, lifting off, landing,
  // rolling in. This is the deck operator's own job - the aircraft is on their
  // ground - so it sits under the layout rather than in the arrivals board.
  groundCard(){
    if(!this.live)return [];
    const e=this.el.bind(this),moves=movementsOf(this.live);
    const list=e('div',{class:'vp-ground'});
    if(!moves.length)list.append(e('p',{class:'vp-note',text:'지금 이 시설 지상에서 움직이는 기체가 없습니다.'}));
    for(const move of moves){
      const decision=describePilotDecision({state:move}),ground=decision.source==='버티포트 지상 통제';
      list.append(e('div',{class:'vp-move','data-phase':move.phase,'data-direction':move.direction},
        e('strong',{text:move.flight_id??move.aircraft_id}),
        e('span',{class:'vp-move-path',text:move.from&&move.to&&move.from!==move.to?`${move.from} → ${move.to}`:(move.to??move.from??'—')}),
        e('small',{title:describeMovement(move),text:this.moveLabel(move)}),
        ...(ground?[e('small',{class:'vp-note',text:[decision.reason,
          ...decision.fields.filter(field=>['blocked_by','planned_stand','assigned_stand','gate_reason'].includes(field.key))
            .map(field=>`${field.label}: ${field.value}`)].join(' · ')})]:[])));
    }
    return [e('div',{class:'vp-card-head vp-ground-head'},e('strong',{text:'지상 이동'}),
      e('span',{class:'vp-source',text:`${moves.length}대 · ${this.live.clock}`})),list];
  }
  moveLabel(move){
    const decision=describePilotDecision({state:move});
    if(decision.source==='버티포트 지상 통제')return decision.title;
    return {gate_out:'유도로 이동',takeoff:'이륙',landing:'착륙',gate_in:'유도로 이동',charge:'충전'}[move.phase]??move.phase;
  }
  weatherCard(){
    const e=this.el.bind(this),point=nearestWeather(this.record,this.weather,this.now()),[kind,label]=weatherSymbol(point),degree=point?.wind_direction_deg;
    const directions=['북','북동','동','남동','남','남서','서','북서'],direction=Number.isFinite(degree)?directions[Math.round(degree/45)%8]:'—';
    const card=e('section',{class:'vp-card'},e('div',{class:'vp-card-head'},e('strong',{text:'주변 기상'}),e('span',{class:'vp-source',text:point?(point.stale?'이전 자료':'모델 추정'):'수신 대기'})),
      e('div',{class:'vp-weather'},weatherIcon(this.document,kind),e('div',{},e('strong',{text:label}),e('div',{class:'vp-temperature',text:number(point?.temperature_c,'°C',1)})),
      e('div',{class:'vp-wind'},e('strong',{text:number(point?.wind_speed_ms,' m/s',1)}),e('span',{text:`${direction}풍 · ${number(degree,'°')}에서`}),e('small',{text:`돌풍 ${number(point?.wind_gust_ms,' m/s',1)}`}))));
    card.append(e('p',{class:'vp-note',text:point?`${point.distance_km>50?'광역':'근접'} 표본 ${point.distance_km.toFixed(1)} km · ${Number.isFinite(point.observed_ms)?timeLabel(point.observed_ms)+' KST':'시각 미상'}${this.weatherError?' · 갱신 실패':''}`:'기상 자료 없음. Library의 Weather 연결을 확인해 주세요.'}),
      e('p',{class:'vp-note'},e('a',{href:'https://open-meteo.com/',target:'_blank',rel:'noopener noreferrer',text:'Open-Meteo'}),' · 지상 10 m 바람 참고값 / 운항 판단용 아님'));
    return card;
  }
  fillBoard(host){
    if(!host)return;
    if(this.live){this.fillLiveBoard(host);return;}
    const old=host.querySelector?.('.vp-board-scroll')?.scrollTop??0,e=this.el.bind(this),now=this.now();
    const flights=this.flights.filter(f=>f.at>=now-15*MINUTE&&f.at<=now+90*MINUTE);
    const table=e('table',{class:'vp-board'},e('thead',{},e('tr',{},...['시각','편명','출/도착','배정','상태'].map(t=>e('th',{text:t})))),
      e('tbody',{},...flights.map(f=>e('tr',{},e('td',{class:'vp-mono',text:timeLabel(f.at)}),e('td',{text:f.callsign.replace(' ','')}),
        e('td',{title:`${f.direction==='arrival'?'도착':'출발'} · ${f.counterpart}`,text:`${f.direction==='arrival'?'↘':'↗'} ${f.counterpart}`}),
        e('td',{title:`Gate ${f.gate} / FATO ${f.fato}`,text:`${f.gate}/${f.fato}`}),e('td',{'data-warning':String(flightStatus(f,this.draft.closures,now)==='조정 필요'),title:flightStatus(f,this.draft.closures,now),text:flightStatus(f,this.draft.closures,now)})))));
    const scroll=e('div',{class:'vp-board-scroll',tabindex:'0','aria-label':'현재 시각 기준 예시 운항 시간표'},table);scroll.scrollTop=old;
    host.replaceChildren(e('section',{class:'vp-card'},e('div',{class:'vp-card-head'},e('strong',{text:'ARR / DEP'}),e('span',{class:'vp-source',text:`${this.demo?'예시':'미연결'} · ${timeLabel(now)} KST`})),
      flights.length?scroll:e('p',{class:'vp-note',text:'연결된 운항 일정이 없습니다. 예시 일정을 켜면 화면 구성을 확인할 수 있습니다.'})));
    scroll.scrollTop=old;
  }
  // The same board, filled from the day rather than from the example schedule.
  // The columns are what the engine actually knows: who, from or to where, which
  // stand, and what they are doing. No arrival time is shown, because the day is
  // being flown and the time it lands is not yet decided.
  fillLiveBoard(host){
    const e=this.el.bind(this),old=host.querySelector?.('.vp-board-scroll')?.scrollTop??0;
    const rows=boardFrom(this.live);
    const table=e('table',{class:'vp-board vp-board-live'},e('thead',{},e('tr',{},...['편명','기체','출/도착','배정','상태'].map(t=>e('th',{text:t})))),
      e('tbody',{},...rows.map(row=>e('tr',{class:'vp-focus-row',tabindex:'0',role:'button',
        'aria-label':`${row.aircraft??row.callsign} 기체로 이동`,
        onclick:()=>this.onFocusAircraft(row.aircraft),
        onkeydown:event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();this.onFocusAircraft(row.aircraft);}},},
        e('td',{class:'vp-mono',title:row.callsign,text:row.callsign}),
        e('td',{class:'vp-mono',title:row.aircraft,text:row.aircraft}),
        e('td',{title:`${row.direction==='arrival'?'도착':'출발'} · ${row.counterpart??'—'}`,
          text:`${row.direction==='arrival'?'↘':'↗'} ${row.counterpart??'—'}`}),
        e('td',{text:row.planned_stand&&row.planned_stand!==row.stand?`${row.planned_stand} → ${row.stand??'미확보'}`:row.stand??'—',
          title:`계획 Gate ${row.planned_stand??'미제공'} / 배정 Gate ${row.stand??'미확보'}${row.gate_reason?` · ${row.gate_reason}`:''}`}),
        e('td',{'data-warning':String(row.holding||row.ground_waiting),
          title:row.reason?[row.reason,row.blocked_by?`통과 대기 기체: ${row.blocked_by}`:''].filter(Boolean).join(' · ')
            :row.holding?`PSU 대기 ${Math.round(row.hold_seconds)}초`:row.status,text:row.status})))));
    const scroll=e('div',{class:'vp-board-scroll',tabindex:'0','aria-label':'재생 중인 비행계획의 도착·출발'},table);
    host.replaceChildren(e('section',{class:'vp-card'},
      e('div',{class:'vp-card-head'},e('strong',{text:'ARR / DEP'}),e('span',{class:'vp-source',text:this.liveSource})),
      rows.length?scroll:e('p',{class:'vp-note',text:'이 버티포트를 오가는 기체가 지금은 없습니다.'})));
    scroll.scrollTop=old;
  }
  open(){if(!this.record)return;this.closeInfo();this.onOpen();this.collapsed=false;this.drawConsole();this.start();}
  close(){this.scenarioDeck?.destroy();this.observer?.disconnect();this.console?.remove();this.console=null;this.document.body?.removeAttribute('data-vp-console');this.document.body?.style?.removeProperty?.('--vp-console-height');this.side?.querySelector?.('.stakeholder-launch')?.focus?.();}
  fold(){this.collapsed=!this.collapsed;this.console.setAttribute('data-collapsed',String(this.collapsed));this.consoleBody.hidden=this.collapsed;this.consoleBody.inert=this.collapsed;this.foldButton.setAttribute('aria-expanded',String(!this.collapsed));this.foldButton.setAttribute('aria-label',this.collapsed?'버티포트 컨트롤 펼치기':'버티포트 컨트롤 접기');this.foldButton.focus?.();this.updateLive();this.measure();}
  measure(){const height=this.console?.getBoundingClientRect?.().height??0;this.document.body?.style?.setProperty?.('--vp-console-height',`${height+10}px`);}
  drawConsole(){
    if(!this.record){this.close();return;}
    const e=this.el.bind(this);this.observer?.disconnect();this.console?.remove();
    this.console=e('section',{class:'vp-console stakeholder-console','aria-label':'버티포트 운영 컨트롤','data-expanded':String(this.expanded),'data-collapsed':String(Boolean(this.collapsed))});this.document.body?.setAttribute('data-vp-console','true');
    this.consoleClock=e('span',{class:'vp-console-clock'});
    this.foldButton=this.button('',()=>this.fold(),{class:'vp-fold','aria-label':this.collapsed?'버티포트 컨트롤 펼치기':'버티포트 컨트롤 접기','aria-expanded':String(!this.collapsed)});
    this.foldButton.append(this.el('span',{'aria-hidden':'true',class:'vp-chevron'}));
    this.expandButton=this.button(this.expanded?'기본 크기':'넓게 보기',()=>{this.expanded=!this.expanded;this.console.setAttribute('data-expanded',String(this.expanded));this.expandButton.textContent=this.expanded?'기본 크기':'넓게 보기';this.measure();},{class:'stakeholder-size-button','aria-label':'버티포트 화면 크기 전환'});
    this.console.append(e('header',{class:'vp-console-header stakeholder-console-header'},e('div',{},e('small',{text:'VERTIPORT OPERATIONS'}),e('h2',{text:'버티포트 Control Panel'})),this.consoleClock,this.expandButton,
      this.foldButton,this.button('×',()=>this.close(),{'aria-label':'버티포트 컨트롤 닫기',class:'vp-close'})));
    this.consoleLayout=e('div');this.timeline=e('div',{class:'vp-timeline'});
    this.resourceDetails=e('div',{class:'vp-resource-details'});this.psu=e('div',{class:'vp-psu'});
    this.consoleBoard=e('div');this.consoleWeather=e('div');this.monitorHost=e('div',{class:'stakeholder-scenario'});
    const scope=e('div',{class:'vp-scope'},e('strong',{text:this.record.name??this.record.id}),e('span',{text:this.live?'재생 중인 비행계획':'운영 연습 / 실제 비행계획 미연결'}));
    if(!this.live)scope.append(e('label',{},e('input',{type:'checkbox',...(this.demo?{checked:''}:{}),onchange:event=>{this.demo=event.target.checked;this.drawSide();this.drawConsole();}}),'예시 일정 표시'));
    if(this.session)this.roleCard=roleCard(this.document,this.session,'vertiport',()=>this.selectedId);
    this.consoleBody=e('div',{class:'vp-console-body'},e('div',{class:'vp-console-left'},scope,this.consoleLayout,this.resourceDetails,this.consoleWeather),
      e('div',{class:'vp-console-right'},this.consoleBoard,e('details',{class:'stakeholder-detail-section'},e('summary',{text:'대기 상세 · FATO 예약'}),this.monitorHost),
        e('details',{class:'stakeholder-detail-section'},e('summary',{text:'자원 점유 전망 · 예시 일정'}),this.timeline),
        e('details',{class:'stakeholder-detail-section'},e('summary',{text:'시설 보고 · 공유 운영 연습'}),this.roleCard?.node,this.psu)));
    this.consoleBody.hidden=Boolean(this.collapsed);this.consoleBody.inert=Boolean(this.collapsed);
    this.console.append(this.consoleBody);this.host.append(this.console);
    this.console.onkeydown=event=>{if(event.key==='Escape'){event.stopPropagation();if(!this.collapsed)this.fold();else this.close();}};
    this.drawResource();this.drawPsu();this.updateLive();this.scenarioDeck?.renderSnapshot(this.monitorHost,this.live);
    const Observer=this.document.defaultView?.ResizeObserver;if(Observer){this.observer=new Observer(()=>this.measure());this.observer.observe(this.console);}this.measure();
  }
  fillTimeline(){
    if(!this.timeline)return;const e=this.el.bind(this),now=this.now(),start=now-15*MINUTE,span=90*MINUTE;
    const top=this.timeline.scrollTop??0,left=this.timeline.scrollLeft??0;
    const rows=resourcesOf(this.record).map(r=>{
      const state=resourceState(r,this.flights,this.draft.closures,now,this.demo),track=e('div',{class:'vp-time-track','data-state':state.state});
      for(const f of this.flights)for(const b of f.bookings){if(b.key!==r.key||b.end<=start||b.start>=start+span)continue;
        const from=Math.max(0,(b.start-start)/span)*100,to=Math.min(1,(b.end-start)/span)*100;
        track.append(e('span',{class:'vp-booking',style:`left:${from}%;width:${to-from}%`,title:`예시 ${f.callsign} · ${timeLabel(b.start)}–${timeLabel(b.end)}`,text:f.callsign}));}
      if(this.draft.closures[r.key])track.append(e('span',{class:'vp-closed-band',style:`left:${100/6}%;right:0`,text:'연습 폐쇄'}));
      track.append(e('i',{class:'vp-time-now',style:`left:${100/6}%`}));
      return e('div',{class:'vp-time-row'},this.button(`${RESOURCE_NAMES[r.kind]} ${r.id}`,()=>{this.draft.selected=r.key;this.drawResource();this.updateLive();},{'data-state':state.state}),track);
    });
    this.timeline.replaceChildren(e('div',{class:'vp-time-content'},e('div',{class:'vp-time-scale'},e('span',{text:'자원'}),e('div',{},...[0,15,30,45,60,75,90].map(m=>e('span',{text:m===15?'현재':timeLabel(start+m*MINUTE)})))),...rows));
    this.timeline.scrollTop=top;this.timeline.scrollLeft=left;
  }
  drawResource(){
    const e=this.el.bind(this),resources=resourcesOf(this.record);
    if(!resources.some(r=>r.key===this.draft.selected))this.draft.selected=resources[0]?.key;
    const r=resources.find(x=>x.key===this.draft.selected);this.resourceDetails.textContent='';if(!r)return;
    const select=e('select',{'aria-label':'운영 자원 선택',onchange:event=>{this.draft.selected=event.target.value;this.drawResource();this.updateLive();}},...resources.map(x=>e('option',{value:x.key,...(x.key===r.key?{selected:''}:{}),text:`${RESOURCE_NAMES[x.kind]} ${x.id}`})));
    this.resourceStatus=e('span',{class:'vp-resource-status'});
    this.reason=e('select',{'aria-label':'시설 제한 사유',onchange:event=>{this.draft.reason=event.target.value;}},...REASONS.map(t=>e('option',{value:t,text:t})));
    this.reason.value=this.draft.reason??REASONS[0];
    this.restrictionButton=this.button('',()=>{const draft=this.draft,key=draft.selected;if(draft.closures[key])delete draft.closures[key];else draft.closures[key]={reason:this.reason.value||REASONS[0],at:this.now()};this.updateLive();}, {class:'vp-restrict'});
    this.resourceDetails.append(e('div',{class:'vp-card-head'},e('strong',{text:'선택 자원'}),this.resourceStatus),select,e('div',{class:'vp-actions'},this.reason,this.restrictionButton),
      e('p',{class:'vp-note',text:'폐쇄는 이 화면의 연습 상태만 변경합니다. 점유 중인 자원은 해제하지 않고 충돌로 표시합니다.'}));
    this.updateResourceStatus();
  }
  updateResourceStatus(){
    const r=resourcesOf(this.record).find(x=>x.key===this.draft.selected);if(!r||!this.resourceStatus)return;
    const state=this.occupancy?.get(r.key)??resourceState(r,this.flights,this.draft.closures,this.now(),this.demo);
    this.resourceStatus.textContent=`${STATUS[state.state]}${state.occupants.length?' · '+state.occupants.join(', '):''}`;
    this.resourceStatus.title=state.reason?`제한 사유: ${state.reason}`:'';
    this.resourceStatus.setAttribute('data-state',state.state);this.restrictionButton.textContent=this.draft.closures[r.key]?'연습 재개':'연습 폐쇄';
  }
  drawPsu(){
    const e=this.el.bind(this);this.psu.textContent='';
    this.reportType=e('select',{'aria-label':'PSU 보고 종류',onchange:event=>{this.draft.reportType=event.target.value;}},...PSU_REPORTS.map(([id,label])=>e('option',{value:id,text:label})));this.reportType.value=this.draft.reportType??PSU_REPORTS[0][0];
    this.memo=e('input',{type:'text',maxlength:'240',placeholder:'사유 또는 요청 사항 (선택)','aria-label':'PSU 보고 메모',value:this.draft.memo??'',oninput:event=>{this.draft.memo=event.target.value;}});
    this.messages=e('div',{class:'vp-message-log',role:'log','aria-label':'PSU 로컬 보고 초안'});
    this.psu.append(e('div',{class:'vp-card-head'},e('strong',{text:'PSU 협조 요청'}),e('span',{class:'vp-source',text:this.session?'공유 연습 / 실운항 미연결':'서울 PSU · 미연결'})),
      e('div',{class:'vp-report-form'},this.reportType,this.memo,this.button('보고 초안 추가',()=>{
        const resource=resourcesOf(this.record).find(r=>r.key===this.draft.selected);
        this.draft.messages.unshift(reportDraft(this.record,this.reportType.value,resource,this.memo.value||'',this.now()));this.draft.messages.length=Math.min(30,this.draft.messages.length);this.memo.value='';this.draft.memo='';this.drawMessages();})),
      e('p',{class:'vp-note',text:'위 초안은 이 화면에만 보관됩니다. 새로고침하면 초기화됩니다.'}),this.messages);this.drawMessages();
    if(this.session){
      this.sharedSend=this.button('공유 연습방에 시설 보고',()=>{
        const resource=resourcesOf(this.record).find(r=>r.key===this.draft.selected),label=PSU_REPORTS.find(([id])=>id===this.reportType.value)?.[1]??'시설 보고';
        void this.session.action('/reports',{facility_id:this.selectedId,note:`${label} / ${resource?.id??'시설 전체'} / ${this.memo.value||'상태 확인 요청'}`.slice(0,240)});
      });this.sharedStatus=e('p',{class:'vp-note',role:'status'});this.sharedReplies=e('div',{class:'ops-shared-replies','aria-label':'담당 시설 공유 요청과 PSU 응답'});
      this.psu.append(this.sharedSend,this.sharedStatus,this.sharedReplies);this.updateShared();
    }
  }
  updateShared(){
    this.roleCard?.update();if(!this.session||!this.sharedSend)return;
    const member=this.session.member,allowed=member?.role==='vertiport'&&member.facility_id===this.selectedId;
    this.sharedSend.disabled=!this.session.online||!allowed||this.session.mutating;
    this.sharedStatus.textContent=this.session.error||(!allowed?'시설 보고 · 공유 운영 연습에서 이 버티포트 담당으로 입장해 주세요.':'같은 서버의 PSU에게 연습 보고를 공유합니다. 실제 시설 폐쇄·허가·비행 제어는 변경하지 않습니다.');
    const states={pending:'PSU 검토 대기',acknowledged:'PSU 보고 확인',hold:'대기 요청',proceed:'진행 응답',resequence:'순서 조정',rejected:'보류 종료'};
    this.sharedReplies.replaceChildren(...(this.session.data?.requests??[]).filter(r=>r.facility_id===this.selectedId).slice(-10).reverse().map(r=>this.el('p',{text:`${r.callsign} · ${states[r.state]??r.state}${r.responder?' / '+r.responder:''}${r.response?' — '+r.response:''}`})));
  }
  drawMessages(){const e=this.el.bind(this);this.messages?.replaceChildren(...this.draft.messages.map(m=>e('div',{},e('time',{text:timeLabel(m.created_at)}),e('strong',{text:m.label}),e('span',{text:`${m.resource_id??'시설 전체'} · 미전송`}),e('small',{text:m.reason||'메모 없음'}))));}
  destroy(){this.closeInfo();this.dead=true;clearTimeout(this.retryTimer);this.retryTimer=null;this.unsubscribe?.();this.generation++;clearInterval(this.timer);this.timer=null;clearInterval(this.liveTimer);this.liveTimer=null;this.close();this.side=null;}
}
