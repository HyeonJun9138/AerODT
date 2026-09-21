import {buildElement as el,buildSvg as svg} from '../../../dom_builder.js';
import {GROUND_RANGES_KM} from './cockpit_surface.js';
import {paintCockpitMarks} from './cockpit_marks.js';
export const SCREEN_WIDTH=628,SCREEN_HEIGHT=520;
const finite=Number.isFinite;
const rad=Math.PI/180;
const s=(p,tag,attrs,...children)=>svg(p.document,tag,attrs,...children);
const d=(p,tag,attrs,...children)=>el(p.document,tag,attrs,...children);

export function buildFlightDisplay(p){
  p.fma=d(p,'div',{class:'cockpit-fma'},d(p,'span',{text:'OBSERVED'}),d(p,'b',{text:'ATTITUDE'}),d(p,'span',{text:'FLIGHT DATA'}));
  const id='cockpit-horizon-clip';
  p.attitude=s(p,'g',{class:'cockpit-attitude'},s(p,'rect',{x:-600,y:-900,width:1800,height:1038,fill:'#2469a4'}),s(p,'rect',{x:-600,y:138,width:1800,height:1000,fill:'#805035'}),s(p,'line',{x1:-600,y1:138,x2:1200,y2:138,stroke:'#e6f0ec','stroke-width':2}));
  for(let a=-80;a<=80;a+=5){if(!a)continue;const y=138-a*3.1,major=a%10===0,len=major?50:24;
    p.attitude.append(s(p,'path',{d:`M${294-len} ${y} h${len-10} m20 0 h${len-10}`,stroke:'#fff','stroke-width':major?1.6:1,fill:'none','stroke-dasharray':a<0?'5 3':''}));
    if(major)p.attitude.append(s(p,'text',{x:294-len-9,y:y+4,'text-anchor':'end',text:Math.abs(a)}),s(p,'text',{x:294+len+9,y:y+4,text:Math.abs(a)}));
  }
  const bank=s(p,'g',{class:'cockpit-bank-scale'});
  for(const a of [-60,-45,-30,-20,-10,0,10,20,30,45,60])bank.append(s(p,'line',{x1:294,y1:24,x2:294,y2:a%30===0?39:33,transform:`rotate(${a} 294 138)`,stroke:'#fff','stroke-width':a===0?3:2}));
  p.bankPointer=s(p,'path',{d:'M294 42 l-7 11 h14 Z',fill:'#fff'});
  p.horizonMissing=s(p,'text',{x:294,y:100,'text-anchor':'middle',class:'cockpit-attitude-missing',text:'ATT DATA'});
  p.speedTicks=s(p,'g',{});p.altTicks=s(p,'g',{});p.vsiPointer=s(p,'path',{d:'M573 138 l10 -5 v10 Z',fill:'#65e9c8'});
  p.horizon=s(p,'svg',{class:'cockpit-horizon',viewBox:'0 0 588 278',preserveAspectRatio:'none','aria-label':'자세·속도·고도 비행 계기'},
    s(p,'defs',{},s(p,'clipPath',{id},s(p,'rect',{x:77,y:0,width:430,height:278})),s(p,'clipPath',{id:'cockpit-pitch-clip'},s(p,'rect',{x:77,y:68,width:430,height:210})),s(p,'clipPath',{id:'cockpit-bank-clip'},s(p,'rect',{x:77,y:0,width:430,height:68}))),
    s(p,'g',{'clip-path':`url(#${id})`},s(p,'g',{'clip-path':'url(#cockpit-pitch-clip)'},p.attitude),
      s(p,'rect',{x:77,y:0,width:430,height:68,fill:'#2469a4'}),s(p,'g',{'clip-path':'url(#cockpit-bank-clip)'},s(p,'g',{transform:'scale(1 .6)'},bank,p.bankPointer)),
      s(p,'path',{d:'M233 138 h42 v7 h-7 v-7 M313 138 h42 M290 138 h8',stroke:'#ffdb69','stroke-width':4,fill:'none'})),
    s(p,'rect',{x:0,y:0,width:76,height:278,fill:'#141f29'}),s(p,'rect',{x:508,y:0,width:60,height:278,fill:'#141f29'}),p.speedTicks,p.altTicks,
    s(p,'path',{d:'M1 119 H65 L76 138 L65 157 H1 Z M567 119 H521 L509 138 L521 157 H567 Z',fill:'#080f17',stroke:'#fff','stroke-width':1.8}),
    s(p,'line',{x1:579,y1:32,x2:579,y2:244,stroke:'#91a9b5','stroke-width':1}),
    ...[-10,-5,0,5,10].map(v=>s(p,'line',{x1:574,y1:138-v*10,x2:586,y2:138-v*10,stroke:'#8ca5b2'})),p.vsiPointer,p.horizonMissing);
  // Readout text shares the tape's SVG coordinates, including when enlarged.
  p.horizon.append(
    s(p,'foreignObject',{x:2,y:119,width:62,height:38},d(p,'div',{class:'cockpit-tape-value'},p.metric('speed','SPEED','m/s'))),
    s(p,'foreignObject',{x:521,y:119,width:46,height:38},d(p,'div',{class:'cockpit-tape-value'},p.metric('altitude','ALT','m'))),
    s(p,'rect',{x:0,y:0,width:76,height:30,fill:'#141f29'}),
    s(p,'rect',{x:508,y:0,width:60,height:30,fill:'#141f29'}),
    s(p,'text',{x:38,y:12,'text-anchor':'middle',class:'cockpit-tape-caption',text:'SPEED'}),
    s(p,'text',{x:38,y:25,'text-anchor':'middle',class:'cockpit-tape-unit',text:'m/s'}),
    s(p,'text',{x:538,y:12,'text-anchor':'middle',class:'cockpit-tape-caption',text:'ALT'}),
    s(p,'text',{x:538,y:25,'text-anchor':'middle',class:'cockpit-tape-unit',text:'m'}));
  p.speedLabel=d(p,'small',{class:'cockpit-basis',text:'SPD ECEF'});
  p.altLabel=d(p,'small',{class:'cockpit-basis',text:'ALT REF ?'});
  p.headingLabel=d(p,'small',{class:'cockpit-heading-basis',text:'HDG'});
  p.compassTicks=s(p,'g',{});p.courseBug=s(p,'path',{d:'M286 3 v7 h16 V3 M294 10 v9',fill:'none',stroke:'#ed9eff','stroke-width':3,visibility:'hidden'});
  p.headingStrip=s(p,'svg',{class:'cockpit-heading-strip',viewBox:'0 0 588 48'},p.compassTicks,p.courseBug,s(p,'path',{d:'M294 2 l-6 8 h12 Z',fill:'#ffdb69'}));
  p.guidanceText=d(p,'div',{class:'cockpit-route-guidance',text:'NO FLIGHT PLAN'});
  p.inputSource=d(p,'b',{class:'cockpit-input-source',text:'NO INPUT'});
  p.inputBars={};
  const inputs=d(p,'div',{class:'cockpit-input-grid'});
  for(const [key,label] of [['throttle','THR'],['roll','ROLL'],['pitch','PITCH'],['yaw','YAW']]){
    const fill=d(p,'i',{}),track=d(p,'div',{class:`cockpit-input-track${key==='throttle'?'':' bipolar'}`},fill);
    p.inputBars[key]=fill;
    inputs.append(d(p,'div',{class:'cockpit-input-cell'},p.metric(`input_${key}`,label,'%'),track));
  }
  p.screens.pfd.append(p.fma,d(p,'div',{class:'cockpit-pfd-stage'},p.horizon),
    d(p,'div',{class:'cockpit-heading'},p.headingStrip,p.metric('heading','HDG'),p.headingLabel),
    d(p,'div',{class:'cockpit-flight-bottom'},p.metric('pitch','PITCH','°'),p.metric('roll','BANK','°'),p.metric('vertical','V/S','m/s')),
    d(p,'div',{class:'cockpit-inputs','aria-label':'조종입력 모니터',title:'Normalized command %, not attitude or actuator output. AP THR shows applied autopilot throttle; unavailable axes show dashes.'},d(p,'div',{class:'cockpit-input-title'},d(p,'span',{text:'CONTROL INPUT'}),p.inputSource),inputs),
    d(p,'div',{class:'cockpit-datums'},p.speedLabel,p.altLabel));
}

