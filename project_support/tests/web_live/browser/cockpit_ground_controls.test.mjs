import test from 'node:test';
import assert from 'node:assert/strict';
import {CockpitConsole,consoleSurface} from '../../../../user_application/web/domains/uam/cockpit/cockpit_console.js';
import {surfaceChart,surfaceOrigin} from '../../../../user_application/web/domains/uam/cockpit/cockpit_surface.js';
import {ManualFlightInput} from '../../../../user_application/web/domains/uam/cockpit/manual_flight_input.js';
import {turnaroundVisual} from '../../../../digital_twin/visualization/web/manual_turnaround.js';
import {fakeDocument} from './fake_dom.mjs';
test('each lower MFD expands only its own display and restores both on return',()=>{
 const p=new CockpitConsole({document:fakeDocument});
 for(const key of ['psu','turnaround','psu']){
  p.focusButtons[key].click();assert.equal(p.focusScreen,key);
  assert.equal(p.psuScreen.hidden,key!=='psu');assert.equal(p.turnaroundScreen.hidden,key!=='turnaround');
  assert.equal(p.focusButtons[key].textContent,'원위치');
  p.focusButtons[key].click();assert.equal(p.focused,false);
  assert.equal(p.psuScreen.hidden,false);assert.equal(p.turnaroundScreen.hidden,false);
 }
 p.destroy();
});
test('remote destination is readable before approach; live identity wins; missing geometry retains allocation',()=>{
 const records=new Map([['VP1',{name:'출발',layout:{frame:{latitude:37,longitude:127}}}],['VP2',{name:'도착',layout:{frame:{latitude:38,longitude:127}}}]]);
 const pos={entity_id:'scenario:A',latitude_deg:37,longitude_deg:127},plan={arrival:{vertiport:'VP2',gate:'G1',fato:'F1'}};
 const detail={state:{aircraft_id:'A',clearance:{vertiport:'VP2',stand:'G3',fato:'F2'}}};
 const chart=surfaceChart(records,pos,plan,detail);assert.equal(chart.id,'VP2');assert.equal(chart.gate,'G3');assert.equal(chart.plannedGate,'G1');assert.equal(chart.assigned,true);assert.equal(surfaceOrigin(chart,pos),chart.center);
 detail.state.aircraft_id='B';assert.equal(surfaceChart(records,pos,plan,detail).gate,'G1');
 const missing=surfaceChart(new Map(),pos,plan);assert.equal(missing.plannedFato,'F1');assert.equal(missing.geometryAvailable,false);
});
test('console mirrors actual input, labels plan versus PSU, and forwards requests only when eligible',()=>{
 const actions=[],p=new CockpitConsole({document:fakeDocument,onControl:(...v)=>actions.push(v),onGround:a=>actions.push(a)});
 const controls={enabled:true,source:'keyboard',mode:'multirotor',throttle:.32,roll:.25,pitch:-.4};
 p.update({controls,ground:{available:false,reason:'정차하세요'},chart:{name:'천호',plannedFato:'F2',plannedGate:'G4'}});
 // Grip travel follows the console canvas, which now carries MFD pixel density.
 assert.equal(p.power,undefined);assert.equal(p.dot,undefined,'stick is actual scene geometry');
 assert.equal(p.root.querySelector('.cockpit-surface-mfd'),null);
 // The flat throttle slider is gone: the thrust lever is in the cabin. What is
 // left here is the number and a note saying whose hand is on it.
 assert.equal(p.throttle,undefined);assert.equal(p.throttleNote,undefined);
 p.ground.click();assert.deepEqual(actions,[]);p.source.click();assert.deepEqual(actions.pop(),['source','screen']);
 p.update({controls:{...controls,source:'screen'},ground:{available:true}});p.ground.click();assert.equal(actions.pop(),'disembark');
 p.update({controls:{...controls,source:'joystick'},ground:{available:true}});assert.equal(p.sourceValue.textContent,'조이스틱');
 p.update({controls:null});assert.equal(p.ground.disabled,true);assert.equal(p.source.disabled,true);p.destroy();
});
test('screen yaw releases on blur, source change, and no independent throttle integration',()=>{
 const input=new ManualFlightInput({target:null});input.start();input.setSource('screen');input.setYaw(.5);input.setThrottle(.22);assert.equal(input.update(.1).yaw,.5);
 input.suspend();input.start();assert.equal(input.update(.1).yaw,0);assert.equal(input.throttle,.22);
});
test('turnaround follows sample time, not wall time; cable ends before controls release',()=>{
 const s={time_s:11,ground_handling:{start_s:10,position:[127,37,80],crew_start_s:20,crew_walk_s:10,crew_path:[[127,37,80],[127.001,37,80]],socket:[127,37,81]}};
 assert.equal(turnaroundVisual(s).open,.5);assert.deepEqual(turnaroundVisual(s),turnaroundVisual(s));
 s.time_s=35;assert.equal(turnaroundVisual(s).progress,.5);assert.equal(turnaroundVisual(s).cable,true);
 s.ground_handling.release_s=35;s.time_s=39;assert.equal(turnaroundVisual(s).open,.5);assert.equal(turnaroundVisual(s).cable,false);
 const surface=consoleSurface({screens:[{id:'nav',center:[2,1,0],width:.3,height:.2,up:[0,1,0]}]});assert.ok(surface.center[1]<1);assert.ok(surface.width>.3);
});


