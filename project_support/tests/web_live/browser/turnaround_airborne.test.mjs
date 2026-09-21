import test from 'node:test';
import assert from 'node:assert/strict';
import {CockpitConsole} from '../../../../user_application/web/domains/uam/cockpit/cockpit_console.js';
import {fakeDocument} from './fake_dom.mjs';
test('manual cruise overrides idle ground service display and disables ground actions',()=>{
 const c=new CockpitConsole({document:fakeDocument});
 const ground={phase:'idle',available:true,passengers_remaining:6};
 c.update({controls:{active:true},ground,telemetry:{airborne:true,passengers:6,battery_pct:92}});
 assert.equal(c.phase.textContent,'AIRBORNE');assert.equal(c.groundStatus.textContent,'비행 중');
 assert.equal(c.charger.textContent,'NOT IN USE');assert.equal(c.passengers.textContent,'6');
 assert.equal(c.ground.disabled,true);assert.equal(c.releaseButton.disabled,true);
 assert.equal(ground.phase,'idle');
 c.update({ground,telemetry:{airborne:false}});assert.equal(c.phase.textContent,'IDLE');
});
