// Flying by hand controller.
//
// A gamepad reports bare axis and button indices; nothing in them says which
// one is roll. The profile is that decision, so it is what these tests hold:
// shape the numbers, bind the functions, keep the binding, and let the head
// switch move the view without the aircraft feeling it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fakeDocument, FakeElement} from './fake_dom.mjs';
import {defaultProfile, normaliseProfile, loadProfile, saveProfile, forgetProfile,
  shapeCentred, shapeLever, readView, mapPad, movedAxis, pressedButton, settle, stabilityBand}
  from '../../../../user_application/web/joystick_profile.js';
import {ManualFlightInput} from '../../../../user_application/web/domains/uam/cockpit/manual_flight_input.js';
import {ManualFlightPanel} from '../../../../user_application/web/domains/uam/cockpit/manual_flight_panel.js';
import {JoystickSetupPanel} from '../../../../user_application/web/joystick_setup_panel.js';

// A gamepad as the browser hands one over: plain numbers, buttons that may be
// objects, and an index the page uses to tell two sticks apart.
const pad = ({axes = [0, 0, 0, -1], buttons = [], id = 'Test Stick', index = 0} = {}) => ({
  id, index, connected: true, axes,
  // Buttons are given as {index: 1} for the few that are down; the device
  // always reports the whole row, so the row is what is built here.
  buttons: Array.from({length: 16}, (_, i) => ({pressed: Boolean(buttons[i]), value: buttons[i] ? 1 : 0})),
});
const fakeStorage = () => {
  const map = new Map();
  return {getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k)};
};
const panelDocument = () => ({...fakeDocument, body: new FakeElement('body')});

test('a stick is shaped, a lever is trimmed: the deadzone does opposite jobs on each', () => {
  // Centre-springing axis: nothing at rest, full travel still reaches full.
  const stick = {deadzone: 0.1, expo: 0};
  assert.equal(shapeCentred(0.05, stick), 0, 'a stick that never quite centres commands nothing');
  assert.equal(shapeCentred(1, stick), 1, 'and still reaches the stop');
  assert.equal(shapeCentred(-1, stick), -1);
  assert.ok(Math.abs(shapeCentred(0.55, stick) - 0.5) < 1e-9, 'linear between the two');
  // Expo bends the middle without shortening the range -- the point of it.
  const soft = shapeCentred(0.55, {deadzone: 0.1, expo: 0.6});
  assert.ok(soft < 0.5 && soft > 0, 'small corrections become smaller');
  assert.equal(shapeCentred(1, {deadzone: 0.1, expo: 0.6}), 1, 'full deflection is untouched');
  assert.equal(shapeCentred(0.5, {...stick, invert: true}), -shapeCentred(0.5, stick));

  // A lever reports where it sits. The trim is at the ends, because a throttle
  // that stops short of its stop must still command idle and full.
  const lever = {deadzone: 0.05, expo: 0, invert: true};
  assert.equal(shapeLever(-1, lever), 1, 'pushed forward is full power once inverted');
  assert.equal(shapeLever(1, lever), 0, 'pulled back is idle');
  assert.equal(shapeLever(-0.94, lever), 1, 'short of the stop still reaches full');
  assert.equal(shapeLever(0.94, lever), 0);
  assert.ok(Math.abs(shapeLever(0, lever) - 0.5) < 1e-9, 'centre detent is half');
  assert.equal(shapeLever(2, lever), 0, 'nonsense from the device stays in range');
  assert.equal(shapeCentred(NaN, stick), 0);
});

test('the head switch reads the same whether the hardware calls it buttons or axes', () => {
  const profile = defaultProfile();
  // Standard mapping: d-pad at 12..15 as up, down, left, right.
  const dpad = n => pad({buttons: Object.fromEntries([[n, 1]])});
  assert.deepEqual(readView(dpad(15), profile.view), {x: 1, y: 0}, '오른쪽');
  assert.deepEqual(readView(dpad(14), profile.view), {x: -1, y: 0}, '왼쪽');
  assert.deepEqual(readView(dpad(12), profile.view), {x: 0, y: -1}, '위 = 위를 봄');
  assert.deepEqual(readView(dpad(13), profile.view), {x: 0, y: 1});

  // The same switch on another stick is a small analogue one.
  const analogue = {...profile.view, kind: 'axes', axes: [4, 5], deadzone: 0.2};
  const stick = pad({axes: [0, 0, 0, -1, 0.8, -0.6]});
  const read = readView(stick, analogue);
  assert.ok(read.x > 0.7 && read.y < -0.4, 'both directions carry through');
  assert.deepEqual(readView(pad({axes: [0, 0, 0, -1, 0.1, 0.1]}), analogue), {x: 0, y: 0}, 'and it rests quiet');
  assert.equal(readView(stick, {...analogue, invertY: true}).y, -read.y);
  assert.deepEqual(readView(stick, {kind: 'none'}), {x: 0, y: 0});
});

