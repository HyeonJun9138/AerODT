import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {FakeElement, fakeDocument} from './fake_dom.mjs';
import {ScenarioVertiportMonitor, phaseLabel}
  from '../../../../user_application/web/domains/uam/operations/scenario_stakeholders.js';
import {StakeholderPanel} from '../../../../user_application/web/domains/uam/operations/stakeholder_panel.js';

const web = new URL('../../../../user_application/web/', import.meta.url);
const app = readFileSync(new URL('app.js', web), 'utf8');
const css = readFileSync(new URL('scenario_control.css', web), 'utf8');

const LIVE = {schema_version: 1, state: 'idle', loaded: false, control_open: false, speeds: [1], speed: 1};
const REPLAYING = {schema_version: 1, state: 'playing', loaded: true, control_open: true,
  name: 'FPL_all.csv', date: '2026-10-10', clock: '06:48:17', speed: 4, speeds: [1, 2, 4]};
const DECK = {
  vertiport_id: 'VP002', clock: '06:48:17',
  standing: [{aircraft_id: 'UAM0007', flight_id: null, phase: 'parked', stand: 'G1', holding: false, hold_seconds: 0}],
  inbound: [{aircraft_id: 'UAM0011', flight_id: 'FPL000044', phase: 'descent', holding: false, hold_seconds: 0, sequence: 3}],
  holding: [{aircraft_id: 'UAM0019', flight_id: 'FPL000051', phase: 'hold', holding: true, hold_seconds: 143.9, sequence: 4}],
  outbound: [{aircraft_id: 'UAM0022', flight_id: 'FPL000060', phase: 'climb', holding: false, hold_seconds: 0}],
  pads: {F2: [{from_s: 24000, to_s: 24090, flight_id: 'FPL000044', kind: 'arrival'}]},
  stands: {G1: 'UAM0007'},
};

const settle = async () => {for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));};

// The banner that used to sit on every stakeholder screen is gone. That a day
// is being replayed is said once, by the replay console across the top of the
// map, which carries the date, the file and the clock on whichever screen is
// open; a second copy of it inside each panel only made the panels shorter.
test('the deck monitor shows who is waiting, who is coming and who is standing', async () => {
  const host = new FakeElement('div');
  const asked = [];
  const monitor = new ScenarioVertiportMonitor({
    api: {status: async () => REPLAYING, vertiport: async id => {asked.push(id); return DECK;}},
    document: fakeDocument, poll: 100000, selected: () => 'VP002'});
  monitor.render(host, 'VP002');
  await settle();
  const root = host.querySelector('#scenario-deck');
  assert.equal(root.hidden, false);
  assert.deepEqual(asked, ['VP002']);
  const figures = root.querySelectorAll('.scenario-deck-figure').map(node => node.textContent.replace(/\s+/g, ''));
  assert.deepEqual(figures, ['주기1', '접근중1', '대기1', '출발1']);
  // Waiting is first on the screen and marked, because it is what the deck
  // operator is looking for.
  const groups = root.querySelectorAll('.scenario-deck-title').map(node => node.textContent);
  assert.equal(groups[0], '대기 중 (1)');
  const waiting = root.querySelector('.scenario-deck-row');
  assert.equal(waiting.getAttribute('data-hold'), 'true');
  assert.match(waiting.textContent, /UAM0019/);
  assert.match(waiting.textContent, /FPL000051/);
  assert.match(waiting.textContent, /착륙 4번/);
  assert.match(waiting.textContent, /대기 144초/);
  // The pad's own bookings are shown too.
  assert.match(root.textContent, /FATO 사용 예정/);
  assert.match(root.textContent, /F2/);
  monitor.destroy();
});

test('the monitor follows whichever deck the operator has selected', async () => {
  const host = new FakeElement('div');
  const asked = [];
  let chosen = 'VP001';
  const monitor = new ScenarioVertiportMonitor({
    api: {status: async () => REPLAYING, vertiport: async id => {asked.push(id); return {...DECK, vertiport_id: id};}},
    document: fakeDocument, poll: 100000, selected: () => chosen});
  monitor.render(host, null);
  await settle();
  chosen = 'VP013';
  await monitor.refresh();
  assert.deepEqual(asked, ['VP001', 'VP013']);
  monitor.destroy();
});

test('nothing is shown, and nothing is asked, while no day is on the map', async () => {
  const host = new FakeElement('div');
  const asked = [];
  const monitor = new ScenarioVertiportMonitor({
    api: {status: async () => LIVE, vertiport: async id => {asked.push(id); return DECK;}},
    document: fakeDocument, poll: 100000, selected: () => 'VP002'});
  monitor.render(host, 'VP002');
  await settle();
  assert.equal(host.querySelector('#scenario-deck').hidden, true);
  assert.deepEqual(asked, [], 'a live screen does not poll a day that is not there');
  monitor.destroy();
});