export function buildNavigationDisplay(p){
  p.navRose=s(p,'g',{});
  for(let a=0;a<360;a+=10){const r=a*rad,major=a%30===0,x=100+Math.sin(r)*92,y=100-Math.cos(r)*92;
    p.navRose.append(s(p,'line',{x1:x,y1:y,x2:100+Math.sin(r)*(major?86:89),y2:100-Math.cos(r)*(major?86:89),stroke:'#b7cbd6','stroke-width':major?1.1:.6}));
    if(major)p.navRose.append(s(p,'text',{x:100+Math.sin(r)*79,y:103-Math.cos(r)*79,'text-anchor':'middle',text:({0:'N',90:'E',180:'S',270:'W'})[a]??String(a/10),fill:'#dbe8ee'}));
  }
  p.route=s(p,'polyline',{class:'cockpit-route',fill:'none',stroke:'#e38bff','stroke-width':1.5,points:''});p.contacts=s(p,'g',{});
  p.routeActive=s(p,'polyline',{fill:'none',stroke:'#f3aaff','stroke-width':3});p.routeMarks=s(p,'g',{});
  p.ownship=s(p,'path',{class:'cockpit-ownship',d:'M100 92 L107 109 L100 105 L93 109 Z',fill:'#eafaff'});
  p.surface=s(p,'g',{'clip-path':'url(#cockpit-route-clip)'});
  p.nav=s(p,'svg',{class:'cockpit-nav-map',viewBox:'0 0 200 200','aria-label':'방위·항로·주변 교통'},
    ...[30,60,92].map(r=>s(p,'circle',{cx:100,cy:100,r,fill:'none',stroke:'#365260','stroke-width':.65})),
    s(p,'path',{d:'M100 12 V188 M12 100 H188',stroke:'#28404c','stroke-width':.6,'stroke-dasharray':'2 4'}),p.navRose,s(p,'defs',{},s(p,'clipPath',{id:'cockpit-route-clip'},s(p,'circle',{cx:100,cy:100,r:92}))),s(p,'g',{'clip-path':'url(#cockpit-route-clip)'},p.route,p.routeActive,p.routeMarks),p.surface,p.contacts,p.ownship,
    s(p,'path',{d:'M100 1 l-3 5 h6 Z',fill:'#ffde78'}));
  // A range the pilot chose is theirs: the automatic fit stands aside until
  // the aircraft reaches a different deck.
  p.rangeButton=p.button('1 km','range',()=>{const ranges=p.groundMode?GROUND_RANGES_KM:[1,2,5,10,.5];p.applyRangeKm(ranges[(ranges.indexOf(p.rangeKm)+1)%ranges.length]);p.rangeUserSet=true;p.lastPaint=-Infinity;});
  p.groundButton=p.button('AIR / 지상 보기','surface-mode',()=>{p.groundMode=!p.groundMode;p.groundFitKey=null;p.rangeUserSet=false;p.applyRangeKm(p.groundMode?.2:1);p.groundButton.textContent=p.groundMode?'GND / 공중 보기':'AIR / 지상 보기';p.groundButton.setAttribute('aria-pressed',String(p.groundMode));p.lastPaint=-Infinity;});
  p.orientationButton=p.button('HDG UP','orientation',()=>{p.headingUp=!p.headingUp;p.orientationButton.textContent=p.headingUp?'HDG UP':'NORTH UP';p.lastPaint=-Infinity;});
  p.routeInfo=d(p,'small',{class:'cockpit-route-info',text:'항로 미수신'});
  p.finalDestination=d(p,'strong',{text:'—'});p.finalDestinationId=d(p,'small',{text:''});
  p.originName=d(p,'strong',{text:'—'});p.originId=d(p,'small',{text:''});
  p.originBox=d(p,'div',{class:'cockpit-route-endpoint'},d(p,'span',{text:'출발 FROM'}),p.originName,p.originId);
  p.finalDestinationBox=d(p,'div',{class:'cockpit-route-endpoint'},d(p,'span',{text:'도착 TO'}),p.finalDestination,p.finalDestinationId);
  p.navStatus=d(p,'small',{class:'cockpit-nav-status',text:'항로 / 교통 미수신'});
  p.status=d(p,'div',{class:'cockpit-data-status',text:'데이터 미수신',role:'status'});
  p.systemNote=d(p,'small',{class:'cockpit-system-note',text:'AIRCRAFT SYSTEMS'});
  p.screens.pfd.append(
    d(p,'div',{class:'cockpit-system-grid'},p.metric('battery','SOC','%'),p.metric('rpm','ROTOR','RPM'),p.metric('tilt','NACELLE','°')),
    d(p,'div',{class:'cockpit-mode-line'},p.metric('mode','MODE'),p.metric('phase','PHASE')));
  p.navSurface=d(p,'div',{class:'cockpit-nav-surface',text:'지상 배정 미수신'});
  p.navAutopilot=d(p,'div',{class:'cockpit-nav-autopilot','aria-label':'비행 유도 조작'});
  p.progressNote=d(p,'div',{class:'cockpit-progress-note',text:'현재 지상속도 기준 예상 · 착륙/대기 시간 제외'});
  p.planClockLabel=d(p,'b',{text:'SIM'});
  p.screens.nav.append(
    d(p,'div',{class:'cockpit-nav-body'},p.nav,
      d(p,'div',{class:'cockpit-nav-controls'},p.groundButton,p.rangeButton,p.orientationButton),
      d(p,'div',{class:'cockpit-nav-waypoint'},p.metric('destination','NEXT'),p.metric('distance','TO WPT','km'),p.routeInfo,p.navAutopilot,p.guidanceText,p.navSurface),p.navStatus),
    d(p,'div',{class:'cockpit-route-endpoints'},p.originBox,d(p,'b',{class:'cockpit-route-arrow',text:'→'}),p.finalDestinationBox),
    d(p,'div',{class:'cockpit-plan-grid'},
      p.metric('remaining','남은 경로','km'),p.metric('ete','남은 시간 ETE'),p.metric('eta','도착 예상 ETA'),p.metric('elapsed','이륙 후 경과'),
      p.metric('planned_off','GATE 출발 계획'),p.metric('planned_takeoff','이륙 계획'),p.metric('actual_takeoff','이륙 실제'),p.metric('planned_landing','착륙 계획')),
    p.progressNote,d(p,'div',{class:'cockpit-clock-line'},p.status,d(p,'div',{class:'cockpit-plan-clock'},p.planClockLabel,p.metric('time','TIME'))));
}

