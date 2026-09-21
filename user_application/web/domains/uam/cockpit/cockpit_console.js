import {pilotGuidance,operationClock,PSU_PILOT_HELP,PSU_STEPS} from '../operations/psu_pilot_guidance.js?v=20260921-arrival2';
// Repeated attributes invalidate style on every cockpit frame, even at rest.
const attribute=(node,name,value)=>{const next=String(value);if(node.getAttribute(name)!==next)node.setAttribute(name,next);};
import {buildElement as el} from '../../../dom_builder.js';
export const CONSOLE_WIDTH=1727,CONSOLE_HEIGHT=374,CONSOLE_FOCUS_WIDTH=740,CONSOLE_FOCUS_HEIGHT=460;
export function consoleSurface(profile){
 const n=profile?.screens?.find(s=>s.id==='nav');if(!n)return null;
 return {...n,id:'console',center:n.center.map((x,i)=>x-(n.up??[0,1,0])[i]*n.height*.96+(n.right??[0,0,1])[i]*n.width*.50),width:n.width*2.10,height:n.height*.72};
}
const set=(node,text)=>{if(node.textContent!==text)node.textContent=text;};
const phaseIndex=phase=>phase==='awaiting_charge'?1:['opening','alighting','connecting','charging','complete'].indexOf(phase);
// MFD actions stay with their displays. Only simulation input/session settings
// are mounted in the application dock; the runtime still owns ground procedures.
export class CockpitConsole{
 constructor({document,onControl=()=>{},onGround=()=>{},onFocus=()=>{},onPsu=()=>{}}){
  this.onControl=onControl;this.onGround=onGround;this.onFocus=onFocus;const e=(tag,a,...c)=>el(document,tag,a,...c);
  const button=(text,fn)=>e('button',{type:'button',text,onclick:event=>{event.stopPropagation?.();fn();}});
  // A control that carries a value is not the same thing as a control that
  // does something, and neither is a setting that opens a window. In one flat
  // row of identical buttons nothing said which was which, or what was
  // currently selected. A picker shows its own value; an action does not.
  const picker=(label,fn)=>{
   const value=e('b',{class:'cockpit-pick-value',text:'—'});
   const node=e('button',{type:'button',class:'cockpit-pick',onclick:event=>{event.stopPropagation?.();fn();}},
    e('span',{class:'cockpit-pick-label',text:label}),value,e('i',{class:'cockpit-pick-next','aria-hidden':'true'}));
   return [node,value];
  };
  [this.source,this.sourceValue]=picker('입력',()=>onControl('source',['keyboard','screen','joystick'][(['keyboard','screen','joystick'].indexOf(this.state?.source)+1)%3]));
  attribute(this.source,'aria-label','조작 입력 방식 · 눌러서 변경');
  [this.mode,this.modeValue]=picker('모드',()=>onControl('mode',this.state?.mode==='fixed_wing'?'multirotor':'fixed_wing'));
  attribute(this.mode,'aria-label','비행 모드 · 눌러서 변경');
  this.tune=button('조이스틱 설정',()=>onControl('tune'));this.tune.className='cockpit-dock-setting';
  this.findAircraft=button('내 기체 찾기',()=>{if(!this.findAircraft.disabled)onControl('find_aircraft');});this.findAircraft.className='cockpit-dock-setting';
  this.pause=button('일시정지',()=>onControl(this.state?.active?'pause':'resume'));this.pause.className='cockpit-dock-act';
  this.groundAction='disembark';
  this.ground=button('문 열기 · 하차 요청',()=>{if(!this.ground.disabled)onGround(this.groundAction);});
  this.releaseButton=button('충전 해제 · 문 닫기',()=>{if(!this.releaseButton.disabled)onGround('release');});
  this.controlOwner=e('strong',{class:'cockpit-control-owner',text:'내 기체'});
  this.controlState=e('span',{class:'cockpit-control-state',text:'연결 대기'});
  this.inputGuide=e('div',{class:'cockpit-input-guide'});
  this.controlsRoot=e('div',{class:'cockpit-operation-controls','aria-label':'수동 조종'},
   e('div',{class:'cockpit-control-context'},this.controlOwner,this.controlState),
   e('div',{class:'cockpit-simulation-row'},this.source,this.mode,this.pause),this.tune,this.findAircraft,
   e('details',{class:'cockpit-control-help'},e('summary',{text:'조작 안내'}),this.inputGuide));
  this.focusButtons={};
  const title=(id,name,key)=>{
   const focus=button('확대',()=>this.setFocused(this.focusScreen===key?null:key));
   attribute(focus,'aria-label',`${id} 확대 또는 원위치`);this.focusButtons[key]=focus;
   let level=0;const brightness=button('밝기',()=>{level=(level+1)%3;const screen=key==='psu'?this.psuScreen:this.turnaroundScreen;screen.style.setProperty('--cockpit-brightness',String([1,.75,.5][level]));});
   attribute(brightness,'aria-label',`${id} 밝기`);
   return e('header',{class:'cockpit-screen-title'},e('span',{text:id}),e('small',{text:name}),e('div',{class:'cockpit-mfd-tools'},brightness,focus));
  };
  this.autopilotButton=button('AP OFF',()=>{if(!this.autopilotButton.disabled)onControl('autopilot',!this.apEnabled);});
  // Two holds beside the autopilot, because that is what they are next to on a
  // stick. They are toggles: pressing the one that is lit takes it off, which
  // is the only thing a pilot can do with one button and the thing they expect.
  this.holdAltitudeButton=button('ALT',()=>{if(!this.holdAltitudeButton.disabled)onControl('hold','altitude');});
  this.holdPositionButton=button('POS',()=>{if(!this.holdPositionButton.disabled)onControl('hold','position');});
  const field=(label,value)=>e('div',{class:'cockpit-ground-metric'},e('span',{text:label}),value);
  this.groundStatus=e('strong',{text:'상태 미수신'});
  this.progress=e('div',{class:'cockpit-ground-steps'},...['DOOR','PAX','CONNECT','CHARGE'].map(text=>e('span',{text})));
  this.door=e('strong',{text:'—'});this.passengers=e('strong',{text:'—'});this.charger=e('strong',{text:'—'});this.energy=e('strong',{text:'—'});
  this.nextFlight=e('strong',{text:'다음 일정 대기'});this.nextDeparture=e('span',{text:''});
  this.nextSchedule=e('div',{class:'cockpit-next-flight',hidden:''},
   e('span',{text:'NEXT FLIGHT'}),this.nextFlight,this.nextDeparture);
  this.groundNote=e('span',{text:'지상 상태 미수신'});this.phase=e('span',{text:'STANDBY'});
  this.turnaroundScreen=e('section',{class:'cockpit-screen cockpit-ground-mfd cockpit-turnaround-mfd','aria-label':'TURNAROUND 지상 지원 계기'},title('TURNAROUND','GROUND SYSTEMS','turnaround'),
   e('div',{class:'cockpit-ground-heading'},this.groundStatus,this.phase),this.progress,
   e('div',{class:'cockpit-ground-grid'},field('DOOR',this.door),field('PAX ON BOARD',this.passengers),field('CHARGER',this.charger),field('BATTERY',this.energy)),
   this.nextSchedule,e('footer',{class:'cockpit-ground-footer'},this.groundNote),e('nav',{class:'cockpit-mfd-actions','aria-label':'TURNAROUND 기능'},this.ground,this.releaseButton));
  this.psuState=e('strong',{text:'지시 수신 대기'});this.psuFlight=e('span',{text:'—'});
  this.psuTakeoff=e('strong',{text:'미정'});this.psuLanding=e('strong',{text:'미정'});
  // These two rows carry a forecast when no slot has been issued, and the
  // label has to say which of the two it is showing -- so it is a node here
  // rather than a string baked into `field`.
  this.psuTakeoffLabel=e('span',{text:'이륙 슬롯 · 허가 별도'});
  this.psuLandingLabel=e('span',{text:'착륙 슬롯 · 허가 별도'});
  this.psuDepartNote=e('span');this.psuArriveNote=e('span');this.psuNotice=e('span');
  this.psuDue=e('span',{class:'cockpit-psu-due'});
  this.departButton=button('출발 준비 · 이동 요청',()=>{if(!this.departButton.disabled&&this.psuNext)onPsu(this.psuNext);});
  this.arriveButton=button('지시 새로 확인',()=>{if(!this.arriveButton.disabled)onPsu('refresh');});
  // Not 대기 요청: a pilot read that as the thing you press when you arrive,
  // which is the one thing it is not. It asks the service whether this flight
  // may keep coming, and the answer is either 'keep coming' or 'wait, here is
  // your bay and your number'. It is also rarely needed -- a hold is imposed
  // and the bay assigned without asking -- so it sits in the quiet row.
  this.holdButton=button('진행 문의',()=>{if(!this.holdButton.disabled)onPsu('hold');});
  this.psuClockRow=e('div',{class:'cockpit-psu-clock'},this.psuDue);
  // The whole procedure in one row. Every stage told the pilot what to press
  // now and nothing said what it was one of, so the order had to be carried in
  // their head. Built once and only restyled, because it never changes shape.
  this.psuSteps=PSU_STEPS.map(([kind,label])=>e('li',{'data-kind':kind,text:({departure:'출발 요청',takeoff:'이륙 요청',report_airborne:'이륙 보고',arrival:'접근 순번',approach:'접근 요청',landing:'착륙 요청',report_landed:'착륙 보고',report_gate:'GATE 보고'})[kind]??label}));
  this.psuStepRow=e('ol',{class:'cockpit-psu-steps','aria-label':'운항 절차 단계'},...this.psuSteps);
  this.psuPrompt=e('p',{class:'cockpit-psu-prompt',hidden:''});
  this.psuDirective=e('div',{class:'cockpit-psu-directive'},this.psuDepartNote);
  this.psuHistory=e('div',{class:'cockpit-psu-history'});
  this.psuHelp=e('div',{class:'cockpit-psu-help'},e('b',{text:'최근 교신'}),this.psuHistory,e('details',{},e('summary',{text:'절차 안내'}),e('p',{text:PSU_PILOT_HELP}))); 
  this.psuConnection=e('span',{class:'cockpit-psu-connection',text:'PSU 미연결'});
  this.psuNextText=e('strong',{text:'PSU 연결 후 다음 행동을 안내합니다'});
  this.psuLiveBody=e('div',{class:'cockpit-psu-live'},
    e('div',{class:'cockpit-psu-section-label',text:'받은 지시'}),this.psuDirective,this.psuPrompt,
    e('div',{class:'cockpit-psu-next'},e('span',{text:'내 다음 행동'}),this.psuNextText),
    this.psuClockRow,e('div',{class:'cockpit-psu-reason'},this.psuNotice));
  this.psuCommsBody=e('div',{class:'cockpit-psu-comms',hidden:''},
    e('div',{class:'cockpit-ground-grid cockpit-psu-times'},
      e('div',{class:'cockpit-ground-metric'},this.psuTakeoffLabel,this.psuTakeoff),
      e('div',{class:'cockpit-ground-metric'},this.psuLandingLabel,this.psuLanding)),
    e('div',{class:'cockpit-psu-route'},this.psuArriveNote),this.psuHelp);
  this.psuTabs=[button('현재 지시',()=>this.setPsuTab(false)),button('교신 · 상세',()=>this.setPsuTab(true))];
  this.psuScreen=e('section',{class:'cockpit-screen cockpit-ground-mfd cockpit-psu-mfd','aria-label':'PSU 통신 및 절차'},
   title('PSU','PILOT PROCEDURE','psu'),
   e('div',{class:'cockpit-ground-heading'},this.psuState,this.psuFlight),
   e('div',{class:'cockpit-psu-tab-row'},this.psuConnection,...this.psuTabs),this.psuStepRow,
   this.psuLiveBody,this.psuCommsBody,
   e('nav',{class:'cockpit-mfd-actions','aria-label':'PSU 요청'},this.departButton,
     e('div',{class:'cockpit-psu-aside'},this.arriveButton,this.holdButton)));
  this.root=e('section',{class:'cockpit-console',hidden:'','aria-label':'하단 다기능 계기'},
   e('div',{class:'cockpit-hardware-clearance','aria-hidden':'true'}),this.turnaroundScreen,this.psuScreen);
  this.setPsuTab(false);this.updatePsu(null);
  // The hardware bays remain transparent to both rendering and scene picking.
  this.root.style.pointerEvents='none';
  this.setFocused(false);
 }
 setPsuTab(comms){
  this.psuLiveBody.hidden=Boolean(comms);this.psuCommsBody.hidden=!comms;
  this.psuTabs.forEach((b,i)=>attribute(b,'aria-pressed',String(Boolean(i)===Boolean(comms))));
 }
 setFocused(value){
  this.focusScreen=value===true?'turnaround':['turnaround','psu'].includes(value)?value:null;
  this.focused=Boolean(this.focusScreen);if(this.focused)this.onFocus();
  // Select the actual display as well as its layout. Never rely on the
  // cached stylesheet alone to decide which of the two MFDs is enlarged.
  this.turnaroundScreen.hidden=this.focused&&this.focusScreen!=='turnaround';
  this.psuScreen.hidden=this.focused&&this.focusScreen!=='psu';
  attribute(this.root,'data-focused',String(this.focused));attribute(this.root,'data-focus-screen',this.focusScreen??'');
  for(const [key,button] of Object.entries(this.focusButtons)){const active=key===this.focusScreen;set(button,active?'원위치':'확대');attribute(button,'aria-pressed',String(active));}
 }
 // What the service is saying, and which of the three requests are worth
 // pressing right now. A button that cannot do anything says so by being
 // unpressable rather than by answering with a refusal.
 updatePsu(psu,{chart=null,stale=false}={}){
  const active=Boolean(psu);
  this.psuActive=active;attribute(this.root,'data-psu',String(active));
  if(!active){
   set(this.psuState,'PSU 미연결');set(this.psuFlight,'—');set(this.psuConnection,'연결 없음');
   set(this.psuDepartNote,'이 비행에는 연결된 PSU 운항 절차가 없습니다.');
   set(this.psuNextText,'비행 계획과 기체 상태를 확인하세요.');
   set(this.psuNotice,'단일 비행·관찰 모드에서도 같은 화면을 사용합니다. 허가를 임의로 표시하지 않습니다.');
   set(this.psuDue,'');this.psuClockRow.hidden=true;this.psuPrompt.hidden=true;this.psuDirective.hidden=false;
   set(this.psuArriveNote,'');set(this.psuHistory,'PSU 교신 없음');
   set(this.psuTakeoff,'미정');set(this.psuLanding,'미정');
   set(this.psuTakeoffLabel,'이륙 슬롯 · 허가 별도');set(this.psuLandingLabel,'착륙 슬롯 · 허가 별도');
   this.psuNext=null;this.departButton.title='연결된 PSU가 없어 요청을 보낼 수 없습니다';this.psuNotice.title='';set(this.departButton,'PSU 연결 필요');set(this.holdButton,'진행 문의');
   for(const b of [this.departButton,this.arriveButton,this.holdButton])b.disabled=true;
   this.psuSteps.forEach(n=>attribute(n,'data-state','todo'));
   attribute(this.psuScreen,'data-alert','false');attribute(this.psuScreen,'data-tone','hold');
   if(chart?.decision){
    const d=chart.decision,fields=d.fields??[],value=key=>fields.find(f=>f.key===key)?.value;
    set(this.psuConnection,stale?'수신 지연':'관찰 · 읽기 전용');set(this.psuState,stale?'지시 재확인':d.title);
    set(this.psuDepartNote,stale?'오래된 지시 · 재확인 필요':value('clearance')??'PSU 지시 미수신');
    set(this.psuNextText,stale?'새 관측을 기다리세요':value('traffic')??d.reason??'현재 상태 관찰');
    set(this.psuNotice,[d.source,value('sequence')?`순번 ${value('sequence')}`:'',d.reason].filter(Boolean).join(' / '));
   }
   return;
  }
  const view=pilotGuidance(psu,{distanceM:this.lastChartDistance});
  set(this.psuFlight,psu.flight_id??'—');set(this.psuState,view.stage);
  attribute(this.psuScreen,'data-tone',view.tone);
  attribute(this.psuScreen,'data-alert',String(Boolean(psu.error||(psu.violations??[]).length)));
  set(this.psuTakeoff,view.takeoff);set(this.psuLanding,view.landing);
  set(this.psuTakeoffLabel,view.takeoffLabel);set(this.psuLandingLabel,view.landingLabel);
  set(this.psuDepartNote,view.text);set(this.psuArriveNote,view.route);set(this.psuDue,view.due);
  const violation=(psu.violations??[]).at(-1);
  set(this.psuNotice,[view.reason,violation?`위반 기록: ${violation.reason}`:''].filter(Boolean).join(' · ')||'다음 요청·보고를 확인하세요');
  this.psuNotice.title=this.psuNotice.textContent;
  view.steps.forEach((step,index)=>attribute(this.psuSteps[index],'data-state',step.state));
  this.psuPrompt.hidden=!view.prompt;
  if(view.prompt)set(this.psuPrompt,view.prompt);
  attribute(this.psuPrompt,'data-urgent',String(Boolean(view.urgent)));
  // Keep the received directive visible; the approach reminder is not a clearance.
  this.psuDirective.hidden=false;
  set(this.psuConnection,psu.stale||psu.error?'수신 확인 필요':psu.pending?'요청 처리 중':view.stopped?'시뮬레이션 정지':view.next.enabled?'요청·보고 가능':'지시 확인');
  set(this.psuNextText,view.next.label??'새 지시를 기다리세요');
  this.psuNext=view.next.kind;set(this.departButton,view.next.label);this.departButton.disabled=!view.next.enabled;
  this.departButton.title=view.reason||view.text;
  this.arriveButton.disabled=Boolean(psu.pending);
  const queued=psu.procedure?.stage==='출발 배정 대기';
  set(this.holdButton,queued?'출발 요청 취소':'접근 중단·대기 요청');
  this.holdButton.title=queued?'대기 중인 출발 접수 취소':'접근·착륙 허가를 취소하고 대기를 요청합니다. 상태 확인은 지시 새로 확인을 누르세요';
  this.holdButton.disabled=view.blocked||(!psu.airborne&&!queued);
  // This row carries the one line that says *when*, and it was shown only in
  // the '준비' stage and while the simulation was stopped. Pressing 출발 요청
  // moves the stage to '출발 배정 대기', so the countdown to the departure
  // review vanished at the exact moment the pilot asked for it -- and the
  // issued approach time, which lives in the same line once airborne, could
  // never appear at all. It is shown whenever it has something to say.
  this.psuClockRow.hidden=!view.due;
  const history=view.history.map(x=>`${operationClock(x.time_s)}  ${PSU_STEPS.find(([kind])=>kind===x.kind)?.[1]??x.kind} → ${({granted:'허가',hold:'대기',holding:'대기',refused:'거절',rejected:'거절',reported:'보고 접수',accepted:'접수',cancelled:'취소'})[x.state]??x.state}  ${x.reason??''}`).join('\n');
  set(this.psuHistory,history||'아직 요청·보고 기록이 없습니다');

 }
 release(){this.onControl('stick',{x:0,y:0});this.onControl('yaw',0);}
 updateControls(controls){
  this.state=controls;const manual=Boolean(controls),enabled=Boolean(controls?.enabled),screen=controls?.source==='screen';
  this.controlsRoot.hidden=!manual;
  set(this.controlOwner,controls?.entity_id?.startsWith('scenario:')?`배정 기체 · ${controls.entity_id.slice(9)}`:'단일 비행 · 내 기체');
  set(this.controlState,controls?.viewingOther?'다른 기체 관찰 중 · 조종 대상 유지':controls?.active?(enabled?'입력 연결됨':'지상 절차 진행 중'):'입력 일시정지');
  set(this.inputGuide,controls?.source==='joystick'?'장치 설정에서 축과 버튼을 확인하세요.':screen?'조종석의 3D 스틱과 스로틀 레버를 드래그하세요.':'방향키: 피치·롤 / 지상 이동 · Q·E: 회전 · W·S: 스로틀 · Shift: 미세 조작 · X/Z: 멀티로터/고정익');
  set(this.pause,controls?.active?'입력 정지':'입력 재개');this.pause.disabled=!manual;
  set(this.sourceValue,controls?.source==='joystick'?'조이스틱':screen?'3D 스틱':'키보드');
  set(this.modeValue,controls?.mode==='fixed_wing'?'고정익':'멀티로터');
  this.source.disabled=this.mode.disabled=!enabled;this.tune.disabled=!manual;
  this.tune.hidden=!manual;
  this.findAircraft.hidden=!manual;this.findAircraft.disabled=!manual;
  attribute(this.pause,'aria-pressed',String(manual&&controls?.active===false));
 }
 update({controls=null,dockControls=controls,ground=null,chart=null,stale=false,telemetry=null,psu=null}={}){
  const ap=telemetry?.autopilot??controls?.autopilot;
  this.apEnabled=Boolean(ap?.enabled);
  this.autopilotButton.hidden=!controls;
  this.autopilotButton.disabled=!controls?.autopilotSupported||Boolean(controls?.autopilotPending)||(!this.apEnabled&&(!controls?.active||!telemetry?.airborne));
  set(this.autopilotButton,controls?.autopilotPending?'AP ...':this.apEnabled?'AP ON':'AP OFF');
  this.autopilotButton.title=(ap?.message??'NAV / ALT / SPEED')+(this.apEnabled?' | '+ap.target_speed_mps+' m/s':'');
  attribute(this.autopilotButton,'aria-pressed',String(this.apEnabled));
  const hold=telemetry?.hold??controls?.hold,holdMode=hold?.mode??'off';
  for(const [node,mode,label,title] of [[this.holdAltitudeButton,'altitude','ALT','고도 유지 — 지금 높이를 지킵니다'],
                                        [this.holdPositionButton,'position','POS','위치 유지 — 지금 자리를 지킵니다 (멀티로터)']]){
    node.hidden=!controls;
    // Available in the air and nowhere else, and never while the far end has
    // not answered the last press.
    node.disabled=Boolean(controls?.holdPending)||(holdMode!==mode&&(!controls?.active||!telemetry?.airborne));
    set(node,controls?.holdPending?'···':label);
    node.title=holdMode===mode?(hold?.message??title):title;
    attribute(node,'aria-pressed',String(holdMode===mode));
  }

  // NAV ground-chart distance also drives the approach reservation reminder.
  this.lastChartDistance=Number.isFinite(chart?.distance_m)?chart.distance_m:null;
  this.updatePsu(psu,{chart,stale});
  // Ground-service phase may stay idle throughout manual flight. Actual
  // airborne telemetry owns the display; never offer ground actions in air.
  if(telemetry?.airborne===true)ground={...ground,phase:'airborne',readOnly:true,available:false,
   door_state:ground?.door_state??'CLOSED',charger_state:'NOT IN USE',
   reason:'비행 중 · 착륙 후 GATE 도착 보고를 마치면 지상 절차를 시작합니다'};
  this.updateControls(dockControls);const manual=Boolean(controls);
  this.groundAction=ground?.phase==='awaiting_charge'?'charge':'disembark';
  set(this.ground,this.groundAction==='charge'?'충전 연결 요청':'문 열기 · 하차 요청');
  const next=ground?.next_flight,target=Number(next?.target_soc_pct),battery=Number(telemetry?.battery_pct);
  const charged=!Number.isFinite(target)||(Number.isFinite(battery)&&battery+1e-6>=target);
  this.nextSchedule.hidden=!next&&!ground?.flight_completed;
  if(next){
   set(this.nextFlight,`${next.flight_id} · ${next.origin} → ${next.destination}`);
   set(this.nextDeparture,[Number.isFinite(next.off_block_s)?`ETD ${operationClock(next.off_block_s)}`:'',Number.isFinite(next.ready_s)?`출발 준비 ${operationClock(next.ready_s)}`:'',Number.isFinite(target)?`목표 ${target.toFixed(0)}%`:''].filter(Boolean).join(' · '));
  }else if(ground?.flight_completed){set(this.nextFlight,'오늘 남은 예정 비행 없음');set(this.nextDeparture,'이 기체의 일정이 완료되었습니다');}
  const continuing=ground?.phase==='released'&&Boolean(next);
  set(this.releaseButton,continuing?'다음 비행 이어가기':ground?.phase==='released'&&ground?.flight_completed?'오늘 운항 완료':ground?.phase==='awaiting_charge'||ground?.phase==='complete'?'문 닫기':'충전 해제 · 문 닫기');
  this.releaseButton.onclick=event=>{event.stopPropagation?.();if(!this.releaseButton.disabled)this.onGround(continuing?'next_flight':'release');};
  this.ground.disabled=Boolean(ground?.readOnly)||(this.groundAction==='charge'&&controls?.groundChargeSupported===false)||stale||controls?.groundSupported===false||!manual||controls?.active===false||!(ground?.available||ground?.phase==='awaiting_charge')||Boolean(controls?.pending);
  this.releaseButton.disabled=Boolean(ground?.readOnly)||stale||controls?.groundSupported===false||!manual||controls?.active===false||Boolean(controls?.pending)||
   (continuing?(controls?.nextFlightSupported===false||!charged):!['awaiting_charge','charging','complete'].includes(ground?.phase));
  const phases={airborne:'비행 중',boarding:'승객 탑승',taxi:'지상 이동',parked:'주기',unknown:'운항 상태 미수신',idle:'지상 절차 대기',opening:'출입문 개방',alighting:'승객 하차',awaiting_charge:'충전 요청 대기',connecting:'충전기 연결',charging:'충전 중',complete:'하차 완료',disconnecting:'충전기 분리',closing:'출입문 닫힘',released:'출발 준비'};
  set(this.groundStatus,stale?'관측 지연':phases[ground?.phase]??'상태 미수신');set(this.phase,stale?'STALE':ground?.phase?.toUpperCase()??'STANDBY');
  const index=ground?.readOnly?-1:phaseIndex(ground?.phase);
  [...this.progress.children].forEach((node,i)=>{attribute(node,'data-done',String(index>=0&&i<index));attribute(node,'data-active',String(i===Math.min(index,3)));});
  set(this.door,ground?.readOnly?ground.door_state:ground?(['alighting','awaiting_charge','connecting','charging','complete','disconnecting'].includes(ground.phase)?'OPEN':ground.phase==='opening'?'OPENING':ground.phase==='closing'?'CLOSING':'CLOSED'):'—');
  set(this.passengers,Number.isFinite(ground?.passengers_remaining)?String(ground.passengers_remaining):Number.isFinite(telemetry?.passengers)?String(telemetry.passengers):'—');
  set(this.charger,ground?.readOnly?ground.charger_state:ground?(ground.phase==='charging'?'CONNECTED':ground.phase==='complete'?'NOT AVAILABLE':ground.phase==='connecting'?'CONNECTING':ground.phase==='disconnecting'?'RELEASING':'STANDBY'):'—');
  set(this.energy,Number.isFinite(telemetry?.battery_pct)?`${telemetry.battery_pct.toFixed(0)} %`:'—');
  const neutralDetail=controls&&!stale&&ground?.reason?.includes('스틱 중립')?
   ` · T ${(100*(controls.throttle??0)).toFixed(1)}% / R ${(100*(controls.roll??0)).toFixed(1)} / P ${(100*(controls.pitch??0)).toFixed(1)} / Y ${(100*(controls.yaw??0)).toFixed(1)}%`:'';
  const chargeNote=continuing&&!charged&&Number.isFinite(target)?` · 다음 비행은 배터리 ${target.toFixed(0)}% 이상에서 준비 가능`:'';
  set(this.groundNote,stale?'마지막 수신 상태':controls?.error??(controls?.groundSupported===false?'서버 재시작 후 지상 조작 사용':controls?.pending?'서버 확인 중…':ground?.reason?ground.reason+neutralDetail+chargeNote:(ground?.label??'지상 상태 미수신')+chargeNote));
 }
 close(){this.release();this.setFocused(false);this.root.hidden=true;this.state=null;}
 destroy(){this.close();this.root.remove();this.controlsRoot.remove();}
}