test('a poll that fails leaves the screen as it was rather than blanking it', async () => {
  const host = new FakeElement('div');
  const monitor = new ScenarioVertiportMonitor({api: {status: async () => {throw new Error('offline');},
    vertiport: async () => {throw new Error('offline');}}, document: fakeDocument, poll: 100000});
  monitor.render(host, 'VP001');
  await settle();
  // Nothing is claimed about a deck that could not be reached.
  assert.equal(host.querySelector('#scenario-deck').hidden, true);
  monitor.destroy();
});

test('the phases read as an operator says them', () => {
  assert.equal(phaseLabel('hold'), 'PSU 대기');
  assert.equal(phaseLabel('hold_exit'), '역천이 · 대기 이동');
  assert.equal(phaseLabel('gate_out'), '지상 이동');
  assert.equal(phaseLabel('mystery'), 'mystery', 'an unknown phase is shown, not hidden');
});

test('the left section mounts only the summary; detail monitor belongs to the console',()=>{
  const drawn=[];
  const panel=new StakeholderPanel({document:fakeDocument,
    vertiportPanel:{deactivate:()=>{},render:()=>drawn.push('summary')},
    scenarioDeck:{render:()=>drawn.push('duplicate monitor'),destroy:()=>drawn.push('stop detail')}});
  panel.role='vertiport';const body=new FakeElement('div');panel.render(body);
  assert.deepEqual(drawn,['summary']);assert.equal(body.querySelector('.stakeholder-scenario'),null);
  panel.deactivate();assert.deepEqual(drawn,['summary'],'closing the sidebar must not stop the separate console');
});

test('console monitor renders existing snapshots without another request or timer',()=>{
 const monitor=new ScenarioVertiportMonitor({document:fakeDocument,api:{status:()=>{throw new Error('duplicate poll');}}});
 const host=new FakeElement('div');monitor.renderSnapshot(host,DECK);
 assert.equal(monitor.timer,null);assert.match(host.textContent,/UAM0019/);
 monitor.updateSnapshot(null);assert.equal(monitor.root.hidden,true);monitor.destroy();
});

test('snapshot-only deck monitor displays ground stop cause and gate reassignment instead of airborne waiting',()=>{
 const monitor=new ScenarioVertiportMonitor({document:fakeDocument,api:{}}),host=new FakeElement('div');
 const row={aircraft_id:'UAM0070',flight_id:'FPL70',phase:'gate_in',airborne:false,holding:true,
   ground_waiting:true,hold_seconds:30,instruction:{action:'ground_wait',reason:'교차 유도로 통과 대기',blocked_by:['UAM0080']},
   gate_assignment:{planned_stand:'G1',assigned_stand:'G2',revision:1,reason:'G1 실제 점유'}};
 monitor.renderSnapshot(host,{...DECK,standing:[row],holding:[],inbound:[]});
 const shown=host.querySelector('.scenario-deck-row');
 assert.match(shown.textContent,/지상 대기/);assert.match(shown.textContent,/교차 유도로 통과 대기/);
 assert.match(shown.textContent,/UAM0080/);assert.match(shown.textContent,/계획 Gate.*G1/);
 assert.match(shown.textContent,/배정 Gate.*G2/);assert.match(shown.textContent,/G1 실제 점유/);
 assert.doesNotMatch(shown.textContent,/체공|대기 30초/);assert.notEqual(shown.getAttribute('data-hold'),'true');
 assert.equal(monitor.timer,null);monitor.destroy();
 assert.equal(phaseLabel('gate_out',{ground_waiting:false,speed_mps:0}),'지상 이동');
 assert.equal(phaseLabel('gate_out',{ground_waiting:false,instruction:{action:'ground_wait'}}),'지상 이동 · 감속');
});

test('the page wires the deck monitor into the stakeholders section, and the styles exist', () => {
  assert.match(app, /new ScenarioVertiportMonitor\(\{api:operatingApi,document,/);
  assert.match(app, /selected:\(\)=>vertiportPanel\.selectedId/);
  assert.match(app, /vertiportPanel\.scenarioDeck=scenarioDeck/);
  assert.match(app, /pilotPanel,onDecisions:/);
  assert.match(app, /vertiport:id=>getOperatingJSON\(`\/api\/operations\/context\/vertiports\//);
  // Opening another independent work window no longer closes this one.
  assert.match(app, /workWindows\.open\(id\)/);
  assert.match(css, /\.scenario-deck-row\[data-hold=true\]\{/);
  // The banner is gone from the page and from the styles, not merely hidden.
  assert.doesNotMatch(app, /ScenarioModeBanner|scenarioBanner/);
  assert.doesNotMatch(css, /\.scenario-mode/);
  // What it used to say is still on screen, on the console the day runs from.
  assert.match(css, /\.scenario-console\{/);
  assert.match(readFileSync(new URL('domains/uam/operations/scenario_control.js', web), 'utf8'), /class: 'sc-day'/);
});
