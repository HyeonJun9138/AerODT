// Telling the dock's controls apart.
//
// 비행 조작 was one flat row of identical buttons: the input device, the flight
// mode, a settings window and a pause, all looking the same. Nothing said which
// one carried the current selection and which one merely did something. Three
// kinds of control, so three shapes -- a picker shows its own value, an action
// does not, and a setting is marked as one.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fakeDocument} from './fake_dom.mjs';
import {CockpitConsole} from '../../../../user_application/web/domains/uam/cockpit/cockpit_console.js';

const CONTROLS = {enabled: true, active: true, source: 'keyboard', mode: 'multirotor', throttle: 0.32};
const rows = console_ => [...console_.controlsRoot.querySelectorAll('.cockpit-dock-group')]
  .find(g => g.querySelector('.cockpit-dock-label')?.textContent === '비행 조작');

test('a picker shows what is selected; an action and a setting do not pretend to', () => {
  const dock = new CockpitConsole({document: fakeDocument});
  dock.update({controls: CONTROLS});

  // The picker carries its own value, so the dock answers "what is selected"
  // without the operator opening anything.
  assert.equal(dock.source.className, 'cockpit-pick');
  assert.equal(dock.source.querySelector('.cockpit-pick-label').textContent, '입력');
  assert.equal(dock.sourceValue.textContent, '키보드');
  assert.equal(dock.mode.querySelector('.cockpit-pick-label').textContent, '모드');
  assert.equal(dock.modeValue.textContent, '멀티로터');
  assert.match(dock.source.getAttribute('aria-label'), /눌러서 변경/, 'and says it is the way to change it');

  dock.update({controls: {...CONTROLS, source: 'joystick', mode: 'fixed_wing'}});
  assert.equal(dock.sourceValue.textContent, '조이스틱');
  assert.equal(dock.modeValue.textContent, '고정익');
  // The label stays put while the value changes: it is a field, not a button
  // whose caption happens to differ.
  assert.equal(dock.source.querySelector('.cockpit-pick-label').textContent, '입력');

  // An action is an action, and a setting is marked as one.
  assert.equal(dock.pause.className, 'cockpit-dock-act');
  assert.equal(dock.tune.className, 'cockpit-dock-setting');
  assert.equal(dock.pause.textContent, '입력 정지');
});

test('input, flight mode and pause share one simulation row without MFD or throttle controls', () => {
 const dock=new CockpitConsole({document:fakeDocument});
 const row=dock.controlsRoot.querySelector('.cockpit-simulation-row');
 assert.deepEqual([...row.children],[dock.source,dock.mode,dock.pause]);
 assert.doesNotMatch(dock.controlsRoot.textContent,/스로틀|기수|하차|충전|도면|확대|시점/);
});

test('joystick setup remains reachable from every manual input source and pause state', () => {
  const dock = new CockpitConsole({document: fakeDocument});
  dock.update({controls: CONTROLS});
  assert.equal(dock.tune.hidden, false, '입력을 바꾸기 전에도 설정을 찾을 수 있다');
  dock.update({controls: {...CONTROLS, source: 'joystick'}});
  assert.equal(dock.tune.hidden, false);
  dock.update({controls: {...CONTROLS, source: 'screen'}});
  assert.equal(dock.tune.hidden, false);

  // Pause reads its own state rather than only its caption: held shows as
  // pressed, so a glance answers whether the aircraft is being flown.
  dock.update({controls: {...CONTROLS, active: true}});
  assert.equal(dock.pause.getAttribute('aria-pressed'), 'false');
  assert.equal(dock.pause.textContent, '입력 정지');
  dock.update({controls: {...CONTROLS, active: false}});
  assert.equal(dock.pause.getAttribute('aria-pressed'), 'true');
  assert.equal(dock.pause.textContent, '입력 재개');
  assert.equal(dock.tune.disabled,false);
  // Observation mode has nothing to pause.
  dock.update({controls: null});
  assert.equal(dock.pause.disabled, true);
  assert.equal(dock.tune.hidden,true);
  assert.equal(dock.pause.getAttribute('aria-pressed'), 'false');
});

test('pressing a picker asks for the next value, and only when it may', () => {
  const asked = [];
  const dock = new CockpitConsole({document: fakeDocument, onControl: (...v) => asked.push(v)});
  dock.update({controls: CONTROLS});
  dock.source.onclick({stopPropagation() {}});
  assert.deepEqual(asked.pop(), ['source', 'screen'], '키보드 → 화면');
  dock.update({controls: {...CONTROLS, source: 'screen'}});
  dock.source.onclick({stopPropagation() {}});
  assert.deepEqual(asked.pop(), ['source', 'joystick']);
  dock.update({controls: {...CONTROLS, source: 'joystick'}});
  dock.source.onclick({stopPropagation() {}});
  assert.deepEqual(asked.pop(), ['source', 'keyboard'], '그리고 처음으로 돌아온다');

  dock.mode.onclick({stopPropagation() {}});
  assert.deepEqual(asked.pop(), ['mode', 'fixed_wing']);

  // Nothing to fly, nothing to pick.
  dock.update({controls: {...CONTROLS, enabled: false}});
  assert.equal(dock.source.disabled, true);
  assert.equal(dock.mode.disabled, true);
});

test('the panels that cover the view can be closed from themselves', () => {
  // Reaching back down to the handle a panel was opened from is the one thing
  // nobody tries, so both the dock and the joystick window carry their own ×.
  const panel = readFileSync(new URL('../../../../user_application/web/domains/uam/cockpit/cockpit_panel.js', import.meta.url), 'utf8');
  assert.match(panel, /this\.dockClose=this\.button\('×','dock-close',\(\)=>this\.setDockExpanded\(false\)\)/);
  assert.match(panel, /aria-label','조작 패널 닫기'/);
  assert.match(panel, /class:'cockpit-dock-head'/, 'and it sits in a header of its own');

  const joystick = readFileSync(new URL('../../../../user_application/web/joystick_setup_panel.js', import.meta.url), 'utf8');
  assert.match(joystick, /button\('×',\(\)=>this\.close\(\),\{class:'joy-close','aria-label':'조이스틱 설정 닫기'/);

  const css = readFileSync(new URL('../../../../user_application/web/cockpit_avionics.css', import.meta.url), 'utf8');
  assert.match(css, /\.cockpit-pick-value\{[^}]*font-weight:600/, 'the selected value is the loud part');
  assert.match(css, /\.cockpit-pick-label\{[^}]*color:#8fa7b3/, 'and its field name is the quiet part');
  assert.match(css, /\.cockpit-toolbar \.cockpit-dock-setting:before/, 'a setting is marked as one');
});
