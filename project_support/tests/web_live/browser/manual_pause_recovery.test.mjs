import test from 'node:test';
import assert from 'node:assert/strict';
import {ManualFlightSession} from '../../../../user_application/web/domains/uam/cockpit/manual_flight_session.js';
import {ManualFlightInput} from '../../../../user_application/web/domains/uam/cockpit/manual_flight_input.js';

function fixture(){
 const sent=[],status=[],s=Object.create(ManualFlightSession.prototype);
 const device={index:0,id:'test',connected:true,axes:[0,0,0,0],buttons:[]};
 const input=new ManualFlightInput({target:null,getGamepads:()=>[device],onSuspend:reason=>s.pause(reason)});
 input.setSource('joystick');input.start();
 Object.assign(s,{socket:{readyState:1,send:raw=>sent.push(JSON.parse(raw))},
  panel:{input,document:{hidden:false,hasFocus:()=>true},tick:dt=>input.update(dt),setStatus:(...args)=>status.push(args)},
  lastControl:performance.now()-50,lastAck:performance.now()-2100,inFlight:2,sequence:2});
 return {s,input,sent,device,status};
}

test('response stall holds physics then automatically requests resume only after acknowledgement',()=>{
 const {s,input,sent}=fixture();
 s.sendControls();assert.equal(input.active,false);assert.equal(sent[0].type,'pause');
 s.sendControls();assert.equal(sent.filter(x=>x.type==='resume').length,0);
 s.handlePaused({type:'paused'});
 assert.equal(sent.at(-1).type,'resume');assert.equal(input.active,false,'wait for resumed ack');
 s.handlePaused({type:'paused'});s.sendControls();
 assert.equal(sent.filter(x=>x.type==='resume').length,1,'no repeated resume from queued pause replies');
 assert.equal(sent.filter(x=>x.sequence!=null).length,0,'never replay buffered flight controls');
});

test('server input-gap pause also recovers a still-active pilot',()=>{
 const {s,sent}=fixture();s.handlePaused({reason:'input gap'});
 assert.equal(sent.at(-1).type,'resume');
});
test('cockpit preparation cannot be bypassed by resume or controls',()=>{
 const {s,sent}=fixture();s.preparing=true;
 s.resume();s.sendControls();
 assert.equal(sent.some(x=>x.type==='resume'||x.sequence!=null),false);
 s.preparing=false;s.resume();assert.equal(sent.at(-1).type,'resume');
});

test('intentional pause cancels pending recovery and focus must not restart it',()=>{
 const {s,input,sent}=fixture();s.sendControls();input.returnOnFocus=true;
 s.pause();s.handlePaused({});input.focus();s.recoverTransport();
 assert.equal(sent.some(x=>x.type==='resume'),false);assert.equal(input.returnOnFocus,false);
});

test('hidden window, tuning and missing joystick postpone automatic recovery',()=>{
 for(const block of ['hidden','focus','tuning','device']){
  const {s,sent,device}=fixture();s.sendControls();
  if(block==='hidden')s.panel.document.hidden=true;
  if(block==='focus')s.panel.document.hasFocus=()=>false;
  if(block==='tuning')s.panel.tuningHeld=true;
  if(block==='device')device.connected=false;
  s.handlePaused({});assert.equal(sent.some(x=>x.type==='resume'),false,block);
  s.panel.document.hidden=false;s.panel.document.hasFocus=()=>true;s.panel.tuningHeld=false;device.connected=true;
  s.recoverTransport();assert.equal(sent.at(-1).type,'resume',block);
 }
});

test('focus loss keeps its own return behavior and does not use transport recovery',()=>{
 const {s,input,sent}=fixture();input.blur();s.handlePaused({});
 assert.equal(sent.some(x=>x.type==='resume'),false);
 assert.equal(input.returnOnFocus,true);
});

test('holding joystick pause does not repeatedly toggle after suspension clears axis filters',()=>{
 let actions=0;
 const pad={index:0,id:'test',connected:true,axes:[0,0,0,0],buttons:[{pressed:true,value:1}]};
 const input=new ManualFlightInput({target:null,getGamepads:()=>[pad],onAction:action=>{
  if(action==='pause'){actions++;input.suspend();}
 }});
 input.setSource('joystick');input.profile={deviceId:'test',axes:{},buttons:{0:'pause'}};input.start();
 assert.equal(input.update(.05),null,'same-tick pause must not emit a flight command');
 for(let n=0;n<20;n++)input.update(.05);
 assert.equal(actions,1);
 pad.buttons[0]={pressed:false,value:0};input.update(.05);
 pad.buttons[0]={pressed:true,value:1};input.update(.05);assert.equal(actions,2);
});

test('real socket message handler resumes recovery but rejects an obsolete resume after user pause',async()=>{
 const savedSocket=globalThis.WebSocket,savedLocation=globalThis.location;
 const {s,input,sent}=fixture();
 class Socket {
  readyState=1;
  send(raw){sent.push(JSON.parse(raw));}
  message(data){this.onmessage({data:JSON.stringify(data)});}
 }
 globalThis.WebSocket=Socket;globalThis.location={href:'http://localhost/',protocol:'http:'};
 Object.assign(s,{generation:0,stop(){},contactDecks:async()=>[],onReady:()=>{},onSample(){},onTelemetry(){},loop(){},startHeartbeat(){},
  display:{reset(){},push(){}}});
 s.panel.open=()=>{};
 try {
  const started=s.start({plan_id:'test',plan:{legs:[{path:[[127,37,80]]}]}});
  await Promise.resolve();
  s.socket.message({type:'ready',sample:{time_s:0}});await started;
  assert.equal(sent.at(-1).type,'resume');
  s.socket.message({type:'resumed'});assert.equal(input.active,true);
  s.socket.message({type:'paused',reason:'input gap'});assert.equal(input.active,false);
  assert.equal(sent.at(-1).type,'resume');
  s.socket.message({type:'resumed'});assert.equal(input.active,true);
  s.socket.message({type:'paused',reason:'input gap'});s.pause();
  s.socket.message({type:'resumed'});assert.equal(input.active,false,'user pause wins over in-flight resume');
  s.socket.message({type:'paused'});assert.equal(sent.at(-1).type,'pause');
 } finally {
  clearInterval(s.transport);globalThis.WebSocket=savedSocket;globalThis.location=savedLocation;
 }
});
