// A read-only view of the existing twin stream. Configuration is still owned
// by LibraryPanel; the monitor keeps only bounded display telemetry, never a
// second entity store. Packet arrival and physical observation age differ.
import {LibraryPanel, describeState} from '../../../library_panel.js';
import {PhysicalUamPanel} from './physical_uam_panel.js';
import {TwinningTestPanel} from './twinning_test_panel.js';

const SOURCE_IDS = {opensky:'aircraft',celestrak:'satellite',open_meteo:'weather'};
const AI_IDS = ['state_estimation','trajectory_prediction','uam_prediction'];
const BAD = new Set(['error','unavailable','stale']);
const n = value => value == null ? '—' : value.toLocaleString('ko-KR');
const seconds = value => value == null ? '—' : value < 60 ? `${value.toFixed(1)}초` : `${Math.floor(value/60)}분 ${Math.floor(value%60)}초`;
const time = value => Number.isFinite(value) ? new Date(value*1000).toISOString().slice(11,19) : '—';

export class TwinTelemetry {
  constructor(){this.reset();}
  reset(){this.receivedAt=null;this.advancedAt=null;this.stateTime=null;this.epoch=null;this.sequence=null;this.interval=null;
    this.startedAt=null;this.buckets=[];this.sources=[];this.capabilities={};this.counts={aircraft:0,satellite:0,uam:0};
    this.derivations={observed:0,estimated:0,simulated:0,other:0};this.total=0;this.observationAge=null;this.fixture=false;}
  observe(snapshot,now=Date.now()){
    if(!snapshot || !Array.isArray(snapshot.entities))return false;
    const epoch=snapshot.epoch??0;
    if(this.epoch!==null && epoch!==this.epoch)this.reset();
    // Match the stream's (epoch, state time, sequence) ordering. A restarted
    // live server can keep epoch 0 while its sequence starts over at a newer UTC.
    if(this.sequence!==null){
      if(snapshot.state_time<this.stateTime || (snapshot.state_time===this.stateTime && snapshot.sequence<=this.sequence))return false;
      if(snapshot.sequence<this.sequence)this.reset();
    }
    if(this.receivedAt!==null)this.interval=Math.max(0,now-this.receivedAt)/1000;
    if(this.stateTime!==snapshot.state_time || this.advancedAt===null)this.advancedAt=now;
    this.receivedAt=now;this.startedAt??=now;this.stateTime=snapshot.state_time;this.epoch=epoch;this.sequence=snapshot.sequence;
    this.sources=snapshot.sources ?? [];this.capabilities=snapshot.capabilities ?? {};
    this.total=snapshot.entities.length;this.counts={aircraft:0,satellite:0,uam:0};
    this.derivations={observed:0,estimated:0,simulated:0,other:0};this.fixture=false;
    let maxAge=null;
    for(const entity of snapshot.entities){
      if(Object.hasOwn(this.counts,entity.kind))this.counts[entity.kind]++;
      const derived=entity.derivation;
      const category=entity.provenance==='simulation' || derived==='simulated' ? 'simulated'
        : ['observed','observation'].includes(derived) ? 'observed'
        : ['extrapolated','interpolated','estimated','propagated','gp_propagated'].includes(derived) ? 'estimated' : 'other';
      this.derivations[category]++;
      if(entity.provenance==='fixture')this.fixture=true;
      if(entity.kind==='aircraft' && Number.isFinite(entity.observation_time) && Number.isFinite(snapshot.state_time)){
        const age=Math.max(0,snapshot.state_time-entity.observation_time);maxAge=Math.max(maxAge??0,age);
      }
    }
    this.observationAge=maxAge;
    const bucket=Math.floor(now/2000)*2000;
    if(this.buckets.at(-1)?.at===bucket)this.buckets.at(-1).count++;
    else this.buckets.push({at:bucket,count:1});
    this.buckets=this.buckets.filter(item=>item.at>=bucket-58000).slice(-30);
    return true;
  }
  view(now=Date.now(),transport='connecting'){
    const age=this.receivedAt===null?null:Math.max(0,now-this.receivedAt)/1000;
    const connected=age!==null && age<=5 && !['error','disconnected','reconnecting','stale','paused'].includes(transport);
    const frozen=connected && now-this.advancedAt>5000;
    const end=Math.floor(now/2000)*2000,byTime=new Map(this.buckets.map(item=>[item.at,item.count]));
    const bars=Array.from({length:30},(_,i)=>{const at=end-(29-i)*2000;return {count:byTime.get(at)??0,known:this.startedAt!==null&&at+2000>this.startedAt};});
    return {age,connected,frozen,bars};
  }
}

