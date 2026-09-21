import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ManualFlightSession} from '../../../../user_application/web/domains/uam/cockpit/manual_flight_session.js';
import {ManualFlightInput} from '../../../../user_application/web/domains/uam/cockpit/manual_flight_input.js';

test('ground idle conditioning reaches the socket, but stale ground observations cannot zero flight input',()=>{
 const input=new ManualFlightInput({target:null});input.start();input.setSource('joystick');
 const command={throttle:.006,roll:.012,pitch:-.012,yaw:.014,input_source:'joystick',flight_mode:'multirotor'};
 const sent=[],session=Object.create(ManualFlightSession.prototype);
 Object.assign(session,{panel:{input,tick:()=>command},socket:{readyState:1,send:s=>sent.push(JSON.parse(s))},display:{latest:{airborne:false,speed_mps:0}},sequence:0});
 const tick=age=>{session.inFlight=0;session.lastControl=performance.now()-60;session.lastAck=performance.now()-age;session.sendControls();};
 for(let i=0;i<6;i++)tick(0);
 for(const k of ['throttle','roll','pitch','yaw'])assert.equal(sent.at(-1)[k],0);
 tick(600);assert.equal(sent.at(-1).throttle,command.throttle);assert.equal(sent.at(-1).roll,command.roll);
 session.display.latest.airborne=true;for(let i=0;i<8;i++)tick(0);
 assert.equal(sent.at(-1).throttle,command.throttle);input.destroy();
});
test('ground keyboard commands transmit without invoking the render loop',()=>{
 const input=new ManualFlightInput({target:null});input.start();input.key({code:'ArrowUp',preventDefault(){},stopImmediatePropagation(){}},true);
 const sent=[];const session=Object.create(ManualFlightSession.prototype);
 Object.assign(session,{panel:{input,tick:dt=>input.update(dt)},socket:{readyState:1,send:s=>sent.push(JSON.parse(s))},
  lastControl:performance.now()-50,lastSend:0,inFlight:0,lastAck:performance.now(),sequence:0});
 session.sendControls();assert.equal(sent[0].pitch,-1);assert.equal(sent[0].throttle,0);assert.equal(sent[0].sequence,1);
 // Two may be unanswered at once: waiting for every reply let one late answer
 // cost a whole tick, and the gap the server steps by doubled with it.
 session.sendControls();assert.equal(sent.length,2);assert.equal(sent[1].sequence,2);
 session.sendControls();assert.equal(sent.length,2,'and no more than two');
 // An answer frees a slot, and only an answer does.
 session.inFlight--;input.key({code:'ArrowUp'},false);session.sendControls();
 assert.equal(sent.length,3);assert.equal(sent[2].pitch,0);
});
test('resume waits for server acknowledgement and does not activate a disconnected session',()=>{
 // The state now travels as a token plus the sentence behind it, so the panel
 // can show one word and keep the explanation in reach.
 const sent=[],states=[];
 const session=Object.create(ManualFlightSession.prototype);
 session.panel={input:{active:true},setStatus:(state,text,detail)=>states.push([state,text,detail])};
 session.socket={readyState:1,send:s=>sent.push(JSON.parse(s))};
 session.resume();
 assert.equal(session.panel.input.active,false,'input waits for the server to acknowledge');
 assert.deepEqual(sent,[{type:'resume'}]);
 assert.equal(states.at(-1)[0],'linking');
 session.socket.readyState=3;session.resume();
 assert.equal(states.at(-1)[0],'closed');
 assert.match(states.at(-1)[2],/연결 종료/,'and the sentence behind it still says what to do');
});


test('explicit pause immediately releases stick, yaw and held keys',()=>{
 const input=new ManualFlightInput({target:null});input.start();input.setSource('screen');input.setStick(1,1);input.setYaw(1);input.keys.add('KeyW');
 const sent=[],session=Object.create(ManualFlightSession.prototype);session.panel={input};session.socket={readyState:1,send:s=>sent.push(JSON.parse(s))};
 session.control('pause');assert.equal(input.active,false);assert.equal(input.keys.size,0);assert.equal(input.yaw,0);assert.deepEqual(input.stick,{x:0,y:0});assert.deepEqual(sent,[{type:'pause'}]);
});