test('manual arrival ground contact selects destination rather than departure chart',()=>{
 const records=new Map([['A',{layout:{frame:{latitude:37,longitude:127}}}],['B',{layout:{frame:{latitude:38,longitude:127}}}]]);
 const plan={departure:{vertiport:'A',gate:'G1'},arrival:{vertiport:'B',gate:'G3'}};
 const pos={manual:true,airborne:false,stage:'gate_out',latitude_deg:38,longitude_deg:127};
 assert.equal(surfaceChart(records,pos,plan).plannedGate,'G3');pos.latitude_deg=37;assert.equal(surfaceChart(records,pos,plan).plannedGate,'G1');
});


test('lower MFDs own ground and display actions while simulation settings stay in dock',()=>{
 const requests=[],p=new CockpitConsole({document:fakeDocument,onGround:a=>requests.push(a)});
 assert.ok(p.turnaroundScreen.querySelectorAll('button').includes(p.ground));assert.ok(p.psuScreen.querySelectorAll('button').includes(p.departButton));
 assert.equal(p.root.querySelectorAll('input').length,0);
 assert.equal(p.root.querySelectorAll('.cockpit-screen').length,2);
 assert.equal(p.psuScreen.hidden,false);
 assert.doesNotMatch(p.root.textContent,/THROTTLE|STICK|W \/ S|키보드|일시정지/);
 assert.equal(p.controlsRoot.querySelectorAll('button').includes(p.ground),false);
 p.update({controls:{enabled:true,active:true},ground:{phase:'charging',passengers_remaining:0,reason:'연결됨'},telemetry:{passengers:4,battery_pct:87.2},chart:{name:'여의도',assigned:true,liveFato:'F2',liveGate:'G3',plannedFato:'F1',plannedGate:'G1'}});
 assert.equal(p.passengers.textContent,'0');assert.equal(p.energy.textContent,'87 %');
 assert.equal(p.releaseButton.disabled,false);p.releaseButton.click();assert.equal(requests.pop(),'release');
 p.update({ground:{phase:'complete'},stale:true});assert.equal(p.charger.textContent,'NOT AVAILABLE');assert.equal(p.phase.textContent,'STALE');
 p.focusButtons.turnaround.click();assert.equal(p.focusScreen,'turnaround');assert.equal(p.focused,true);p.close();assert.equal(p.focused,false);p.destroy();
});

