import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fakeDocument} from './fake_dom.mjs';
import {SEOUL_DAILY_TRIPS, allPairs, buildRequest, clockMinutes, dailyTrips, defaultState, describeHours,
  clampMix, fitMix, fleetRows, fleetTotals, initialStateDocument, livePairs, mixSeats, mixTotal,
  operatingMinutes, operatingTrips, pairCounts, pairKey, resolveSeed, seatCapacity, spreadMix, togglePair,
  DEFAULT_SEAT_CLASS, SEAT_CHOICES}
  from '../../../../user_application/web/demand_setup.js';
import {DemandPanel} from '../../../../user_application/web/domains/uam/planning/demand_panel.js';
import {PlanPanel} from '../../../../user_application/web/domains/uam/planning/plan_panel.js';

const web = new URL('../../../../user_application/web/', import.meta.url);
const app = readFileSync(new URL('app.js', web), 'utf8');
const css = readFileSync(new URL('styles.css', web), 'utf8');
const globe = readFileSync(new URL('../../../../digital_twin/visualization/web/globe.js', import.meta.url), 'utf8');

const record = (id, name, gates, longitude) => ({id, name, gates, fatos: [{role: 'both'}], heading_deg: 0,
  latitude: 37.5, longitude, layout: {frame: {latitude: 37.5, longitude, altitude_m: 20, heading_deg: 0}}});
const RECORDS = [record('vp-1', '여의도', 4, 126.93), record('vp-2', '강남', 6, 127.03), record('vp-3', '김포', 2, 126.79)];
const scopeOf = (...ids) => ({...defaultState(), scope: ids});

// ---- the numbers -------------------------------------------------------

test('the decks start with a spread of cabin sizes rather than one size repeated', () => {
  // A fleet of one cabin size answers the day with one shape of answer: a
  // rehearsal that only ever has four seats to offer cannot show what a six or
  // an eight would have carried.
  assert.deepEqual(spreadMix(6), {seat4: 2, seat6: 2, seat8: 2});
  assert.deepEqual(spreadMix(4), {seat4: 2, seat6: 1, seat8: 1}, 'the odd one goes to the smaller cabin');
  assert.deepEqual(spreadMix(3), {seat4: 1, seat6: 1, seat8: 1});
  assert.deepEqual(spreadMix(2), {seat4: 1, seat6: 1, seat8: 0});
  assert.deepEqual(spreadMix(1), {seat4: 1, seat6: 0, seat8: 0});
  assert.deepEqual(spreadMix(0), {seat4: 0, seat6: 0, seat8: 0});
  assert.deepEqual(spreadMix(-4), {seat4: 0, seat6: 0, seat8: 0});
  // However it is split, every aircraft asked for is placed and none invented.
  for (let gates = 0; gates <= 24; gates += 1) assert.equal(mixTotal(spreadMix(gates)), gates);
});

test('a deck fills with the spread by default, and one size only if that is asked for', () => {
  const decks = [{id: 'a', name: '여의도', gates: 4}, {id: 'b', name: '잠실', gates: 6}];
  const spread = fleetRows(decks, {fill: 'all', seat_class: DEFAULT_SEAT_CLASS, overrides: {}});
  assert.deepEqual(spread.map(row => row.mix),
    [{seat4: 2, seat6: 1, seat8: 1}, {seat4: 2, seat6: 2, seat8: 2}]);
  assert.deepEqual(fleetTotals(spread), {aircraft: 10, seats: 58, gates: 10});
  // One size is still a choice somebody can make, and it should read as one.
  const fours = fleetRows(decks, {fill: 'all', seat_class: 'seat4', overrides: {}});
  assert.deepEqual(fours.map(row => row.mix),
    [{seat4: 4, seat6: 0, seat8: 0}, {seat4: 6, seat6: 0, seat8: 0}]);
  // A setting nobody recognises falls back to the spread rather than to a
  // silently empty deck.
  assert.deepEqual(fleetRows(decks, {fill: 'all', seat_class: 'seat99', overrides: {}})[0].mix,
    {seat4: 2, seat6: 1, seat8: 1});
  // Placing a fixed number per deck spreads that number, not the gate count.
  assert.deepEqual(fleetRows(decks, {fill: 'count', count: 3, seat_class: DEFAULT_SEAT_CLASS, overrides: {}})
    .map(row => row.mix), [{seat4: 1, seat6: 1, seat8: 1}, {seat4: 1, seat6: 1, seat8: 1}]);
  // And a deck the operator has edited by hand keeps what they wrote.
  assert.deepEqual(fleetRows(decks, {fill: 'all', seat_class: DEFAULT_SEAT_CLASS,
    overrides: {a: {seat4: 0, seat6: 0, seat8: 4}}})[0].mix, {seat4: 0, seat6: 0, seat8: 4});
});