test('a mode button fires once when pressed, a precision button only while held', () => {
  const profile = normaliseProfile({buttons: {0: 'mode_fixed_wing', 5: 'precision'}}, 'Test Stick');
  const holding = pad({buttons: {0: 1, 5: 1}});
  const first = mapPad(holding, profile, null);
  assert.deepEqual(first.pressed, ['mode_fixed_wing'], 'the press is an event');
  assert.ok(first.held.has('precision'), 'the lean is a state');
  // Leaning on the mode button must not re-fire it every frame.
  const second = mapPad(holding, profile, first);
  assert.deepEqual(second.pressed, [], 'held down is not pressed again');
  assert.ok(second.held.has('precision'), 'but the held one is still held');
  // Released and pressed again is a new event.
  const released = mapPad(pad({buttons: {}}), profile, second);
  assert.deepEqual(released.pressed, []);
  assert.deepEqual(mapPad(holding, profile, released).pressed, ['mode_fixed_wing']);
});

test('the binding survives the browser closing, and is kept per device', () => {
  const storage = fakeStorage();
  const mine = defaultProfile('Airbus Sidestick');
  mine.axes.roll.axis = 4;
  mine.axes.roll.expo = 0.5;
  mine.buttons = {3: 'view_reset'};
  saveProfile(mine, storage);
  const back = loadProfile('Airbus Sidestick', storage);
  assert.equal(back.axes.roll.axis, 4);
  assert.equal(back.axes.roll.expo, 0.5);
  assert.equal(back.buttons[3], 'view_reset');
  // Another stick on the same machine keeps its own, and does not inherit.
  const other = loadProfile('Some Other Pad', storage);
  assert.equal(other.axes.roll.axis, defaultProfile().axes.roll.axis);
  saveProfile({...defaultProfile('Some Other Pad'), axes: {...defaultProfile().axes, roll: {axis: 7, invert: true, deadzone: 0.2, expo: 0}}}, storage);
  assert.equal(loadProfile('Airbus Sidestick', storage).axes.roll.axis, 4, 'the first is untouched');
  assert.equal(loadProfile('Some Other Pad', storage).axes.roll.axis, 7);
  forgetProfile('Some Other Pad', storage);
  assert.equal(loadProfile('Some Other Pad', storage).axes.roll.axis, defaultProfile().axes.roll.axis);

  // Whatever is in storage may predate any field added since, or be nonsense.
  const junk = normaliseProfile({axes: {roll: {axis: 999, deadzone: 5, expo: -3}}, view: {kind: 'wat', speed: 99}, buttons: {0: 'launch_missile', 2: 'view_reset'}}, 'x');
  assert.equal(junk.axes.roll.axis, defaultProfile().axes.roll.axis, 'an impossible index falls back');
  assert.ok(junk.axes.roll.deadzone <= 0.5 && junk.axes.roll.expo >= 0);
  assert.equal(junk.view.kind, 'buttons');
  assert.ok(junk.view.speed <= 4);
  assert.equal(junk.buttons[0], undefined, 'an action that does not exist is not bound');
  assert.equal(junk.buttons[2], 'view_reset');
  // A storage that throws (private window, blocked site data) is not a crash.
  const angry = {getItem() {throw new Error('nope');}, setItem() {throw new Error('nope');}};
  assert.equal(loadProfile('x', angry).axes.roll.axis, defaultProfile().axes.roll.axis);
  assert.doesNotThrow(() => saveProfile(defaultProfile('x'), angry));
});

