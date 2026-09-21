import test from 'node:test';
import assert from 'node:assert/strict';
import {fakeDocument} from './fake_dom.mjs';
import {ManualFlightPanel} from '../../../../user_application/web/domains/uam/cockpit/manual_flight_panel.js';

// Opening the joystick window holds the aircraft on purpose: finding an axis
// means pushing the stick to its stop, and doing that to a flying aircraft is
// what the operator is not asking for. The hold is released by the window's own
// close -- so a window that never opened left the aircraft held, its controls
// greyed out, and nothing to press.

const panelOf = () => new ManualFlightPanel({document: fakeDocument, target: null,
  onPause: () => {}, onResume: () => {}, onExit: () => {}, onLook: () => {}, onAction: () => {}});

test('a joystick window that will not open does not leave the aircraft held', () => {
  const panel = panelOf();
  panel.input.active = true;
  // Stand in for the window, and make opening fail the way a broken one would.
  panel.joystick = {open() {throw new Error('no window');}, profile: {}};
  let released = 0;
  panel.onResume = () => {released += 1;};
  assert.throws(() => panel.openJoystickSetup(), /no window/);
  assert.equal(panel.tuningHeld, false, '잡고 있던 것을 놓는다');
  assert.equal(released, 1, '입력이 다시 열린다');
});

test('a window that opens keeps the hold until it is closed', () => {
  const panel = panelOf();
  panel.input.active = true;
  let closed = null;
  panel.joystick = {open() {this.opened = true;}, profile: {axes: {}}};
  panel.onResume = () => {closed = true;};
  panel.openJoystickSetup();
  assert.equal(panel.joystick.opened, true);
  assert.equal(panel.tuningHeld, true, '창이 떠 있는 동안은 계속 잡고 있다');
  assert.equal(closed, null);
  // Closing the window is what gives the aircraft back.
  panel.releaseTuning();
  assert.equal(panel.tuningHeld, false);
  assert.equal(closed, true);
});

test('nothing is held when the aircraft was not under the stick to begin with', () => {
  const panel = panelOf();
  panel.input.active = false;
  panel.joystick = {open() {throw new Error('no window');}, profile: {}};
  let released = 0;
  panel.onResume = () => {released += 1;};
  assert.throws(() => panel.openJoystickSetup(), /no window/);
  assert.equal(released, 0, '잡은 적이 없으면 놓을 것도 없다');
});