test('demand is the baseline times the conversion rate, or the number entered directly', () => {
  const state = defaultState();
  assert.equal(state.demand.baseline, SEOUL_DAILY_TRIPS);
  // 13,500,000 x 0.5% is a UAM-sized number; a ratio would give 6.75 million.
  assert.equal(dailyTrips(state.demand), 67500);
  assert.equal(dailyTrips({...state.demand, mode: 'direct', riders: 10000}), 10000);
  // The row that is not chosen says nothing, however it is filled in.
  assert.equal(dailyTrips({...state.demand, mode: 'direct', riders: 0}), 0);
  assert.equal(dailyTrips({mode: 'baseline', baseline: 0, conversion_pct: 5}), 0);
});

test('every pair exists until it is cut, and excluding a vertiport cuts all of its own', () => {
  const pairs = allPairs(['a', 'b', 'c']);
  assert.equal(pairs.length, 3);
  assert.ok(pairs.every(pair => pair.kept));
  // The key does not depend on which end was clicked.
  assert.equal(pairKey('b', 'a'), pairKey('a', 'b'));
  const cut = allPairs(['a', 'b', 'c'], {broken: [pairKey('a', 'b')]});
  assert.equal(cut.filter(pair => pair.kept).length, 2);
  const out = allPairs(['a', 'b', 'c'], {excluded: ['c']});
  assert.deepEqual(out.filter(pair => pair.kept).map(pair => pair.key), [pairKey('a', 'b')]);
  assert.equal(livePairs(['a', 'b', 'c'], {excluded: ['c']}).length, 1);
});

test('cutting a line and joining it again is the same edit from the map or the list', () => {
  let state = scopeOf('a', 'b', 'c');
  state = togglePair(state, pairKey('a', 'b'));
  assert.equal(livePairs(state.scope, state).length, 2);
  state = togglePair(state, pairKey('a', 'b'));
  assert.equal(livePairs(state.scope, state).length, 3);
  // Joining a pair whose end was excluded brings that end back rather than
  // leaving a line the operator clicked on still dead.
  state = {...state, excluded: ['c']};
  state = togglePair(state, pairKey('a', 'c'));
  assert.deepEqual(state.excluded, []);
  assert.equal(livePairs(state.scope, state).length, 3);
});

test('the list says how many connections each vertiport still carries', () => {
  const state = {...scopeOf('a', 'b', 'c'), broken: [pairKey('a', 'b')]};
  const counts = pairCounts(state.scope, state);
  assert.equal(counts.get('a'), 1);
  assert.equal(counts.get('b'), 1);
  assert.equal(counts.get('c'), 2);
});

test('the operating day is read from the clock and may run past midnight', () => {
  assert.equal(clockMinutes('06:30'), 390);
  assert.equal(clockMinutes('24:00'), null);
  assert.equal(clockMinutes('6:5'), null);
  assert.equal(operatingMinutes({start: '06:30', end: '21:30'}), 900);
  assert.equal(operatingMinutes({start: '22:00', end: '02:00'}), 240);
  assert.equal(operatingMinutes({start: '06:30', end: 'x'}), 0);
  assert.match(describeHours({start: '06:30', end: '21:30'}), /15시간/);
});

test('the operating window clips the 24-hour UAM demand instead of compressing it', () => {
  const curve = [1.9581,1.3959,1.0857,.8918,1.2796,2.7142,4.2458,5.3509,5.6223,5.3121,5.1764,5.1377,
    5.0407,5.1764,5.2927,5.4672,5.7387,5.8938,5.7774,5.2540,4.7111,4.4785,4.0132,2.9857];
  assert.equal(operatingTrips(67500, {start: '06:30', end: '21:30'}, curve), 53537);
  assert.equal(operatingTrips(67500, {start: '23:00', end: '01:00'}, curve), 3337);
  assert.equal(operatingTrips(67500, {start: '06:30', end: '06:30'}, curve), 0);
});

test('a fixed seed must be a whole number of at least one; random has none', () => {
  assert.equal(resolveSeed({mode: 'random', value: 7}), null);
  assert.equal(resolveSeed({mode: 'fixed', value: '7'}), 7);
  assert.equal(resolveSeed({mode: 'fixed', value: 0}), null);
  assert.equal(resolveSeed({mode: 'fixed', value: 'x'}), null);
});

