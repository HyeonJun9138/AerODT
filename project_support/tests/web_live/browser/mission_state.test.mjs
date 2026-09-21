// What a selected UAM is doing, as the panel says it.
//
// A replayed day's aircraft carries a mission the twin's entity knows nothing
// about: which phase, which flight, and whether the service has answered. These
// hold the wording, the order of the rows, and the two things that must never
// happen -- a mission left on screen after the aircraft is deselected, and a
// simulated state read as an observed one.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {FakeElement, fakeDocument} from './fake_dom.mjs';

const web = new URL('../../../../user_application/web/', import.meta.url);
const details = await import(new URL('entity_details.js', web).href);
const selection = readFileSync(new URL('selection_panel.js', web), 'utf8');
const panelSource = selection.replace("'./entity_details.js'", JSON.stringify(new URL('entity_details.js', web).href))
  .replace("'/visualization/model_preview.js'", JSON.stringify(new URL('../../digital_twin/visualization/web/model_preview.js', web).href))
  .replace("'/visualization/entity_labels.js'", JSON.stringify(new URL('../../digital_twin/visualization/web/entity_labels.js', web).href));
const {SelectionPanel} = await import(`data:text/javascript;base64,${Buffer.from(panelSource).toString('base64')}`);
const html = readFileSync(new URL('index.html', web), 'utf8');
const app = readFileSync(new URL('app.js', web), 'utf8');

const flying = {
  state: {aircraft_id: 'UAM0007', flight_id: 'FPL000031', phase: 'cruise', airborne: true,
    speed_mps: 66.88, seats: 4, passengers: 3, origin: 'VP001', destination: 'VP013',
    holding: false, direct: false, hold_seconds: 0, sequence: null},
  flight: {origin_name: '여의도', destination_name: '강남'},
  clearance: null, remaining: 12,
};
const value = (view, key) => view.fields.find(field => field.key === key)?.value;

test('a flying UAM reads out its stage, its flight and how fast it is going', () => {
  const view = details.describeMission(flying);
  assert.equal(view.stage, '순항');
  assert.equal(value(view, 'stage'), '순항');
  assert.equal(value(view, 'phase'), '순항');
  assert.equal(value(view, 'flight'), 'FPL000031');
  assert.equal(value(view, 'route'), '여의도 → 강남');
  assert.equal(value(view, 'seats'), '4석 · 3명');
  assert.match(value(view, 'speed'), /66\.9 m\/s \(130 kt\)/, 'the same number in the pilot\'s unit');
  assert.equal(value(view, 'remaining'), '12편');
  assert.equal(value(view, 'sequence'), undefined, 'no landing number until the service gives one');
  assert.match(view.note, /시뮬레이션/, 'never presented as an observation');
});

test('every phase of a scheduled flight is named, and one nobody named is shown as it came', () => {
  const engine = ['parked', 'gate_out', 'takeoff', 'climb', 'cruise', 'descent',
    'hold_exit', 'hold', 'hold_return', 'landing', 'gate_in', 'charge'];
  for (const phase of engine) {
    assert.ok(details.MISSION_PHASE[phase], phase);
    assert.ok(details.MISSION_STAGE[phase], phase);
  }
  assert.equal(details.missionPhase('taxi_hold'), 'taxi_hold');
  assert.equal(details.missionPhase(null), '정보 없음');
  assert.equal(details.missionStage('landing'), '착륙');
  assert.equal(details.missionStage('hold'), '체공');
});

test('a holding aircraft says why it is waiting, its landing number and how long', () => {
  const view = details.describeMission({...flying,
    state: {...flying.state, phase: 'hold', holding: true, hold_seconds: 143.4, sequence: 4},
    clearance: {sequence: 4, reason: 'FATO 혼잡'}});
  assert.equal(view.holding, true);
  assert.equal(value(view, 'sequence'), '4번');
  assert.equal(value(view, 'clearance'), 'FATO 혼잡');
  assert.equal(value(view, 'hold'), '143 s');
  assert.doesNotMatch(view.note, /항로 밖에서 대기 중/, 'a final-approach hold may be at the current position');
  // The engine keeps the number on the aircraft even when the service record has
  // been cleared; the pilot still sees it.
  const kept = details.describeMission({...flying,
    state: {...flying.state, phase: 'descent', sequence: 2}, clearance: null});
  assert.equal(value(kept, 'sequence'), '2번');
  assert.equal(value(kept, 'clearance'), undefined);
});

