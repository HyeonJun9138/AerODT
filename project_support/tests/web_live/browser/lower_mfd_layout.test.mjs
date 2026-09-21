import test from 'node:test';
import assert from 'node:assert/strict';
import {CockpitConsole} from '../../../../user_application/web/domains/uam/cockpit/cockpit_console.js';
import {CockpitPanel} from '../../../../user_application/web/domains/uam/cockpit/cockpit_panel.js';
import {throttleFrame} from '../../../../digital_twin/visualization/web/cockpit_throttle.js';
import {CockpitStick} from '../../../../digital_twin/visualization/web/cockpit_stick.js';
import {fakeDocument} from './fake_dom.mjs';
test('throttle stays at the left edge and stick stays on NAV centre at every cabin scale',()=>{
 for(const width of [.2,.4,1]){
  const screen={id:'nav',center:[1,2,3],right:[0,0,1],up:[0,1,0],width,height:width*.8};
  const profile={screens:[screen]},t=throttleFrame(profile),s=CockpitStick.prototype.placement(profile);
  assert.ok(t.anchor[2]<3);
  assert.ok(Math.abs(s.anchor[2]-3)<1e-9);
  assert.equal(t.anchor[0],s.anchor[0]);assert.equal(t.anchor[1],s.anchor[1]);
 }
});
test('connection loss resets directives and disables all PSU requests without removing either monitor',()=>{
 const calls=[],c=new CockpitConsole({document:fakeDocument,onPsu:k=>calls.push(k)});
 c.update({psu:{flight_id:'A',procedure:{stage:'이륙 허가',text:'이륙 허가',next:{kind:'report_airborne',label:'이륙 완료 보고',enabled:true}}}});
 c.update({psu:null});for(const b of [c.departButton,c.arriveButton,c.holdButton])b.click();
 assert.deepEqual(calls,[]);assert.equal(c.root.querySelectorAll('.cockpit-screen').length,2);
 assert.equal(c.psuScreen.hidden,false);assert.doesNotMatch(c.psuDepartNote.textContent,/이륙 허가/);
 c.setPsuTab(true);assert.equal(c.psuLiveBody.hidden,true);assert.equal(c.psuCommsBody.hidden,false);
 c.setPsuTab(false);assert.equal(c.psuCommsBody.hidden,true);
});
test('NAV retains live assignment and planned allocation after removing lower SURFACE monitor',()=>{
 const p=new CockpitPanel({document:fakeDocument});p.open();
 p.update({entity:{latitude_deg:37,longitude_deg:127,heading_deg:0},telemetry:{},mission:{surface:{name:'여의도',assigned:true,gate:'G3',fato:'F2',plannedGate:'G1',plannedFato:'F1'}}},0);
 assert.match(p.navSurface.textContent,/배정/);assert.match(p.navSurface.textContent,/G3/);assert.match(p.navSurface.title,/G1/);
});