test('the bulk placement fills every deck with one size and an override gives it a mix', () => {
  const all = fleetRows(RECORDS, {fill: 'all', seat_class: 'seat4', overrides: {}});
  assert.deepEqual(all.map(row => row.aircraft), [4, 6, 2]);
  assert.deepEqual(all[0].mix, {seat4: 4, seat6: 0, seat8: 0});
  assert.equal(fleetTotals(all).aircraft, 12);
  assert.equal(fleetTotals(all).seats, 48);
  const each = fleetRows(RECORDS, {fill: 'count', count: 3, seat_class: 'seat6', overrides: {}});
  // Never more than the deck has gates for.
  assert.deepEqual(each.map(row => row.aircraft), [3, 3, 2]);
  assert.equal(each[0].seats, 18);
  assert.deepEqual(fleetRows(RECORDS, {fill: 'none', seat_class: 'seat4'}).map(row => row.aircraft), [0, 0, 0]);
  // A deck of its own: two fours and a six standing together.
  const mixed = fleetRows(RECORDS, {fill: 'all', seat_class: 'seat4', overrides: {'vp-2': {seat4: 2, seat6: 1, seat8: 0}}});
  assert.equal(mixed[1].aircraft, 3);
  assert.equal(mixed[1].seats, 14);
  assert.equal(mixed[1].custom, true);
  assert.equal(mixed[0].custom, false);
  // A deck edited when it had more gates than it has now is held to what it has.
  assert.equal(fleetRows(RECORDS, {fill: 'none', overrides: {'vp-3': {seat4: 9, seat6: 9, seat8: 9}}})[2].aircraft, 2);
});

test('raising one size takes the room from the others rather than being refused', () => {
  assert.equal(mixTotal({seat4: 2, seat6: 1, seat8: 0}), 3);
  assert.equal(mixSeats({seat4: 2, seat6: 1, seat8: 0}), 14);
  // Four gates already full of fours: asking for three eights leaves one four.
  assert.deepEqual(fitMix({seat4: 4, seat6: 0, seat8: 0}, 'seat8', 3, 4), {seat4: 1, seat6: 0, seat8: 3});
  // The excess comes off whichever class has the most, one at a time, so a mix
  // keeps its shape instead of one size being wiped out.
  assert.deepEqual(fitMix({seat4: 2, seat6: 2, seat8: 0}, 'seat8', 3, 4), {seat4: 0, seat6: 1, seat8: 3});
  // Asking for more than the deck has gates for gets the gates.
  assert.deepEqual(fitMix({seat4: 0, seat6: 0, seat8: 0}, 'seat6', 99, 4), {seat4: 0, seat6: 4, seat8: 0});
  // Nonsense typed into the box is nothing, not a crash.
  assert.deepEqual(fitMix({seat4: 1, seat6: 0, seat8: 0}, 'seat4', '', 4), {seat4: 0, seat6: 0, seat8: 0});
  assert.deepEqual(fitMix({seat4: 1, seat6: 0, seat8: 0}, 'seat4', -3, 4), {seat4: 0, seat6: 0, seat8: 0});
  // There is room to spare: nothing else moves.
  assert.deepEqual(fitMix({seat4: 1, seat6: 1, seat8: 0}, 'seat8', 1, 6), {seat4: 1, seat6: 1, seat8: 1});
  assert.deepEqual(clampMix({seat4: 3, seat6: 3, seat8: 3}, 4), {seat4: 1, seat6: 1, seat8: 2});
  assert.deepEqual(clampMix({seat4: 1, seat6: 1, seat8: 0}, 0), {seat4: 0, seat6: 0, seat8: 0});
});

test('the seat ceiling is the fleet against the length of the day', () => {
  const rows = fleetRows(RECORDS, {fill: 'all', seat_class: 'seat4', overrides: {}});
  // 48 seats, 900 minutes, one 30 minute turn each: 30 turns.
  assert.equal(seatCapacity(rows, {start: '06:30', end: '21:30'}), 1440);
  assert.equal(seatCapacity(rows, {start: '06:30', end: '06:30'}), 0);
});

// ---- the request -------------------------------------------------------

test('the request carries the scope, the live pairs, the demand, the day, the seed and the fleet', () => {
  const state = {...scopeOf('vp-1', 'vp-2', 'vp-3'), broken: [pairKey('vp-1', 'vp-3')],
    seed: {mode: 'fixed', value: 12}, fleet: {fill: 'all', seat_class: 'seat4', overrides: {}},
    schedule_planning: {calibration_id: 'seoul_uam_20260921', fato_headway_s: 60}};
  const {request, errors} = buildRequest(state, RECORDS);
  assert.equal(errors, undefined);
  assert.deepEqual(request.vertiports, ['vp-1', 'vp-2', 'vp-3']);
  assert.equal(request.pairs.length, 2);
  assert.equal(request.demand.daily_trips, 67500);
  assert.equal(request.operating.minutes, 900);
  assert.deepEqual(request.seed, {mode: 'fixed', value: 12});
  assert.equal(request.fleet.reduce((sum, row) => sum + row.aircraft, 0), 12);
  assert.deepEqual(request.fleet[0].aircraft_by_class, {seat4: 4, seat6: 0, seat8: 0});
  assert.equal(request.fleet[0].seats, 16);
  assert.deepEqual(request.planning, state.schedule_planning);
});

