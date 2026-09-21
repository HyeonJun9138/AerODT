import {ManualFlightPanel} from './manual_flight_panel.js?v=20260918-pause-recovery';
import {ManualFlightDisplay} from './manual_flight_display.js?v=20260918-turn-continuity';
// How many commands may be unanswered at once. With one, a reply that arrived
// just after a tick cost the whole next tick, so the gap the server steps by
// doubled and a turn came in lumps; at a 60 ms round trip the effective control
// rate fell from 20 Hz to about 12. Two keeps the cadence without giving up the
// back-pressure that stops an unanswered client filling the socket.
const COMMANDS_IN_FLIGHT=2;
// The socket has to be kept alive from a worker, not from the page's own timer.
// While the tab is hidden the panel suspends input on purpose and only
// keepalives are left flowing -- but the interval that sends them is a page
// timer, and a hidden page's timers are throttled to one second and then, after
// about five minutes, to one a minute. The server gives up after thirty
// seconds of silence, so a session left in the background died on its own: 16
// of 63 recorded manual flights ended that way, their median length 217 s.
// A dedicated worker's timer is not throttled like that, so the beat survives.
const HEARTBEAT_MS=4000;
// How long before the issued approach time the cockpit says so out loud.
const APPROACH_CALL_S=60;
let heartbeatSource=null;
function heartbeatWorker(){
 // Anywhere without workers -- a test, a locked-down page -- simply keeps the
 // page timer it already had. The beat is a backstop, never the only thing.
 try{
  if(!heartbeatSource)heartbeatSource=URL.createObjectURL(new Blob(
   ['let t=null;onmessage=e=>{clearInterval(t);t=e.data>0?setInterval(()=>postMessage(0),e.data):null;};'],
   {type:'text/javascript'}));
  return new Worker(heartbeatSource);
 }catch{return null;}
}
export class ManualFlightSession {
 constructor({onSample,onClear=()=>{},onTelemetry=()=>{},onReady,onExit,contactDecks=()=>[],notify=()=>{},onLook=()=>{},onAction=()=>{},onSound=()=>{}}){Object.assign(this,{onSample,onClear,onTelemetry,onReady,onExit,contactDecks,notify,onAction,onSound});this.display=new ManualFlightDisplay();this.panel=new ManualFlightPanel({onPause:reason=>this.pause(reason),onResume:()=>this.resume(),onExit:()=>this.stop(),onLook,onAction,onHold:mode=>this.setHold(mode)});this.frame=null;this.generation=0;}
  readControls(){
   if(!this.socket||this.socket.readyState!==WebSocket.OPEN||!this.plan)return null;
   const input=this.panel.input,locked=this.display?.latest?.ground_handling?.locked;
   return {...this.lastCommand,entity_id:this.twin?`scenario:${this.twin}`:'preview:selected-flight',active:input.active,throttle:this.display?.latest?.autopilot?.enabled?(this.display.latest.throttle??input.throttle):input.throttle,mode:input.mode,source:input.source,enabled:input.active&&!locked,
    autopilot:this.display?.latest?.autopilot,autopilotPending:Boolean(this.autopilotPending),autopilotSupported:this.capabilities?.includes('autopilot_v1'),
    hold:this.display?.latest?.hold,holdPending:Boolean(this.holdPending),
    pending:Boolean(this.groundPending),error:this.groundError,groundChargeSupported:this.capabilities?.includes('ground_handling_v2'),groundSupported:this.capabilities?.includes('ground_handling_v1'),nextFlightSupported:this.capabilities?.includes('next_flight_v1')};
  }
  control(action,value){
   if(action==='find_aircraft'){if(this.readControls())this.onAction?.('find_aircraft');return;}
   if(action==='autopilot'){this.setAutopilot(value);return;}
   if(action==='hold'){this.setHold(value);return;}
   if(action==='pause'){this.pause();return;}
   if(action==='resume'){this.resume();return;}
   // Reachable whether or not input is live -- the window is opened precisely
   // when the stick is not yet doing the right thing.
   if(action==='tune'){this.panel.openJoystickSetup?.();return;}
   if(!this.readControls()?.enabled&&!(action==='stick'&&value?.x===0&&value?.y===0)&&!(action==='yaw'&&value===0))return;
   const p=this.panel,i=p.input;
   if(action==='source'){p.releaseStick();i.setSource(value);p.source.value=value;if(value==='joystick')p.openJoystickSetup?.();else p.joystick?.close();}
   if(action==='mode')i.setMode(value);
   if(action==='stick'&&i.source==='screen')i.setStick(value.x,value.y);
   if(action==='yaw'&&i.source==='screen')i.setYaw(value);
   if(action==='throttle'&&i.source!=='joystick')i.setThrottle(value);
   p.paint(this.lastCommand);
  }
  handleAutopilotAck(message){
   if(message.request_id!==this.autopilotPending)return;
   clearTimeout(this.autopilotTimer);this.autopilotPending=null;
   if(message.sample)this.display.push(message.sample,performance.now());
   if(message.message)this.notify(message.message);
  }
  setAutopilot(enabled){
   if(this.autopilotPending||!this.readControls()?.autopilotSupported||this.socket?.readyState!==1)return;
   const id=`ap-${++this.groundSequence}`;this.autopilotPending=id;
   this.socket.send(JSON.stringify({type:'autopilot',enabled:Boolean(enabled),request_id:id}));
   this.autopilotTimer=setTimeout(()=>{if(this.autopilotPending===id){this.autopilotPending=null;this.notify('AP 응답 지연 · 상태를 확인하세요');}},5000);
  }
  handleHoldAck(message){
   if(message.request_id!==this.holdPending)return;
   clearTimeout(this.holdTimer);this.holdPending=null;
   if(message.sample)this.display.push(message.sample,performance.now());
   this.onSound?.(message.accepted?'received':'error');
   if(message.message)this.notify(message.message);
  }
  // A hold is a toggle on a stick button: pressing the one that is already on
  // is how a pilot takes it off, and they should not have to find a second
  // button to do it.
  setHold(mode){
   if(this.holdPending||this.socket?.readyState!==1)return;
   const engaged=this.display?.latest?.hold?.mode;
   const wanted=mode==='off'||mode===engaged?'off':mode;
   const id=`hold-${++this.groundSequence}`;this.holdPending=id;
   this.socket.send(JSON.stringify({type:'hold',mode:wanted,request_id:id}));
   this.holdTimer=setTimeout(()=>{if(this.holdPending===id){this.holdPending=null;this.notify('유지 응답 지연 · 상태를 확인하세요');}},5000);
  }
  ground(action){
   if(this.groundPending)return;
   if(!this.readControls()?.groundSupported){this.groundError='서버 재시작 후 지상 조작을 사용할 수 있습니다';return;}
   if(action==='charge'&&!this.readControls()?.groundChargeSupported){this.groundError='서버 재시작 후 개별 충전 요청을 사용할 수 있습니다';return;}
   if(action==='next_flight'&&!this.readControls()?.nextFlightSupported){this.groundError='서버 재시작 후 다음 비행 이어가기를 사용할 수 있습니다';return;}
   const id=`ground-${++this.groundSequence}`;this.groundPending=id;this.groundError=null;
   this.socket.send(JSON.stringify({type:'ground',action,request_id:id}));this.onSound?.('request');
   clearTimeout(this.groundTimer);this.groundTimer=setTimeout(()=>{if(this.groundPending===id){this.groundPending=null;this.groundError='응답 지연 · 상태 확인 후 다시 요청하세요';this.onSound?.('error');}},5000);
  }
 // What the service is saying to this pilot, for the cockpit to draw. Null
 // when this is a flight of its own: there is no service to talk to, and an
 // empty PSU screen is a worse answer than no PSU screen.
 readPsu(){
  if(!this.twin)return null;
  return {...this.advisory,stale:!this.psuReceivedAt||Date.now()-this.psuReceivedAt>3500,pending:Boolean(this.psuPending),error:this.psuRequestError||this.psuError,answer:this.psuAnswer};
 }
 async pollPsu(announce=false){
  if(!this.twin||this.psuReading)return;
  const twin=this.twin,generation=this.generation;this.psuReading=true;if(announce)this.onSound?.("request");
  try{
   const answer=await fetch(`/api/simulation/scenario/manual/${encodeURIComponent(this.twin)}`,{cache:'no-store',signal:AbortSignal.timeout(5000)});
   if(!answer.ok)throw new Error(String(answer.status));
   const body=await answer.json();
   if(twin!==this.twin||generation!==this.generation)return;
   const key=JSON.stringify([body.flight_id,body.instruction?.action,body.procedure?.phase,body.procedure?.state,
    body.departure?.state,body.departure?.status,Boolean(body.departure),body.arrival?.state,body.arrival?.status,Boolean(body.arrival),Boolean(body.hold),body.violations?.length,body.next_flight?.flight_id]);
   if(announce||(this.advisorySoundKey&&key!==this.advisorySoundKey&&Date.now()-(this.lastSoundReply??0)>600))this.onSound?.('received');
   this.advisorySoundKey=key;
   this.advisory=body;this.psuReceivedAt=Date.now();this.psuError=null;
   this.announceApproach(body);
  }catch{
   // A day that went away is worth saying once, not every second.
   if(twin===this.twin&&generation===this.generation){this.psuError='PSU 상태를 읽지 못했습니다';if(announce)this.onSound?.('error');}
  }finally{this.psuReading=false;}
 }
 // The two moments a holding pilot needs told rather than shown: the service
 // has moved their approach time, and that time is nearly here. Everything
 // else about the hold is on the PSU screen to be read at leisure -- these two
 // are worth a sound, because a pilot watching the aircraft is not watching a
 // clock. Said once each, so neither becomes background noise.
 announceApproach(body){
  if(body?.procedure?.version>=2){
   const p=body.procedure;
   const key=body.stale||body.error||(body.clock&&body.clock.state!=='playing')?null:`${p.stage}:${p.next?.kind}:${Boolean(p.next?.enabled)}`;
   if(key&&key!==this.approachSaid?.key){
    if(p.next?.kind==='approach'&&p.next.enabled){this.onSound?.('received');this.notify('접근 허가를 요청할 수 있습니다 · 허가 전 접근 금지');}
    else if(p.stage==='접근 허가'||p.stage==='착륙 허가'||p.stage==='접근 보류'||p.stage==='착륙 허가 보류'){
     this.onSound?.('received');this.notify(`${p.stage} · ${p.text}`);
    }
   }
   this.approachSaid={key};return;
  }
  const arrival=body?.arrival;
  if(!arrival||Number.isFinite(arrival.released_s)||!Number.isFinite(arrival.eat_s)){
   this.approachSaid=null;return;
  }
  const revision=arrival.eat_revision??0;
  if(this.approachSaid&&this.approachSaid.revision!==revision){
   const moved=Math.round(arrival.eat_moved_s??0);
   this.onSound?.('received');
   this.notify(`접근 시각 수정 · ${moved>0?`${moved}초 늦춰짐`:`${-moved}초 당겨짐`}`);
  }
  const now=body?.procedure?.timeline?.now_s;
  const left=Number.isFinite(now)?arrival.eat_s-now:null;
  const near=left!=null&&left<=APPROACH_CALL_S;
  if(near&&!this.approachSaid?.near){
   this.onSound?.('received');
   this.notify(left>0?`접근 검토 예상까지 ${Math.max(0,Math.round(left))}초`:'접근 검토 예상 시각입니다 · 허가를 확인하세요');
  }
  this.approachSaid={revision,near:Boolean(near||this.approachSaid?.near&&left!=null&&left<=APPROACH_CALL_S)};
 }
 async requestPsu(kind){
  if(kind==='refresh'){this.psuRequestError=null;return this.pollPsu(true);}
  if(!this.twin||this.psuPending)return null;
  const twin=this.twin,generation=this.generation;
  this.onSound?.("request");this.psuPending=kind;this.psuError=null;this.psuRequestError=null;
  try{
   const messageId=globalThis.crypto?.randomUUID?.()??`pilot-${Date.now()}-${Math.random().toString(16).slice(2)}`;
   const sequence=++this.psuSequence;
   const answer=await fetch(`/api/simulation/scenario/manual/${encodeURIComponent(this.twin)}/request`,
    {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind,message_id:messageId,sequence}),signal:AbortSignal.timeout(5000)});
   const body=await answer.json().catch(()=>({}));
   if(!answer.ok)throw new Error(body.message||(typeof body.detail==='string'?body.detail:null)||`PSU 요청 실패 (HTTP ${answer.status})`);
   if(twin!==this.twin||generation!==this.generation)return null;
   this.psuAnswer={kind,...body};this.lastSoundReply=Date.now();this.onSound?.(['rejected','denied','error'].includes(body.state)?'error':'received');
   if(body.reason)this.notify(`PSU · ${body.reason}`);
   return body;
  }catch(error){if(twin===this.twin&&generation===this.generation){this.onSound?.('error');this.psuRequestError=`요청 결과 확인 실패: ${error.message} · 지시 새로 확인을 눌러 접수 여부를 확인하세요`;}return null;}
  finally{if(twin===this.twin&&generation===this.generation){this.psuPending=null;await this.pollPsu();}}
 }
 async start({plan_id,plan,aircraft_id}){
  this.stop(false);const generation=++this.generation;this.plan=plan;this.preparing=true;
  // One airframe of a running day, or a flight of its own.
  this.twin=aircraft_id??null;this.lastCommand=null;this.advisory=null;this.advisorySoundKey=null;this.lastSoundReply=0;this.psuReceivedAt=null;this.psuAnswer=null;this.psuError=null;this.psuRequestError=null;this.psuPending=null;this.psuSequence=0;this.displayed=null;this.targetSample=null;this.groundSequence=0;this.groundPending=null;this.groundError=null;this.capabilities=[];this.panel.input.setThrottle(0);this.panel.input.setMode('multirotor');
  const point=plan.legs[0].path[0],decks=await this.contactDecks();
  if(generation!==this.generation)throw new Error('수동 시작 취소');
  const url=new URL('/api/simulation/manual',location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';
  const socket=this.socket=new WebSocket(url);let ready=false;
  return await new Promise((resolve,reject)=>{
   this.cancelStart=()=>{clearTimeout(timeout);reject(new Error('수동 시작 취소'));};
   const timeout=setTimeout(()=>{if(generation!==this.generation)return;if(!ready){reject(new Error('수동 엔진 연결 시간 초과. 서버 재시작과 native 빌드를 확인하세요.'));this.stop(false);}},12000);
   socket.onopen=()=>socket.send(JSON.stringify(this.twin?{aircraft_id:this.twin,altitude_m:point[2],contact_decks:decks}:{plan_id,altitude_m:point[2],contact_decks:decks}));
   socket.onmessage=event=>{
    if(generation!==this.generation)return;
    let message;try{message=JSON.parse(event.data);}catch{return;}
    if(message.type==='ready'){
      this.capabilities=message.capabilities??[];
     // The day built the real plan for this flight; the page started from a
     // stand-in with just the stand in it, so take the real one now.
     if(message.plan)this.plan=message.plan;
     ready=true;this.running=true;clearTimeout(timeout);this.run_id=message.run_id;this.display.reset(message.sample,performance.now());this.displayed=message.sample;this.onSample(message.sample);this.onTelemetry(message.sample);this.panel.open();this.panel.input.active=false;this.panel.setStatus('preparing','준비 중','조종석 준비 중 · 입력 잠금');
     Promise.resolve().then(()=>this.onReady()).then(()=>{if(generation!==this.generation)return;this.preparing=false;this.cancelStart=null;this.resume();resolve(message);}).catch(error=>{if(generation!==this.generation)return;reject(error);this.notify(error.message);this.stop();});
     this.last=performance.now();this.lastSend=0;this.sequence=0;this.inFlight=0;this.lastAck=performance.now();this.lastControl=performance.now();this.transport=setInterval(()=>this.sendControls(),50);this.startHeartbeat();
     // The service answers in seconds, not frames: a second is often enough to
     // see a hold appear and slow enough not to ask a running day 20 times a second.
     if(this.twin){this.pollPsu();this.psuTimer=setInterval(()=>this.pollPsu(),1000);}
     this.loop();
    }else if(message.type==='resumed'){this.inFlight=0;if(!this.resumePending)return;this.resumePending=false;this.autoRecovery=false;this.pauseReason=null;this.pauseAcknowledged=false;this.lastAck=performance.now();this.panel.input.start();this.panel.setStatus('active','조작 중','조작 중 · 방향키 지상 이동 / Q·E 회전 / W·S 스로틀');}
    else if(message.type==='state'){this.inFlight=Math.max(0,this.inFlight-1);this.lastAck=performance.now();if(this.display.latest?.autopilot?.enabled&&!message.sample?.autopilot?.enabled)this.notify(message.sample?.autopilot?.message??'AP 해제');this.display.push(message.sample,performance.now());if(performance.now()-(this.lastTelemetry??-Infinity)>=100){this.lastTelemetry=performance.now();this.onTelemetry(message.sample);}}
     else if(message.type==='ground_ack'){
      if(message.request_id!==this.groundPending)return;
      this.onSound?.(message.accepted?'received':'error');
     clearTimeout(this.groundTimer);this.groundPending=null;this.groundError=message.accepted?null:message.message;
      if(message.plan)this.plan=message.plan;
      if(message.sample)this.display.push(message.sample,performance.now());
      if(message.accepted){this.panel.input.keys.clear();this.panel.input.setThrottle(0);this.panel.releaseStick();this.panel.input.setYaw(0);}
     }else if(message.type==='autopilot_ack'){this.handleAutopilotAck(message);}
     else if(message.type==='hold_ack'){this.handleHoldAck(message);}
     else if(message.type==='paused'){this.inFlight=0;this.handlePaused(message);}
    else if(message.type==='error'){const error=new Error(message.message);this.notify(error.message);if(!ready)reject(error);this.stop();}
   };
   socket.onerror=()=>{if(generation!==this.generation)return;if(!ready){clearTimeout(timeout);reject(new Error('수동 서버 연결 실패. 변경한 서버를 재시작해 주세요.'));this.stop(false);}};
   socket.onclose=()=>{
    clearTimeout(timeout);
    // A close this side asked for bumps the generation first, so reaching here
    // means the far end went away on its own.
    if(generation!==this.generation)return;
    if(!ready){reject(new Error('수동 세션 연결이 종료되었습니다.'));return;}
    this.panel.input.active=false;this.panel.setStatus('closed','종료됨','연결 종료 · 계획에서 다시 실행하세요');
    if(this.frame)cancelAnimationFrame(this.frame);clearInterval(this.transport);
    // The session is over, so the mode is over. Leaving the strip up said
    // 종료됨 and still offered a button, over a workspace that stayed put
    // away -- which is what read as 종료 doing nothing.
    this.notify('수동 세션 연결이 종료되었습니다.');
    this.stop();
   };
  });
 }
 loop(){
  const now=performance.now();
  const sample=this.display.sample(now,this.panel.input.active,this.lastCommand);
  if(sample){this.displayed=sample;this.onSample(sample);}
  this.frame=requestAnimationFrame(()=>this.loop());
 }
 // Nothing is sent from here that moves the aircraft: a keepalive steps no
 // physics and replays no control, it only tells the server this pilot is still
 // there. The pose stays where the hidden tab left it, and the panel resumes on
 // its own when the window comes back.
 startHeartbeat(){
  this.stopHeartbeat();
  this.beat=heartbeatWorker();
  if(!this.beat)return;                 // no worker: the page timer is all there is
  this.beat.onmessage=()=>this.keepAlive();
  this.beat.postMessage(HEARTBEAT_MS);
 }
 stopHeartbeat(){if(this.beat){this.beat.postMessage(0);this.beat.terminate();this.beat=null;}}
 keepAlive(){
  if(this.socket?.readyState!==1)return;
  const now=performance.now();
  if(now-(this.lastHeartbeat??-Infinity)<HEARTBEAT_MS/2)return;
  if(now-(this.lastSend??-Infinity)<HEARTBEAT_MS/2)return;    // commands already say we are here
  this.lastHeartbeat=now;this.socket.send(JSON.stringify({type:'keepalive'}));
 }
 sendControls(){
  if(this.preparing){this.keepAlive();return;}
  const now=performance.now(),dt=(now-this.lastControl)/1000;this.lastControl=now;
  if(this.inFlight>0&&now-(this.lastAck??now)>2000&&this.panel.input.active)this.panel.input.suspend('transport');
  this.recoverTransport();
  let command=this.panel.tick(dt);
  command=this.panel.input.groundIdle(command,now-(this.lastAck??-Infinity)<=500?this.display?.latest:null,dt);
   if(this.display?.latest?.ground_handling?.locked&&command){this.panel.input.keys.clear();this.panel.input.setThrottle(0);this.panel.releaseStick();this.panel.input.setYaw(0);command={...command,throttle:0,roll:0,pitch:0,yaw:0,flight_mode:'multirotor'};}
   this.lastCommand=command;
  if(!command&&this.socket?.readyState===1&&now-(this.lastHeartbeat??0)>1000){this.lastHeartbeat=now;this.socket.send(JSON.stringify({type:'keepalive'}));}
  if(command&&this.inFlight<COMMANDS_IN_FLIGHT&&this.socket?.readyState===1){this.inFlight++;this.lastSend=now;this.socket.send(JSON.stringify({...command,sequence:++this.sequence}));}
 }
 resume(){if(this.preparing)return;if(this.resumePending&&this.socket?.readyState===1)return;if(this.socket?.readyState===1){this.resumePending=true;this.pauseAcknowledged=false;this.panel.input.active=false;this.panel.setStatus('linking','연결 중','입력 연결 중…');this.socket.send(JSON.stringify({type:'resume'}));}else this.panel.setStatus('closed','종료됨','연결 종료 · 계획에서 다시 실행하세요');}
 // Intentional pause and temporary back-pressure must not share a recovery policy.
 handlePaused(message){
  if(this.resumePending)return; // Older queued pause replies cannot cancel a newer resume.
  const input=this.panel.input;
  if(input.active&&!this.pauseReason)this.autoRecovery=true;
  this.pauseAcknowledged=true;this.lastAck=performance.now();
  input.active=false;input.keys.clear();
  this.panel.setStatus('held','대기',this.autoRecovery?'응답 지연 · 연결 확인 후 자동 복귀':message.reason??'일시정지 · 재개를 눌러주세요');
  this.recoverTransport();
 }
 recoverTransport(){
  const document=this.panel.document??globalThis.document;
  if(!this.autoRecovery||!this.pauseAcknowledged||this.resumePending||this.panel.tuningHeld||
     document?.hidden||document?.hasFocus?.()===false||this.socket?.readyState!==1)return;
  const input=this.panel.input;
  if(input.source==='joystick'&&!input.pad())return;
  // The pause acknowledgement proves the socket is responsive. Resume clears
  // server carry; only a new device reading after its acknowledgement may move.
  this.resume();
 }
 pause(reason='user'){
  this.resumePending=false;this.pauseAcknowledged=false;
  this.autoRecovery=reason==='transport'||(reason==='focus'&&this.autoRecovery);
  this.pauseReason=reason;
  const i=this.panel.input;if(reason==='user'||reason==='tuning')i.returnOnFocus=false;i.active=false;i.keys.clear();i.setStick(0,0);i.setYaw(0);if(this.socket?.readyState===1)this.socket.send(JSON.stringify({type:'pause'}));}
 // Every way out comes through here: the 종료 button, the plan panel, a socket
 // that stopped answering, and the page unloading. Leaving is announced once,
 // and only when there was a session to leave -- `onExit` puts the workspace
 // back and clears the flight, which must not happen twice or on a session
 // that never started.
 stop(notify=true){
  if(this.stopping)return;this.stopping=true;
    const live=this.running;this.running=false;this.preparing=false;
  try{this.teardown(notify&&live);}finally{this.stopping=false;}
 }
 teardown(notify){clearTimeout(this.autopilotTimer);this.autopilotPending=null;clearTimeout(this.holdTimer);this.holdPending=null;this.autoRecovery=false;this.resumePending=false;this.pauseReason=null;this.pauseAcknowledged=false;this.onClear?.();this.stopHeartbeat();clearInterval(this.psuTimer);this.psuTimer=null;this.twin=null;this.advisory=null;clearTimeout(this.groundTimer);this.groundPending=null;clearInterval(this.transport);this.transport=null;this.cancelStart?.();this.cancelStart=null;++this.generation;if(this.frame)cancelAnimationFrame(this.frame);this.frame=null;this.inFlight=0;this.panel.close();if(this.socket){if(this.socket.readyState===1)this.socket.send(JSON.stringify({type:'stop'}));this.socket.close();this.socket=null;}if(notify)this.onExit?.();}
 destroy(){this.stop(false);this.panel.destroy();}
}
