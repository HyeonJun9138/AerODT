import test from 'node:test';
import assert from 'node:assert/strict';
import {flightProgress,groundSpeed,flightTiming,manualFlightTiming,flightClock,navClock} from '../../../../user_application/web/domains/uam/cockpit/cockpit_flight_progress.js';
import {cockpitInstrumentState} from '../../../../user_application/web/domains/uam/cockpit/cockpit_state.js';
import {CockpitPanel} from '../../../../user_application/web/domains/uam/cockpit/cockpit_panel.js';
import {fakeDocument} from './fake_dom.mjs';
const points=[{id:'a',latitude_deg:0,longitude_deg:0},{id:'b',latitude_deg:.01,longitude_deg:0},{id:'c',latitude_deg:.01,longitude_deg:.01}];
const e={entity_id:'scenario:A',orientation_source:'attitude',latitude_deg:.005,longitude_deg:0,heading_deg:0,airborne:true,ground_speed_mps:10};
const m={route_points:points,next_waypoint_id:'b',timing:{now_s:24000,actual_takeoff_s:23900}};
test('remaining route follows all future WP legs and recomputes with location/speed',()=>{
 const before=structuredClone(m),a=flightProgress(e,m),b=flightProgress({...e,latitude_deg:.009},m);
 assert.ok(a.remaining>1600&&a.remaining<1700);assert.ok(b.remaining<a.remaining);
 assert.equal(a.ete,a.remaining/10);assert.equal(flightProgress({...e,ground_speed_mps:20},m).ete,a.ete/2);
 assert.equal(a.eta,24000+a.ete);assert.equal(a.elapsed,100);assert.deepEqual(m,before);
});
test('stopped, unknown airborne, hold, stale and invalid route cannot fabricate ETA',()=>{
 for(const [entity,mission,opt] of [[{...e,ground_speed_mps:0},m,{}],[{...e,airborne:false},m,{}],[{...e,airborne:undefined},m,{}],[e,{...m,holding:true},{}],[e,m,{stale:true}],[e,{...m,timing:{stale:true}},{}],[e,{route_points:[]},{}],[e,{route_points:[points[0],{longitude_deg:NaN}]},{}]]){
  const r=flightProgress(entity,mission,opt);assert.equal(r.ete,null);assert.equal(r.eta,null);
 }
 assert.equal(flightProgress(e,{...m,timing:{}}).eta,null);
});
test('GS is horizontal and vertical-only movement is not forward progress',()=>{
 assert.equal(groundSpeed({velocity_ned_mps:[3,4,90]}),5);
 assert.equal(groundSpeed({latitude_deg:0,longitude_deg:0,velocity_ecef_mps:[30,0,0]}),0);
 assert.equal(groundSpeed({recorded_speed_mps:50}),null);
 const r=flightProgress({...e,ground_speed_mps:undefined,velocity_ned_mps:[0,0,-8]},m);assert.equal(r.ete,null);
});
test('matching recorded takeoff is actual, PSU slot and report time are not',()=>{
 const detail={state:{aircraft_id:'A'},flight:{flight_id:'F',off_block_s:0,lift_off_s:10,touchdown_s:90},events:[{flight_id:'OTHER',kind:'takeoff',time_s:4},{flight_id:'F',kind:'takeoff',time_s:20},{flight_id:'F',kind:'touchdown',time_s:100}]};
 const t=flightTiming(detail,60);assert.equal(t.off_block_s,0);assert.equal(t.actual_takeoff_s,20);assert.equal(t.actual_landing_s,undefined);assert.equal(t.planned_takeoff_s,10);
 const before=flightTiming(detail,15);assert.equal(before.actual_takeoff_s,undefined);
 const psu={flight_id:'F',procedure:{timeline:{now_s:60,takeoff_s:11},reports:{report_airborne:30}}};
 const without=manualFlightTiming({entityId:'scenario:A',detail:{...detail,events:[]},psu,plan:{},sample:{}});assert.equal(without.actual_takeoff_s,undefined);
 const foreign=manualFlightTiming({entityId:'scenario:B',detail,psu:null,plan:{},sample:{}});assert.equal(foreign.actual_takeoff_s,undefined);
 assert.equal(flightProgress(e,{...m,timing:{now_s:120,actual_takeoff_s:20,actual_landing_s:100}}).elapsed,80);
});
test('clock domains preserve elapsed time and day wrap without using wall clock',()=>{
 assert.equal(flightClock({time_s:24000,epoch_time:1800000000},1800000005),24005);
 assert.equal(flightClock({time_s:24000,epoch_time:1800000000},1),null);
 assert.equal(navClock(86403),'+1d 00:00:03');assert.equal(navClock(86403,true),'24:00:03');assert.equal(navClock(null),'—');
 const t=manualFlightTiming({entityId:'preview:selected-flight',plan:{legs:[{stage:'takeoff',start_s:8},{stage:'landing',end_s:150}]},sample:{time_s:20}});
 assert.equal(t.now_s,20);assert.equal(t.elapsed_clock,true);assert.equal(t.actual_takeoff_s,undefined);
});
test('observed adapter identity-checks departure and flight timing',()=>{
 const detail={state:{aircraft_id:'A',airborne:true},flight:{origin:'VP1',origin_name:'Start',destination:'VP2',flight_id:'F',off_block_s:100},events:[{flight_id:'F',kind:'takeoff',time_s:120}]};
 const out=cockpitInstrumentState({entity:e,display:e,missionDetail:detail,clock:{epoch_time:1800000000,time_s:130},stateTime:1800000000});
 assert.equal(out.mission.origin_name,'Start');assert.equal(out.mission.timing.actual_takeoff_s,120);assert.equal(out.mission.timing.now_s,130);
 detail.state.aircraft_id='B';const other=cockpitInstrumentState({entity:e,display:e,missionDetail:detail});assert.equal(other.mission.origin,undefined);assert.equal(other.mission.timing.actual_takeoff_s,undefined);
});
test('systems live in PFD, NAV endpoints/progress survive ground mode and reset on new entity',()=>{
 const p=new CockpitPanel({document:fakeDocument});p.open();
 const state={entity:e,mission:{...m,origin_name:'Start',origin_id:'VP1',destination_name:'Finish',destination_id:'VP2'},telemetry:{battery_soc_pct:72,rotor_rpm:1234,mode:'multirotor'},nearby:[]};p.update(state,0);
 for(const key of ['battery','rpm','tilt','mode','phase']){assert.ok(p.screens.pfd.querySelector(`[data-readout=${key}]`));assert.equal(p.screens.nav.querySelector(`[data-readout=${key}]`),null);}
 assert.equal(p.originName.textContent,'Start');assert.equal(p.finalDestination.textContent,'Finish');assert.notEqual(p.readouts.ete.textContent,'—');
 p.groundButton.click();p.update(state,200);assert.equal(p.finalDestination.textContent,'Finish');assert.equal(p.originName.textContent,'Start');
 p.update({entity:{entity_id:'other'},mission:{}},201);assert.equal(p.readouts.eta.textContent,'—');assert.equal(p.originName.textContent,'—');p.close();assert.equal(p.finalDestination.textContent,'—');p.destroy();
});

