import test from 'node:test';import assert from 'node:assert/strict';
import {observedCockpit} from '../../../../user_application/web/domains/uam/cockpit/cockpit_observed.js';
import {CockpitConsole} from '../../../../user_application/web/domains/uam/cockpit/cockpit_console.js';
import {fakeDocument} from './fake_dom.mjs';
test('multi cockpit hardware follows sampled attitude and RPM, remains read only, and never borrows another aircraft',()=>{
 const entity={entity_id:'scenario:A',flight_phase:'cruise',battery_pct:83};
 const sample={pitch_deg:-15,roll_deg:12,rotor_radps:300};
 const detail={state:{aircraft_id:'A',airborne:true,on_board:4}};const before=structuredClone({entity,sample,detail});
 const o=observedCockpit(entity,sample,detail);assert.equal(o.controls.throttle,.5);assert.equal(o.controls.pitch,-.5);assert.equal(o.controls.roll,.4);assert.equal(o.controls.enabled,false);
 assert.equal(o.ground.phase,'airborne');assert.equal(o.telemetry.passengers,4);assert.equal(o.telemetry.battery_pct,83);assert.equal(o.ground.door_state,'미수신');
 assert.equal(observedCockpit({...entity,entity_id:'scenario:B'},sample,detail).telemetry.passengers,null);assert.deepEqual({entity,sample,detail},before);
});
test('multi turnaround reads passenger and charger observations while procedure buttons remain disabled',()=>{
 const p=new CockpitConsole({document:fakeDocument});
 const entity={entity_id:'scenario:A',flight_phase:'charge',battery_pct:77},state={aircraft_id:'A',airborne:false,on_board:0,energy:{charge_state:'charging'}};
 let o=observedCockpit(entity,{}, {state});p.update({...o,controls:null});assert.equal(p.groundStatus.textContent,'충전 중');assert.equal(p.passengers.textContent,'0');assert.equal(p.charger.textContent,'CONNECTED');assert.equal(p.energy.textContent,'77 %');assert.equal(p.ground.disabled,true);assert.equal(p.releaseButton.disabled,true);assert.equal(p.controlsRoot.hidden,true);
 state.passenger_flow={phase:'alighting',on_board:2};o=observedCockpit(entity,{}, {state});p.update({...o,controls:null});assert.equal(p.passengers.textContent,'2');assert.equal(p.groundStatus.textContent,'승객 하차');
 p.update({...o,controls:null,stale:true});assert.equal(p.phase.textContent,'STALE');p.destroy();
});