test('a setup that cannot be generated says why instead of being sent', () => {
  assert.match(buildRequest(defaultState(), RECORDS).errors.join(' '), /2곳 이상/);
  const alone = {...scopeOf('vp-1', 'vp-2'), broken: [pairKey('vp-1', 'vp-2')]};
  assert.match(buildRequest(alone, RECORDS).errors.join(' '), /연결된 버티포트 쌍이 없습니다/);
  const empty = {...scopeOf('vp-1', 'vp-2'), fleet: {fill: 'none', overrides: {}}};
  assert.match(buildRequest(empty, RECORDS).errors.join(' '), /배치된 기체가 없습니다/);
  const noDemand = {...scopeOf('vp-1', 'vp-2'), demand: {mode: 'direct', riders: 0}};
  assert.match(buildRequest(noDemand, RECORDS).errors.join(' '), /하루 수요가 0/);
  const badSeed = {...scopeOf('vp-1', 'vp-2'), seed: {mode: 'fixed', value: 0}};
  assert.match(buildRequest(badSeed, RECORDS).errors.join(' '), /시드/);
  // A vertiport deleted elsewhere simply leaves the scope.
  assert.deepEqual(buildRequest(scopeOf('vp-1', 'gone'), RECORDS).errors.length, 1);
});

test('the saved file holds the request, the vertiports it names and every pair with its state', () => {
  const state = {...scopeOf('vp-1', 'vp-2', 'vp-3'), broken: [pairKey('vp-1', 'vp-3')]};
  const saved = initialStateDocument(state, RECORDS, {generatedAt: '2026-09-10T00:00:00.000Z'});
  assert.equal(saved.kind, 'aerodt.multi_flight_setup');
  assert.equal(saved.incomplete, null);
  assert.equal(saved.vertiports.length, 3);
  assert.equal(saved.vertiports[0].gates, 4);
  assert.equal(saved.pairs.length, 3);
  assert.equal(saved.pairs.filter(pair => pair.connected).length, 2);
  assert.equal(saved.fleet.length, 3);
  // An unfinished setup is still worth keeping; it says what is missing.
  const partial = initialStateDocument(defaultState(), RECORDS, {generatedAt: '2026-09-10T00:00:00.000Z'});
  assert.equal(partial.request, null);
  assert.ok(partial.incomplete.length);
});

// ---- the panel ---------------------------------------------------------

function mount({records = RECORDS, generate = null, plans = null, demandDefaults = null} = {}) {
  const calls = {pairs: [], editor: [], scrap: [], notices: [], saved: [], quiet: [], controls: []};
  const panel = new DemandPanel({document: fakeDocument,
    // The dashboard's own endpoint answers {vertiports: [...]}, which is what
    // this hands over; a bare list is accepted as well.
    api: {list: async () => ({vertiports: records}), ...(generate ? {generate} : {}), ...(demandDefaults ? {demandDefaults} : {})},
    notify: (status, message) => calls.notices.push([status, message]),
    onPairs: (pairs, options) => calls.pairs.push({pairs, options}),
    onDemandEditor: editor => calls.editor.push(editor),
    onScrap: scrap => calls.scrap.push(scrap),
    onQuiet: active => calls.quiet.push(active),
    download: (name, text) => {calls.saved.push({name, text}); return true;},
    plans, onControlPanel: plan => {calls.controls.push(plan); return plan;},
    now: () => new Date('2026-09-10T01:02:03.000Z')});
  const root = fakeDocument.createElement('div');
  return {panel, root, calls, ready: panel.render(root)};
}

test('a vertiport the map has not placed is not offered for a flight day', async () => {
  const {panel, ready} = mount({records: [...RECORDS, {id: 'vp-4', name: '미배치', gates: 2}]});
  await ready;
  assert.deepEqual(panel.records.map(item => item.id), ['vp-1', 'vp-2', 'vp-3']);
});