test('ground MFD never sends stale, paused, pending or unsupported procedure requests',()=>{
 const sent=[],p=new CockpitConsole({document:fakeDocument,onGround:a=>sent.push(a)});
 for(const change of [{stale:true},{controls:{active:false}},{controls:{pending:true}},{controls:{groundSupported:false}}]){
  p.update({controls:{active:true,enabled:true,...change.controls},ground:{available:true,phase:'charging'},stale:change.stale});
  p.ground.click();p.releaseButton.click();assert.deepEqual(sent,[]);
 }
 p.destroy();
});

test('manual charging waits for a separate request and no phantom cable is drawn',()=>{
 const sent=[],p=new CockpitConsole({document:fakeDocument,onGround:a=>sent.push(a)});
 const controls={active:true,groundSupported:true,groundChargeSupported:true};
 const ground={phase:'awaiting_charge',available:false,door_open:1,charge_requested_s:null,
  start_s:10,position:[127,37,80],crew_start_s:20,crew_walk_s:10,socket:[127,37,80],crew_path:null};
 p.update({controls,ground});assert.equal(p.ground.textContent,'충전 연결 요청');assert.equal(p.ground.disabled,false);
 assert.equal(p.door.textContent,'OPEN');assert.equal(p.charger.textContent,'STANDBY');
 assert.equal(p.releaseButton.textContent,'문 닫기');p.ground.click();assert.deepEqual(sent,['charge']);
 const v=turnaroundVisual({time_s:5000,ground_handling:ground});assert.equal(v.cable,false);assert.equal(v.open,1);
 p.update({controls:{...controls,groundChargeSupported:false},ground});assert.equal(p.ground.disabled,true);
 p.update({controls,ground:{...ground,readOnly:true}});assert.equal(p.ground.disabled,true);assert.equal(p.releaseButton.disabled,true);
 const charged={...ground,charge_requested_s:4999,crew_start_s:4989,crew_path:[[127,37,80],[127.001,37,80]]};
 assert.equal(turnaroundVisual({time_s:5000,ground_handling:charged}).cable,true);
 assert.equal(turnaroundVisual({time_s:5001,ground_handling:{...ground,release_s:5000,door_open:.5}}).open,.5);
 p.destroy();
});

test('turnaround shows the scheduled next flight during charging and continues after release',()=>{
 const sent=[],p=new CockpitConsole({document:fakeDocument,onGround:a=>sent.push(a)});
 const controls={active:true,enabled:true,groundSupported:true,groundChargeSupported:true,nextFlightSupported:true};
 const next={flight_id:'F2',origin:'VP2',destination:'VP1',off_block_s:26400,ready_s:26000,target_soc_pct:90};
 p.update({controls,ground:{phase:'charging',flight_completed:true,next_flight:next,passengers_remaining:0},telemetry:{battery_pct:88}});
 assert.equal(p.nextSchedule.hidden,false);assert.match(p.nextFlight.textContent,/F2.*VP2.*VP1/);
 assert.match(p.nextDeparture.textContent,/ETD.*목표 90%/);
 p.update({controls,ground:{phase:'released',flight_completed:true,next_flight:next},telemetry:{battery_pct:89.9}});
 assert.equal(p.releaseButton.textContent,'다음 비행 이어가기');assert.equal(p.releaseButton.disabled,true);
 p.update({controls,ground:{phase:'released',flight_completed:true,next_flight:next},telemetry:{battery_pct:90}});
 assert.equal(p.releaseButton.disabled,false);p.releaseButton.click();assert.equal(sent.pop(),'next_flight');
 p.update({controls,ground:{phase:'released',flight_completed:true,next_flight:null},telemetry:{battery_pct:100}});
 assert.equal(p.nextFlight.textContent,'오늘 남은 예정 비행 없음');assert.equal(p.releaseButton.disabled,true);
 p.destroy();
});