export function buildCameraDisplay(p){
  const screen=p.screens.system;screen.setAttribute('aria-label','외부 카메라 모니터');
  screen.querySelector('header').querySelector('span').textContent='EXTERNAL VISION';
  screen.querySelector('header').querySelector('small').textContent='AIRFRAME CAMERA';
  p.cameraCanvas=d(p,'canvas',{class:'cockpit-camera-canvas',width:576,height:360,'aria-label':'기체 외부 3D 카메라 영상'});
  p.cameraCover=p.button('카메라 켜기','camera-power',()=>p.setCameraEnabled(!p.cameraEnabled));
  p.cameraCover.className='cockpit-camera-cover';
  p.cameraLabel=d(p,'span',{class:'cockpit-camera-channel',text:'CAM 01 / FORWARD'});
  p.cameraAge=d(p,'span',{class:'cockpit-camera-age',role:'status',text:'STANDBY'});
  p.cameraMode='front';p.cameraEnabled=false;p.cameraButtons={};
  const modes=[['front','정면','FWD'],['left','좌측','LFT'],['right','우측','RGT'],['down','하방','DOWN'],['around','어라운드','SURR']];
  const buttons=d(p,'nav',{class:'cockpit-camera-modes','aria-label':'외부 카메라 전환'});
  for(const [id,title,short] of modes){const b=p.button(title,`camera-${id}`,()=>{p.cameraMode=id;p.setCameraEnabled(true);});b.setAttribute('aria-pressed',String(id==='front'));b.setAttribute('data-label',short);p.cameraButtons[id]=b;buttons.append(b);}
  p.cameraOff=p.button('⏻ OFF','camera-off',()=>p.setCameraEnabled(!p.cameraEnabled));
  p.cameraOff.className='cockpit-camera-power';p.cameraOff.setAttribute('aria-label','외부 카메라 전원');p.cameraOff.setAttribute('aria-pressed','false');
  buttons.append(p.cameraOff);
  p.screens.system.append(buttons,d(p,'div',{class:'cockpit-camera-top'},p.cameraLabel,p.cameraAge),
    d(p,'div',{class:'cockpit-camera-viewport'},p.cameraCanvas,p.cameraCover));
}