test('the scope list offers every saved vertiport and a scrap takes several at once', async () => {
  const {panel, root, calls, ready} = mount();
  await ready;
  // Seven: demand, resources, planning criteria and manual flight.
  assert.equal(root.querySelectorAll('.dm-step').length, 7);
  assert.ok(root.querySelector('#demand-manual-want'));
  assert.equal(root.querySelector('#demand-scope-table').querySelectorAll('.dm-row').length, 3);
  // Arming the scrap hands the map a handler; the map answers with what the
  // rectangle enclosed.
  root.querySelector('#demand-scrap').click();
  const armed = calls.scrap.at(-1);
  assert.ok(armed);
  // The button is the only sign the map is armed, so it has to say so, and
  // pressing it again has to disarm it.
  assert.equal(root.querySelector('#demand-scrap').getAttribute('aria-pressed'), 'true');
  assert.match(root.querySelector('#demand-scrap').textContent, /끄기/);
  root.querySelector('#demand-scrap').click();
  assert.equal(calls.scrap.at(-1), null);
  assert.equal(root.querySelector('#demand-scrap').getAttribute('aria-pressed'), 'false');
  root.querySelector('#demand-scrap').click();
  assert.ok(calls.scrap.at(-1));
  assert.deepEqual(armed.records().map(item => item.id), ['vp-1', 'vp-2', 'vp-3']);
  armed.onScrap(['vp-1', 'vp-2']);
  assert.deepEqual(panel.state.scope, ['vp-1', 'vp-2']);
  // A click on one vertiport takes it in, and another takes it out again.
  armed.onToggle('vp-3');
  assert.equal(panel.state.scope.length, 3);
  armed.onToggle('vp-3');
  assert.equal(panel.state.scope.length, 2);
  // Something the map does not know about is not taken in, and an empty box
  // says it caught nothing rather than claiming a selection.
  armed.onScrap(['vp-nope']);
  assert.equal(panel.state.scope.length, 2);
  assert.match(calls.notices.at(-1)[1], /없습니다/);
  root.querySelector('#demand-scope-all').click();
  assert.equal(panel.state.scope.length, 3);
  root.querySelector('#demand-scope-none').click();
  assert.equal(panel.state.scope.length, 0);
});

test('leaving the scope step disarms the scrap, and the header keeps the answer', async () => {
  const {panel, root, calls, ready} = mount();
  await ready;
  root.querySelector('#demand-scope-all').click();
  root.querySelector('#demand-scrap').click();
  assert.ok(calls.scrap.at(-1));
  root.querySelector('#dm-head-demand').click();
  assert.equal(calls.scrap.at(-1), null);
  assert.equal(panel.scrapping, false);
  assert.equal(root.querySelector('#dm-head-scope').getAttribute('aria-expanded'), 'false');
  assert.match(root.querySelector('#dm-head-scope').textContent, /3 \/ 3곳/);
});

test('the pairs are drawn only while their step is open, and the map can cut one', async () => {
  const {panel, root, calls, ready} = mount();
  await ready;
  root.querySelector('#demand-scope-all').click();
  // Nothing is on the map while the scope step is open.
  assert.deepEqual(calls.pairs.at(-1).pairs, []);
  assert.equal(calls.editor.at(-1), null);
  root.querySelector('#dm-head-demand').click();
  assert.equal(calls.pairs.at(-1).pairs.length, 3);
  const editor = calls.editor.at(-1);
  assert.ok(editor);
  editor.onPair({key: pairKey('vp-1', 'vp-2')});
  assert.equal(livePairs(panel.state.scope, panel.state).length, 2);
  assert.equal(calls.pairs.at(-1).pairs.filter(pair => pair.kept).length, 2);
  // Selecting one in the list draws its own connections strongly.
  root.querySelector('#demand-pair-table').querySelector('.dm-row-pick').click();
  assert.equal(calls.pairs.at(-1).options.focus, 'vp-1');
  // Unchecking a vertiport takes all of its pairs with it.
  root.querySelector('#dm-pair-vp-3').onchange();
  assert.equal(livePairs(panel.state.scope, panel.state).length, 0);
  root.querySelector('#demand-link-all').click();
  assert.equal(livePairs(panel.state.scope, panel.state).length, 3);
  root.querySelector('#demand-link-none').click();
  assert.equal(livePairs(panel.state.scope, panel.state).length, 0);
});

test('the route network drops to background for the whole setup and comes back on the way out', async () => {
  const {panel, root, calls, ready} = mount();
  await ready;
  assert.equal(calls.quiet.at(-1), true, '첫 단계에서도 항로는 배경이어야 합니다');
  root.querySelector('#dm-head-demand').click();
  assert.equal(calls.quiet.at(-1), true);
  panel.deactivate();
  assert.equal(calls.quiet.at(-1), false);
});

test('a cut pair and a kept one are told apart in the list as well as on the map', async () => {
  const {panel, root, ready} = mount();
  await ready;
  root.querySelector('#demand-scope-all').click();
  root.querySelector('#dm-head-demand').click();
  const rowOf = id => root.querySelector(`#demand-pair-table`).querySelectorAll('.dm-row').find(row => row.getAttribute('data-id') === id);
  assert.equal(rowOf('vp-3').getAttribute('data-state'), 'on');
  root.querySelector('#dm-pair-vp-3').onchange();
  assert.equal(rowOf('vp-3').getAttribute('data-state'), 'off');
  assert.match(rowOf('vp-3').textContent, /제외/);
  // A facility still in but with nothing left to fly to is its own case.
  root.querySelector('#demand-link-none').click();
  assert.match(rowOf('vp-1').textContent, /고립/);
  assert.equal(rowOf('vp-1').getAttribute('data-state'), 'off');
});

