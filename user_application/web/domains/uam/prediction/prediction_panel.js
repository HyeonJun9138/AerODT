import {buildElement} from '../../../dom_builder.js';
import {ROLES,MAX_FORECASTS,PHASES,uams,airborne,located,distance,scopeFor,candidates,checkedForecast,matchingForecast,pathFor,predictionEvents} from '../../../prediction_data.js';
import {predictionMap,altitudeProfile} from '../../../prediction_map.js';
import {predictionExample} from '../../../prediction_examples.js';

export class PredictionPanel {
  constructor({document=globalThis.document,getJSON,onOpen=()=>{},onClose=()=>{},onSettings=()=>{},onRisk=()=>{},onRiskSettings=()=>{},now=()=>Date.now(),pollMs=5000}={}){
    Object.assign(this,{document,getJSON,onOpen,onClose,onSettings,onRisk,onRiskSettings,now,pollMs});
    this.role='psu';this.example=false;this.horizon=90;this.selected={psu:'',vertiport:'',pilot:''};this.zoom=1;
    this.layers={routes:true,ports:true,labels:true,forecast:true};this.forecasts=new Map();this.ports=[];this.network={nodes:[],fatos:[],links:[]};
    this.generation=0;this.receivedAt=0;this.contextAt=0;this.forecastAt=0;this.exampleData=predictionExample();this.highlight=[];this.errors=[];
  }
  el(tag,props={},...children){return buildElement(this.document,tag,props,...children);}
  button(text,onclick,props={}){return this.el('button',{type:'button',text,onclick,...props});}
  get isOpen(){return Boolean(this.root);}
  observe(snapshot){this.liveSnapshot=snapshot;if(!this.replaySnapshot)this.applySnapshot(snapshot);}
  setReplay(snapshot,prediction=null){
    const changed=Boolean(snapshot)!==Boolean(this.replaySnapshot);
    this.replaySnapshot=snapshot;
    if(changed){this.cancelForecasts();this.forecasts.clear();this.forecastAt=0;}
    if(snapshot){this.applySnapshot(snapshot);this.forecasts.clear();
      const entity=snapshot.entities?.[0];
      if(entity&&prediction)this.forecasts.set(entity.entity_id,checkedForecast(prediction,entity,snapshot.epoch));
    }else if(this.liveSnapshot)this.applySnapshot(this.liveSnapshot);
    this.paint();
  }
  applySnapshot(snapshot){if(this.snapshot?.epoch!==snapshot.epoch){this.forecasts.clear();this.cancelForecasts();this.forecastAt=0;}
    this.snapshot=snapshot;this.receivedAt=this.now();}
  get data(){return this.example?this.exampleData:{snapshot:this.snapshot,ports:this.ports,network:this.network,forecasts:this.forecasts};}
  get enabled(){return this.example||this.config?.enabled===true;}
  get stale(){return !this.example&&(!this.snapshot||this.now()-this.receivedAt>8000);}
  get entities(){return uams(this.data.snapshot).sort((a,b)=>a.entity_id.localeCompare(b.entity_id));}
  selection(){const list=this.role==='vertiport'?this.data.ports:this.entities;
    const key=this.role==='vertiport'?'id':'entity_id';
    if(this.role!=='psu'&&!list.some(row=>row[key]===this.selected[this.role]))this.selected[this.role]=(list.find(airborne)??list[0])?.[key]??'';
    return this.selected[this.role];}
  scope(){return this.focusScope??scopeFor(this.role,this.entities,this.data.ports,this.selection());}
  open(){if(this.root){this.close();return;}
    this.onOpen();this.generation++;this.mount();this.paint();void this.loadContext();
    this.timer=setInterval(()=>{if(!this.document.hidden&&this.root){this.paint();
      if(!this.example&&this.now()-this.contextAt>30000)void this.loadContext();
      if(!this.example&&this.now()-this.forecastAt>=this.pollMs)void this.readForecasts();}},1000);this.timer?.unref?.();
  }
  close(){if(!this.root)return;this.generation++;clearInterval(this.timer);this.timer=null;
    this.contextController?.abort();this.contextController=null;this.cancelForecasts();
    this.root.remove();this.root=null;this.document.body?.removeAttribute('data-prediction');this.onClose();}
  destroy(){this.close();this.snapshot=null;this.forecasts.clear();}
  cancelForecasts(){this.forecastController?.abort();this.forecastController=null;}
  setRole(role){if(!ROLES[role])return;this.role=role;this.zoom=1;this.focusScope=null;this.highlight=[];this.cancelForecasts();this.forecastAt=0;this.paint();void this.readForecasts();}
  setExample(value){this.example=value;this.selected={psu:'',vertiport:'',pilot:''};this.focusScope=null;this.zoom=1;this.highlight=[];
    this.cancelForecasts();this.forecastAt=0;this.paint();if(!value){void this.loadContext();void this.readForecasts();}}
  pick(kind,id){
    if(this.role==='psu'){this.selected.psu=id;this.highlight=[id];this.cancelForecasts();this.forecastAt=0;}
    else if(kind===this.role){this.selected[this.role]=id;this.focusScope=null;this.zoom=1;this.highlight=[];this.cancelForecasts();this.forecastAt=0;}
    else {this.highlight=[id];}
    this.paint();void this.readForecasts();
  }
  mount(){const e=this.el.bind(this);this.optionSignature=null;this.feedSignature=null;this.modelsSignature=null;this.preparationSignature=null;
    this.root=e('section',{class:'prediction-workspace',role:'dialog','aria-modal':'true','aria-label':'Prediction 모니터'});this.document.body.append(this.root);this.document.body.setAttribute('data-prediction','open');
    this.sourceTag=e('span',{class:'pred-source'});
    this.modeButtons=[this.button('실시간',()=>this.setExample(false),{'aria-pressed':'true'}),this.button('예시 보기',()=>this.setExample(true),{'aria-pressed':'false'})];
    const close=this.button('×',()=>this.close(),{class:'pred-close','aria-label':'Prediction 닫기'});
    this.root.append(e('header',{class:'pred-header'},e('div',{class:'pred-brand'},e('span',{class:'pred-brand-icon','aria-hidden':'true',text:'⌁'}),
      e('div',{},e('small',{text:'PREDICTIVE INTELLIGENCE'}),e('h1',{text:'Prediction'}))),this.sourceTag,
      e('div',{class:'pred-mode','aria-label':'데이터 모드'},...this.modeButtons),close));
    this.roleTabs=e('div',{class:'pred-role-tabs',role:'tablist','aria-label':'UAM 예측 시점'},...Object.entries(ROLES).map(([id,{label}])=>this.button(label,()=>this.setRole(id),{
      role:'tab','data-role':id,'aria-selected':String(this.role===id),onkeydown:event=>{
        const ids=Object.keys(ROLES),i=ids.indexOf(id),next=event.key==='ArrowRight'?ids[(i+1)%3]:event.key==='ArrowLeft'?ids[(i+2)%3]:event.key==='Home'?ids[0]:event.key==='End'?ids[2]:null;
        if(next){event.preventDefault();this.setRole(next);this.roleTabs.children[ids.indexOf(next)]?.focus?.();}}})));
    this.targetSelect=e('select',{'aria-label':'예측 관측 대상',onchange:event=>this.pick(this.role,event.target.value)});
    this.scopeText=e('span',{class:'pred-scope-description'});
    this.root.append(e('div',{class:'pred-perspective'},e('span',{class:'pred-domain',text:'UAM'}),this.roleTabs,this.targetSelect,this.scopeText));
    this.horizons=e('div',{class:'pred-horizons','aria-label':'예측 시간 범위'},...[10,90,240].map(seconds=>this.button(`+${seconds}초`,()=>{this.horizon=seconds;this.paint();},{'data-seconds':seconds,'aria-pressed':String(this.horizon===seconds)})));
    this.layerToggle=this.button('예측 Layer',()=>{this.layers.forecast=!this.layers.forecast;this.paint();},{class:'pred-layer-toggle','aria-pressed':'true'});
    const layerDetails=e('details',{class:'pred-layer-options'},e('summary',{text:'지도 표시'}),e('div',{},...['routes','ports','labels'].map(key=>e('label',{},
      e('input',{type:'checkbox',checked:'',onchange:event=>{this.layers[key]=event.target.checked;this.paint();}}),{routes:'항로',ports:'버티포트',labels:'시설 이름'}[key]))));
    this.root.append(e('div',{class:'pred-toolbar'},e('span',{class:'pred-toolbar-label',text:'예측 범위'}),this.horizons,this.layerToggle,layerDetails,
      this.button('전체 범위',()=>{this.focusScope=null;this.zoom=1;this.highlight=[];this.paint();},{class:'pred-fit'}),
      this.button('−',()=>{this.zoom=Math.max(.6,this.zoom/1.35);this.paint();},{'aria-label':'예측 지도 축소'}),
      this.button('+',()=>{this.zoom=Math.min(3,this.zoom*1.35);this.paint();},{'aria-label':'예측 지도 확대'})));
    this.mapTitle=e('h2');this.mapSubtitle=e('p');this.stats=e('div',{class:'pred-stats'});this.mapHost=e('div',{class:'pred-map-host'});
    this.mapStatus=e('div',{class:'pred-map-status',role:'status'});this.profile=e('div',{class:'pred-profile'});
    const map=e('div',{class:'pred-map-panel'},e('div',{class:'pred-map-top'},e('div',{},this.mapTitle,this.mapSubtitle),this.stats),this.mapHost,this.mapStatus,this.profile,
      e('div',{class:'pred-legend'},...[
        ['current','현재 기체'],['route','저장 항로'],['future','예측 경로'],['end','예측 끝점']].map(([kind,label])=>e('span',{'data-kind':kind,text:label})),e('small',{text:'북쪽 위 · 평면 투영'})));
    this.feed=e('div',{class:'pred-feed'});this.models=e('div',{class:'pred-models'});this.preparation=e('div',{class:'pred-preparation'});
    this.root.append(e('div',{class:'pred-main'},map,e('aside',{class:'pred-sidebar','aria-label':'예측 이벤트와 확인 제안'},
      e('div',{class:'pred-feed-title'},e('span',{text:'INSIGHT FEED'}),e('h2',{text:'먼저 확인할 정보'})),this.feed,this.models,this.preparation,
      e('section',{class:'pred-risk-card'},e('small',{text:'RISK PREDICTION'}),e('h3',{text:'PRISM 주변 교통'}),
        e('p',{text:'기수 방향 레이더 · 다중 경로와 불확실성 · 최대 15초'}),
        this.button('주변 레이더 열기',()=>this.onRisk(this.scope().target?.entity_id||this.selection()||null),{'data-risk-open':'true'}),
        this.button('위험 예측 모델 설정',()=>this.onRiskSettings(),{'data-risk-settings':'true'}),
        e('small',{text:'2D 연구용 · 충돌 확률 및 자동 회피 아님'})))));
    this.footer=e('footer',{class:'pred-footer'});this.root.append(this.footer);
    this.root.onkeydown=event=>{if(event.key==='Escape'){event.stopPropagation();this.close();}
      if(event.key==='Tab'&&!this.root.classList.contains('ww-managed')){const nodes=[...this.root.querySelectorAll('button,select,input,summary,[tabindex="0"]')].filter(n=>!n.disabled&&n.getClientRects?.().length);
        if(!nodes.length)return;const first=nodes[0],last=nodes.at(-1);
        if(event.shiftKey&&this.document.activeElement===first){event.preventDefault();last.focus();}
        else if(!event.shiftKey&&this.document.activeElement===last){event.preventDefault();first.focus();}}};
    close.focus?.({preventScroll:true});
  }
  async loadContext(){if(!this.root||this.example||this.contextController)return;
    const controller=new AbortController(),generation=this.generation;this.contextController=controller;const options={signal:controller.signal};
    const environment=this.getJSON('/api/operations/context/environment',options).then(value=>{
      if(!Array.isArray(value.vertiports)||!value.network)throw new Error('No operating environment');return value;
    }).catch(async()=>{if(controller.signal.aborted)throw new Error('Aborted');
      const [ports,network]=await Promise.all([this.getJSON('/api/simulation/vertiports',options),this.getJSON('/api/simulation/routes',options)]);
      return {vertiports:ports.vertiports,network,source:'stored'};});
    try{const tasks=[environment,this.getJSON('/api/library/sources',options)];
      if(!this.snapshot)tasks.push(this.getJSON('/api/live/snapshot',options));
      const results=await Promise.allSettled(tasks);if(controller.signal.aborted||generation!==this.generation||!this.root)return;
      this.errors=[];
      if(results[0].status==='fulfilled'){this.ports=(results[0].value.vertiports??[]).filter(located);this.network=results[0].value.network;this.contextSource=results[0].value.source;}
      else this.errors.push('운항 환경 갱신 실패');
      if(results[1].status==='fulfilled'){const config=results[1].value.values?.uam_prediction;
        if(JSON.stringify(config)!==JSON.stringify(this.config)){this.cancelForecasts();this.forecasts.clear();this.forecastAt=0;}this.config=config;
        this.provider=results[1].value.sources?.find(s=>s.id==='uam_prediction')?.provider??'UAM 예측 모델';}else this.errors.push('모델 설정 갱신 실패');
      if(results[2]?.status==='fulfilled'&&!this.snapshot)this.observe(results[2].value);
      this.contextAt=this.now();this.paint();void this.readForecasts();
    }finally{if(this.contextController===controller)this.contextController=null;}
  }
  async readForecasts(){if(!this.root||this.example||this.replaySnapshot||this.document.hidden||!this.enabled||this.stale||this.forecastController)return;
    const controller=new AbortController(),generation=this.generation,epoch=this.snapshot.epoch;
    this.forecastController=controller;this.forecastAt=this.now();
    const scope=this.scope(),target=scope.target??this.entities.find(e=>e.entity_id===this.selection())??this.data.ports.find(p=>p.id===this.selection()),
      rows=candidates(this.entities,this.role,target,[...this.forecasts.keys()]);
    const wanted=new Set(rows.map(e=>e.entity_id));for(const id of this.forecasts.keys())if(!wanted.has(id))this.forecasts.delete(id);
    let cursor=0;
    const worker=async()=>{while(cursor<rows.length&&!controller.signal.aborted){const entity=rows[cursor++];let result;
      try{const value=await this.getJSON(`/api/live/trajectory/${encodeURIComponent(entity.entity_id)}`,{signal:controller.signal});result=checkedForecast(value,entity,epoch);}
      catch(error){if(controller.signal.aborted)return;result={entityId:entity.entity_id,status:'unavailable',paths:[],reason:'예측 미수신 · 모델 설정과 입력 상태 확인'};}
      if(controller.signal.aborted||generation!==this.generation||epoch!==this.snapshot?.epoch||!this.root)return;
      const current=this.entities.find(e=>e.entity_id===entity.entity_id);
      if(!current||current.continuity_id!==entity.continuity_id||current.flight_phase!==entity.flight_phase)continue;
      this.forecasts.set(entity.entity_id,result);
    }};
    try{await Promise.all([worker(),worker()]);if(!controller.signal.aborted)this.paint();}
    finally{if(this.forecastController===controller)this.forecastController=null;}
  }
  paint(){if(!this.root)return;
    const e=this.el.bind(this),data=this.data,entities=this.entities,selected=this.selection(),scope=this.scope(),now=data.snapshot?.state_time??0,epoch=data.snapshot?.epoch;
    const forecasts=this.stale||!this.enabled?new Map():data.forecasts;
    const visible=entities.filter(item=>this.role==='psu'||distance(item,scope.center)<=scope.radius);
    const ready=entities.filter(item=>matchingForecast(forecasts.get(item.entity_id),item,epoch)&&pathFor(forecasts.get(item.entity_id),this.horizon,now));
    const events=predictionEvents({entities,forecasts,now,horizon:this.horizon,role:this.role,target:scope.target,epoch});
    this.root.setAttribute('data-example',String(this.example));this.sourceTag.textContent=this.example?'EXAMPLE · 개념 시연':this.stale?'수신 대기 / 지연':this.replaySnapshot?'REPLAY · 단일 비행':entities.some(x=>x.source==='physical_uam')?'PHYSICAL · 모사 센서':'TWIN · 현재 상태';
    this.modeButtons[0].textContent=this.replaySnapshot?'기록 재생':'실시간';
    this.modeButtons.forEach((button,i)=>button.setAttribute('aria-pressed',String(this.example===Boolean(i))));
    for(const button of this.roleTabs.children){const active=button.getAttribute('data-role')===this.role;button.setAttribute('aria-selected',String(active));button.setAttribute('tabindex',active?'0':'-1');}
    const options=this.role==='vertiport'?data.ports:entities;
    const signature=JSON.stringify([this.role,options.map(x=>[x.id??x.entity_id,x.name])]);
    if(signature!==this.optionSignature){this.targetSelect.replaceChildren(...(this.role==='psu'?[e('option',{value:'',text:'기체 / 시설을 지도에서 선택'})]:[]),
      ...options.map(row=>e('option',{value:row.id??row.entity_id,text:row.name??row.id??row.entity_id})));this.optionSignature=signature;}
    this.targetSelect.value=selected;
    this.scopeText.textContent=ROLES[this.role].description;
    for(const button of this.horizons.children)button.setAttribute('aria-pressed',String(Number(button.getAttribute('data-seconds'))===this.horizon));
    this.layerToggle.setAttribute('aria-pressed',String(this.layers.forecast));
    this.mapTitle.textContent=this.role==='psu'?'Network outlook':`${scope.target?.name??'대상 선택'} · ${this.role==='vertiport'?'3 km 관측권':'Pilot outlook'}`;
    this.mapSubtitle.textContent=this.example?'예시 데이터 · 실제 운항과 독립':this.role==='psu'?`${data.ports.length}개 버티포트 · ${data.network.links?.length??0}개 ${this.contextSource==='physical'?'보고':'저장'} 항로 구간`:'주변 교통과 미래 경로를 같은 평면에서 확인';
    this.stats.replaceChildren(...[['관측 기체',visible.length],['예측 수신',`${ready.length}/${Math.min(MAX_FORECASTS,entities.filter(airborne).length)}`]].map(([label,value])=>e('div',{},e('strong',{text:String(value)}),e('span',{text:label}))));
    // Only the map and result regions redraw; role controls and inputs retain focus.
    const focused=this.mapHost.contains?.(this.document.activeElement)?this.document.activeElement?.getAttribute('aria-label'):null;
    this.mapHost.replaceChildren(predictionMap(this.document,{entities,ports:data.ports,network:data.network,forecasts,scope,role:this.role,
      selected,highlight:this.highlight,horizon:this.horizon,now,epoch,zoom:this.zoom,layers:this.layers,example:this.example,size:this.mapHost.getBoundingClientRect?.(),onPick:(kind,id)=>this.pick(kind,id)}));
    if(focused)[...this.mapHost.querySelectorAll('[role=button]')].find(n=>n.getAttribute('aria-label')===focused)?.focus?.({preventScroll:true});
    this.mapStatus.textContent=this.example?'EXAMPLE — 경로·이벤트는 시연용 합성 데이터입니다.':this.stale?'현재 상태 수신 지연 · 예측 결과는 숨겼습니다.':
      !this.config?'예측 모델 설정 확인 중 · 현재 위치와 항로를 표시합니다.':!this.enabled?'UAM 예측 생성이 꺼져 있습니다. 현재 위치와 항로를 표시합니다.':ready.length?`예측 ${ready.length}대 표시 · 전체 교통의 일부 (${MAX_FORECASTS}대까지)`:'예측 입력 준비 / 수신 대기 · 현재 위치만 표시';
    this.paintFeed(events,ready,scope,forecasts,now);
    const record=forecasts.get(selected),path=pathFor(record,this.horizon,now);
    this.profile.replaceChildren();this.profile.hidden=this.role!=='pilot'||!path;
    if(this.role==='pilot'&&path)this.profile.append(e('span',{class:'pred-profile-label',text:'예측 고도 · MSL'}),altitudeProfile(this.document,path,now,this.horizon));
    this.footer.textContent=this.example?'예시 모드 · AI 모델 추론 및 실제 이벤트 전달은 수행하지 않습니다.':
      `${this.errors.length?this.errors.join(' · ')+' / ':''}현재 상태는 ${this.replaySnapshot?'비행 기록':'Twin'}, 미래 경로는 서버의 선택 모델 기준 · 전달/의사결정은 확인 제안이며 자동 실행하지 않습니다.`;
  }
  paintFeed(events,ready,scope,forecasts,now){const e=this.el.bind(this);
    const signature=JSON.stringify([events.map(event=>[event.id,event.title,event.detail,event.metric,event.note]),ready.length===0,this.role,this.example,
      scope.target?.name,scope.target?.flight_phase,Math.round(scope.target?.altitude_m??0)]);
    if(signature!==this.feedSignature){this.feedSignature=signature;
    const expanded=new Set([...this.feed.querySelectorAll('article')].filter(n=>n.querySelector('details')?.open).map(n=>n.getAttribute('data-event-id')));
    const focusButton=this.feed.contains?.(this.document.activeElement)?this.document.activeElement?.getAttribute('data-event'):null;
    const focusSummary=this.feed.contains?.(this.document.activeElement)?this.document.activeElement?.getAttribute('data-summary'):null;
    this.feed.replaceChildren();
    if(events.length)for(const event of events){this.feed.append(e('article',{class:'pred-event','data-kind':event.kind,'data-event-id':event.id},
      e('div',{class:'pred-event-top'},e('span',{text:this.example?'예시 이벤트':'예측 기반 참고'}),e('span',{text:event.kind==='entry'?'APPROACH':'TRAFFIC'})),
      e('h3',{text:event.title}),e('p',{class:'pred-event-identity',text:event.detail}),e('strong',{class:'pred-event-metric',text:event.metric}),
      e('p',{class:'pred-decision',text:this.role==='psu'?'확인 제안 · 담당 조종사와 예상 통과 시각·고도 비교':this.role==='vertiport'?'확인 제안 · 접근 순서와 주변 교통 점유 확인':'확인 제안 · 상대 진로·고도차를 확인하고 관제와 공유'}),
      e('details',expanded.has(event.id)?{open:''}:{},e('summary',{text:'판단 근거','data-summary':event.id}),e('p',{text:event.note})),
      this.button(`${event.action} ↗`,()=>{this.highlight=event.ids;this.focusScope=this.role==='psu'?{center:event.point,radius:3000,target:null}:null;this.zoom=1;this.paint();},
        {'data-event':event.id,class:'pred-event-action'})));}
    else this.feed.append(e('div',{class:'pred-feed-empty'},e('span',{class:'pred-empty-symbol','aria-hidden':'true',text:'◎'}),
      e('h3',{text:!ready.length?'예측 정보 연결을 기다립니다':'우선 표시할 후보 없음'}),
      e('p',{text:!ready.length?'현재 위치를 관찰하거나 예시 모드에서 시점별 예측 화면을 살펴보세요.':'수신한 예측 구간에서 근접·관측권 진입 후보가 없습니다. 전체 공역의 안전 판정은 아닙니다.'})));
    if(focusButton)[...this.feed.querySelectorAll('button')].find(b=>b.getAttribute('data-event')===focusButton)?.focus?.({preventScroll:true});
    if(focusSummary)[...this.feed.querySelectorAll('summary')].find(b=>b.getAttribute('data-summary')===focusSummary)?.focus?.({preventScroll:true});
    if(this.role==='pilot'&&scope.target){const item=scope.target;
      this.feed.append(e('section',{class:'pred-ownship'},e('small',{text:'관측 기체'}),e('strong',{text:item.name}),
        e('span',{text:`${PHASES[item.flight_phase]??'상태 미상'} · ${Math.round(item.altitude_m??0)} m MSL`}),
        e('p',{text:'예측 끝점과 고도 변화를 먼저 확인하고, 주변 교통과의 상대 진로를 비교하세요.'})));}}
    const targetId=this.role==='pilot'?this.selection():this.highlight.find(id=>forecasts.has(id))??ready[0]?.entity_id;
    const record=forecasts.get(targetId);
    const modelsSignature=JSON.stringify([this.role,this.example,this.provider,this.enabled,record?.reason,record?.paths?.map(p=>[p.model,p.seconds])]);
    if(modelsSignature!==this.modelsSignature){this.modelsSignature=modelsSignature;
    this.models.replaceChildren(e('div',{class:'pred-model-heading'},e('span',{text:'PREDICTION SOURCE'}),e('strong',{text:this.example?'모델별 표현 예시':this.provider??'모델 설정 확인 중'})),
      e('p',{text:this.example?'합성 경로로 단기·중기·장기 표현을 시연합니다.':!this.enabled?'UAM 예측 생성 OFF':`동시 관측 ${MAX_FORECASTS}대까지 · ${this.role==='psu'?'관측 기체 유지':this.role==='pilot'?'내 기체와 가까운 교통 우선':'시설에 가까운 교통 우선'}`}));
    if(record?.paths?.length)this.models.append(e('div',{class:'pred-model-chips'},...record.paths.map(p=>e('span',{style:`--model-color:${p.color}`,text:`${p.label} ${p.seconds}초`}))));
    else if(this.enabled)this.models.append(e('p',{text:record?.reason??'모델 입력 이력 또는 새로운 예측 응답을 기다립니다.'}));
    this.models.append(this.button('예측 모델 설정 ↗',()=>this.onSettings(),{class:'pred-settings-link'}));}
    const preparationSignature=JSON.stringify([this.role,this.example]);
    if(preparationSignature!==this.preparationSignature){this.preparationSignature=preparationSignature;
    this.preparation.replaceChildren();
    if(this.role==='vertiport')this.preparation.append(e('span',{class:'pred-preparation-tag',text:'PREPARING'}),e('strong',{text:'주변 공역 감시'}),
      e('p',{text:'새 · 드론 · 미확인 비행체의 탐지/예측 입력을 연결할 영역입니다.'}),
      this.example?e('p',{class:'pred-example-note',text:'지도 표적은 화면 구성을 위한 예시입니다.'}):null);}
  }
}
