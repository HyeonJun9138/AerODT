import test from 'node:test';
import assert from 'node:assert/strict';
import {fakeDocument} from './fake_dom.mjs';
import {CockpitEntryScreen} from '../../../../user_application/web/domains/uam/cockpit/cockpit_entry_screen.js';
import {LiveGlobe} from '../../../../digital_twin/visualization/web/globe.js';

// Getting into a cockpit is a wait for an airframe to load, and what the
// operator used to be shown during it was their own map being flown across.
// Now a screen covers it and the camera is put at the aircraft in one frame
// behind that screen. Two things have to hold for this to be an improvement
// rather than a way to hide a bug: the screen must always come down, and the
// camera must still end up where it would have flown to, because that is the
// view handed back on leaving the cockpit.

const ASSIGNMENT = {aircraft_id: 'UAM0013', label: '6인승',
  flight: {origin: 'VP002', destination: 'VP011'}};

function screenOf() {
  const host = fakeDocument.createElement('div');
  const pending = new Map();
  let id = 0, now = 0;
  const view = {
    setTimeout: (fn, ms) => {pending.set(++id, {fn, at: now + ms}); return id;},
    clearTimeout: key => pending.delete(key),
  };
  const run = ms => {
    now += ms;
    for (const [key, entry] of [...pending]) if (entry.at <= now) {pending.delete(key); entry.fn();}
  };
  return {screen: new CockpitEntryScreen({document: fakeDocument, host, window: view}), run,
    waiting: () => pending.size};
}

test('the screen names the flight being taken and starts at the first phase', () => {
  const {screen} = screenOf();
  assert.equal(screen.visible, false, '무엇도 배정되기 전에는 떠 있지 않는다');
  screen.show(ASSIGNMENT);
  assert.equal(screen.visible, true);
  assert.equal(screen.callsign.textContent, 'UAM0013');
  assert.match(screen.route.textContent, /VP002 → VP011/);
  assert.match(screen.route.textContent, /6인승/, '어떤 기체를 기다리는지도 말한다');
  assert.equal(screen.root.getAttribute('aria-busy'), 'true');
  assert.equal(screen.fill.style.width, '0%');
});

test('the rule follows the phases and never goes backwards', () => {
  const {screen} = screenOf();
  screen.show(ASSIGNMENT);
  screen.advance('기체 모델 준비 중');
  const reached = screen.fill.style.width;
  assert.equal(reached, '75%');
  // Text the arrival made up on the spot is still shown -- it is what the code
  // wanted to say -- but it must not move a bar it knows nothing about.
  screen.advance('무언가 다른 안내');
  assert.equal(screen.step.textContent, '무언가 다른 안내');
  assert.equal(screen.fill.style.width, reached);
  // Nor may a phase that arrives late drag it back.
  screen.advance('배정 기체 수신 대기');
  assert.equal(screen.fill.style.width, reached);
});

test('it comes down once the seat is taken', () => {
  const {screen, run} = screenOf();
  screen.show(ASSIGNMENT);
  screen.hide();
  assert.equal(screen.root.getAttribute('data-phase'), 'leaving');
  assert.equal(screen.visible, true, '페이드가 도는 동안은 아직 떠 있다');
  run(300);
  assert.equal(screen.visible, false);
});

test('a failure says so and then clears itself, so nothing can leave the map covered', () => {
  const {screen, run, waiting} = screenOf();
  screen.show(ASSIGNMENT);
  screen.fail('배정 기체의 모델 준비 시간이 초과되었습니다.');
  assert.equal(screen.root.getAttribute('data-phase'), 'error');
  assert.match(screen.step.textContent, /시간이 초과/);
  assert.equal(screen.visible, true, '읽을 시간은 준다');
  run(2500);
  run(300);
  assert.equal(screen.visible, false, '그리고 스스로 사라진다');
  assert.equal(waiting(), 0, '타이머를 남기지 않는다');
});

test('a second flight reuses the one screen and starts it clean', () => {
  const {screen, run} = screenOf();
  screen.show(ASSIGNMENT);
  screen.advance('기체 모델 준비 중');
  screen.hide();run(300);
  const root = screen.root;
  screen.show({aircraft_id: 'UAM0044', flight: {origin: 'VP001', destination: 'VP005'}});
  assert.equal(screen.root, root, '창은 하나뿐이다');
  assert.equal(screen.fill.style.width, '0%');
  assert.equal(screen.step.textContent, '배정 기체 수신 대기');
  assert.equal(screen.root.getAttribute('data-phase'), 'preparing');
});

test('showing again cancels a fade that had not finished', () => {
  // Taking a second aircraft straight after the first would otherwise have the
  // old fade time out underneath it and hide the new screen.
  const {screen, run} = screenOf();
  screen.show(ASSIGNMENT);
  screen.hide();
  run(100);
  screen.show(ASSIGNMENT);
  run(500);
  assert.equal(screen.visible, true);
});

test('an approach can be landed in one frame at the framing it was flying to', () => {
  // The framing is still wanted -- it is where the operator stands when they
  // leave the cockpit -- so the approach is set up and finished rather than
  // skipped. Finishing means driving it past its own duration, not cutting it
  // short at wherever it had reached.
  const globe = Object.create(LiveGlobe.prototype);
  let steppedAt = null;
  globe.motion = {now: () => 1000};
  globe.approach = {startedAt: 1000, frameAt: 1000, duration: 3400, prepareUntil: 1250};
  globe.stepApproach = now => {steppedAt = now; globe.approach = null;};
  assert.equal(globe.finishApproach(), true);
  assert.ok(steppedAt > 1000 + 3400, `한 번에 끝까지 간다 (${steppedAt})`);
  assert.equal(globe.approach, null);
});

test('landing an approach that is not running is not an error', () => {
  const globe = Object.create(LiveGlobe.prototype);
  globe.motion = {now: () => 0};
  globe.approach = null;
  globe.stepApproach = () => assert.fail('진행 중인 접근이 없으면 건드리지 않는다');
  assert.equal(globe.finishApproach(), false);
});