test('the stick flies the aircraft: axes become a command, buttons change mode, the head switch does not', () => {
  const looks = [];
  const actions = [];
  let current = pad({axes: [0.6, -0.4, 0, -1], buttons: {}});
  const input = new ManualFlightInput({target: null, getGamepads: () => [current],
    onLook: (...v) => looks.push(v), onAction: (a, amount) => actions.push([a, amount])});
  input.setSource('joystick');
  input.start();

  const flying = input.update(0.05);
  assert.equal(flying.input_source, 'joystick');
  assert.ok(flying.roll > 0.4 && flying.pitch < -0.2, 'the stick is in the command');
  assert.equal(flying.throttle, 1, 'the lever pushed forward is full power');
  assert.equal(flying.flight_mode, 'multirotor');
  assert.deepEqual(looks, [], 'a centred head switch moves nothing');

  // Default binding: button 1 is 고정익, and it arrives in this tick's command.
  current = pad({axes: [0.6, -0.4, 0, -1], buttons: {1: 1}});
  assert.equal(input.update(0.05).flight_mode, 'fixed_wing');
  assert.equal(input.update(0.05).flight_mode, 'fixed_wing', 'held down does not toggle back');

  // Button 5 is 미세 조종: the same stick position commands a quarter of it.
  current = pad({axes: [0.6, -0.4, 0, -1], buttons: {5: 1}});
  const fine = input.update(0.05);
  assert.ok(Math.abs(fine.roll - flying.roll * 0.25) < 1e-9, 'precision scales, it does not centre');

  // The head switch looks around and stays out of the command entirely. What
  // goes out is where it is pushed and how fast the profile says to look --
  // not how far to turn, because the turning happens on the render loop. The
  // axes are steadied, so centring is a short settle rather than a step; what
  // matters is that it lands on exactly nothing and the switch added none.
  current = pad({axes: [0, 0, 0, -1], buttons: {15: 1}});
  let looking = input.update(0.05);
  assert.deepEqual(looks.at(-1), [1, 0, 1, 0], '오른쪽을 보는 것은 시야에만 간다');
  for (let i = 0; i < 30; i += 1) looking = input.update(0.05);
  assert.equal(looking.roll, 0);
  assert.equal(looking.pitch, 0);
  assert.equal(looking.yaw, 0);

  // 시야 초기화 is not a flight input either; it goes out as an action.
  current = pad({axes: [0, 0, 0, -1], buttons: {2: 1}});
  input.update(0.05);
  assert.ok(actions.some(([a]) => a === 'view_reset'));
});

test('a stick unplugged mid-flight stops commanding a turn but does not drop the throttle', () => {
  const actions = [];
  let pads = [pad({axes: [1, 0, 0, -1]})];
  const input = new ManualFlightInput({target: null, getGamepads: () => pads, onAction: a => actions.push(a)});
  input.setSource('joystick');
  input.start();
  const held = input.update(0.05);
  assert.equal(held.roll, 1);
  assert.equal(held.throttle, 1);

  pads = [];
  const orphaned = input.update(0.05);
  // A stick that vanished at full deflection would otherwise keep turning.
  assert.equal(orphaned.roll, 0, 'attitude goes neutral');
  assert.equal(orphaned.pitch, 0);
  assert.equal(orphaned.yaw, 0);
  assert.equal(orphaned.throttle, 1, 'power is retained, the way releasing the keys retains it');
  assert.ok(actions.includes('device_lost'));
  assert.equal(actions.filter(a => a === 'device_lost').length, 1, 'said once, not every frame');
  input.update(0.05);
  assert.equal(actions.filter(a => a === 'device_lost').length, 1);

  // A disconnected entry in the slot is not a device.
  pads = [{...pad(), connected: false}];
  assert.equal(input.update(0.05).roll, 0);
  pads = [pad({axes: [1, 0, 0, -1]})];
  assert.equal(input.update(0.05).roll, 1, 'plugged back in, it flies again');
  assert.ok(actions.includes('device_found'));
});

test('keyboard and screen are untouched by the stick being there', () => {
  const input = new ManualFlightInput({target: null, getGamepads: () => [pad({axes: [1, 1, 1, 1]})]});
  input.start();
  // Default source is still the keyboard, and the attached pad says nothing.
  assert.equal(input.update(0.05).roll, 0);
  assert.equal(input.update(0.05).input_source, 'keyboard');
  input.setSource('screen');
  input.setStick(0.5, 0);
  assert.ok(input.update(0.05).roll > 0);
  assert.equal(input.update(0.05).input_source, 'screen');
  assert.throws(() => input.setSource('mind-control'));
});

test('the aircraft is held while the bindings are set, and flies again when the window closes', () => {
  // Finding an axis means pushing the stick to its stop. Doing that to a flying
  // aircraft is exactly what the operator did not ask for -- the window holds
  // the session for as long as it is open, and hands it back on the way out.
  const document = panelDocument();
  const resumed = [];
  const paused = [];
  const panel = new ManualFlightPanel({document, target: null, getGamepads: () => [pad()],
    storage: fakeStorage(), onResume: () => resumed.push(1), onPause: () => paused.push(1)});
  assert.deepEqual([...panel.source.children].map(o => o.getAttribute('value')), ['keyboard', 'screen', 'joystick']);
  assert.equal(panel.joystick, undefined, 'the window is not built until a stick is asked for');
  panel.open();
  panel.input.start();
  assert.equal(panel.input.active, true);

  panel.source.value = 'joystick';
  panel.source.onchange();
  assert.equal(panel.input.source, 'joystick');
  assert.ok(panel.joystick, '설정 창이 열린다');
  assert.equal(panel.joystick.root.hidden, false);
  assert.equal(panel.input.active, false, '설정 중에는 기체가 움직이지 않는다');
  assert.equal(paused.length, 1, 'and the session is told');
  assert.equal(panel.tick(0.05), null, 'no command leaves while it is open');

  const before = resumed.length;
  panel.joystick.close();
  assert.equal(panel.joystick.root.hidden, true);
  assert.equal(resumed.length, before + 1, '닫으면 다시 조작으로 돌아온다');
  // Closing again is not a second handover.
  panel.joystick.close();
  assert.equal(resumed.length, before + 1);

  // Opened from the console while already held, nothing is resumed on close --
  // it was not this window that stopped it.
  panel.input.active = false;
  const quiet = resumed.length;
  panel.openJoystickSetup();
  panel.joystick.close();
  assert.equal(resumed.length, quiet, '멈춰 있던 세션을 임의로 재개하지 않는다');
  panel.destroy();
});