const ICONS={
  aircraft:'M3 13l7-3 1-7 2 0 1 7 7 3v2l-7-1v5l3 2H7l3-2v-5l-7 1z',
  satellite:'M9 9h6v6H9zM3 3l5 2-3 3zM16 16l5 2-3 3zM8 8l2 2m4 4 2 2M8 18c-2-1-3-3-3-5',
  uam:'M8 10h8v6H8zM4 7h5m6 0h5M6 7v5m12-5v5M6 18h12M10 16v2m4-2v2',
  environment:'M6 15a4 4 0 1 1 1-8 5 5 0 0 1 9 2 3 3 0 0 1 2 6H6m1 3h11m-8 3h5',
  mission:'M4 5l5-2 6 2 5-2v16l-5 2-6-2-5 2V5m5-2v16m6-14v16',
  traffic:'M3 9l9-6 9 6-9 6-9-6m0 5 9 6 9-6m-9-8v6',
  alerts:'M12 3 3 20h18L12 3m0 6v5m0 3v1',
};
function icon(kind){return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[kind]}"/></svg>`;}
const ORBIT=`<svg viewBox="0 0 440 162" class="lt-orbit" aria-hidden="true">
  <defs><radialGradient id="lt-glow"><stop stop-color="#8edfd2" stop-opacity=".22"/><stop offset="1" stop-color="#8edfd2" stop-opacity="0"/></radialGradient><linearGradient id="lt-flow"><stop stop-color="#90c7cd"/><stop offset="1" stop-color="#a6eee2"/></linearGradient></defs>
  <path class="lt-grid-line" d="M0 41H440M0 81H440M0 121H440M60 0V162M140 0V162M220 0V162M300 0V162M380 0V162"/>
  <circle class="lt-light lt-source-glow" cx="104" cy="81" r="77" fill="url(#lt-glow)"/><circle class="lt-light lt-twin-glow" cx="336" cy="81" r="77" fill="url(#lt-glow)"/>
  <g class="lt-orbit-shell"><circle cx="104" cy="81" r="44"/><ellipse cx="104" cy="81" rx="17" ry="44"/><ellipse cx="104" cy="81" rx="44" ry="17"/><path d="M60 81h88M104 37v88"/><ellipse cx="104" cy="81" rx="62" ry="23" transform="rotate(-30 104 81)"/></g>
  <g class="lt-twin-shell"><path d="m336 30 44 25v51l-44 26-44-26V55l44-25m-44 25 44 26 44-26m-44 26v51m-22-90v51l44 26m0-77v51l-44 26m-22-51 44 26 44-26"/><circle cx="336" cy="81" r="6"/><circle cx="292" cy="55" r="3"/><circle cx="380" cy="106" r="3"/><circle cx="336" cy="30" r="3"/></g>
  <path class="lt-flow-track" d="M163 70H277M277 93H163"/><g class="lt-light lt-light-out"><ellipse cx="164" cy="70" rx="12" ry="4" fill="url(#lt-glow)"/><path d="M158 70h6" stroke="#b1e8d7" stroke-width="2" stroke-linecap="round"/><circle cx="164" cy="70" r="2" fill="#e0fff4"/></g>
  <g class="lt-light lt-light-back"><ellipse cx="276" cy="93" rx="12" ry="4" fill="url(#lt-glow)"/><path d="M276 93h6" stroke="#b1e8d7" stroke-width="2" stroke-linecap="round"/><circle cx="276" cy="93" r="2" fill="#e0fff4"/></g>
  <path d="m270 66 7 4-7 4m-100 15-7 4 7 4" fill="none" stroke="#98d2d0"/>
  <rect x="193" y="55" width="54" height="52" rx="15" fill="#314951" stroke="#97c7c666"/>
  <rect class="lt-light lt-check-glow" x="194" y="56" width="52" height="50" rx="14" fill="#b1e8d7"/>
  <path class="lt-sync-mark" d="m208 82 8 8 16-19" fill="none" stroke="#b0eee0" stroke-width="2"/>
  <text x="104" y="155" text-anchor="middle">SOURCE STATE</text><text x="336" y="155" text-anchor="middle">DIGITAL TWIN</text>
</svg>`;
const AI_ART=[
  '<path d="M0 29 14 29 24 13 38 40 50 21 65 27 78 11 91 22 108 17 132 22"/><path class="lt-ai-result" d="M0 30C22 30 28 23 44 24S71 23 84 21 108 18 132 20"/>',
  '<path d="M0 39Q36 37 58 24"/><path class="lt-ai-result lt-dashed" d="M58 24Q91 5 132 12"/><path class="lt-ai-band" d="M58 24Q94-1 132 1V27Q99 13 58 24"/>',
  '<path d="M0 40Q24 40 40 31"/><path class="lt-ai-result" d="M40 31Q56 20 71 22"/><path class="lt-ai-mid lt-dashed" d="M40 31Q75 10 102 15"/><path class="lt-ai-long lt-dashed" d="M40 31Q97-2 132 7"/>',
];