test('a state answer frees a slot; a pause or resume clears the whole window',()=>{
  // Only a state is an answer to a command. Counting keepalives or a pause as
  // one would let the window drift open and the back-pressure stop meaning
  // anything.
  const session=Object.create(ManualFlightSession.prototype);
  const pushed=[];
  Object.assign(session,{inFlight:2,display:{push:s=>pushed.push(s),reset(){}},
    panel:{input:{active:true,start(){},keys:{clear(){}}},setStatus(){}},
    onTelemetry(){},lastTelemetry:performance.now()});
  const handle=message=>{
    if(message.type==='state'){session.inFlight=Math.max(0,session.inFlight-1);session.lastAck=performance.now();}
    else if(message.type==='paused'||message.type==='resumed')session.inFlight=0;
  };
  handle({type:'state',sample:{time_s:1}});
  assert.equal(session.inFlight,1,'one answer, one slot');
  handle({type:'paused'});
  assert.equal(session.inFlight,0,'a pause throws the window away with the commands');
  // The source of truth is the session itself, not this reconstruction.
  const source=readFileSync(new URL('../../../../user_application/web/domains/uam/cockpit/manual_flight_session.js',import.meta.url),'utf8');
  assert.match(source,/const COMMANDS_IN_FLIGHT=2;/);
  assert.match(source,/type==='state'\)\{this\.inFlight=Math\.max\(0,this\.inFlight-1\)/);
  assert.match(source,/type==='paused'\)\{this\.inFlight=0/);
  assert.match(source,/type==='resumed'\)\{this\.inFlight=0/);
  // The stall guard watches the last answer, which is what says the far end
  // went quiet; with more than one in flight the last send does not.
  assert.match(source,/this\.inFlight>0&&now-\(this\.lastAck\?\?now\)>2000/);
});

test('the server applies an even slice per message and carries the rest',()=>{
  // The lumps were whole delivery gaps applied at once. A ceiling per message
  // keeps each advance even; the overflow stays in the remainder, so the
  // simulation still keeps real time instead of throwing the excess away.
  const routes=readFileSync(new URL('../../../../communication/web/manual_routes.py',import.meta.url),'utf8');
  const steps=Number(routes.match(/STEPS_PER_MESSAGE=(\d+)/)[1]);
  const step=Number(routes.match(/STEP_SECONDS=([\d.]+)/)[1]);
  const carry=Number(routes.match(/CARRY_SECONDS=([\d.]+)/)[1]);
  // The ceiling only binds when messages are sparse: a client keeping its 20 Hz
  // hands over 50 ms at a time and never reaches it, so raising it costs that
  // client nothing. What it buys is the client that cannot -- a page busy
  // enough to send ten a second still keeps real time at 100 ms a message,
  // where 60 ms would have run the pilot's clock at six tenths and left them
  // watching the rest of the day pull away.
  const slice=steps*step;
  assert.ok(slice>=.1-1e-9,'a message carries enough that ten a second is still real time');
  assert.ok(slice<=.15+1e-9,'and not so much that a turn arrives in lumps');
  assert.ok(carry>slice,'and more than that may be carried, so time is not lost');
  assert.match(routes,/remainder\+=min\(CARRY_SECONDS,elapsed\)/);
  assert.match(routes,/remainder-=steps\*STEP_SECONDS/,'the overflow is kept');
  const lines=routes.split(/\r?\n/),start=lines.findIndex(line=>line.trim()==='if steps:');
  assert.ok(start>=0);
  const indent=lines[start].search(/\S/),block=[];
  for(const line of lines.slice(start+1)){
    if(line.trim()&&line.search(/\S/)<=indent)break;
    block.push(line);
  }
  // Physics stays inside the non-empty slice, PSU synchronisation and all --
  // and it is one hand-off, not four. Every hop waits on the GIL the day's tick
  // holds, and the number of hops per message is what sets how many messages a
  // second a pilot gets, which is what their simulated clock is made of.
  const work=block.join('\n');
  assert.match(work,/session\.step\(command,steps\)/,'physics remains inside the non-empty slice');
  assert.match(work,/await run_in_threadpool\(advance\)/,'and reaches the worker in a single hop');
  assert.equal((work.match(/await run_in_threadpool\(/g)??[]).length,1,'one hop per message, not one per task');
});