test('the setup window shows what the device is doing and binds what the operator moves', () => {
  const document = panelDocument();
  const storage = fakeStorage();
  let current = pad({id: 'Airbus Sidestick', axes: [0, 0, 0, -1]});
  const applied = [];
  const setup = new JoystickSetupPanel({document, window: null, storage,
    getGamepads: () => [current], onApply: p => applied.push(p)});
  setup.open();
  assert.equal(setup.device.children[0].getAttribute('value'), '0');
  assert.match(setup.deviceNote.textContent, /1개 연결됨/);

  // The bars follow the device, which is what makes the window worth opening.
  current = pad({id: 'Airbus Sidestick', axes: [0.8, 0, 0, -1], buttons: {1: 1}});
  // The bars show what the aircraft is being sent, steadying included, so they
  // settle over a few frames the way the command does.
  for (let i = 0; i < 30; i += 1) setup.paint();
  const roll = setup.axisRows.get('roll');
  assert.ok(Number(roll.out.textContent) > 0.6, 'the roll bar reads the roll axis');
  assert.equal(roll.row.getAttribute('data-live'), 'true');
  assert.equal(setup.buttonRows.get(1).lamp.getAttribute('data-on'), 'true', '누른 버튼이 켜진다');
  assert.equal(setup.buttonRows.get(0).lamp.getAttribute('data-on'), 'false');

  // 자동 감지: remember where everything rests, then take what moves.
  setup.startCapture({target: 'axis', name: 'yaw'});
  assert.equal(setup.hint.hidden, false);
  setup.paint();
  assert.equal(setup.profile.axes.yaw.axis, 2, 'nothing moved, nothing bound');
  current = pad({id: 'Airbus Sidestick', axes: [0.8, 0, 0, -1, 0, 0.9]});
  setup.paint();
  assert.equal(setup.profile.axes.yaw.axis, 5, '움직인 축이 요가 된다 · 감지는 원시 값을 본다');
  assert.equal(setup.hint.hidden, true);
  assert.equal(setup.capture, null);

  // Nonconsecutive directions must be observed individually, including release.
  current = pad({id:'Airbus Sidestick'});setup.startCapture({target:'view'});
  for(const index of [6,9,11,7]){
    current=pad({id:'Airbus Sidestick',buttons:{[index]:1}});setup.paint();
    current=pad({id:'Airbus Sidestick'});setup.paint();
  }
  assert.equal(setup.capture,null);
  assert.deepEqual(setup.profile.view.buttons,[6,9,11,7]);

  // Assigning a function is a select on the row that lit up.
  setup.buttonRows.get(4).select.value = 'view_reset';
  setup.buttonRows.get(4).select.onchange();
  assert.equal(setup.profile.buttons[4], 'view_reset');
  setup.buttonRows.get(4).select.value = 'none';
  setup.buttonRows.get(4).select.onchange();
  assert.equal(setup.profile.buttons[4], undefined);

  // Saving is what makes it last, and it goes out to whoever is flying.
  setup.buttonRows.get(4).select.value = 'view_reset';
  setup.buttonRows.get(4).select.onchange();
  setup.save();
  assert.equal(applied.length, 1);
  assert.equal(applied[0].axes.yaw.axis, 5);
  const reloaded = loadProfile('Airbus Sidestick', storage);
  assert.equal(reloaded.axes.yaw.axis, 5);
  assert.equal(reloaded.buttons[4], 'view_reset');
  assert.match(setup.status.textContent, /저장/);

  // 기본값 is a proposal, not a deletion: it needs saving like anything else.
  setup.reset();
  assert.equal(setup.profile.axes.yaw.axis, defaultProfile().axes.yaw.axis);
  assert.equal(loadProfile('Airbus Sidestick', storage).axes.yaw.axis, 5, '저장하기 전까지 남아 있다');
  setup.destroy();
});

