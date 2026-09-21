import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pilotGuidance, PSU_STEPS} from '../../../../user_application/web/domains/uam/operations/psu_pilot_guidance.js';

// Every stage told the pilot what to press *now* and nothing said what it was
// one of, so the order had to be carried in their head -- and the one button
// that is almost never right, 대기 요청, sat next to the one that always is.
// 왤케 직관적이지가 않지.

const TIMELINE = {now_s: 23970, off_block_s: 23400, ready_s: 23457, takeoff_s: 23457, landing_s: 24446};

function flying(next, over = {}) {
  return {flight_id: 'F1', departed: true, airborne: true, instruction: {},
    procedure: {origin: 'VP002', destination: 'VP001', reports: {report_airborne: 1},
      stage: '항로 비행', tone: 'info', text: '항로 유지', reason: '',
      timeline: TIMELINE, next, ...over}};
}

const ARRIVAL = {kind: 'arrival', label: '접근 순번 요청', enabled: true};

test('the whole procedure is offered in the order it is flown', () => {
  assert.deepEqual(PSU_STEPS.map(([kind]) => kind),
    ['departure', 'takeoff', 'report_airborne', 'arrival', 'approach', 'landing', 'report_landed', 'report_gate']);
});

test('the step being flown is lit, the ones behind it are done', () => {
  const view = pilotGuidance(flying(ARRIVAL));
  assert.deepEqual(view.steps.map(s => s.state),
    ['done', 'done', 'done', 'now', 'todo', 'todo', 'todo', 'todo']);
  assert.equal(view.steps[3].label, '순번');
  // And it moves with the request the service is waiting for.
  const later = pilotGuidance(flying({kind: 'report_landed', label: '착륙 완료 보고', enabled: true}));
  assert.deepEqual(later.steps.map(s => s.state),
    ['done', 'done', 'done', 'done', 'done', 'done', 'now', 'todo']);
});

test('a finished flight has the whole strip behind it', () => {
  const view = pilotGuidance(flying({kind: null, label: '운항 보고 완료', enabled: false},
    {reports: {report_airborne: 1, report_gate: 1}}));
  assert.ok(view.steps.every(s => s.state === 'done'));
});

test('the approach reservation is asked for by distance, before the pilot arrives', () => {
  // It books from a 120 s default estimate, so asking on arrival is asking to
  // be put at the back of the queue. Nothing said so until they were there.
  assert.equal(pilotGuidance(flying(ARRIVAL), {distanceM: 40000}).prompt, '', '멀면 조용하다');
  const near = pilotGuidance(flying(ARRIVAL), {distanceM: 12400});
  assert.match(near.prompt, /12\.4 km/);
  assert.match(near.prompt, /예약/);
  assert.equal(near.urgent, false);
  const late = pilotGuidance(flying(ARRIVAL), {distanceM: 4200});
  assert.match(late.prompt, /늦습니다/);
  assert.equal(late.urgent, true);
});

test('nothing is suggested once the number has been asked for', () => {
  // The step has moved on, so the prompt is about a request already made.
  const booked = pilotGuidance(flying({kind: 'landing', label: '최종 착륙 허가 요청', enabled: false}),
    {distanceM: 4200});
  assert.equal(booked.prompt, '');
  assert.equal(booked.urgent, false);
});

test('a distance nobody measured suggests nothing rather than guessing', () => {
  assert.equal(pilotGuidance(flying(ARRIVAL)).prompt, '');
  assert.equal(pilotGuidance(flying(ARRIVAL), {distanceM: NaN}).prompt, '');
});

test('the panel separates the one action from the two that are not', () => {
  const source = readFileSync(new URL('../../../../user_application/web/domains/uam/cockpit/cockpit_console.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../../../../user_application/web/cockpit_console.css', import.meta.url), 'utf8');
  // Not 대기 요청: a pilot read that as the thing you press on arrival, which
  // is the one thing it is not.
  assert.match(source, /button\('진행 문의'/);
  assert.equal(/'대기 요청'/.test(source), false, '두 곳 모두 바뀌었다 — 페인트가 라벨을 되돌리고 있었다');
  assert.match(source, /class:'cockpit-psu-aside'/);
  // Direct children only: as a descendant rule this also caught the quiet
  // row's first button, which then spanned both columns and stacked the two.
  assert.match(css, /\.cockpit-mfd-actions > button:first-child\{grid-column:1 \/ -1/);
  // The prompt takes the directive's line rather than stacking on it.
  assert.match(source, /psuDirective\.hidden=false/);
});
