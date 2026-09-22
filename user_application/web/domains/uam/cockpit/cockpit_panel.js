import {flightProgress,navClock,navDuration} from './cockpit_flight_progress.js?v=20260921-psu-eta';
import {routeGuidance,angleDelta} from './cockpit_route.js?v=20260914-cabin';
import {fitGroundRangeKm,GROUND_RANGES_KM,surfaceOrigin,surfaceDistance} from './cockpit_surface.js';
import {buildFlightDisplay,buildNavigationDisplay,buildCameraDisplay,paintInstruments} from './cockpit_instruments.js?v=20260921-lower';
import {buildElement, buildSvg} from '../../../dom_builder.js';
import {paintCockpitMarks} from './cockpit_marks.js';
const finite = value => typeof value === 'number' && Number.isFinite(value);
const fmt = (value, digits = 0) => finite(value) ? value.toFixed(digits) : '—';
const degrees = Math.PI / 180;
const stop = event => event.stopPropagation?.();

// A read-only presentation of the caller's displayed snapshot. No timers,
// requests, flight commands or second renderer; anchors belong to the scene.
export class CockpitPanel {
  constructor({document, onCameraChange = () => {}, onPlayback = () => {}, onViewpoint = () => {}, onOccupants = () => {}, onScreenFocus = () => {}}) {
    this.onScreenFocus=onScreenFocus;this.document = document;this.onCameraChange=onCameraChange;this.onViewpoint=onViewpoint;this.onOccupants=onOccupants;
    this.active = false;
    this.lastPaint = -Infinity;
    this.rangeKm = 1;
    // Which deck and assignment the ground range was last fitted to, and
    // whether the pilot has since chosen a range by hand. Both are what keeps
    // the fit from arguing with the range button while an aircraft taxis.
    this.groundFitKey = null;
    this.rangeUserSet = false;
    this.headingUp = true;
    this.readouts = {};
    this.root = buildElement(document, 'div', {class:'cockpit-instruments', 'aria-label':'실시간 조종석 계기'});
    this.root.style.setProperty('--cockpit-brightness', '1');
    this.toolbar = buildElement(document, 'section', {class:'cockpit-toolbar', 'aria-label':'시뮬레이션 설정'});
    this.dockBody=buildElement(document,'div',{class:'cockpit-dock-body',id:'cockpit-dock-body'});
    const group=(label,...children)=>buildElement(document,'div',{class:'cockpit-dock-group'},buildElement(document,'span',{class:'cockpit-dock-label',text:label}),buildElement(document,'div',{class:'cockpit-dock-actions'},...children));
    this.playbackTime=buildElement(document,'strong',{class:'cockpit-playback-time',text:'—'});
    this.playbackToggle=this.button('재생','playback-toggle',()=>onPlayback('toggle'));
    this.playbackRate=this.button('×1','playback-rate',()=>onPlayback('rate'));
    this.playbackGroup=group('재생',this.playbackTime,this.playbackToggle,this.playbackRate);this.playbackGroup.hidden=true;
    this.viewControls=group('객실 시점');this.cabinControls=this.viewControls;
    this.displayControls=group('객실 표시');
    // A panel that covers the view needs a way out that is not the handle it
    // was opened from -- reaching back down to the same button to dismiss it
    // is the one thing nobody tries.
    this.dockClose=this.button('×','dock-close',()=>this.setDockExpanded(false));
    this.dockClose.className='cockpit-dock-close';
    this.dockClose.setAttribute('aria-label','조작 패널 닫기');
    this.dockClose.setAttribute('title','닫기');
    this.dockTitle=buildElement(document,'b',{text:'재생 설정'});
    this.dockBody.append(buildElement(document,'div',{class:'cockpit-dock-head'},this.dockTitle,this.dockClose));
    this.dockHint=buildElement(document,'p',{class:'cockpit-dock-label',text:'기체 준비 중 · 조종석 진입 또는 수동 배정 후 조작할 수 있습니다.'});
    this.dockBody.append(this.playbackGroup,this.dockHint);
    this.dockToggle=this.button('조작','dock-toggle',()=>this.setDockExpanded(!this.dockExpanded));
    this.dockToggle.className='cockpit-dock-handle';this.dockToggle.setAttribute('aria-controls','cockpit-dock-body');
    this.toolbar.append(this.dockBody,this.dockToggle);
    this.setDockExpanded(false);
    this.screens = {};this.focusButtons={};
    for (const [id, title] of [['pfd','PRIMARY FLIGHT'], ['nav','NAVIGATION'], ['system','AIRCRAFT SYSTEMS']]) {
      const screen = buildElement(document, 'section', {class:`cockpit-screen cockpit-${id}`, 'data-screen':id, 'aria-label':title});
      const titleNode = buildElement(document, 'header', {class:'cockpit-screen-title'}, buildElement(document,'span',{text:id==='system'?'VISION':id.toUpperCase()}),buildElement(document,'small',{text:title}));
      const focus=this.button(`${id==='system'?'VISION':id.toUpperCase()} 확대`,`focus-${id}`,()=>this.setScreenFocus(this.focusScreen===id?null:id));
      focus.setAttribute('aria-label',`${title} 확대 또는 원위치`);focus.setAttribute('aria-pressed','false');
      let level=0;const brightness=this.button('밝기',`brightness-${id}`,()=>{level=(level+1)%3;screen.style.setProperty('--cockpit-brightness',String([1,.75,.5][level]));});
      brightness.setAttribute('aria-label',`${title} 밝기`);
      focus.textContent='확대';this.focusButtons[id]=focus;
      titleNode.append(buildElement(document,'div',{class:'cockpit-mfd-tools'},brightness,focus));screen.append(titleNode);
      this.screens[id] = screen;
      this.root.append(screen);
    }
    this.buildPfd(); this.buildNav(); this.buildSystem();
    for (const node of [this.root,this.toolbar,this.viewControls,this.displayControls,...Object.values(this.screens)]) {
      node.onpointerdown=stop; node.onclick=stop; node.ondblclick=stop;
      node.onwheel=event=>{stop(event);event.preventDefault?.();};
      node.onkeydown=event=>{if(event.key!=='Escape')stop(event);};
    }
    this.close();
  }
  button(text, action, handler) {
    return buildElement(this.document,'button',{type:'button',text,'data-action':action,onclick:event=>{stop(event);handler();}});
  }
  setDockExpanded(expanded){
    if(expanded)this.onDockOpen?.();
    this.dockExpanded=Boolean(expanded);this.toolbar.setAttribute('data-expanded',String(this.dockExpanded));
    this.dockBody.inert=!this.dockExpanded;this.dockBody.setAttribute('aria-hidden',String(!this.dockExpanded));
    this.dockToggle.setAttribute('aria-expanded',String(this.dockExpanded));
    this.dockToggle.textContent='조작';
    this.dockToggle.setAttribute('aria-label',this.dockExpanded?'조작 패널 닫기':'조작 패널 열기');
  }
  setCabin(profile){
    this.cabinProfile=profile;this.seatIndex=-1;this.occupantsShown=false;
    this.rearButton=this.button('객실 보기','view-cabin',()=>this.onViewpoint('cabin'));
    this.pilotButton=this.button('조종석 정면','view-pilot',()=>this.onViewpoint('pilot'));
    this.seatButton=this.button('승객석 앉기','view-seat',()=>{const seats=profile.viewpoints??[];if(!seats.length)return;this.seatIndex=(this.seatIndex+1)%seats.length;this.onViewpoint(seats[this.seatIndex].id);});
    this.seatButton.disabled=!profile.viewpoints?.length;
    this.occupantsButton=this.button('착석 미리보기','occupants',()=>{this.occupantsShown=!this.occupantsShown;this.occupantsButton.setAttribute('aria-pressed',String(this.occupantsShown));this.onOccupants(this.occupantsShown);});
    this.occupantsButton.disabled=!profile.occupant_nodes?.length;this.occupantsButton.setAttribute('aria-pressed','false');
    this.occupantsButton.setAttribute('title','객실 배치용 인물 표현 · 실제 탑승 인원과 무관');
    this.cabinControls.querySelector('.cockpit-dock-actions').replaceChildren(this.pilotButton,this.rearButton,this.seatButton);
    this.displayControls.querySelector('.cockpit-dock-actions').replaceChildren(this.occupantsButton);
    this.setViewpointLabel('pilot');
  }
  setViewpointLabel(id){
    const label=id==='cabin'?'객실 뒤쪽':id==='pilot'?'조종석':this.cabinProfile?.viewpoints?.find(v=>v.id===id)?.label??id;
    if(this.seatButton)this.seatButton.textContent=id.startsWith('seat_')?`${label} · 다음 ↻`:'승객석 앉기';
    this.viewControls.setAttribute('aria-label',`객실 시점 · ${label}`);
    for(const [button,pressed] of [[this.rearButton,id==='cabin'],[this.pilotButton,id==='pilot'],[this.seatButton,id.startsWith('seat_')]])button?.setAttribute('aria-pressed',String(pressed));
  }
  setPlayback({enabled=false,time='—',playing=false,speed='×1',canToggle=false,canRate=false,manualFleet=false}={}){
    this.manualFleetPlayback=manualFleet;
    this.playbackGroup.querySelector('.cockpit-dock-label').textContent=manualFleet?'시뮬레이션 · 전체 운항':'시뮬레이션 재생';
    this.playbackEnabled=enabled;this.playbackGroup.hidden=!enabled||(this.manualMode&&!manualFleet);this.playbackTime.textContent=time;
    this.playbackToggle.textContent=playing?'Ⅱ 시뮬레이션 일시정지':'▷ 시뮬레이션 재생';this.playbackToggle.disabled=!canToggle;
    this.playbackRate.textContent=speed;this.playbackRate.disabled=!canRate;this.refreshDockVisibility();
  }
  metric(key,label,unit='') {
    const value=buildElement(this.document,'strong',{'data-readout':key,text:'—'});
    this.readouts[key]=value;
    return buildElement(this.document,'div',{class:`cockpit-metric cockpit-metric-${key}`},buildElement(this.document,'span',{class:'cockpit-metric-label',text:label}),value,buildElement(this.document,'small',{text:unit}));
  }
  applyRangeKm(km){
    if(!finite(km)||km<=0||km===this.rangeKm)return false;
    this.rangeKm=km;
    this.rangeButton.textContent=this.groundMode?`${Math.round(km*1000)} m`:`${km} km`;
    return true;
  }
  // Fit the ground range to the deck the aircraft is on and the stand and pad
  // it is taxiing between. Fitted when that changes, and after that widened the
  // moment the chart outgrows the range but closed in only when the fit has
  // fallen two steps: one step of drift is how a range flickers back and forth
  // while an aircraft taxis. A range the pilot chose holds until the next leg.
  fitGroundRange(chart,position){
    if(!chart){this.groundFitKey=null;return;}
    const fitted=fitGroundRangeKm(chart,position,GROUND_RANGES_KM);
    if(!finite(fitted))return;
    const key=`${chart.id??chart.name??''}|${chart.gate??''}|${chart.fato??''}`;
    if(key!==this.groundFitKey){
      this.groundFitKey=key;this.rangeUserSet=false;this.applyRangeKm(fitted);return;
    }
    if(this.rangeUserSet)return;
    const here=GROUND_RANGES_KM.indexOf(this.rangeKm),want=GROUND_RANGES_KM.indexOf(fitted);
    if(fitted>this.rangeKm||(here>=0&&want>=0&&here-want>=2))this.applyRangeKm(fitted);
  }
  buildPfd(){buildFlightDisplay(this);}
  // Read-only command monitor. Never infer stick input from aircraft attitude.
  setControlInputs(controls=null){
    const c=controls?.source==='observation'?null:controls;
    const ap=c?.autopilot?.enabled===true;
    const source=!c?'NO INPUT':ap?'AP THR':c.enabled===false?'HELD':({joystick:'JOYSTICK',keyboard:'KEYBOARD',screen:'SCREEN'})[c.source]??'MANUAL';
    if(this.inputSource.textContent!==source)this.inputSource.textContent=source;
    for(const key of ['throttle','roll','pitch','yaw']){
      const raw=ap&&key!=='throttle'?null:c?.[key];
      const value=finite(raw)?Math.max(key==='throttle'?0:-1,Math.min(1,raw)):null;
      const text=value===null?'—':`${value>0&&key!=='throttle'?'+':''}${Math.round(value*100)}`;
      if(this.readouts[`input_${key}`].textContent!==text)this.readouts[`input_${key}`].textContent=text;
      const fill=this.inputBars[key],hidden=value===null;
      if(fill.hidden!==hidden)fill.hidden=hidden;
      const left=key==='throttle'?'0%':`${50+Math.min(0,value??0)*50}%`,width=`${Math.abs(value??0)*(key==='throttle'?100:50)}%`;
      if(fill.style.left!==left)fill.style.left=left;
      if(fill.style.width!==width)fill.style.width=width;
    }
  }
  buildNav(){buildNavigationDisplay(this);}
  buildSystem(){buildCameraDisplay(this);}
  setCameraEnabled(enabled){
    this.cameraEnabled=Boolean(enabled);this.cameraReady=false;this.cameraCover.hidden=this.cameraEnabled;
    this.cameraAge.textContent=this.cameraEnabled?'LOADING':'STANDBY';
    this.cameraOff.textContent=this.cameraEnabled?'⏻ ON':'⏻ OFF';this.cameraOff.setAttribute('aria-pressed',String(this.cameraEnabled));
    this.cameraLabel.textContent=({front:'CAM 01 / FORWARD',left:'CAM 02 / LEFT',right:'CAM 03 / RIGHT',down:'CAM 04 / DOWN',around:'SURROUND / TOP VIEW'})[this.cameraMode];
    for(const [id,b] of Object.entries(this.cameraButtons))b.setAttribute('aria-pressed',String(id===this.cameraMode));
    this.onCameraChange({enabled:this.cameraEnabled,mode:this.cameraMode});
  }
  setCameraStatus({text,age,label}={}){
    if(text!==undefined)this.cameraAge.title=text;
    if(age!==undefined){this.cameraAge.textContent=age;this.cameraReady=age==='● 3D LIVE'||age==='HELD POSE';}
    if(label!==undefined)this.cameraLabel.textContent=label;
  }
  setDockAvailable(available){this.dockAvailable=Boolean(available);this.refreshDockVisibility();}
  refreshDockVisibility(){
    const hidden=!this.active&&!this.manualMode&&!this.dockAvailable;
    if(this.toolbar.hidden!==hidden)this.toolbar.hidden=hidden;
    if(this.dockHint)this.dockHint.hidden=Boolean(this.manualMode||this.playbackEnabled);
  }
  setManualMode(manual){
    const next=Boolean(manual);
    if(this.manualMode!==next){
      this.manualMode=next;this.dockTitle.textContent=next?'수동 조종':'재생 설정';
      this.toolbar.setAttribute('aria-label',this.dockTitle.textContent);
      this.playbackGroup.hidden=(next&&!this.manualFleetPlayback)||!this.playbackEnabled;
    }
    this.refreshDockVisibility();
  }
  open() { if(this.destroyed)return;this.active=true;this.root.hidden=false;this.toolbar.hidden=false;this.viewControls.hidden=this.displayControls.hidden=false;this.setDockExpanded(false);this.lastPaint=-Infinity; }
  update(state={},now=0) {
    if(!this.active||this.destroyed)return false;
    const e=state.entity||{},t=state.telemetry||{},m=state.mission||{};
    const identity=e.entity_id??null;
    if(identity===this.identity&&state.epoch===this.epoch&&now>=this.lastPaint&&now-this.lastPaint<100)return false;
    this.identity=identity;this.epoch=state.epoch;this.lastPaint=now;
    const attitude=e.orientation_source==='attitude';
    const heading=(attitude||e.orientation_source==='ground_track')&&finite(e.heading_deg)?((e.heading_deg%360)+360)%360:null;
    const pitch=attitude&&finite(e.pitch_deg)?e.pitch_deg:null,roll=attitude&&finite(e.roll_deg)?e.roll_deg:null;
    const velocity=Array.isArray(e.velocity_ecef_mps)&&e.velocity_ecef_mps.length===3&&e.velocity_ecef_mps.every(finite)?e.velocity_ecef_mps:null;
    const speed=finite(e.recorded_speed_mps)?e.recorded_speed_mps:finite(e.ground_speed_mps)?e.ground_speed_mps:velocity?Math.hypot(...velocity):null;
    let vertical=finite(e.vertical_speed_mps)?e.vertical_speed_mps:null;
    if(!finite(vertical)&&e.velocity_reference!=='latest_observation'&&velocity&&finite(e.latitude_deg)&&finite(e.longitude_deg)) {
      const lat=e.latitude_deg*degrees,lon=e.longitude_deg*degrees;
      vertical=velocity[0]*Math.cos(lat)*Math.cos(lon)+velocity[1]*Math.cos(lat)*Math.sin(lon)+velocity[2]*Math.sin(lat);
    }
    const values={heading:finite(heading)?`${String(Math.round(heading)%360).padStart(3,'0')}°`:'—',pitch:fmt(pitch,1),roll:fmt(roll,1),speed:fmt(speed,1),altitude:fmt(e.altitude_m),vertical:fmt(vertical,1),
      battery:fmt(t.battery_soc_pct),rpm:fmt(finite(t.rotor_rpm)?t.rotor_rpm:finite(t.rotor_radps)?t.rotor_radps*60/(2*Math.PI):null),tilt:fmt(t.tilt_deg,1),mode:t.mode||'미수신',phase:t.flight_phase||m.phase||'미수신',destination:m.next_waypoint||m.destination||'미수신',time:fmt(state.stateTime??e.state_time,1)};
    for(const [key,value] of Object.entries(values))this.readouts[key].textContent=typeof value==='string'?value:'미수신';
    // PHASE is a status annunciator, not the turnaround instruction line.
    // Keep the complete received text available without crowding MODE/TIME.
    const phase=String(values.phase),shortPhase=phase.split(/\s*[·•]\s*/)[0].trim()||phase;
    this.readouts.phase.textContent=shortPhase;
    this.readouts.phase.setAttribute('title',phase);
    this.readouts.phase.setAttribute('aria-label',`운항 상태: ${phase}`);
    this.readouts.phase.style.fontSize=shortPhase.length>8?'13px':'16px';
    this.readouts.altitude.style.fontSize=values.altitude.length>4?'14px':'20px';
    this.readouts.speed.style.fontSize=values.speed.length>4?'18px':'22px';
    this.speedLabel.textContent=finite(e.recorded_speed_mps)?'SPD REC':finite(e.ground_speed_mps)?'SPD GS':'SPD ECEF';
    this.speedLabel.setAttribute('title',`Not airspeed${state.speedNote?` · ${state.speedNote}`:''}`);
    this.systemNote.textContent=state.systemNote||'AIRCRAFT SYSTEMS';
    this.screens.pfd.querySelector('.cockpit-system-grid').setAttribute('title',this.systemNote.textContent);
    this.altLabel.textContent=e.altitude_reference==='MSL'?'ALT MSL':e.altitude_reference==='ellipsoid'?'ALT ELLIPSOID':'ALT REF ?';
    this.altLabel.setAttribute('title','Not AGL; ALT REF ? means altitude datum unavailable');
    this.headingLabel.textContent=attitude?'HDG':'TRK';
    this.screens.pfd.querySelector('.cockpit-metric-heading').querySelector('.cockpit-metric-label').textContent=attitude?'HDG':'TRK';
    const missing=!finite(pitch)||!finite(roll);this.attitude.hidden=missing;
    this.attitude.setAttribute('visibility',missing?'hidden':'visible');this.horizonMissing.setAttribute('visibility',missing?'visible':'hidden');
    if(!missing)this.attitude.setAttribute('transform',`rotate(${-roll} 294 138) translate(0 ${pitch*3.1})`);
    const stale=state.stale||e.quality==='stale';
    this.status.textContent=stale?'오래된 상태 · 마지막 수신값':identity?'관측 표시 · 수신 시간 확인':'데이터 미수신';
    this.status.setAttribute('data-stale',String(Boolean(stale)));
    paintInstruments(this,{speed,altitude:e.altitude_m,heading,pitch,roll,vertical,mission:m,entity:e,stateTime:state.stateTime??e.state_time});
    this.fma.children[0].textContent=stale?'STALE':'OBSERVED';
    this.paintNav(e,m,state.nearby,heading,state.nearbyNote,Boolean(stale));
    this.paintFlightPlan(e,m,Boolean(stale));
    return true;
  }
  paintFlightPlan(entity,mission,stale){
    const timing=mission.timing??{},progress=flightProgress(entity,mission,{stale,cue:this.routeCue});
    const clock=value=>navClock(value,timing.elapsed_clock);
    const values={remaining:finite(progress.remaining)?(progress.remaining/1000).toFixed(1):'—',ete:navDuration(progress.ete),eta:clock(progress.eta),elapsed:navDuration(progress.elapsed),
      planned_off:clock(timing.off_block_s),planned_takeoff:clock(timing.planned_takeoff_s),actual_takeoff:clock(timing.actual_takeoff_s),planned_landing:clock(timing.planned_landing_s)};
    for(const [key,value] of Object.entries(values)){this.readouts[key].textContent=value;this.readouts[key].setAttribute('title',value);}
    this.originName.textContent=mission.origin_name||mission.origin||'—';this.originId.textContent=mission.origin_id||'';
    this.originBox.setAttribute('title',[this.originName.textContent,this.originId.textContent].filter(Boolean).join(' / '));
    const notes={'PSU ROUTE ETA':'접근 순번 활성화와 동일한 남은 항로 ETA · 감속·하강 포함','DATA STALE':'수신 지연 · 예상 시간 계산 보류','NO ROUTE':'경로 미수신 · 예상 시간 계산 불가','HOLD':'대기 중 · 예상 시간 계산 보류','GROUND / NO AIR DATA':'지상 / 비행 상태 미수신 · 예상 시간 대기','NO GROUND SPEED':'지상속도 미수신 · 예상 시간 대기','LOW GROUND SPEED':'지상속도 부족 · 예상 시간 계산 보류'};
    this.progressNote.textContent=notes[progress.note]??`현재 GS ${progress.speed.toFixed(1)} m/s 기준 · 경로 끝까지 · 착륙/대기 제외`;
    this.progressNote.setAttribute('title',progress.note==='PSU ROUTE ETA'?'접근 순번 요청 버튼도 이 ETA가 설정된 요청 시점 이하가 될 때 활성화됩니다.':'남은 경로는 현재 위치부터 다음 WP와 이후 모든 경유점까지 재계산합니다. ETA는 일정이나 허가가 아닌 현재 지상속도 기준 근사값입니다.');
    this.planClockLabel.textContent=mission.timing?(timing.elapsed_clock?'ELAPSED':'SIM KST'):'STATE';
    // Operational schedule seconds and native elapsed seconds must not be mixed.
    if(mission.timing)this.readouts.time.textContent=clock(timing.now_s);
  }
  paintNav(entity,mission,nearby,heading,nearbyNote,stale=false) {
    this.finalDestination.textContent=mission.destination_name||mission.destination||'미수신';
    this.finalDestinationId.textContent=mission.destination_id&&mission.destination_id!==this.finalDestination.textContent?mission.destination_id:'';
    this.finalDestinationBox.title=[this.finalDestination.textContent,this.finalDestinationId.textContent].filter(Boolean).join(' · ');
    const origin=this.groundMode?surfaceOrigin(mission.surface,entity):entity;
    const deckCentred=origin!==entity;
    const validOrigin=finite(origin?.latitude_deg)&&finite(origin?.longitude_deg),angle=this.headingUp?(heading??(deckCentred?0:null)):0;
    const valid=validOrigin&&finite(angle);
    if(this.groundMode)this.fitGroundRange(mission.surface,origin);
    this.ownship.setAttribute('transform',`rotate(${this.headingUp?0:(heading??0)} 100 100)`);
    this.ownship.setAttribute('visibility',finite(heading)?'visible':'hidden');
    const project=point=>{
      if(!valid||!finite(point?.latitude_deg)||!finite(point?.longitude_deg))return null;
      const north=(point.latitude_deg-origin.latitude_deg)*111320;
      const delta=((point.longitude_deg-origin.longitude_deg+540)%360)-180;
      const east=delta*111320*Math.cos(origin.latitude_deg*degrees),r=angle*degrees,scale=90/(this.rangeKm*1000);
      return [100+(east*Math.cos(r)-north*Math.sin(r))*scale,100-(east*Math.sin(r)+north*Math.cos(r))*scale];
    };
    const own=project(entity);
    this.ownship.setAttribute('visibility',!deckCentred&&finite(heading)?'visible':'hidden');
    const points=(mission.route_points||[]).map(project).filter(Boolean);
    this.route.setAttribute('points',points.map(p=>p.map(n=>Math.round(n*10)/10).join(',')).join(' '));
    const cue=routeGuidance(entity,mission);this.routeCue=cue;
    this.routeActive.setAttribute('points',cue?points.slice(cue.index-1,cue.index+1).map(p=>p.join(',')).join(' '):'');
    const routeMarks=[];
    if(valid)for(const [i,p] of points.entries()){
      if(Math.hypot(p[0]-100,p[1]-100)>88)continue;
      const active=i===cue?.index;
      routeMarks.push(['path',{d:`M${p[0]} ${p[1]-3} l3 3 l-3 3 l-3 -3 Z`,fill:active?'#f1a6ff':'#07121d',stroke:'#e38bff','stroke-width':1}]);
      routeMarks.push(['text',{x:p[0]+4,y:p[1]-4,fill:active?'#fff':'#d5a5e5',text:mission.route_points[i].name??String(i+1)}]);
    }
    paintCockpitMarks(this.document,this.routeMarks,routeMarks);
    const guided=cue&&!stale&&!mission.holding&&finite(heading);
    this.courseBug.setAttribute('visibility',guided?'visible':'hidden');
    if(guided){const delta=angleDelta(cue.bearing,heading);this.courseBug.setAttribute('transform',`translate(${Math.max(-275,Math.min(275,delta*5.2))} 0)`);}
    this.guidanceText.textContent=!cue?'NO FLIGHT PLAN':stale?'PLAN STALE':`PLAN ${Math.round(cue.course).toString().padStart(3,'0')}°   XTK ${Math.abs(cue.crossTrackM).toFixed(0)} m ${cue.crossTrackM>5?'R':cue.crossTrackM< -5?'L':'ON PATH'}`;
    if(mission.holding)this.guidanceText.textContent='HOLD / PLAN REFERENCE';
    this.routeInfo.textContent=cue?`${cue.explicit?'지정 구간':'최근접 계획 구간'} ${cue.index}/${mission.route_points.length-1}`:'항로 미수신';
    if(cue){this.readouts.destination.textContent=cue.target.name??cue.target.id??mission.next_waypoint??`WP ${cue.index+1}`;this.readouts.distance.textContent=(cue.distanceM/1000).toFixed(2);}
    const contactMarks=[];
    const visibleContacts=(nearby||[]).filter(other=>other.entity_id!==entity.entity_id)
     .map(other=>({other,p:project(other)})).filter(({p})=>p&&Math.hypot(p[0]-100,p[1]-100)<=86)
     .sort((a,b)=>Math.hypot(a.p[0]-100,a.p[1]-100)-Math.hypot(b.p[0]-100,b.p[1]-100)).slice(0,80);
    for(const {other,p} of visibleContacts){
      const staleContact=other.stale===true||other.quality==='stale',color=staleContact?'#98a5aa':'#68e6e0';
      const bearing=finite(other.heading_deg)?other.heading_deg-angle:0;
      contactMarks.push(['path',{class:'cockpit-contact',d:'M0 -4 L3 3 L0 1 L-3 3 Z',
       transform:`translate(${p[0]} ${p[1]}) rotate(${bearing})`,fill:staleContact?'none':color,stroke:color,'stroke-width':1,
       'data-contact-id':other.entity_id}]);
      const label=String(other.name??other.entity_id??'').split(':').pop();
      contactMarks.push(['text',{x:p[0]+5,y:p[1]-4,fill:color,'font-size':5,text:label}]);
    }
    paintCockpitMarks(this.document,this.contacts,contactMarks);
    this.navStatus.textContent=!valid?'위치 / 방위 미수신':!Array.isArray(nearby)?'주변 교통 미수신':`관측 교통 ${visibleContacts.length}${nearbyNote?' (최신 관측)':''} · ${points.length?'항로 표시':'항로 미수신'}`;
    const allocation=mission.surface;
    this.navSurface.textContent=allocation?`${allocation.name??allocation.id??''} / ${allocation.stale?'수신 지연':allocation.assigned?'배정':'계획'}\nFATO ${allocation.fato??allocation.liveFato??allocation.plannedFato??'—'}  /  GATE ${allocation.gate??allocation.liveGate??allocation.plannedGate??'—'}`:'지상 배정 미수신';
    this.navSurface.title=allocation?`계획 FATO ${allocation.plannedFato??'—'} / GATE ${allocation.plannedGate??'—'} — ${allocation.instruction??'배정은 이동 허가가 아닙니다'}`:'';
    for(const [key,label] of [['destination',this.groundMode?'GATE':'NEXT'],['distance',this.groundMode?'FATO':'TO WPT']]){
      const metric=this.screens.nav.querySelector(`.cockpit-metric-${key}`);metric.querySelector('.cockpit-metric-label').textContent=label;metric.querySelector('small').textContent=key==='distance'&&!this.groundMode?'km':'';
    }
    this.surface.replaceChildren();
    for(const node of [this.route,this.routeActive,this.routeMarks])node.setAttribute('visibility',this.groundMode?'hidden':'visible');
    if(this.groundMode){
      const chart=mission.surface;
      for(const path of chart?.paths??[])this.surface.append(buildSvg(this.document,'polyline',{points:path.map(project).filter(Boolean).map(p=>p.join(',')).join(' '),fill:'none',stroke:'#71878c','stroke-width':2}));
      const taxi=(chart?.taxiPath??[]).map(project).filter(Boolean),routeColor=chart?.taxiGranted?'#70dbc1':'#ffde78';
      if(taxi.length>1){
       this.surface.append(buildSvg(this.document,'polyline',{points:taxi.map(p=>p.join(',')).join(' '),fill:'none',stroke:routeColor,'stroke-width':2.8,'data-ground-route':'assigned'}));
       let spacing=0;
       for(let i=1;i<taxi.length;i++){const a=taxi[i-1],b=taxi[i],dx=b[0]-a[0],dy=b[1]-a[1];spacing+=Math.hypot(dx,dy);
        if(spacing<12&&i<taxi.length-1)continue;spacing=0;
        this.surface.append(buildSvg(this.document,'path',{d:'M-2 -3 L2 0 L-2 3',fill:'none',stroke:routeColor,'stroke-width':1.5,transform:`translate(${(a[0]+b[0])/2} ${(a[1]+b[1])/2}) rotate(${Math.atan2(dy,dx)*180/Math.PI})`}));
       }
      }
      for(const occupied of chart?.occupied??[]){const p=project(occupied);if(!p)continue;
       this.surface.append(buildSvg(this.document,'circle',{cx:p[0],cy:p[1],r:Math.max(2,(occupied.radius_m??7)/(this.rangeKm*1000)*85),fill:'#e7824033',stroke:'#ffa568','stroke-width':1,'data-ground-occupant':occupied.aircraft_id}));
      }
      for(const place of chart?.places??[]){
        const p=project(place);if(!p)continue;
        const assigned=place.id===(place.kind==='gate'?chart.gate:chart.fato),color=assigned?'#ffde78':place.kind==='gate'?'#70dbc1':'#8fcde8';
        const radius=Math.max(2,place.radius*90/(this.rangeKm*1000));
        this.surface.append(buildSvg(this.document,'circle',{cx:p[0],cy:p[1],r:radius,fill:assigned?'#555035':'#142731',stroke:color,'stroke-width':assigned?1.6:.7}));
        this.surface.append(buildSvg(this.document,'text',{x:p[0],y:p[1]-radius-1.6,'text-anchor':'middle',fill:color,'font-size':6,text:place.id}));
      }
      this.readouts.destination.textContent=chart?.gate??'미할당';
      this.readouts.distance.textContent=chart?.fato??'미할당';
      this.routeInfo.textContent=chart?`${chart.name} · ${chart.stale?'배정 수신 지연':chart.assigned?'관제 배정':chart.planned?'계획 배정':'배정 미수신'}`:'주변 지상 도면 없음';
      this.navStatus.textContent=chart?.geometryAvailable?(deckCentred?`목적지 중심 · 기체 ${(chart.distance_m/1000).toFixed(1)} km 밖 · 노랑: 지정 위치`:'기체 중심 · 노랑: 지정 위치 · 이동 허가 아님'):'배정 도면 미수신';
      if(chart?.taxiPath?.length)this.navStatus.textContent=chart.taxiGranted?'초록: 배정 이동 경로 · 주황: 기체 점유':'노랑: 배정 경로 · 이동 허가 대기 · 주황: 점유';
      if(deckCentred&&own){const dx=own[0]-100,dy=own[1]-100,n=Math.hypot(dx,dy)||1;this.surface.append(buildSvg(this.document,'path',{d:'M0 -4 L4 4 L-4 4 Z',fill:'#fff',transform:`translate(${100+dx/n*84} ${100+dy/n*84}) rotate(${Math.atan2(dy,dx)*180/Math.PI+90})`}));}
    }

  }
  setScreenFocus(id){
    this.focusScreen=Object.hasOwn(this.screens,id)?id:null;
    if(this.focusScreen)this.onScreenFocus();
    for(const [key,screen] of Object.entries(this.screens)){
      const selected=key===this.focusScreen;screen.setAttribute('data-focused',String(selected));
      const button=this.focusButtons[key];
      button.textContent=selected?'원위치':'확대';button.setAttribute('aria-pressed',String(selected));
    }
  }
  close() {
    this.setScreenFocus(null);
    if(this.cameraEnabled)this.setCameraEnabled(false);
    this.navSurface.textContent='지상 배정 미수신';this.navSurface.title='';
    this.active=false;this.root.hidden=true;this.refreshDockVisibility();this.viewControls.hidden=this.displayControls.hidden=true;this.setDockExpanded(false);this.identity=null;this.lastPaint=-Infinity;
    this.groundFitKey=null;this.rangeUserSet=false;
    for(const node of Object.values(this.readouts))node.textContent='—';
    this.setControlInputs(null);
    for(const node of [this.originName,this.finalDestination])node.textContent='—';
    this.originId.textContent=this.finalDestinationId.textContent='';
    this.progressNote.textContent='경로 / 시간 미수신';
    this.route.setAttribute('points','');this.routeActive.setAttribute('points','');this.routeMarks.replaceChildren();this.courseBug.setAttribute('visibility','hidden');this.contacts.replaceChildren();this.surface.replaceChildren();
    this.attitude.setAttribute('visibility','hidden');this.horizonMissing.setAttribute('visibility','visible');
    this.status.textContent='데이터 미수신';
  }
  destroy() {
    this.close();this.destroyed=true;
    const descendants = node => [node, ...Array.from(node.children).flatMap(descendants)];
    for(const node of [...descendants(this.root),...descendants(this.toolbar),...descendants(this.viewControls),...descendants(this.displayControls)]){
      node.onclick=null;node.onwheel=null;node.onpointerdown=null;node.ondblclick=null;node.onkeydown=null;
    }
    this.root.remove();this.toolbar.remove();this.viewControls.remove();this.displayControls.remove();
  }
}