test('with nothing plugged in the window explains itself instead of failing', () => {
  const document = panelDocument();
  const setup = new JoystickSetupPanel({document, window: null, storage: fakeStorage(), getGamepads: () => []});
  setup.open();
  assert.match(setup.deviceNote.textContent, /연결하고/);
  assert.equal(setup.device.children[0].getAttribute('value'), '');
  setup.startCapture({target: 'axis', name: 'roll'});
  assert.match(setup.status.textContent, /장치가 없습니다/);
  assert.equal(setup.capture, null, 'nothing to capture from');
  assert.doesNotThrow(() => setup.paint());
  assert.doesNotThrow(() => setup.save());
  setup.destroy();
});

test('a stick that turns up brings its own saved tuning, without the window being opened', () => {
  // The input is built before any device exists, so it starts on the unnamed
  // default. Plugging in a tuned stick has to pick that tuning up by itself --
  // otherwise it only arrived if the operator opened the window and re-saved.
  const storage = fakeStorage();
  const tuned = defaultProfile('Airbus Sidestick');
  tuned.axes.roll.axis = 4;
  tuned.buttons = {9: 'view_reset'};
  saveProfile(tuned, storage);

  let pads = [];
  const actions = [];
  const input = new ManualFlightInput({target: null, storage, getGamepads: () => pads, onAction: a => actions.push(a)});
  input.setSource('joystick');
  input.start();
  input.update(0.05);
  assert.notEqual(input.profile.axes.roll.axis, 4, 'nothing attached, nothing to know');

  pads = [pad({id: 'Airbus Sidestick', axes: [0, 0, 0, -1, 0.9, 0]})];
  const flying = input.update(0.05);
  assert.equal(input.profile.axes.roll.axis, 4, '꽂으면 저장해둔 설정으로 돌아온다');
  assert.ok(flying.roll > 0.7, 'and the axis it was tuned to is the one that flies it');
  assert.equal(input.profile.buttons[9], 'view_reset');

  // It settles: the profile is not reloaded, nor the arrival re-announced,
  // on every tick that follows.
  const found = actions.filter(a => a === 'device_found').length;
  input.update(0.05);
  input.update(0.05);
  assert.equal(actions.filter(a => a === 'device_found').length, found, '한 번만 알린다');

  // A different stick swapped in brings its own, not the first one's.
  pads = [pad({id: 'Some Other Pad', axes: [0.9, 0, 0, -1, 0, 0]})];
  input.update(0.05);
  assert.equal(input.profile.deviceId, 'Some Other Pad');
  assert.equal(input.profile.axes.roll.axis, defaultProfile().axes.roll.axis);
});

test('the window shows every axis and button the browser reports, bound or not', () => {
  // The four tuned rows can only show what they have been told about. A stick
  // whose axes sit somewhere else looked exactly like one that was not
  // reporting at all, which is the question this answers.
  const document = panelDocument();
  let current = pad({id: 'Airbus Sidestick', axes: [0.4, -0.9, 0, -1, 0, 0], buttons: {3: 1}});
  const setup = new JoystickSetupPanel({document, window: null, storage: fakeStorage(), getGamepads: () => [current]});
  setup.open();
  const bars = setup.rawAxes.querySelectorAll('.joy-raw-axis');
  assert.equal(bars.length, 6, 'one row per axis the device has');
  assert.equal(setup.rawButtons.querySelectorAll('.joy-raw-button').length, 16);
  assert.equal(setup.rawCells.axes[1].value.textContent, '-0.90', '값이 그대로 보인다');
  assert.equal(setup.rawCells.buttons[3].getAttribute('data-on'), 'true');
  assert.equal(setup.rawCells.buttons[4].getAttribute('data-on'), 'false');

  current = pad({id: 'Airbus Sidestick', axes: [0.4, 0.25, 0, -1, 0, 0], buttons: {}});
  setup.paint();
  assert.equal(setup.rawCells.axes[1].value.textContent, '0.25');
  assert.equal(setup.rawCells.buttons[3].getAttribute('data-on'), 'false');

  // Nothing reported is stated rather than drawn as an empty grid.
  const empty = new JoystickSetupPanel({document: panelDocument(), window: null, storage: fakeStorage(), getGamepads: () => []});
  empty.open();
  assert.match(empty.rawAxes.textContent, /보고되는 축과 버튼이 없습니다/);
  setup.destroy();
  empty.destroy();
});