test('a new PSU flight cannot inherit the previous flight takeoff on the same aircraft',()=>{
 const old={state:{aircraft_id:'A',flight_id:'old'},flight:{flight_id:'old',off_block_s:12},events:[{flight_id:'old',kind:'takeoff',time_s:20}]};
 const t=manualFlightTiming({entityId:'scenario:A',detail:old,psu:{flight_id:'new',procedure:{timeline:{now_s:100,off_block_s:90}}},plan:{},sample:{}});
 assert.equal(t.actual_takeoff_s,undefined);assert.equal(t.off_block_s,90);
});
test('dateline route is short and known next WP chooses the remaining branch',()=>{
 const mission={next_waypoint_id:'b',route_points:[{id:'a',latitude_deg:0,longitude_deg:179.9},{id:'b',latitude_deg:0,longitude_deg:-179.9},{id:'c',latitude_deg:0,longitude_deg:-179.8}]};
 const out=flightProgress({...e,latitude_deg:0,longitude_deg:179.95},mission);assert.ok(out.remaining>27000&&out.remaining<29000);
 const last=flightProgress({...e,latitude_deg:0,longitude_deg:-179.8},{...mission,next_waypoint_id:'c'});assert.equal(last.remaining,0);assert.equal(last.ete,0);
});

import {CockpitView} from '../../../../user_application/web/domains/uam/cockpit/cockpit_view.js';
import {CockpitConsole} from '../../../../user_application/web/domains/uam/cockpit/cockpit_console.js';
test('manual NAV uses owner PSU clock and recorded flight event, not native elapsed time',()=>{
 const v=Object.create(CockpitView.prototype);let displayed;
 Object.assign(v,{globe:{},panel:{update:s=>displayed=s},manualControls:()=>({enabled:true}),
 readMission:()=>({state:{aircraft_id:'A'},flight:{flight_id:'F',lift_off_s:22000},events:[{flight_id:'F',kind:'takeoff',time_s:22010}]}),
 readPsu:()=>({flight_id:'F',procedure:{timeline:{now_s:22100,off_block_s:21900}}})});
 const sample={manual:true,time_s:10,position:{latitude:37,longitude:127,altitude_m:200},airborne:true,velocity_ned_mps:[30,40,1]};
 v.paintManual(sample,{departure:{name:'Start'},arrival:{name:'End'},legs:[]},100,'scenario:A');
 assert.equal(displayed.mission.timing.now_s,22100);assert.equal(displayed.mission.timing.actual_takeoff_s,22010);assert.equal(displayed.mission.origin,'Start');assert.equal(groundSpeed(displayed.entity),50);
});
test('relocated AP controls keep existing callbacks and map buttons send no flight commands',()=>{
 const calls=[],p=new CockpitPanel({document:fakeDocument}),c=new CockpitConsole({document:fakeDocument,onControl:(...args)=>calls.push(args)});
 p.navAutopilot.append(c.autopilotButton,c.holdAltitudeButton,c.holdPositionButton);
 c.update({controls:{enabled:true,active:true,autopilotSupported:true,source:'keyboard'},telemetry:{airborne:true,mode:'cruise'}});
 c.autopilotButton.click();assert.deepEqual(calls,[['autopilot',true]]);
 p.groundButton.click();p.rangeButton.click();p.orientationButton.click();assert.equal(calls.length,1);
 p.destroy();c.destroy();
});