export function paintInstruments(p,{speed,altitude,heading,pitch,roll,vertical,mission,entity,stateTime}){
  const ticks=(group,value,step,scale,x,width)=>{
    if(!group._tickRows){group._tickRows=Array.from({length:17},()=>{const line=s(p,'line',{stroke:'#c4d1da'}),text=s(p,'text',{'text-anchor':'end'});group.append(line,text);return {line,text};});}
    const base=finite(value)?Math.floor(value/step)*step:0;
    group._tickRows.forEach(({line,text},i)=>{const n=base+(i-8)*step,y=138+(value-n)*scale,visible=finite(value)&&y>=8&&y<=270&&!(x===0&&n<0);
      line.setAttribute('visibility',visible?'visible':'hidden');text.setAttribute('visibility',visible&&(y<110||y>169)?'visible':'hidden');if(!visible)return;
      for(const [key,v] of Object.entries({x1:x+width-10,y1:y,x2:x+width-2,y2:y}))line.setAttribute(key,String(v));
      text.setAttribute('x',String(x+width-14));text.setAttribute('y',String(y+4));if(text.textContent!==String(n))text.textContent=String(n);
    });
  };
  ticks(p.speedTicks,speed,5,5,0,76);ticks(p.altTicks,altitude,20,1.6,508,60);
  p.bankPointer.setAttribute('transform',`rotate(${finite(roll)?-roll:0} 294 138)`);
  p.bankPointer.setAttribute('visibility',finite(roll)?'visible':'hidden');
  p.vsiPointer.setAttribute('transform',`translate(0 ${finite(vertical)?-Math.max(-10,Math.min(10,vertical))*10:0})`);
  p.vsiPointer.setAttribute('visibility',finite(vertical)?'visible':'hidden');
  const compassMarks=[];
  if(finite(heading)){const base=Math.floor(heading/10)*10;for(let h=base-60;h<=base+60;h+=5){const x=294+(h-heading)*5.2,major=h%10===0;if(x<10||x>578)continue;
    compassMarks.push(['line',{x1:x,y1:7,x2:x,y2:major?20:14,stroke:'#d6e0e8'}]);
    if(major&&Math.abs(x-294)>64)compassMarks.push(['text',{x,y:34,'text-anchor':'middle',text:String((h%360+360)%360).padStart(3,'0')}]);}}
  paintCockpitMarks(p.document,p.compassTicks,compassMarks);
  p.navRose.setAttribute('transform',`rotate(${p.headingUp&&finite(heading)?-heading:0} 100 100)`);
  const end=mission?.route_points?.at(-1);
  const distance=finite(end?.latitude_deg)&&finite(entity.latitude_deg)&&finite(entity.longitude_deg)?Math.hypot((end.latitude_deg-entity.latitude_deg)*111.32,((end.longitude_deg-entity.longitude_deg+540)%360-180)*111.32*Math.cos(entity.latitude_deg*rad)):null;
  p.readouts.distance.textContent=finite(distance)?distance.toFixed(1):'—';
  p.readouts.time.textContent=finite(stateTime)?(stateTime>1e9?new Date(stateTime*1000).toISOString().slice(11,19):`${Math.floor(stateTime/3600).toString().padStart(2,'0')}:${Math.floor(stateTime/60)%60<10?'0':''}${Math.floor(stateTime/60)%60}:${Math.floor(stateTime)%60<10?'0':''}${Math.floor(stateTime)%60}`):'—';
  p.readouts.time.setAttribute('title',finite(stateTime)?`표시 시각 ${stateTime.toFixed(1)}s`:'시각 미수신');
  p.fma.children[1].textContent=finite(pitch)&&finite(roll)?'ATTITUDE':'ATT DATA';
  p.fma.setAttribute('data-valid',String(finite(pitch)&&finite(roll)));
}
