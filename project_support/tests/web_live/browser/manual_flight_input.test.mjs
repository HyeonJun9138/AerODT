import test from 'node:test';import assert from 'node:assert/strict';
import {ManualFlightInput} from '../../../../user_application/web/domains/uam/cockpit/manual_flight_input.js';
const key=(m,code,down=true,extra={})=>m.key({code,preventDefault(){},...extra},down);
test('loading keys and their repeat events cannot become first flight commands',()=>{
 const m=new ManualFlightInput({target:null});
 for(const code of ['KeyW','KeyZ','ArrowUp','KeyQ'])key(m,code);
 assert.equal(m.update(.1),null);m.start();
 for(const code of ['KeyW','KeyZ','ArrowUp','KeyQ'])key(m,code,true,{repeat:true});
 const neutral=m.update(.1);
 assert.equal(neutral.throttle,0);assert.equal(neutral.pitch,0);assert.equal(neutral.yaw,0);assert.equal(neutral.flight_mode,'multirotor');
 key(m,'KeyW',false);key(m,'KeyW');assert.ok(m.update(.1).throttle>0);
});

test('stationary joystick idle settles to exact zero, survives jitter and releases for real input',()=>{
 const m=new ManualFlightInput({target:null});m.setSource('joystick');
 const sample={airborne:false,speed_mps:0},c={throttle:.007,roll:.014,pitch:-.012,yaw:.018,input_source:'joystick',flight_mode:'multirotor'};
 for(let i=0;i<5;i++)assert.equal(m.groundIdle(c,sample,.05),c,'not a one-frame neutral decision');
 const zero=m.groundIdle(c,sample,.05);for(const k of ['throttle','roll','pitch','yaw'])assert.equal(zero[k],0);
 assert.equal(m.groundIdle({...c,roll:.027},sample,.05).roll,0,'hysteresis keeps settled noise neutral');
 for(const k of ['throttle','roll','pitch','yaw']){
  const intended={...c,[k]:.1};assert.equal(m.groundIdle(intended,sample,.05),intended,'deliberate input passes immediately');
  assert.equal(m.groundIdle(c,sample,.05),c,'must settle again after a real deflection');
 }
 m.destroy();
});
test('idle conditioning never swallows flight, moving, stale or non-joystick commands',()=>{
 const m=new ManualFlightInput({target:null});m.setSource('joystick');
 const c={throttle:.005,roll:.01,pitch:-.01,yaw:.01,input_source:'joystick'};
 for(const sample of [null,{airborne:true,speed_mps:0},{airborne:false,speed_mps:.2},{airborne:false}])
  for(let i=0;i<12;i++)assert.equal(m.groundIdle(c,sample,.05),c);
 const sample={airborne:false,speed_mps:0};
 for(const source of ['keyboard','screen']){m.setSource(source);for(let i=0;i<12;i++)assert.equal(m.groundIdle({...c,input_source:source},sample,.05).throttle,.005);}
 m.setSource('joystick');for(let i=0;i<6;i++)m.groundIdle(c,sample,.05);
 m.suspend();assert.equal(m.groundIdle(c,sample,.05),c,'pause clears the idle latch');m.destroy();
});
test('Shift provides precision control without changing retained throttle; centre jitter is neutral',()=>{const m=new ManualFlightInput({target:null});m.start();m.setThrottle(.42);key(m,'ShiftLeft');key(m,'ArrowRight');key(m,'KeyQ');const c=m.update(.05);assert.equal(c.roll,.25);assert.equal(c.yaw,-.25);assert.equal(c.throttle,.42);key(m,'ShiftLeft',false);assert.equal(m.update(.05).roll,1);m.setSource('screen');m.setStick(.01,.02);assert.equal(m.update(.05).roll,0);});
test('W/S ramp gently, release holds throttle, Z/X request modes',()=>{const m=new ManualFlightInput({target:null});m.start();key(m,'KeyW');for(let i=0;i<10;i++)m.update(.1);assert.ok(Math.abs(m.throttle-.02)<1e-9);key(m,'KeyW',false);assert.equal(m.update(.1).throttle,m.throttle);key(m,'KeyZ');assert.equal(m.update(0).flight_mode,'fixed_wing');key(m,'KeyX');assert.equal(m.update(0).flight_mode,'multirotor');key(m,'KeyS');assert.ok(m.update(.1).throttle<.02);});
test('arrows, opposite keys and circular screen stick remain bounded',()=>{const m=new ManualFlightInput({target:null});m.start();key(m,'ArrowLeft');assert.equal(m.update(0).roll,-1);key(m,'ArrowRight');assert.equal(m.update(0).roll,0);m.setSource('screen');m.setStick(3,4);const c=m.update(0);assert.equal(c.roll,.6);assert.equal(c.pitch,.8);m.setThrottle(9);assert.equal(m.throttle,1);});
test('blur suspends, restart clears keys, editable fields do not capture flight input',()=>{let stopped=0;const m=new ManualFlightInput({target:null,onSuspend:()=>stopped++});m.start();key(m,'KeyW');m.blur();assert.equal(m.update(.1),null);assert.equal(stopped,1);m.start();assert.equal(m.update(.1).throttle,0);key(m,'KeyW',true,{target:{tagName:'INPUT'}});assert.equal(m.update(.1).throttle,0);key(m,'ArrowLeft');key(m,'KeyW',true,{ctrlKey:true});assert.equal(m.update(0).roll,0);});

test('Q/E yaw left/right without changing flight mode',()=>{const m=new ManualFlightInput({target:null});m.start();key(m,'KeyQ');assert.equal(m.update(.1).yaw,-1);assert.equal(m.mode,'multirotor');key(m,'KeyE');assert.equal(m.update(.1).yaw,0);key(m,'KeyQ',false);assert.equal(m.update(.1).yaw,1);key(m,'KeyE',false);assert.equal(m.update(.1).yaw,0);});

test('temporary blur clears held keys and requests resume once on focus return',()=>{let resumed=0;const m=new ManualFlightInput({target:null,onReturn:()=>resumed++});m.start();key(m,'ArrowUp');m.blur();m.blur();assert.equal(m.keys.size,0);assert.equal(m.active,false);m.focus();m.focus();assert.equal(resumed,1);assert.equal(m.active,false);});
