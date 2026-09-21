import {buildElement,buildSvg} from '../../../dom_builder.js';
import {located,localEnu,headingUp,uncertaintyEllipse,checkedRiskResponse,radarLayout,reanchorPrediction} from '../../../risk_radar_geometry.js';

const DEFAULTS={enabled:true,model:'prism_2d_v1',radius_m:3000,altitude_band_m:150,horizon_s:15};
const STATES={ready:'모델 예측 수신',warming_up:'입력 이력 준비 중',unavailable:'모델 사용 불가',disabled:'AI 예측 OFF'};
const COLORS=['#7edcc7','#c2acef','#e6bd83'];
const AIRCRAFT=new Set(['uam','aircraft','helicopter','drone']);
const UNUSABLE_QUALITY=new Set(['stale','frozen','unavailable','invalid']);
const MIN_RADIUS_M=500,MAX_RADIUS_M=10000,WHEEL_QUIET_MS=180;
const radiusLabel=radius=>`${Number((radius/1000).toFixed(2))} km`;
let radarId=0;

export class RiskRadar {
  constructor({document=globalThis.document,getJSON,onSettings=()=>{},now=()=>Date.now()}={}){
    Object.assign(this,{document,getJSON,onSettings,now});this.window=document.defaultView??globalThis;
    this.config={...DEFAULTS};this.snapshot=null;this.result=null;this.entityId=null;this.generation=0;this.receivedAt=0;this.resultAt=0;
    this.lastRequest=-Infinity;this.pending=null;this.expanded=false;this.destroyed=false;this.frame=null;this.timer=null;this.opened=false;this.id=++radarId;
    this.onVisibility=()=>{if(this.document.hidden){this.stop();this.result=null;}else if(this.opened)this.start();};
    this.onResize=()=>this.requestPaint();
    this.wheelQuietUntil=0;this.onWheel=event=>this.zoomWheel(event);
    this.injectedHistory=new Map();
    document.addEventListener?.('visibilitychange',this.onVisibility);this.window.addEventListener?.('resize',this.onResize);
  }
  el(tag,props={},...children){return buildElement(this.document,tag,props,...children);}
  svg(tag,props={},...children){return buildSvg(this.document,tag,props,...children);}
  button(text,onclick,props={}){return this.el('button',{type:'button',text,onclick,...props});}
  get isOpen(){return this.opened;}
  get current(){return this.snapshot?.entities?.find(entity=>entity.entity_id===this.entityId);}
  get stale(){return !this.snapshot||this.now()-this.receivedAt>8000||!this.current||UNUSABLE_QUALITY.has(this.current.quality)||this.current.discontinuity===true;}
  getConfig(){return {...this.config};}
  setConfig(config={}){
    const next={...this.config};
    if(typeof config.enabled==='boolean')next.enabled=config.enabled;
    if(typeof config.model==='string')next.model=config.model;
    if(Number.isFinite(config.radius_m)&&config.radius_m>=MIN_RADIUS_M&&config.radius_m<=MAX_RADIUS_M)next.radius_m=config.radius_m;
    if(config.altitude_band_m===null||Number.isFinite(config.altitude_band_m)&&config.altitude_band_m>=0&&config.altitude_band_m<=3000)
      next.altitude_band_m=config.altitude_band_m===0?null:config.altitude_band_m;
    if([5,10,15].includes(config.horizon_s))next.horizon_s=config.horizon_s;
    if(JSON.stringify(next)===JSON.stringify(this.config))return;
    this.config=next;this.invalidate();this.paint();if(this.opened)void this.refresh();
  }
  zoomWheel(event){
    if(!this.opened||this.destroyed||this.document.hidden||this.layoutCollapsed)return;
    event.preventDefault();event.stopPropagation();
    if(!Number.isFinite(event.deltaY)||event.deltaY===0)return;
    const unit=event.deltaMode===1?16:event.deltaMode===2?(this.plot.clientHeight||300):1;
    const pixels=Math.max(-160,Math.min(160,event.deltaY*unit));
    const radius=Math.max(MIN_RADIUS_M,Math.min(MAX_RADIUS_M,Math.round(this.config.radius_m*Math.exp(pixels*.002))));
    if(radius===this.config.radius_m)return;
    // Range changes only the projection around ownship, never the cursor or World.
    // Keep valid, anchored paths visible; the existing poll obtains new coverage
    // after the gesture settles without abort/restart storms or per-wheel requests.
    this.config={...this.config,radius_m:radius};this.wheelQuietUntil=this.now()+WHEEL_QUIET_MS;
    this.requestPaint();
  }
  select(entity){
    if(this.destroyed)return;
    if(!entity||!AIRCRAFT.has(entity.kind)){this.entityId=null;this.hide();if(this.chip)this.chip.hidden=true;return;}
    const changed=this.entityId!==entity.entity_id;
    if(changed){this.entityId=entity.entity_id;this.selectedContinuity=entity.continuity_id;this.detailId=null;this.invalidate();}
    if(changed||!this.root)this.open();else this.requestPaint();
  }
  observe(snapshot){
    if(this.destroyed||!snapshot)return;
    const previous=this.current,newCurrent=snapshot.entities?.find(entity=>entity.entity_id===this.entityId);
    const changed=this.snapshot&&this.snapshot.epoch!==snapshot.epoch||previous&&newCurrent&&previous.continuity_id!==newCurrent.continuity_id||
      this.snapshot&&Number.isFinite(snapshot.state_time)&&snapshot.state_time<this.snapshot.state_time||previous&&!newCurrent;
    if(changed)this.invalidate();
    if(this.snapshot&&(this.snapshot.epoch!==snapshot.epoch||snapshot.state_time<this.snapshot.state_time))this.injectedHistory.clear();
    const active=new Set();
    for(const entity of (snapshot.entities??[]).filter(e=>e.source==='intruder'&&e.intruder?.injected).slice(0,8)){
      const t=entity.state_time,p=entity.position_ecef_m;
      if(!Number.isFinite(t)||!Array.isArray(p)||p.length!==3||!p.every(Number.isFinite))continue;
      active.add(entity.entity_id);let entry=this.injectedHistory.get(entity.entity_id);
      if(!entry){entry={entity_id:entity.entity_id,kind:entity.kind,samples:[]};this.injectedHistory.set(entity.entity_id,entry);}
      const last=entry.samples.at(-1);
      if(!last||t>last[0]){
        const row=[t,...p];
        if(last&&Math.floor(t*2)===Math.floor(last[0]*2))entry.samples[entry.samples.length-1]=row;
        else entry.samples.push(row);
        entry.samples=entry.samples.filter(r=>r[0]>=snapshot.state_time-9.5).slice(-20);
      }
    }
    for(const id of this.injectedHistory.keys())if(!active.has(id))this.injectedHistory.delete(id);
    this.snapshot=snapshot;this.receivedAt=this.now();
    if(this.opened){this.requestPaint();if(changed)void this.refresh();}
  }
  invalidate(){this.generation++;this.pending?.controller.abort();this.pending=null;this.result=null;this.error=null;this.wheelQuietUntil=0;}
  open(){
    if(this.destroyed||!this.entityId)return;
    if(!this.root)this.mount();this.opened=true;this.root.hidden=false;this.chip.hidden=true;this.start();
  }
  hide(){
    this.opened=false;this.stop();this.result=null;
    if(this.root)this.root.hidden=true;
    if(this.chip){this.chip.hidden=!this.entityId;this.chip.textContent='◎ 주변 레이더 열기';}
  }
  stop(){
    this.wheelQuietUntil=0;
    this.generation++;this.pending?.controller.abort();this.pending=null;
    if(this.timer!==null)this.window.clearInterval(this.timer);this.timer=null;
    if(this.frame!==null)this.window.cancelAnimationFrame?.(this.frame);this.frame=null;
  }
  start(){
    if(!this.opened||this.document.hidden)return;
    this.paint();if(this.layoutCollapsed)return;void this.refresh();
    if(this.timer===null){this.timer=this.window.setInterval(()=>{this.requestPaint();void this.refresh();},500);this.timer?.unref?.();}
  }
  destroy(){
    if(this.destroyed)return;this.hide();this.destroyed=true;this.plot?.removeEventListener('wheel',this.onWheel);this.root?.remove();this.chip?.remove();this.root=null;this.chip=null;this.snapshot=null;
    this.document.removeEventListener?.('visibilitychange',this.onVisibility);this.window.removeEventListener?.('resize',this.onResize);
  }
  requestPaint(){
    if(!this.opened||this.document.hidden||this.frame!==null)return;
    if(!this.window.requestAnimationFrame){this.paint();return;}
    // One coalesced display frame, never an independent simulation or extrapolation loop.
    this.frame=this.window.requestAnimationFrame(()=>{this.frame=null;this.paint();});
  }
  async refresh(){
    if(!this.opened||this.document.hidden||this.layoutCollapsed||this.pending||this.stale||!located(this.current)||!this.config.enabled||this.now()-this.lastRequest<500||this.now()<this.wheelQuietUntil)return;
    const controller=new AbortController(),generation=this.generation,entityId=this.entityId,epoch=this.snapshot.epoch,continuity=this.current.continuity_id;
    const config={...this.config},request={controller};this.pending=request;this.lastRequest=this.now();
    const query=new URLSearchParams({entity_id:entityId,radius_m:String(config.radius_m),horizon_s:String(config.horizon_s),
      altitude_band_m:config.altitude_band_m===null?'all':String(config.altitude_band_m)});
    try{
      const tracks=[...this.injectedHistory.values()];
      const requestOptions=tracks.length?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({epoch,tracks})}:{};
      const value=await this.getJSON(`/api/prediction/risk?${query}`,{signal:controller.signal,...requestOptions});
      if(controller.signal.aborted||generation!==this.generation||!this.opened||this.document.hidden||epoch!==this.snapshot?.epoch||entityId!==this.entityId||continuity!==this.current?.continuity_id)return;
      const result=checkedRiskResponse(value,{entityId,epoch,stateTime:this.snapshot.state_time,radius:config.radius_m,horizon:config.horizon_s});
      this.result=result;this.resultAt=this.now();this.error=result?null:'응답 기준 불일치: 새 예측을 기다립니다.';
    }catch(error){
      if(!controller.signal.aborted&&generation===this.generation){this.result=null;this.error='예측 연결 실패: 현재 관측만 표시합니다.';}
    }finally{if(this.pending===request)this.pending=null;if(generation===this.generation)this.requestPaint();}
  }
  mount(){
    const e=this.el.bind(this);
    this.root=e('section',{class:'risk-radar',role:'region','aria-label':'PRISM 2D 주변 교통 레이더','aria-description':'실험적 2D 예측. 분기 가중치는 충돌확률이 아니며 자동 회피를 수행하지 않습니다.','data-size':this.expanded?'expanded':'compact'});
    this.chip=this.button('◎ 주변 레이더 열기',()=>this.open(),{class:'risk-reopen','aria-label':'주변 레이더 다시 열기'});this.chip.hidden=true;
    this.heading=e('strong',{text:'주변 교통'});this.identity=e('span',{class:'risk-identity'});
    this.expandButton=this.button('⤢',()=>{this.expanded=!this.expanded;this.paint();},{class:'risk-expand','aria-label':'레이더 확대','aria-pressed':'false'});
    this.root.append(e('header',{class:'risk-header'},e('div',{},e('small',{text:'PRISM 2D / EXPERIMENTAL'}),this.heading,this.identity),
      e('div',{class:'risk-actions'},this.expandButton,this.button('−',()=>this.hide(),{'aria-label':'레이더 접기'}))));
    this.body=e('div',{class:'risk-body'});
    this.radiusSelect=e('select',{'aria-label':'레이더 반경',onchange:event=>this.setConfig({radius_m:Number(event.target.value)})},
      ...[500,1000,3000,5000,10000].map(radius=>e('option',{value:radius,text:radiusLabel(radius)})));
    this.altitudeSelect=e('select',{'aria-label':'강조 고도대',onchange:event=>this.setConfig({altitude_band_m:event.target.value==='all'?null:Number(event.target.value)})},
      ...[50,150,300].map(band=>e('option',{value:band,text:`±${band} m`})),e('option',{value:'all',text:'모든 고도'}));
    this.body.append(e('div',{class:'risk-controls'},e('label',{},'반경',this.radiusSelect),e('label',{},'고도대',this.altitudeSelect),
      this.button('⚙',()=>this.onSettings(),{class:'risk-settings','aria-label':'위험 예측 모델 설정'})));
    this.horizonSelect=e('select',{'aria-label':'레이더 예측 시간',onchange:event=>this.setConfig({horizon_s:Number(event.target.value)})},
      ...[5,10,15].map(seconds=>e('option',{value:seconds,text:`${seconds}초`}))); 
    this.body.append(e('div',{class:'risk-time-control'},e('label',{},'예측 시간',this.horizonSelect),e('span',{text:'선택 기체 중심 / 휠 확대·축소'})));
    this.plot=e('div',{class:'risk-plot'});this.stats=e('div',{class:'risk-stats'});this.status=e('p',{class:'risk-status',role:'status','aria-live':'polite'});
    this.plot.addEventListener('wheel',this.onWheel,{passive:false});
    this.detail=e('div',{class:'risk-detail','aria-live':'polite'});this.provenance=e('p',{class:'risk-provenance'});
    this.body.append(this.plot,this.stats,this.status,this.detail,e('div',{class:'risk-legend'},e('span',{text:'△ 현재 교통'}),e('span',{text:'┄ 예측 5 / 10 / 15초'}),
      e('span',{text:'◌ 불확실성 2σ'}),e('span',{text:'? 종류 / 고도 미상'})),
      e('p',{class:'risk-disclaimer',text:'실험적 2D 예측입니다. 분기 가중치는 충돌확률이 아닙니다. 고도대 밖 교통은 흐리게 표시합니다.'}),this.provenance);
    this.root.append(this.body);this.document.body.append(this.root,this.chip);
    this.root.onkeydown=event=>{if(event.key==='Escape'){event.stopPropagation?.();this.hide();this.chip.focus?.();}};
  }
  applyLayout(){
    if(this.root?.classList?.contains('ww-managed')){this.root.hidden=!this.opened;this.chip.hidden=this.opened;return;}
    const selection=this.document.getElementById?.('selection');
    const rect=selection?.getAttribute('data-open')==='true'?selection.getBoundingClientRect?.():null;
    const box=radarLayout({width:this.window.innerWidth??1280,height:this.window.innerHeight??800,expanded:this.expanded,selection:rect});
    const restoring=this.layoutCollapsed&&!box.collapsed;this.layoutCollapsed=box.collapsed;
    if(box.collapsed){this.stop();this.result=null;}else if(restoring)queueMicrotask(()=>{if(this.opened&&!this.destroyed)this.start();});
    for(const key of ['left','top','width'])this.root.style[key]=`${box[key]}px`;
    this.root.style.maxHeight=`${box.height}px`;this.root.hidden=box.collapsed||!this.opened;this.chip.hidden=!box.collapsed;
    if(box.collapsed)this.chip.textContent='◎ 레이더 / 화면 공간 필요';
    this.root.setAttribute('data-size',this.expanded?'expanded':'compact');this.expandButton.setAttribute('aria-pressed',String(this.expanded));
    this.expandButton.setAttribute('aria-label',this.expanded?'레이더 크기 복원':'레이더 확대');
  }
  forecastUsable(){return !this.stale&&this.config.enabled&&this.result&&this.now()-this.resultAt<=3500&&
    this.result.epoch===this.snapshot.epoch&&this.snapshot.state_time-this.result.state_time<=3;}
  paint(){
    if(!this.root||!this.opened||this.document.hidden)return;
    this.applyLayout();
    for(const [select,value,label] of [[this.radiusSelect,String(this.config.radius_m),radiusLabel(this.config.radius_m)],
      [this.altitudeSelect,this.config.altitude_band_m===null?'all':String(this.config.altitude_band_m),`±${this.config.altitude_band_m} m`]]){
      for(const option of [...select.children])if(option.getAttribute('data-risk-custom')==='true'&&option.value!==value)option.remove();
      if(![...select.children].some(option=>option.value===value))select.append(this.el('option',{value,text:label,'data-risk-custom':'true'}));select.value=value;
    }
    this.horizonSelect.value=String(this.config.horizon_s);
    const own=this.current,heading=Number.isFinite(own?.heading_deg)?own.heading_deg:0,hasHeading=Number.isFinite(own?.heading_deg);
    this.identity.textContent=`${own?.name??this.entityId} / ${hasHeading?`${Math.round((heading+360)%360)}° HDG`:'방위 미수신 (북쪽 위)'}`;
    const usable=this.forecastUsable(),forecast=usable?this.result:null;
    const tracks=located(own)?(this.snapshot.entities??[]).filter(entity=>entity.entity_id!==own.entity_id&&located(entity)&&entity.kind!=='vertiport').map(entity=>{
      const point=localEnu(entity,own),distance=Math.hypot(point.east_m,point.north_m);
      const relative=Number.isFinite(entity.altitude_m)&&Number.isFinite(own.altitude_m)?entity.altitude_m-own.altitude_m:null;
      return {entity,point,distance,relative,altitude:relative===null?'unknown':this.config.altitude_band_m!==null&&Math.abs(relative)>this.config.altitude_band_m?'outside':'inside',
        forecast:UNUSABLE_QUALITY.has(entity.quality)||entity.discontinuity?null:forecast?.tracks.find(track=>track.entity_id===entity.entity_id&&track.continuity_id===entity.continuity_id)};
    }).filter(track=>track.distance<=this.config.radius_m).sort((a,b)=>a.distance-b.distance):[];
    this.paintPlot(own,heading,tracks,forecast);
    const predicted=tracks.filter(track=>track.forecast?.prediction).length;
    this.stats.textContent=`주변 ${tracks.length}대 / 예측 ${predicted}대 / ${radiusLabel(this.config.radius_m)}`;
    const state=!this.config.enabled?'disabled':forecast?.status;
    this.status.setAttribute('data-status',this.stale?'stale':state??'unavailable');
    this.status.textContent=this.stale?'현재 상태 수신 지연: 예측을 숨겼습니다.':this.error??(!this.config.enabled?'AI 예측 OFF: 현재 교통만 표시합니다.':
      forecast?`${STATES[state]}${forecast.reason?`: ${String(forecast.reason)}`:''}`:this.result?'예측 수신 지연: 새 결과를 기다립니다.':'모델 입력 준비 / 예측 수신 대기');
    const provenance=forecast?.provenance,notes=[],inputs=provenance?.input_basis??[],covariances=provenance?.covariance_basis??[];
    if(inputs.includes('experimental_simulation_state'))notes.push('시뮬레이션 상태 입력 (학습 분포와 다를 수 있음)');
    if(inputs.includes('accepted_navigation_observation'))notes.push('수신한 항법 관측 기반');
    if(inputs.includes('observed_track_state'))notes.push('관측 교통 상태 기반');
    if(inputs.includes('camera_detection_estimate'))notes.push('카메라 AI 인식 위치 추정 포함 (거리 오차 큼)');
    if(inputs.includes('injected_test_state'))notes.push('주입 객체 위치 기반 PRISM 시험 · 카메라 탐지 결과 아님 · 짧은 이력 정확도 미검증');
    if(covariances.includes('assumed_isotropic_10m_sigma'))notes.push('표적 관측 오차: 등방성 σ 10 m 가정');
    if(covariances.includes('posterior_horizontal_sigma_isotropic_approximation'))notes.push('항법 수평 불확실성을 등방성으로 근사');
    if(provenance?.ownship_covariance==='original_assumed_0.5m_sigma')notes.push('내 기체 관측 오차: σ 0.5 m 가정');
    if(typeof provenance?.note==='string')notes.push(provenance.note);
    this.provenance.textContent=[forecast?.model_id??this.config.model,...notes,notes.length?'자동 회피 없음':'서버 관측 기반 실험적 2D 모델, 자동 회피 없음'].join(' / ');
    this.status.title=this.status.textContent+' / '+this.provenance.textContent+' / 분기 가중치는 충돌확률이 아닙니다.';
    this.paintDetail(tracks);
  }
  paintPlot(own,heading,tracks,forecast){
    const s=this.svg.bind(this),extent=150,radius=124,scale=radius/this.config.radius_m,clipId=`risk-circle-${this.id}`;
    const svg=s('svg',{viewBox:'0 0 300 300',role:'img','aria-label':'선택 기체 중심 heading-up 주변 교통과 서버 예측 경로'});
    svg.append(s('defs',{},s('clipPath',{id:clipId},s('circle',{cx:extent,cy:extent,r:radius}))),s('circle',{class:'risk-disc',cx:extent,cy:extent,r:radius}));
    for(let i=1;i<=3;i++)svg.append(s('circle',{class:'risk-ring',cx:extent,cy:extent,r:radius*i/3}),
      s('text',{class:'risk-ring-label',x:extent+4,y:extent-radius*i/3+12,text:`${Number((this.config.radius_m*i/3000).toFixed(2))} km`}));
    svg.append(s('path',{class:'risk-cross',d:`M26 150H274 M150 26V274`}));
    const north=headingUp(0,139,heading);svg.append(s('text',{class:'risk-north',x:extent+north.x,y:extent+north.y+4,'text-anchor':'middle',text:'N'}));
    svg.append(s('text',{class:'risk-ahead',x:150,y:12,'text-anchor':'middle',text:'HEADING UP'}));
    const content=s('g',{'clip-path':`url(#${clipId})`});
    const anchor=forecast&&own?localEnu(forecast.ownship,own):null;
    const project=point=>{const rotated=headingUp(point.east_m,point.north_m,heading);return {x:extent+rotated.x*scale,y:extent+rotated.y*scale};};
    for(const track of tracks){
      const record=track.forecast,group=s('g',{'data-altitude':track.altitude,class:'risk-forecast'});
      if(record?.prediction&&anchor&&track.entity.quality!=='stale'&&!track.entity.discontinuity){
        for(const [index,branch] of record.prediction.branches.entries()){
          const points=branch.points.filter(point=>forecast.state_time+point.t_s>=this.snapshot.state_time).map(point=>reanchorPrediction(point,forecast.ownship,own));
          if(points.length<2)continue;
          const projected=points.map(project);
          group.append(s('polyline',{class:'risk-branch',points:projected.map(point=>`${point.x},${point.y}`).join(' '),stroke:COLORS[index],
            'stroke-width':index===0?1.7:1.1,'stroke-opacity':.45+.5*branch.weight}));
          for(const point of points.filter(point=>[5,10,15].some(time=>Math.abs(point.t_s-time)<.025))){
            const center=project(point),ellipse=uncertaintyEllipse(point,heading);
            if(ellipse)group.append(s('ellipse',{class:'risk-uncertainty',cx:center.x,cy:center.y,rx:ellipse.rx*scale,ry:ellipse.ry*scale,
              transform:`rotate(${ellipse.angle} ${center.x} ${center.y})`,stroke:COLORS[index],fill:COLORS[index]}));
            group.append(s('circle',{class:'risk-future-point',cx:center.x,cy:center.y,r:1.8,fill:COLORS[index]},s('title',{text:`+${point.t_s}초 / 분기 가중치 ${Math.round(branch.weight*100)}%`})));
          }
        }
      }
      content.append(group);
    }
    for(const track of tracks){
      const p=project(track.point),known=AIRCRAFT.has(track.entity.kind),angle=Number.isFinite(track.entity.heading_deg)?track.entity.heading_deg-heading:0;
      const altitude=track.relative===null?'고도 미상':`${track.relative>=0?'+':''}${Math.round(track.relative)} m`;
      const pick=()=>{this.detailId=track.entity.entity_id;this.paintDetail(tracks);};
      const marker=s('g',{class:'risk-track',transform:`translate(${p.x} ${p.y})`,'data-altitude':track.altitude,'data-kind':known?track.entity.kind:'unknown',
        role:'button',tabindex:'0','aria-label':`${track.entity.name??track.entity.entity_id}, ${Math.round(track.distance)} m, ${altitude}`,onclick:pick,
        onkeydown:event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();pick();}}});
      marker.append(s('circle',{r:14,class:'risk-hit'}),s('title',{text:`${track.entity.name??track.entity.entity_id} / ${altitude}`}),
        known?s('path',{d:'M0 -7L5 6L0 3L-5 6Z',class:'risk-symbol',transform:`rotate(${angle})`}):s('text',{class:'risk-unknown',y:4,'text-anchor':'middle',text:'?'}),
        s('text',{class:'risk-track-label',x:9,y:-7,text:track.entity.name??track.entity.entity_id}),s('text',{class:'risk-altitude',x:9,y:5,text:altitude}));
      content.append(marker);
    }
    if(located(own))content.append(s('circle',{class:'risk-own-ring',cx:150,cy:150,r:12}),s('path',{class:'risk-ownship',d:'M150 139L156 159L150 155L144 159Z'},s('title',{text:'선택 기체 / 현재 관측'})));
    svg.append(content);this.plot.replaceChildren(svg);
  }
  paintDetail(tracks){
    const selected=tracks.find(track=>track.entity.entity_id===this.detailId);
    this.detail.hidden=!selected;
    if(!selected){this.detail.textContent='교통 표식을 선택하면 상대고도와 분기 정보를 확인합니다.';return;}
    const {entity,relative,forecast}=selected,prediction=forecast?.prediction;
    const relativeText=relative===null?'고도 미상':`${relative>=0?'+':''}${Math.round(relative)} m`;
    this.detail.replaceChildren(this.el('strong',{text:entity.name??entity.entity_id}),this.el('span',{text:`${Math.round(selected.distance)} m / 상대고도 ${relativeText}`}),
      this.el('p',{text:prediction?`분기 가중치: ${prediction.branches.map((branch,i)=>`${i+1}번 ${Math.round(branch.weight*100)}%`).join(' / ')}`:
        `${STATES[forecast?.status]??'예측 미수신'}${forecast?.reason?`: ${String(forecast.reason)}`:''}`}),
      this.el('p',{text:prediction?.type_probabilities.length?`모델 유형 추정: ${prediction.type_probabilities.map(item=>`${item.type} ${Math.round(item.probability*100)}%`).join(' / ')}`:'모델 유형 추정 미수신'}));
  }
}