test('a parked aircraft says where it stands, and a direct corridor is marked', () => {
  const view = details.describeMission({state: {aircraft_id: 'UAM0001', flight_id: null,
    phase: 'parked', airborne: false, speed_mps: 0, seats: 4, passengers: 0,
    vertiport: 'VP001', stand: 'G1'}, remaining: 20});
  assert.equal(view.stage, '대기 중');
  assert.equal(value(view, 'stand'), 'VP001 G1');
  assert.equal(value(view, 'flight'), undefined, 'no flight, no flight number');
  assert.equal(value(view, 'speed'), undefined, 'a standing aircraft is not reporting a speed');
  const direct = details.describeMission({...flying, state: {...flying.state, direct: true}});
  assert.match(value(direct, 'direct'), /직항 회랑/);
  assert.equal(details.describeMission(null), null);
  assert.equal(details.describeMission({state: null}), null);
});

// ---- the panel ------------------------------------------------------------
function box() {
  const nodes = Object.fromEntries(['mission', 'mission-title', 'mission-detail', 'mission-note',
    'mission-progress', 'mission-planned']
    .map(id => [id, new FakeElement(id === 'mission-detail' ? 'dl' : 'div')]));
  nodes.mission.hidden = true;
  // setMission paints the bar through another method of its own, so `this` has
  // to be a panel rather than a bag of the two fields it reads.
  const panel = Object.assign(Object.create(SelectionPanel.prototype),
    {entityId: 'scenario:UAM0007', $: id => nodes[id]});
  const saved = globalThis.document;
  globalThis.document = fakeDocument;
  return {panel, nodes, restore: () => {globalThis.document = saved;}};
}
const rows = nodes => nodes['mission-detail'].children.map(group =>
  group.children.map(node => node.textContent));

test('the panel draws the mission, keeps its rows while only the values move, and clears on deselect', () => {
  const {panel, nodes, restore} = box();
  try {
    SelectionPanel.prototype.setMission.call(panel, flying);
    assert.equal(nodes.mission.hidden, false);
    assert.equal(nodes['mission-title'].textContent, '임무 상태 · 순항');
    assert.deepEqual(rows(nodes)[0], ['임무 상태', '순항']);
    assert.ok(rows(nodes).some(([label, text]) => label === '구간' && text === '여의도 → 강남'));
    assert.equal(nodes.mission.dataset.holding, 'false');

    // The same shape one tick later: the rows are reused, the values change.
    const before = nodes['mission-detail'].children;
    SelectionPanel.prototype.setMission.call(panel, {...flying,
      state: {...flying.state, speed_mps: 60.0}});
    assert.equal(nodes['mission-detail'].children, before, 'no row was rebuilt');
    assert.ok(rows(nodes).some(([, text]) => /60\.0 m\/s/.test(text)));

    // A holding aircraft is a different set of rows, and the box says so.
    SelectionPanel.prototype.setMission.call(panel, {...flying,
      state: {...flying.state, phase: 'hold', holding: true, hold_seconds: 20, sequence: 1}});
    assert.equal(nodes.mission.dataset.holding, 'true');
    assert.ok(rows(nodes).some(([label]) => label === '착륙 순번'));

    SelectionPanel.prototype.setMission.call(panel, null);
    assert.equal(nodes.mission.hidden, true);
    assert.equal(nodes['mission-detail'].children.length, 0);
  } finally {restore();}
});

test('nothing is drawn for an entity that is no longer selected', () => {
  const {panel, nodes, restore} = box();
  try {
    panel.entityId = null;
    SelectionPanel.prototype.setMission.call(panel, flying);
    assert.equal(nodes.mission.hidden, true, 'a late answer cannot put a mission back on screen');
  } finally {restore();}
});

test('the mission box is in the panel and is asked for only while a UAM is selected', () => {
  assert.match(html, /<section id="mission"[^>]*hidden/);
  assert.match(html, /id="mission-detail"/);
  assert.ok(html.indexOf('id="mission"')<html.indexOf('id="trajectory"'), 'mission comes before optional calculated paths');
  assert.match(html, /<details[^>]+class="selection-fold"[^>]*><summary>임무 상세/, 'the long record is folded, not the headline');
  assert.match(app, /entity\?\.kind==='uam'\?entity\.entity_id:null/, 'only a UAM has a mission');
  assert.match(app, /setInterval\(\(\)=>void readMission\(\),\s*\d+\)/, 'a phase changes while the panel is open');
  assert.match(app, /clearInterval\(missionWatch\)/, 'and the asking stops with the selection');
});