test('deactivating clears the pairs, the editor and the scrap', async () => {
  const {panel, calls, ready} = mount();
  await ready;
  panel.setScrapping(true);
  panel.deactivate();
  assert.deepEqual(calls.pairs.at(-1).pairs, []);
  assert.equal(calls.editor.at(-1), null);
  assert.equal(calls.scrap.at(-1), null);
  assert.equal(calls.quiet.at(-1), false);
});

test('typing a demand figure updates the readout without rebuilding the form', async () => {
  const {panel, root, ready} = mount();
  await ready;
  root.querySelector('#dm-head-demand').click();
  const conversion = root.querySelector('#demand-conversion');
  conversion.value = '1';
  conversion.oninput({target: conversion});
  assert.equal(root.querySelector('#demand-trips').textContent, (135000).toLocaleString('ko-KR') + '명');
  assert.equal(root.querySelector('#demand-conversion'), conversion, '입력 칸이 그대로 남아 있어야 커서를 잃지 않습니다');
  root.querySelector('#demand-mode-direct').onchange();
  assert.equal(panel.state.demand.mode, 'direct');
});

test('the seed value is only editable while the seed is fixed', async () => {
  const {panel, root, ready} = mount();
  await ready;
  root.querySelector('#dm-head-seed').click();
  assert.equal(root.querySelector('#demand-seed').disabled, true);
  root.querySelector('#demand-seed-fixed').onchange();
  assert.equal(root.querySelector('#demand-seed').disabled, false);
  const seed = root.querySelector('#demand-seed');
  seed.value = '42';
  seed.oninput({target: seed});
  assert.equal(resolveSeed(panel.state.seed), 42);
  // The header carries the answer once the step is confirmed.
  root.querySelector('#dm-body-seed').querySelector('.dm-confirm').click();
  assert.match(root.querySelector('#dm-head-seed').textContent, /고정 42/);
  assert.equal(root.querySelector('#dm-body-seed').hidden, true);
});

test('a deck is given a mix of sizes and the gates hold the total down', async () => {
  const {panel, root, ready} = mount();
  await ready;
  root.querySelector('#demand-scope-all').click();
  root.querySelector('#dm-head-fleet').click();
  assert.match(root.querySelector('#demand-fleet-total').textContent, /^12대/);
  // 강남 has six gates and starts with two of each size. Asking for four eights
  // takes one off each of the others, and the row corrects itself on screen.
  const eights = root.querySelector('#dm-fleet-vp-2-seat8');
  eights.value = '4';
  eights.oninput({target: eights});
  const row = fleetRows(panel.scopeRecords(), panel.state.fleet).find(item => item.id === 'vp-2');
  assert.deepEqual(row.mix, {seat4: 1, seat6: 1, seat8: 4});
  assert.equal(row.aircraft, 6);
  assert.equal(row.seats, 42);
  assert.equal(root.querySelector('#dm-fleet-vp-2-seat4').value, '1', '밀려난 대수가 화면에도 반영되어야 합니다');
  // The spinner keeps its place: the row is corrected, not rebuilt.
  assert.equal(root.querySelector('#dm-fleet-vp-2-seat8'), eights);
  assert.match(root.querySelector('#demand-fleet-total').textContent, /^12대/);
  // The header above says the same thing as the total below it.
  assert.match(root.querySelector('#dm-head-fleet').textContent, /12대 · 74석/);
  // Asking for more than the deck has gates for gets the gates.
  eights.value = '99';
  eights.oninput({target: eights});
  assert.equal(fleetRows(panel.scopeRecords(), panel.state.fleet).find(item => item.id === 'vp-2').aircraft, 6);
  assert.equal(root.querySelector('#dm-fleet-vp-2-seat4').value, '0');
  // The bulk button is what puts an individual correction back.
  root.querySelector('#demand-fleet-apply').click();
  assert.equal(fleetTotals(fleetRows(panel.scopeRecords(), panel.state.fleet)).seats, 68);
  const fill = root.querySelector('#demand-fill');
  fill.value = 'none';
  fill.onchange({target: fill});
  assert.match(root.querySelector('#dm-head-fleet').textContent, /0대/);
});

