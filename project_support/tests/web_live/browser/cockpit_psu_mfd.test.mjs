// The PSU page in the cabin: what the service is saying, and the three things
// a pilot asks it for.
//
// A button that cannot do anything says so by being unpressable rather than by
// answering with a refusal -- asking for a landing number before leaving the
// stand is not a mistake worth making and then explaining. And the page is only
// there when flying one airframe of a running day: a flight of its own has no
// service to talk to, and an empty third screen is a worse answer than none.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fakeDocument} from './fake_dom.mjs';
import {CockpitConsole} from '../../../../user_application/web/domains/uam/cockpit/cockpit_console.js';

const FLYING = {enabled: true, active: true, source: 'keyboard', mode: 'multirotor', throttle: 0.3};
const ADVICE = {flight_id: 'F1', departed: false, airborne: false, instruction: {},
                departure: null, arrival: null, hold: null, violations: []};

const dock = (onPsu = () => {}) => new CockpitConsole({document: fakeDocument, onPsu});

test('standalone and fleet share the same PSU screen without inventing standalone permissions', () => {
  const console_ = dock();
  console_.update({controls: FLYING});
  assert.equal(console_.psuScreen.hidden, false, '단일 비행도 같은 화면을 유지한다');
  assert.equal(console_.root.getAttribute('data-psu'), 'false');
  assert.equal(console_.departButton.disabled,true);assert.equal(console_.psuState.textContent,'PSU 미연결');

  console_.update({controls: FLYING, psu: ADVICE});
  assert.equal(console_.psuScreen.hidden, false);
  assert.equal(console_.root.getAttribute('data-psu'), 'true');
  assert.equal(console_.psuFlight.textContent, 'F1');

  console_.update({controls: FLYING, psu: null});
  assert.equal(console_.psuScreen.hidden, false, '연결 해제해도 화면은 유지한다');
});

test('legacy reservation alone cannot grant movement or takeoff', () => {
 const c=dock();c.update({controls:FLYING,psu:{...ADVICE,departed:true,departure:{state:'granted'}}});
 assert.equal(c.departButton.disabled,true);
 assert.equal(c.psuState.textContent,'PSU 갱신 필요');
 assert.equal(c.psuTakeoff.textContent,'미정');
});

test('violations remain visible alongside current waiting reasons',()=>{
 const c=dock();c.update({controls:FLYING,psu:{...ADVICE,
  procedure:{stage:'대기',text:'대기',tone:'hold',reason:'패드 점유',next:{enabled:false}},
  violations:[{reason:'출발 허가 없이 이륙했습니다'}]}});
 assert.equal(c.psuScreen.getAttribute('data-alert'),'true');
 assert.match(c.psuNotice.textContent,/패드 점유/);
 assert.match(c.psuNotice.textContent,/위반 기록: 출발 허가 없이 이륙했습니다/);
 c.update({controls:FLYING,psu:ADVICE});assert.equal(c.psuScreen.getAttribute('data-alert'),'false');
});

test('refresh cannot manufacture permission and pending requests disable actions',()=>{
 const asked=[],c=dock(k=>asked.push(k));
 const psu={...ADVICE,airborne:true,procedure:{stage:'항로 비행',text:'접근 요청',tone:'info',next:{kind:'arrival',label:'접근 순번 요청',enabled:true}}};
 c.update({controls:FLYING,psu});c.departButton.click();c.arriveButton.click();c.holdButton.click();
 assert.deepEqual(asked,['arrival','refresh','hold']);
 c.update({controls:FLYING,psu:{...psu,pending:'arrival'}});
 assert.ok(c.departButton.disabled&&c.arriveButton.disabled&&c.holdButton.disabled);
});