test('at rest the filter is heavy, on a real push it gets out of the way', () => {
  // A plain low-pass has to choose: steady or responsive. This one reads how
  // fast the stick is actually moving and filters accordingly, which is the
  // only way to have both -- and the complaint was a yaw axis shaking while it
  // was being held somewhere, which the deadzone cannot reach at all.
  const off = stabilityBand(0);
  assert.deepEqual(off, {minCutoff: 0, beta: 0}, '끄면 아무것도 하지 않는다');
  const some = stabilityBand(0.25), lots = stabilityBand(1);
  assert.ok(lots.minCutoff < some.minCutoff, '올릴수록 더 걸러낸다');
  assert.ok(lots.beta > some.beta, '그리고 빠른 움직임은 더 통과시킨다');

  // Off is a straight wire: the value arrives whole, on the first sample.
  assert.equal(settle(null, 0.7, off).value, 0.7);
  assert.equal(settle({x: 0, dx: 0, value: 0}, 0.7, off).value, 0.7);

  const cfg = stabilityBand(0.55);
  // Held still, a dithering sensor barely moves the output.
  let state = {x: 0.5, dx: 0, value: 0.5};
  const still = [];
  for (const wobble of [0.52, 0.48, 0.51, 0.49, 0.52]) {
    state = settle(state, wobble, cfg, 0.05); still.push(state.value);
  }
  assert.ok(Math.max(...still.map(v => Math.abs(v - 0.5))) < 0.01, '떨림은 거의 통과하지 못한다');

  // Pushed properly, it arrives -- and it arrives at the stop, not near it.
  state = {x: 0, dx: 0, value: 0};
  let frames = 0;
  while (frames < 60 && state.value < 0.9) {state = settle(state, 1, cfg, 0.05); frames += 1;}
  assert.ok(frames * 0.05 <= 0.3, `끝까지 꺾으면 ${(frames * 0.05).toFixed(2)}초에 90%`);
  for (let i = 0; i < 40; i += 1) state = settle(state, 1, cfg, 0.05);
  assert.equal(state.value, 1, '스톱은 정확히 스톱이다');

  // Letting go is exactly nothing, at once. The deadzone has already decided
  // there is no input, and filtering that would leave the aircraft turning.
  assert.deepEqual(settle(state, 0, cfg, 0.05), {x: 0, dx: 0, value: 0});

  // How far it gets depends on how long it has been: a stretched frame must
  // not steady the stick by a different amount than a short one.
  const from = {x: 0, dx: 0, value: 0};
  assert.ok(settle(from, 1, cfg, 0.08).value > settle(from, 1, cfg, 0.02).value);
  // Rubbish from the device holds the last good value rather than lurching.
  assert.deepEqual(settle(from, NaN, cfg), from);
  assert.equal(settle(null, NaN, cfg).value, 0);
});

test('a shaky yaw axis is measurably steadier, and it still sits where the stick is', () => {
  // A stick held at half deflection with a noisy sensor, played through the
  // real mapping: once with steadying off, once with the yaw default.
  const noise = (() => {let seed = 7; return () => {seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5;};})();
  const run = stability => {
    const profile = normaliseProfile({axes: {yaw: {axis: 2, deadzone: 0.1, expo: 0, stability}}}, 'Test Stick');
    let reading = null;
    const out = [];
    for (let i = 0; i < 600; i += 1) {
      reading = mapPad(pad({axes: [0, 0, 0.5 + noise() * 0.06, -1]}), profile, reading, 0.05);
      if (i > 80) out.push(reading.axes.yaw);
    }
    // Frame-to-frame movement is what is felt as shaking; spread about the
    // mean is not -- a slow drift of the same size is not a tremble.
    const step = out.slice(1).map((v, i) => Math.abs(v - out[i]));
    return {mean: out.reduce((a, b) => a + b, 0) / out.length,
      avg: step.reduce((a, b) => a + b, 0) / step.length, worst: Math.max(...step)};
  };
  const raw = run(0), calm = run(0.55);
  assert.ok(calm.avg < raw.avg / 3, `프레임당 평균 움직임 ${raw.avg.toFixed(4)} → ${calm.avg.toFixed(4)}`);
  assert.ok(calm.worst < raw.worst / 2, `한 프레임 최대 ${raw.worst.toFixed(3)} → ${calm.worst.toFixed(3)}`);
  // Steadier, not offset: it sits in exactly the same place, which is the
  // difference between filtering and trimming.
  assert.ok(Math.abs(calm.mean - raw.mean) < 0.005, '같은 자리에 머문다');

  // Yaw starts with more help than the gimbal axes: it is usually a twist or
  // a rocker with a shorter throw, so the same dither is a bigger fraction.
  const defaults = defaultProfile();
  assert.ok(defaults.axes.yaw.stability > defaults.axes.roll.stability);
  assert.equal(normaliseProfile({axes: {yaw: {stability: 5}}}, 'x').axes.yaw.stability, 1, '범위를 벗어난 값은 잘린다');
  assert.equal(normaliseProfile({axes: {yaw: {}}}, 'x').axes.yaw.stability, defaults.axes.yaw.stability);
});

