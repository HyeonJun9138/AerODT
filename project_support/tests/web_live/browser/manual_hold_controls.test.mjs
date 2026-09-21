import test from 'node:test';
import assert from 'node:assert/strict';
import {ManualFlightSession} from '../../../../user_application/web/domains/uam/cockpit/manual_flight_session.js';
import {ManualFlightPanel} from '../../../../user_application/web/domains/uam/cockpit/manual_flight_panel.js';
import {BUTTON_ACTIONS} from '../../../../user_application/web/joystick_profile.js';

// 고도 유지 · 위치 유지 go on a stick button, so the whole point is that one
// press answers. What is tested here is the path from that press to the wire
// and back -- the loops themselves are flown against the real aircraft in
// test_manual_hold.py.

test('the holds are offered as stick button functions', () => {
  const ids = BUTTON_ACTIONS.map(([id]) => id);
  for (const id of ['hold_altitude', 'hold_position', 'hold_off']) assert.ok(ids.includes(id), id);
});

function sessionOf(engaged = null) {
  const sent = [];
  const session = Object.create(ManualFlightSession.prototype);
  Object.assign(session, {
    socket: {readyState: 1, send: text => sent.push(JSON.parse(text))},
    display: {latest: engaged ? {hold: {mode: engaged}} : {}, push() {}},
    groundSequence: 0, notify() {}, onSound() {},
  });
  return {session, sent};
}

test('pressing a hold asks for it, and pressing the one already on takes it off', () => {
  const off = sessionOf();
  off.session.setHold('altitude');
  assert.deepEqual(off.sent.map(m => [m.type, m.mode]), [['hold', 'altitude']]);
  // A stick button is one button. Pressing it again is the only way a pilot has
  // to let go, so the same press has to mean off once it is on.
  const on = sessionOf('altitude');
  on.session.setHold('altitude');
  assert.equal(on.sent.at(-1).mode, 'off');
  // A different hold from the one that is on is a swap, not a release.
  const swap = sessionOf('altitude');
  swap.session.setHold('position');
  assert.equal(swap.sent.at(-1).mode, 'position');
});

test('a hold that has not been answered is not asked for again', () => {
  const {session, sent} = sessionOf();
  session.setHold('position');
  session.setHold('position');
  assert.equal(sent.length, 1, '앞선 요청의 답을 기다린다');
  session.handleHoldAck({request_id: sent[0].request_id, accepted: true, message: '위치 유지'});
  assert.equal(session.holdPending, null);
  session.setHold('position');
  assert.equal(sent.length, 2);
  clearTimeout(session.holdTimer);
});

test('an answer to a request that is no longer the pending one is ignored', () => {
  const {session, sent} = sessionOf();
  session.setHold('altitude');
  const pending = session.holdPending;
  session.handleHoldAck({request_id: 'hold-old', accepted: false, message: '지난 요청'});
  assert.equal(session.holdPending, pending, '지난 답은 대기 상태를 풀지 않는다');
  session.handleHoldAck({request_id: sent[0].request_id, accepted: true, message: '고도 유지'});
  assert.equal(session.holdPending, null);
});

test('a stick button reaches the hold rather than the rest of the page', () => {
  // `pause` is handled in the panel and the view actions go out to the map; the
  // holds are about this aircraft alone, so they are answered here too.
  const panel = Object.create(ManualFlightPanel.prototype);
  const asked = [], elsewhere = [];
  panel.input = {active: true, suspend() {}};
  const handle = action => panel.handleAction(action, undefined,
    (name, amount) => elsewhere.push([name, amount]), () => {}, mode => asked.push(mode));
  handle('hold_altitude');
  handle('hold_position');
  handle('hold_off');
  assert.deepEqual(asked, ['altitude', 'position', 'off']);
  assert.deepEqual(elsewhere, [], '지도로는 나가지 않는다');
  handle('view_reset');
  assert.deepEqual(elsewhere, [['view_reset', undefined]]);
});

test('nothing is sent when there is no socket to send it on', () => {
  const session = Object.create(ManualFlightSession.prototype);
  Object.assign(session, {socket: null, display: {latest: {}}, groundSequence: 0, notify() {}});
  session.setHold('altitude');
  assert.equal(session.holdPending, undefined);
});
