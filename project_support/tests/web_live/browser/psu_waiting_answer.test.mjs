import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pilotGuidance} from '../../../../user_application/web/domains/uam/operations/psu_pilot_guidance.js';

// The same fault twice: the service works out when the aircraft may go, and the
// cockpit hides it. Before departure the countdown to the review was shown only
// in the '준비' stage -- and pressing 출발 요청 moves the stage to '출발 배정 대기',
// so it vanished at the exact moment the pilot asked. The issued approach time
// lives in that same line once airborne and so could never appear at all.

const TIMELINE = {now_s: 23477, off_block_s: 23400, ready_s: 23601};

function waiting(over = {}) {
  return {
    departed: false,
    // As the live advisory sends it: the reason, the departure review time it
    // is being held to, and the arrival entry it is metered towards.
    instruction: {action: 'departure_wait', reason: '도착 VP001 / F2 진입 순서 대기 (주기장 유지)',
      ready_s: 23601.22, entry_s: 24172.82},
    procedure: {stage: '출발 배정 대기', tone: 'hold', text: '출발 요청 접수 · PSU 자동 재검토 중',
      reason: '계획 출발·회항 준비·도착 진입 순서 시각 대기', timeline: TIMELINE,
      next: {kind: 'departure', label: '요청 접수됨', enabled: false}},
    ...over,
  };
}

test('a pilot who has asked is still told how long', () => {
  const view = pilotGuidance(waiting());
  assert.match(view.due, /2분 4초/, '출발 검토까지 남은 시간을 말한다');
  assert.ok(view.due, '요청을 접수한 단계에서도 비어 있지 않다');
});

test('the line that carries it is shown whenever it has something to say', () => {
  // Read from the console itself: the rule is one expression and the whole
  // fault was that expression, so a reconstruction here would test nothing.
  const source = readFileSync(new URL('../../../../user_application/web/domains/uam/cockpit/cockpit_console.js', import.meta.url), 'utf8');
  assert.match(source, /this\.psuClockRow\.hidden=!view\.due;/);
  assert.equal(/psuClockRow\.hidden=.*stage!=='준비'/.test(source), false,
    '단계로 숨기지 않는다 — 조종사가 묻는 바로 그 단계가 그 단계였다');
});

test('the reason given is about this aircraft, not about the stage', () => {
  const view = pilotGuidance(waiting());
  assert.match(view.reason, /VP001 \/ F2/, '어느 데크 뒤에서 기다리는지 말한다');
  // The generic sentence is still the fallback when there is nothing better.
  const bare = pilotGuidance(waiting({instruction: {}}));
  assert.match(bare.reason, /도착 진입 순서 시각 대기/);
});

test('once airborne the same line carries the approach time that was issued', () => {
  const view = pilotGuidance({
    departed: true, airborne: true,
    arrival: {eat_s: 23700, cleared_s: 23850, sequence: 4, eat_revision: 0, released_s: null},
    // The landing row is fed from the timeline, which the server fills from
    // this same clearance once it has one.
    procedure: {stage: '순항', tone: 'normal', text: '', reason: '',
      timeline: {...TIMELINE, landing_s: 23850},
      next: {kind: null, label: '', enabled: false}},
  });
  assert.match(view.due, /접근 검토 예상/);
  assert.match(view.due, /3분 43초 뒤/);
  assert.match(view.due, /순번 4/);
  // The landing slot has a row of its own. Saying it twice is what made this
  // line long enough to wrap in a panel this narrow.
  assert.equal(/착륙 슬롯/.test(view.due), false);
  assert.equal(view.landing, '06:37:30', '그 줄은 제 자리에 있다');
  assert.equal(view.approachAt, 23700);
});

test('an arrival already released says nothing about an approach time', () => {
  const view = pilotGuidance({
    departed: true, airborne: true,
    arrival: {eat_s: 23700, cleared_s: 23850, sequence: 4, released_s: 23860},
    procedure: {stage: '착륙', tone: 'normal', text: '', reason: '', timeline: TIMELINE,
      next: {kind: null, label: '', enabled: false}},
  });
  assert.equal(view.due, '');
  assert.equal(view.approachAt, null);
});

test('the two slot rows carry a forecast instead of 미정, and say that is what it is', () => {
  // Neither slot is issued until its clearance is, so both read 미정 for the
  // whole of the wait -- while the service is holding the aircraft to a
  // departure review time and metering it towards an arrival entry, both of
  // which are on the wire. The label changes with the value, because these rows
  // say 허가 별도 precisely because they are slots, and a prediction is not one.
  const view = pilotGuidance(waiting());
  assert.equal(view.takeoff, '06:33:21 예상');
  assert.match(view.takeoffLabel, /허가 아님/);
  assert.equal(view.landing, '06:42:52 예상');
  assert.match(view.landingLabel, /예약 아님/);
  // Both forecast labels are the same length as the slot labels they replace,
  // so a row that fitted on one line before still does.
  assert.equal(view.takeoffLabel.length, '이륙 슬롯 · 허가 별도'.length);
  assert.equal(view.landingLabel.length, '착륙 슬롯 · 허가 별도'.length);
});

test('an issued slot is shown as the slot it is, under the original label', () => {
  const view = pilotGuidance(waiting({
    procedure: {...waiting().procedure,
      timeline: {...TIMELINE, takeoff_s: 23700, landing_s: 24300}},
  }));
  assert.equal(view.takeoff, '06:35:00');
  assert.equal(view.takeoffLabel, '이륙 슬롯 · 허가 별도');
  assert.equal(view.landing, '06:45:00');
  assert.equal(view.landingLabel, '예상 접지 · 허가/대기시간 아님');
});

test('with neither a slot nor a forecast it still says 미정 rather than inventing one', () => {
  const view = pilotGuidance(waiting({instruction: {}, procedure: {
    ...waiting().procedure, timeline: {now_s: 23477, off_block_s: 23400}}}));
  assert.equal(view.takeoff, '미정');
  assert.equal(view.landing, '미정');
  assert.equal(view.landingLabel, '예상 접지 · 허가/대기시간 아님');
});

test('after departure the takeoff row stops offering the departure review time', () => {
  // `ready_s` is when the aircraft may be released from the gate. Once it has
  // gone it is not a forecast of anything.
  const view = pilotGuidance(waiting({departed: true}));
  assert.equal(view.takeoff, '미정');
});