test('which index moved, and which button is down', () => {
  const rest = [0, 0, 0, -1];
  assert.equal(movedAxis(pad({axes: [0, 0, 0, -1]}), rest), null);
  assert.equal(movedAxis(pad({axes: [0, 0.9, 0, -1]}), rest), 1);
  // The furthest one wins, so brushing a neighbour does not steal the binding.
  assert.equal(movedAxis(pad({axes: [0.5, 0.95, 0, -1]}), rest), 1);
  assert.equal(movedAxis(pad({axes: [0, 0.2, 0, -1]}), rest), null, 'a nudge is not an answer');
  assert.equal(pressedButton(pad({buttons: {}})), null);
  assert.equal(pressedButton(pad({buttons: {7: 1}})), 7);
});

test('POV single-axis calibration survives storage and reads all eight directions without neutral drift',()=>{
  let current=pad({axes:[0,0,0,-1,3.285714]});
  const setup=new JoystickSetupPanel({document:panelDocument(),window:null,storage:fakeStorage(),getGamepads:()=>[current]});
  setup.open();setup.startCapture({target:'view'});
  for(const value of [-1,1/7,5/7,-3/7]){
    current=pad({axes:[0,0,0,-1,value]});setup.paint();
    current=pad({axes:[0,0,0,-1,3.285714]});setup.paint();
  }
  assert.equal(setup.capture,null);assert.equal(setup.profile.view.kind,'hat');
  const storage=fakeStorage();saveProfile(setup.profile,storage);const view=loadProfile('Test Stick',storage).view;
  assert.deepEqual(readView(current,view),{x:0,y:0});
  assert.deepEqual(readView(pad(),view),{x:0,y:0});
  for(const [value,x,y] of [[-1,0,-1],[-3/7,1,0],[1/7,0,1],[5/7,-1,0]]){
    const result=readView(pad({axes:[0,0,0,-1,value]}),view);
    assert.ok(Math.abs(result.x-x)<1e-6&&Math.abs(result.y-y)<1e-6);
  }
  const diagonal=readView(pad({axes:[0,0,0,-1,-5/7]}),view);assert.ok(diagonal.x>.7&&diagonal.y<-.7);
  setup.destroy();
});

test('view actions remain usable while paused without sending flight input or changing throttle',()=>{
  let current=pad({axes:[1,1,1,-1],buttons:{15:1,1:1}}),looks=[],actions=[];
  const input=new ManualFlightInput({target:null,getGamepads:()=>[current],onLook:(...v)=>looks.push(v),onAction:a=>actions.push(a)});
  input.setSource('joystick');input.throttle=.2;
  assert.equal(input.update(.05),null);assert.deepEqual(looks.at(-1),[1,0,1,0]);assert.equal(input.throttle,.2);
  assert.equal(input.mode,'multirotor');
  current=pad({buttons:{2:1}});input.update(.05);assert.ok(actions.includes('view_reset'));input.destroy();
});

test('the head switch sends where it is pushed, not how far to turn, and lets go of it exactly once', () => {
  // The stick is polled on the flight command's tick -- once every three drawn
  // frames. A step measured there and applied there is what made the view move
  // in jumps. What leaves here is an intent the renderer can hold between
  // polls: direction, the tuned speed beside it, and the zoom in the same
  // breath because it is the same switch.
  const looks = [];
  let current = pad({buttons: {15: 1}});
  const input = new ManualFlightInput({target: null, getGamepads: () => [current], onLook: (...v) => looks.push(v)});
  input.setSource('joystick');
  input.start();

  input.update(0.05);
  assert.deepEqual(looks.at(-1), [1, 0, 1, 0], '오른쪽 · 배속 1 · 줌 없음');
  assert.equal(looks.length, 1);

  // Held, it is repeated: the renderer may have been rebuilt underneath, and
  // the cost of saying it again is a function call.
  input.update(0.05);
  assert.equal(looks.length, 2);
  assert.deepEqual(looks.at(-1), [1, 0, 1, 0], 'one poll later, the same intent -- not twice the angle');

  // The tuned speed travels beside the direction rather than inside it, so the
  // renderer keeps a direction it can clamp and a speed it can scale.
  input.setProfile({...input.profile, view: {...input.profile.view, speed: 2.5}});
  input.update(0.05);
  assert.deepEqual(looks.at(-1), [1, 0, 2.5, 0]);

  // Let go: said once, then silence. Repeating a release every poll would be
  // noise, and never saying it would leave the view turning.
  current = pad({});
  input.update(0.05);
  assert.deepEqual(looks.at(-1), [0, 0, 2.5, 0]);
  const quiet = looks.length;
  input.update(0.05);
  input.update(0.05);
  assert.equal(looks.length, quiet, '중립은 한 번만 말한다');
  input.destroy();
});