export class LiveTwinningPanel extends LibraryPanel {
  constructor(options={}){
    super({...options,section:'live'});this.domainOnly=options.domainOnly??null;
    this.physical=new PhysicalUamPanel({onFocus:options.onFocusPhysical,onToggle:on=>this.setField('uam','enabled',on)});
    this.twinningTest=new TwinningTestPanel({document:this.document});
    this.telemetry=new TwinTelemetry();this.context=options.context??(()=>({}));this.isVisible=options.isVisible??(()=>true);
    this.transport='connecting';this.events=[];this.sourceStatuses=new Map();this.active=false;this.timer=null;this.polling=false;
    this.statusFailure=false;this.generation=0;
    this.onVisibility=()=>this.updateMotion();
  }
  take(description){super.take(description);this.liveValues=structuredClone(description.values??{});}
  observe(snapshot,now=Date.now()){
    const epoch=this.telemetry.epoch;
    if(!this.telemetry.observe(snapshot,now))return;
    if(epoch!==null&&epoch!==snapshot.epoch){this.events=[];this.sourceStatuses.clear();this.addEvent('트윈 시계가 새 실행으로 전환되었습니다.',now);}
    for(const source of snapshot.sources??[]){
      if(this.sourceStatuses.get(source.id)!==source.status){
        if(BAD.has(source.status)||this.sourceStatuses.has(source.id))this.addEvent(`${source.id} · ${describeState(source)}`,now);
        this.sourceStatuses.set(source.id,source.status);
      }
    }
    // At most one DOM update per second, independent of the wire frequency.
  }
  addEvent(message,now=Date.now()){
    if(this.events[0]?.message===message&&now-this.events[0].at<10000)return;
    this.events.unshift({message,at:now});this.events=this.events.slice(0,8);
  }
  setTransport(status){
    if(this.transport!==status && ['stale','error','reconnecting','disconnected'].includes(status))this.addEvent('트윈 스트림 연결 확인 필요');
    this.transport=status;
  }
  render(body){
    this.leave();this.active=true;this.generation++;super.render(body);
    this.document.addEventListener?.('visibilitychange',this.onVisibility);
    this.timer=setInterval(()=>{
      this.updateMotion();
      if(!this.active||!this.isVisible()||this.document.hidden)return;
      this.paint();if(!this.lastPoll||Date.now()-this.lastPoll>5000)void this.refreshState();
    },1000);
  }
  leave(){this.document.removeEventListener?.('visibilitychange',this.onVisibility);
    if(this.monitor)this.monitor.dataset.motion='paused';
    this.physical?.close();this.active=false;this.generation++;clearInterval(this.timer);this.timer=null;this.body=null;this.monitor=null;}
  async load(body){
    const generation=this.generation;
    try{
      const answer=await this.api.describe();
      if(!this.active||generation!==this.generation)return;
      this.take(answer);this.statusFailure=false;this.lastPoll=Date.now();this.draw();this.applyDisplay();
    }catch{
      if(!this.active||generation!==this.generation)return;
      body.replaceChildren(this.el('p',{class:'sim-error',role:'alert',text:'트윈 모니터 설정을 불러오지 못했습니다.'}),
        this.el('button',{type:'button',text:'다시 연결',onclick:()=>this.render(body)}));
    }
  }
  draw(){
    if(!this.body||!this.active)return;
    super.draw();
    const configNodes=[...this.body.children];
    const actions=this.body.querySelector('#library-save')?.parentElement;
    this.body.textContent='';
    this.eventKey=null;this.monitor=this.el('div',{class:'lt-monitor',id:'live-twinning-monitor'});
    this.monitor.innerHTML=`
      <div class="lt-topline"><span class="lt-eyebrow">REAL-TIME TWIN OBSERVATORY</span><span class="lt-badge" data-lt="mode">연결 대기</span></div>
      <section class="lt-hero" aria-label="트윈 동기화 상태">
        <div class="lt-hero-title"><div><span class="lt-kicker">STATE SYNCHRONIZATION</span><h3 data-lt="headline">트윈 연결을 기다리는 중</h3></div><span class="lt-signal" aria-hidden="true"><i></i><i></i><i></i><i></i></span></div>
        ${ORBIT}
        <div class="lt-flow-label"><span data-lt="source-caption">수신 스트림</span><span data-lt="state-caption">트윈 상태</span></div>
        <div class="lt-metrics"><div><span>트윈 개체</span><strong data-lt="total">—</strong></div><div><span>마지막 수신</span><strong data-lt="age">—</strong></div><div><span>수신 간격</span><strong data-lt="interval">—</strong></div></div>
        <div class="lt-sync-foot"><span data-lt="state-clock">트윈 시각 —</span><span data-lt="sequence">SEQ —</span></div>
      </section>
      <div class="lt-section-title"><h3>동기화 파이프라인</h3><span>LIVE TWINNING PROCESS</span></div>
      <div class="lt-pipeline" aria-label="실시간 처리 단계">
        <div data-stage="input"><b>01</b><strong>자료 수신</strong><span data-lt="input">대기</span></div><i>›</i>
        <div data-stage="align"><b>02</b><strong>정합 · 추정</strong><span data-lt="align">대기</span></div><i>›</i>
        <div data-stage="update"><b>03</b><strong>트윈 갱신</strong><span data-lt="update">대기</span></div>
      </div>
      <div class="lt-capabilities"><span data-lt="fusion">인지 · 트랙 융합 확인 중</span><span data-lt="assessment">상황 평가 확인 중</span></div>
      <section class="lt-history" aria-label="최근 60초 수신 이력"><div><span>스트림 수신 이력</span><b data-lt="packets">0 packets</b></div><svg class="lt-bars" viewBox="0 0 420 39" role="img" aria-label="2초 구간별 실제 수신 스냅샷 수"><g>${Array.from({length:30},(_,i)=>`<rect x="${i*14}" y="36" width="9" height="3" rx="2"/>`).join('')}</g></svg><footer><span>60초 전</span><span>2초 단위 · 브라우저 수신 기준</span><span>현재</span></footer></section>
      <div class="lt-section-title"><h3>실시간 트윈 모델</h3><span>REAL-TIME TWIN MODELS</span></div>
      <div class="lt-models"></div>
      <section class="lt-intelligence"><div class="lt-section-title"><div><span class="lt-kicker">AI INTELLIGENCE</span><h3>추정에서 예측까지</h3></div><span class="lt-badge" data-lt="ai-count">— / 3 설정</span></div><p class="lt-ai-intro">관측을 현재 상태로, 현재 상태를 미래 경로로.</p><div class="lt-ai-grid"></div><div class="lt-ai-foot">곡선은 처리 개념도 · 실제 추론 결과는 지도에서 기체 선택 시 표시</div></section>
      <section class="lt-sources"><div class="lt-section-title"><h3>입력 소스 상태</h3><span data-lt="source-freshness">상태 확인 중</span></div><div class="lt-source-list"></div></section>
      <section class="lt-events"><div class="lt-section-title"><h3>연결 활동</h3><span>이 화면에서 감지한 상태 변화</span></div><div class="lt-event-list"></div></section>`;
    this.body.append(this.monitor);
    this.physical.mount(this.monitor);
    this.monitor.querySelector('.lt-hero')?.after(this.physical.box);
    const navigation=this.el('nav',{class:'lt-navigation','aria-label':'Live Twinning 바로가기'});
    navigation.append(this.el('button',{type:'button',text:'Twinning Test',onclick:()=>void this.twinningTest.open()}));
    for(const [label,selector] of [['모니터링','.lt-hero'],['트윈 모델','.lt-models'],['AI 분석','.lt-intelligence'],['입력 소스','.lt-sources']]){
      navigation.append(this.el('button',{type:'button',text:label,onclick:()=>this.monitor.querySelector(selector)?.scrollIntoView({block:'start',behavior:'smooth'})}));
    }
    this.body.prepend(navigation);
    this.settings=this.el('details',{class:'lt-settings'});
    this.settings.append(this.el('summary',{text:'데이터 수집 · AI 모델 설정'}),...configNodes);
    if(actions)this.settings.append(actions);
    if(this.error)this.settings.append(this.error);
    this.body.append(this.settings);
    this.buildModels();this.buildAi();this.buildSources();this.paint();
  }
  buttonCard(className,label,action){return this.el('button',{class:className,type:'button','aria-label':label,onclick:action});}
  buildModels(){
    const models=this.monitor.querySelector('.lt-models');
    const asset=this.buttonCard('lt-asset-card','자산 상태와 데이터 수집 설정',()=>this.openSettings('asset_states'));
    asset.innerHTML=`<div class="lt-card-title"><span>자산 상태</span><span class="lt-link">관측 · 추정 · 시뮬레이션 ↗</span></div><div class="lt-asset-counts">${['aircraft','satellite','uam'].filter(id=>this.domainOnly!=='uam'||id!=='satellite').map(id=>`<div>${icon(id)}<span>${{aircraft:'항공기',satellite:'위성',uam:'UAM'}[id]}</span><strong data-lt="count-${id}">—</strong></div>`).join('')}</div><div class="lt-composition">${['observed','estimated','simulated','other'].map(id=>`<span data-part="${id}"></span>`).join('')}</div><div class="lt-composition-label" data-lt="composition">수신 개체 없음</div>`;
    models.append(asset);
    for(const [id,label,art,key] of [['mission_resources','임무 · 자원','mission','mission'],['environment','환경','environment','environment'],['traffic_airspace','교통 · 공역','traffic','traffic'],['events_alerts','이벤트 · 경보','alerts','alerts']]){
      const card=this.buttonCard('lt-domain-card',`${label} 상세 설정`,()=>this.openSettings(id));
      card.innerHTML=`${icon(art)}<div><strong>${label}</strong><span data-lt="${key}-value">확인 중</span></div><span class="lt-domain-state" data-lt="${key}-status">—</span>`;models.append(card);
    }
  }
  buildAi(){
    const grid=this.monitor.querySelector('.lt-ai-grid');
    AI_IDS.forEach((id,index)=>{
      const card=this.buttonCard('lt-ai-card',`${['상태 추정','항공기 예측','UAM 예측'][index]} 모델 설정`,()=>this.openSettings('ai_models',id));
      card.setAttribute('data-ai',id);
      card.innerHTML=`<div class="lt-ai-card-top"><span>0${index+1}</span><b data-lt="${id}-status">대기</b></div><svg viewBox="0 0 132 48" aria-hidden="true">${AI_ART[index]}</svg><h4>${['상태 추정','항공기 예측','UAM 예측'][index]}</h4><strong data-lt="${id}-model">모델 확인 중</strong><span class="lt-ai-horizon" data-lt="${id}-detail">—</span><span class="lt-ai-config">모델 설정 <b>↗</b></span>`;grid.append(card);
    });
  }
  buildSources(){
    const list=this.monitor.querySelector('.lt-source-list');
    for(const id of ['aircraft','satellite','weather','clouds']){
      const source=this.description?.sources?.find(item=>item.id===id);if(!source)continue;
      const row=this.buttonCard('lt-source-row',`${source.label} 수집 설정`,()=>this.openSettings(source.group,id));
      row.setAttribute('data-source',id);
      row.append(this.el('i',{'aria-hidden':'true'}),this.el('strong',{text:source.label}),this.el('span',{'data-lt':`${id}-source-label`}),this.el('time',{'data-lt':`${id}-source-age`}));list.append(row);
    }
  }
  openSettings(group,id){
    if(!this.settings)return;
    this.settings.open=true;
    if(!this.openGroups.has(group))this.toggleGroup(group);
    if(id&&!this.open.has(id))this.toggle(id);
    const target=this.body.querySelector(`#library-${id??`group-${group}`}-head`);
    target?.scrollIntoView?.({block:'nearest',behavior:'smooth'});target?.focus?.({preventScroll:true});
  }
  setText(key,value){const node=this.monitor?.querySelector(`[data-lt="${key}"]`);if(node&&node.textContent!==String(value))node.textContent=String(value);return node;}
  states(){
    const states=new Map((this.description?.state??[]).map(item=>[item.id,item]));
    for(const source of this.telemetry.sources){const id=SOURCE_IDS[source.id];if(id)states.set(id,{...source,id});}
    return states;
  }
  updateMotion(now=Date.now()){
    if(!this.monitor)return;
    const view=this.telemetry.view(now,this.transport);
    this.monitor.dataset.motion=this.active&&this.isVisible()&&!this.document.hidden&&view.connected&&!view.frozen?'running':'paused';
  }
  paint(now=Date.now()){
    if(!this.monitor||!this.active)return;
    this.updateMotion(now);
    const t=this.telemetry,v=t.view(now,this.transport),ctx=this.context(),states=this.states(),values=this.liveValues??this.values;
    const failed=[...states].filter(([id,s])=>['aircraft','satellite','weather'].includes(id)&&BAD.has(s.status));
    const mode=t.fixture?'TEST DATA':t.derivations.simulated>0?'SIMULATION':'LIVE STREAM';
    this.setText('mode',t.receivedAt===null?'연결 대기':mode);
    this.monitor.dataset.state=v.connected?'connected':'waiting';
    this.monitor.dataset.frozen=String(v.frozen);
    this.monitor.dataset.health=failed.length?'attention':'normal';
    this.monitor.querySelector('.lt-sync-mark').setAttribute('d',!v.connected?'M220 69v15m0 7v1':v.frozen?'M215 72v18m10-18v18':'m208 82 8 8 16-19');
    this.setText('headline',t.receivedAt===null?'트윈 연결을 기다리는 중':!v.connected?'스트림 수신 확인 필요':v.frozen?'트윈 시계 정지 · 수신 중':failed.length?'트윈 수신 중 · 입력 점검':'트윈 상태가 갱신되고 있습니다');
    this.setText('total',t.receivedAt===null?'—':n(t.total));this.setText('age',seconds(v.age));this.setText('interval',seconds(t.interval));
    this.setText('state-clock',`트윈 시각 ${time(t.stateTime)} UTC`);this.setText('sequence',`SEQ ${n(t.sequence)}`);
    this.setText('source-caption',t.fixture?'시험 데이터':t.derivations.simulated?'시뮬레이션 상태 입력':'외부 관측 데이터');
    this.setText('state-caption',v.frozen?'마지막 트윈 상태 유지':`${n(t.total)}개 개체 · 상태 반영`);
    const estimate=states.get('state_estimation');
    this.setText('input',v.connected?'스트림 연결':t.receivedAt===null?'수신 대기':'연결 지연');
    this.setText('align',t.derivations.simulated===t.total&&t.total>0?'시뮬레이션 상태':values.state_estimation?.enabled?'추정 설정 켜짐':'관측 상태 유지');
    this.setText('update',v.frozen?'시계 정지':v.connected?'스냅샷 반영':'마지막 상태');
    for(const [stage,status] of [['input',v.connected?'ready':'stale'],['align',estimate?.status??'pending'],['update',v.connected&&!v.frozen?'ready':'pending']])this.monitor.querySelector(`[data-stage="${stage}"]`).dataset.status=status;
    this.setText('fusion',t.capabilities.perception_track_fusion?'인지 · 트랙 융합 연결됨':'인지 · 트랙 융합 미연동');
    this.setText('assessment',t.capabilities.situation_assessment?'상황 평가 연결됨':'상황 평가 미연동');
    const max=Math.max(1,...v.bars.map(b=>b.count));
    this.monitor.querySelectorAll('.lt-bars rect').forEach((bar,i)=>{const b=v.bars[i],height=b.count?Math.max(4,b.count/max*34):2;bar.setAttribute('height',height);bar.setAttribute('y',38-height);bar.setAttribute('data-known',String(b.known));bar.setAttribute('data-empty',String(!b.count));});
    this.setText('packets',`${n(v.bars.reduce((sum,b)=>sum+b.count,0))} snapshots / 60s`);
    for(const id of ['aircraft','satellite','uam'])this.setText(`count-${id}`,t.receivedAt===null?'—':n(t.counts[id]));
    const labels={observed:'관측',estimated:'추정',simulated:'시뮬레이션',other:'기타'};
    for(const [id,value] of Object.entries(t.derivations))this.monitor.querySelector(`[data-part="${id}"]`).style.width=`${t.total?value/t.total*100:0}%`;
    this.setText('composition',t.total?Object.entries(t.derivations).filter(([,value])=>value).map(([id,value])=>`${labels[id]} ${n(value)}`).join(' · '):'현재 수신 범위에 개체 없음');
    this.setText('mission-value',`${n(ctx.vertiports??0)}곳 버티포트`);this.setText('mission-status',t.capabilities.mission_resources?'연동':'임무 미연동');
    this.setText('environment-value',describeState(states.get('weather')).split(' · ')[0]);this.setText('environment-status',t.capabilities.environment?'평가 연결':'기상');
    this.setText('traffic-value',ctx.airspace==null?'지도 공역 선택 시 연결':`${n(ctx.airspace)}개 공역`);this.setText('traffic-status',t.capabilities.airspace_assessment?'평가 연결':'자료');
    this.setText('alerts-value',t.capabilities.situation_assessment?'상황 평가 연결됨':'상황 평가 모델 미연동');this.setText('alerts-status','연결 상태');
    this.setText('ai-count',`${AI_IDS.filter(id=>values[id]?.enabled).length} / 3 설정 켜짐`);
    AI_IDS.forEach((id,index)=>{
      const val=values[id]??{},state=states.get(id),models=this.description?.ai_models?.models??[];
      const modelId=val.model==='same_as_estimation'?values.state_estimation?.model:val.model;
      const model=models.find(item=>item.model_id===modelId);
      this.setText(`${id}-status`,BAD.has(state?.status)?'확인 필요':val.enabled?'설정 켜짐':'꺼짐');
      this.setText(`${id}-model`,model?.label??this.description?.sources?.find(s=>s.id===id)?.provider??'미선택');
      this.setText(`${id}-detail`,index===0?'관측 → 현재 상태':id==='uam_prediction'&&val.model==='uam_route_mlp_comparison'?`${val.short_enabled?'10s ':''}${val.mid_enabled?'90s ':''}${val.long_enabled?'240s':''}`:val.seconds?`${val.seconds}초 예측 구간`:'선택 기체 기반');
      const card=this.monitor.querySelector(`[data-ai="${id}"]`);card.dataset.enabled=String(Boolean(val.enabled));card.title=state?.message??'';
    });
    this.setText('source-freshness',this.statusFailure?'설정 조회 지연 · 마지막 상태 유지':failed.length?`${failed.length}개 소스 확인 필요`:'소스별 수신 상태');
    for(const id of ['aircraft','satellite','weather','clouds']){
      const state=states.get(id),row=this.monitor.querySelector(`[data-source="${id}"]`);if(!row)continue;
      this.setText(`${id}-source-label`,describeState(state).split(' · ')[0]);
      this.setText(`${id}-source-age`,Number.isFinite(state?.updated_at)?`${seconds(Math.max(0,now/1000-state.updated_at))} 전`:'—');
      row.dataset.status=state?.status??'pending';row.title=describeState(state);
    }
    const eventKey=JSON.stringify(this.events);
    if(this.eventKey!==eventKey){this.eventKey=eventKey;const list=this.monitor.querySelector('.lt-event-list');list.textContent='';
      if(!this.events.length)list.append(this.el('p',{text:'연결 상태가 바뀌면 여기에 표시됩니다.'}));
      for(const event of this.events.slice(0,3))list.append(this.el('div',{},this.el('time',{text:time(event.at/1000)}),this.el('span',{text:event.message})));
    }
  }
  async refreshState(){
    if(!this.active||!this.isVisible()||this.polling)return;
    const generation=this.generation;this.polling=true;this.lastPoll=Date.now();
    try{
      const answer=await this.api.describe();if(!this.active||generation!==this.generation)return;
      // Do not overwrite an operator's unsaved form or selected model.
      this.description={...this.description,state:answer.state};this.liveValues=structuredClone(answer.values??this.values);this.statusFailure=false;
      const states=this.states();
      for(const [id,state] of states){const node=this.body?.querySelector(`#library-${id}-head .library-state`);if(node){node.textContent=describeState(state);node.dataset.status=state.status;}}
      super.refreshCounts();this.paint();
    }catch{if(this.active&&generation===this.generation){this.statusFailure=true;this.paint();}}
    finally{this.polling=false;}
  }
  destroy(){this.leave();}
}