test('a generated day hands over the controls without being asked', async () => {
  // A day was asked for and a day arrived; the next thing anybody does with it
  // is play it.
  const applied = {schedule: {flights: 128}};
  const {panel, root, calls, ready} = mount({
    generate: async () => {await panel.adoptPlan(applied); return {flights: 128};}});
  await ready;
  root.querySelector('#demand-scope-all').click();
  await panel.generate();
  assert.deepEqual(calls.controls, [applied], '생성 직후 재생 컨트롤이 열려야 합니다');
  assert.equal(panel.planBusy, '', 'and the panel is not left saying it is switching over');
});

test('a request that produced no day leaves the setup where it is', async () => {
  // The generator answering without handing a day over is not a day, and
  // opening a console onto nothing would be worse than saying nothing.
  const {panel, root, calls, ready} = mount({generate: async () => ({flights: 0})});
  await ready;
  root.querySelector('#demand-scope-all').click();
  await panel.generate();
  assert.deepEqual(calls.controls, []);
  // Nor does a generator that is not connected yet.
  const missing = mount({generate: async () => {throw Object.assign(new Error('nope'), {status: 404});}});
  await missing.ready;
  missing.root.querySelector('#demand-scope-all').click();
  await missing.panel.generate();
  assert.deepEqual(missing.calls.controls, []);
});

test('generating asks for the run, and says so plainly when the generator is not there yet', async () => {
  const asked = [];
  const {panel, root, ready} = mount({generate: async request => {asked.push(request); return {flights: 128,
    summary: {operating_window_demand_passengers: 53537, out_of_window_demand_passengers: 13963,
      capacity_delayed_flights: 18, capacity_delay_seconds_max: 125, turnaround_recovery_seconds: 120}};}});
  await ready;
  root.querySelector('#demand-scope-all').click();
  await panel.generate();
  assert.equal(asked.length, 1);
  assert.equal(asked[0].vertiports.length, 3);
  assert.match(panel.result, /생성 완료 · 비행 128편/);
  assert.match(panel.result, /운항시간 수요 53,537명 · 항로 반영 53,537명 · 시간 외 13,963명/);
  assert.match(panel.result, /계획 슬롯 조정 18편 \(최대 3분\) · 회항 회복여유 2분/);
  // Pressing it again simply asks for another one.
  await panel.generate();
  assert.equal(asked.length, 2);

  const missing = mount();
  await missing.ready;
  missing.root.querySelector('#demand-scope-all').click();
  const request = await missing.panel.generate();
  assert.ok(request, '생성기가 없어도 설정은 그대로 남아야 합니다');
  assert.match(missing.panel.result, /연결되지 않았습니다/);

  const failing = mount({generate: async () => {throw Object.assign(new Error('nope'), {status: 404});}});
  await failing.ready;
  failing.root.querySelector('#demand-scope-all').click();
  assert.equal(await failing.panel.generate(), null);
  assert.match(failing.panel.result, /연결되지 않았습니다/);
});

test('an incomplete setup is refused with the reason in the panel, not sent', async () => {
  const asked = [];
  const {panel, root, ready} = mount({generate: async request => {asked.push(request); return {};}});
  await ready;
  await panel.generate();
  assert.equal(asked.length, 0);
  assert.match(root.querySelector('#demand-error').textContent, /2곳 이상/);
});

test('a disconnected pair is visibly excluded rather than silently flown direct', async () => {
  const {panel, root, ready, calls} = mount({generate: async () => ({
    flights: 12, summary: {routed_pairs: 4, blocked_pairs: 2, direct_pairs: 0},
  })});
  await ready;
  root.querySelector('#demand-scope-all').click();
  await panel.generate();
  assert.match(panel.result, /항로 미연결 2개 방향 \(직항 대체 없음\)/);
  assert.match(panel.result, /직항 대체 없음/);
  assert.equal(calls.notices.at(-1)[0], 'warn');
});

test('the initial state downloads as one file and the reset button empties the form', async () => {
  const {panel, root, calls, ready} = mount();
  await ready;
  root.querySelector('#demand-scope-all').click();
  // The button for it is in the summary window now, beside the description of
  // what the file contains; the panel still writes it.
  assert.equal(root.querySelectorAll('#demand-download').length, 0);
  panel.save();
  const saved = calls.saved.at(-1);
  assert.match(saved.name, /^aerodt_multi_setup_20260910010203\.json$/);
  const parsed = JSON.parse(saved.text);
  assert.equal(parsed.vertiports.length, 3);
  assert.equal(parsed.request.pairs.length, 3);
  root.querySelector('#demand-reset').click();
  assert.deepEqual(panel.state.scope, []);
  assert.equal(panel.open, 'scope');
});

// ---- how it is joined up -----------------------------------------------