test('nothing keeps turning the view after the stick, the source or the session goes away', () => {
  // Each of these is a way the switch stops being pressed without the operator
  // letting go of it, and each one left the camera turning with nothing left to
  // stop it -- the intent is held by the far end, so it has to be withdrawn.
  for (const [name, leave] of [
    ['기기 분리', (input, pads) => {pads.length = 0; input.update(0.05);}],
    ['입력 방식 변경', input => input.setSource('keyboard')],
    ['세션 종료', input => input.suspend()],
  ]) {
    const looks = [], pads = [pad({buttons: {15: 1}})];
    const input = new ManualFlightInput({target: null, getGamepads: () => pads, onLook: (...v) => looks.push(v)});
    input.setSource('joystick');
    input.start();
    input.update(0.05);
    assert.deepEqual(looks.at(-1).slice(0, 2), [1, 0], name);
    leave(input, pads);
    assert.deepEqual(looks.at(-1).slice(0, 2), [0, 0], `${name} 뒤에는 시야가 멈춘다`);
    input.destroy();
  }
});

test('시야 확대·축소 rides in the same intent as the looking', () => {
  const looks = [], actions = [];
  const input = new ManualFlightInput({target: null, getGamepads: () => [pad({buttons: {4: 1}})],
    onLook: (...v) => looks.push(v), onAction: (a, amount) => actions.push([a, amount])});
  input.setSource('joystick');
  input.setProfile(normaliseProfile({...input.profile, deviceId: 'Test Stick', buttons: {4: 'view_zoom_in'}}, 'Test Stick'));
  input.start();
  input.update(0.05);
  assert.deepEqual(looks.at(-1), [0, 0, 1, -1], '확대는 -1');
  assert.ok(!actions.some(([a]) => a === 'view_zoom'),
    '초당 스무 번 계단으로 밀어 넣던 동작은 더 이상 없다');
  input.destroy();
});

test('an empty device list says which silence it is: no input yet, no API, or the address',()=>{
  // Three ways to see no devices, and they look identical on screen. The last
  // one matters because the dashboard is meant to be opened from another PC:
  // a page served over plain http is not a secure context, and a browser that
  // gates the Gamepad API there shows exactly what an unplugged machine shows.
  const open=view=>{
    const setup=new JoystickSetupPanel({document:panelDocument(),window:view,
      storage:fakeStorage(),getGamepads:()=>[]});
    setup.open();
    return setup;
  };
  const secure={navigator:{getGamepads:()=>[]},isSecureContext:true,location:{origin:'http://127.0.0.1:8766'}};
  const plain={navigator:{getGamepads:()=>[]},isSecureContext:false,location:{origin:'http://103.218.162.73:8766'}};
  const ancient={navigator:{},isSecureContext:true,location:{origin:'http://127.0.0.1:8766'}};

  const usual=open(secure);
  assert.match(usual.deviceNote.textContent,/버튼을 한 번 누르면/,'평소에는 눌러 보라고만 한다');
  assert.doesNotMatch(usual.deviceNote.textContent,/http/,'멀쩡한 주소를 의심하게 만들지 않는다');

  const remote=open(plain);
  assert.match(remote.deviceNote.textContent,/버튼을 한 번 누르면/,'흔한 이유가 먼저다');
  assert.match(remote.deviceNote.textContent,/103\.218\.162\.73:8766/,'그 다음에 실제 주소를 짚는다');
  assert.match(remote.deviceNote.textContent,/127\.0\.0\.1|https/,'그리고 무엇을 하면 되는지 말한다');

  const old=open(ancient);
  assert.match(old.deviceNote.textContent,/Gamepad API/,'아예 없는 경우는 다른 이야기다');
  assert.doesNotMatch(old.deviceNote.textContent,/버튼을 한 번 누르면/,'누를 곳이 없는데 누르라고 하지 않는다');

  // A device present is a device present: none of this appears.
  const found=new JoystickSetupPanel({document:panelDocument(),window:plain,storage:fakeStorage(),
    getGamepads:()=>[pad({id:'Test Stick'})]});
  found.open();
  assert.match(found.deviceNote.textContent,/1개 연결됨/);
  assert.doesNotMatch(found.deviceNote.textContent,/보안 연결/);
  for(const panel of [usual,remote,old,found])panel.destroy();
});