test('the multi tab holds the setup and gives the map back when it is left', async () => {
  const seen = [];
  const demandPanel = {render: root => {seen.push(['render', root.getAttribute('id')]);}, deactivate: () => seen.push(['deactivate'])};
  const plan = new PlanPanel({document: fakeDocument, demandPanel,
    api: {options: async () => ({vertiports: [], reachable: {}})},
    controlHost: fakeDocument.createElement('div')});
  const body = fakeDocument.createElement('div');
  plan.render(body);
  assert.equal(body.querySelector('#plan-tab-multi').textContent, '다중 비행');
  plan.selectTab('multi');
  assert.deepEqual(seen.at(-1), ['render', 'demand-slot']);
  plan.selectTab('single');
  assert.deepEqual(seen.at(-1), ['deactivate']);
  plan.destroy?.();
});

test('the page joins the panel to the map and the generator endpoint', () => {
  assert.match(app, /createPanel\(DemandPanel,/);
  assert.match(app, /showDemandPairs/);
  assert.match(app, /setDemandEditor/);
  assert.match(app, /setDemandFocus/);
  assert.match(app, /beginScrap/);
  assert.match(app, /cancelScrap/);
  assert.match(app, /\/api\/simulation\/plans\/multi/);
  assert.match(app, /planPanel=createPanel\(PlanPanel,\{api:planApi,demandPanel/);
});

test('the map holds the camera still while a scrap is drawn and gives it back after', () => {
  assert.match(globe, /beginScrap\(/);
  assert.match(globe, /enableInputs=false/);
  assert.match(globe, /cancelScrap\(\)/);
  // Destroying the map must not leave the camera disabled or the box behind.
  // Whichever line ending the file happens to carry: the checkout is mixed and
  // a source-matching test that depends on it fails for a reason nobody meant.
  assert.match(globe, /destroy\(\) \{\r?\n\s*this\.cancelScrap\(\);/);
  assert.match(css, /\.map-scrap\{/);
  assert.match(css, /\.dm-step\{/);
});

const PLANNING_DEFAULTS = {fato_headway_s: 60, turnaround_recovery_s: 120,
  phase_floor_s: {gate_out: 177.5, takeoff: 13.7, climb: 46.1, descent: 45.1, landing: 22.8, gate_in: 160.7},
  phase_mean_s: {gate_out: 146.3}};

test('planning controls load server values, preserve edits and reset only planning', async () => {
  const {panel, root, ready} = mount({demandDefaults: async () => ({schedule_planning: PLANNING_DEFAULTS})});
  await ready;
  panel.setScope(['vp-1', 'vp-2']);
  panel.goto('planning');
  const input = root.querySelector('#dm-planning-fato_headway_s');
  assert.equal(input.value, '60');
  input.oninput({target: {value: '90'}});
  root.querySelector('#dm-planning-gate_out').oninput({target: {value: '200.5'}});
  assert.equal(panel.state.schedule_planning.fato_headway_s, 90);
  assert.equal(panel.state.schedule_planning.phase_floor_s.gate_out, 200.5);
  assert.equal(PLANNING_DEFAULTS.phase_floor_s.gate_out, 177.5);
  await panel.readWeightDefaults();
  assert.equal(panel.state.schedule_planning.fato_headway_s, 90);
  const result = buildRequest(panel.state, RECORDS);
  assert.equal(result.errors, undefined);
  assert.equal(result.request.planning.fato_headway_s, 90);
  assert.equal(result.request.planning.phase_floor_s.gate_out, 200.5);
  root.querySelector('#dm-planning-reset').click();
  assert.deepEqual(panel.state.scope, ['vp-1', 'vp-2']);
  assert.deepEqual(panel.state.schedule_planning, PLANNING_DEFAULTS);
  panel.reset();
  assert.deepEqual(panel.state.schedule_planning, PLANNING_DEFAULTS);
});

test('invalid planning values cannot become a generated request', async () => {
  const {panel, root, ready} = mount({demandDefaults: async () => ({schedule_planning: PLANNING_DEFAULTS})});
  await ready;
  panel.setScope(['vp-1', 'vp-2']);
  const input = root.querySelector('#dm-planning-fato_headway_s');
  for (const value of ['', '-1', '3601', 'NaN']) {
    input.oninput({target: {value}});
    assert.equal(input.getAttribute('aria-invalid'), 'true');
    assert.ok(buildRequest(panel.state, RECORDS).errors.some(error => error.includes('스케줄링 기준')));
  }
  input.oninput({target: {value: '0'}});
  assert.equal(buildRequest(panel.state, RECORDS).errors, undefined);
  assert.equal(input.getAttribute('aria-invalid'), 'false');
});

test('unavailable planning defaults remain explicit and retryable', async () => {
  const {root, ready} = mount({demandDefaults: async () => {throw new Error('offline');}});
  await ready;
  assert.ok(root.querySelector('#dm-planning-retry'));
  assert.match(root.textContent, /서버 기본값을 사용/);
});
