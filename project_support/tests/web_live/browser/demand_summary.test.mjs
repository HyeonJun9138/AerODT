import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {FakeElement, fakeDocument} from './fake_dom.mjs';
import {DEFAULT_WEIGHT, WEIGHT_MAX, WEIGHT_MIN, WEIGHT_STEP, buildRequest, clampWeight,
  defaultState, describeWeights, odDemandPlan, odEstimates, operatingTrips, weightOf, weightRows}
  from '../../../../user_application/web/demand_setup.js';
import {DemandSummary, TOP_PAIRS, barWidth} from '../../../../user_application/web/domains/uam/planning/demand_summary.js';
import {DemandPanel} from '../../../../user_application/web/domains/uam/planning/demand_panel.js';

const web = new URL('../../../../user_application/web/', import.meta.url);
const app = readFileSync(new URL('app.js', web), 'utf8');
const css = readFileSync(new URL('demand_summary.css', web), 'utf8');

const PLACES = [['VP001', '여의도'], ['VP002', '잠실'], ['VP004', '용산'], ['VP013', '강남']];
const VERTIPORTS = PLACES.map(([id, name]) => ({id, name, gates: 4, layout: {gates: [1, 2, 3, 4]},
  latitude: 37.5, longitude: 127, fatos: [{}, {}], heading_deg: 0}));
const DEFAULTS = {
  VP001: {departure: 100, arrival: 100, known: true, source: '영등포·여의도'},
  VP002: {departure: 120, arrival: 100, known: true, source: '잠실'},
  VP004: {departure: 50, arrival: 50, known: true, source: '용산'},
  VP013: {departure: 210, arrival: 160, known: true, source: '강남'},
};
const SCOPE = PLACES.map(([id]) => id);
const KNOWN = new Map(VERTIPORTS.map(record => [record.id, record]));

function state(changes = {}) {
  return {...defaultState(), scope: SCOPE, weight_defaults: DEFAULTS, ...changes};
}

test('a weight is held to the range and the step it is shown in', () => {
  assert.equal(clampWeight(123), 120);
  assert.equal(clampWeight(125), 130, 'halves go up, the way the spinner suggests');
  assert.equal(clampWeight(-40), WEIGHT_MIN);
  assert.equal(clampWeight(9999), WEIGHT_MAX);
  assert.equal(clampWeight('nonsense'), DEFAULT_WEIGHT);
  assert.equal(WEIGHT_STEP, 10);
});

test('a deck the operator has not touched carries the forecast itself', () => {
  const untouched = state();
  assert.equal(weightOf(untouched, 'VP013', 'departure', DEFAULTS), 210);
  assert.equal(weightOf(untouched, 'VP004', 'arrival', DEFAULTS), 50);
  // A deck nobody has a forecast for starts at the average rather than at zero.
  assert.equal(weightOf(untouched, 'VP999', 'departure', DEFAULTS), DEFAULT_WEIGHT);
  // Once it is changed, the change wins.
  const changed = state({weights: {VP013: {departure: 80}}});
  assert.equal(weightOf(changed, 'VP013', 'departure', DEFAULTS), 80);
  assert.equal(weightOf(changed, 'VP013', 'arrival', DEFAULTS), 160, 'the other direction is untouched');
});

test('the weights come to shares over the decks in scope', () => {
  const rows = weightRows(SCOPE, state(), DEFAULTS, KNOWN);
  assert.deepEqual(rows.map(row => row.name), ['여의도', '잠실', '용산', '강남']);
  const total = rows.reduce((sum, row) => sum + row.departure_share, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, 'departures share out the whole day');
  assert.ok(Math.abs(rows.reduce((sum, row) => sum + row.arrival_share, 0) - 1) < 1e-9);
  const gangnam = rows.find(row => row.id === 'VP013');
  assert.equal(gangnam.departure, 210);
  assert.ok(Math.abs(gangnam.departure_share - 210 / 480) < 1e-9);
  assert.equal(gangnam.changed, false, 'and it is the forecast, not an edit');
  // Editing one marks it and moves every share, because they are shares.
  const edited = weightRows(SCOPE, state({weights: {VP004: {departure: 0, arrival: 0}}}), DEFAULTS, KNOWN);
  const yongsan = edited.find(row => row.id === 'VP004');
  assert.equal(yongsan.changed, true);
  assert.equal(yongsan.departure_share, 0);
  assert.ok(edited.find(row => row.id === 'VP013').departure_share > gangnam.departure_share);
});

test('the setting is described the way an operator would say it', () => {
  assert.match(describeWeights(weightRows(SCOPE, state(), DEFAULTS, KNOWN)), /강남 최다 · 출발 210%/);
  const flat = {};
  for (const id of SCOPE) flat[id] = {departure: 100, arrival: 100};
  assert.equal(describeWeights(weightRows(SCOPE, state({weights: flat}), DEFAULTS, KNOWN)),
    '모든 버티포트 100%');
  const off = {...flat, VP004: {departure: 0, arrival: 0}};
  assert.match(describeWeights(weightRows(SCOPE, state({weights: off}), DEFAULTS, KNOWN)), /1곳 0%/);
  assert.equal(describeWeights([]), '먼저 버티포트를 선택하세요');
});

test('the pairs a day is mostly about follow from the two sets of weights', () => {
  const rows = weightRows(SCOPE, state(), DEFAULTS, KNOWN);
  const pairs = [{from: 'VP001', to: 'VP013'}, {from: 'VP002', to: 'VP013'}, {from: 'VP004', to: 'VP001'}];
  const plan = odDemandPlan(rows, pairs, 10000);
  const legs = plan.legs;
  assert.equal(legs.length, 6, 'a joined pair carries both directions');
  assert.ok(legs.reduce((sum, leg) => sum + leg.share, 0) < 1,
    '15% of disconnected OD demand leaves instead of being manufactured elsewhere');
  assert.equal(plan.redistributed_trips + plan.lost_trips, plan.disconnected_trips);
  assert.equal(legs.reduce((sum, leg) => sum + leg.trips, 0), plan.schedulable_trips);
  assert.ok(plan.redistributed_trips > plan.lost_trips && plan.lost_trips > 0);
  assert.ok(legs[0].from_name && legs[0].to_name);
  assert.ok(legs.every((leg, index) => index === 0 || legs[index - 1].share >= leg.share),
    'the displayed alternatives are sorted by their post-diffusion demand');
  // A deck switched off carries nothing in either direction.
  const silent = weightRows(SCOPE, state({weights: {VP013: {departure: 0, arrival: 0}}}), DEFAULTS, KNOWN);
  for (const leg of odEstimates(silent, pairs, 10000)) {
    if (leg.from === 'VP013' || leg.to === 'VP013') assert.equal(leg.trips, 0);
  }
  assert.deepEqual(odEstimates(rows, [], 10000), []);
});

test('the request carries the shares a scheduler consumes', () => {
  const fleet = {fill: 'all', count: 2, seat_class: 'seat4', overrides: {}};
  const {request, errors} = buildRequest(state({fleet}), VERTIPORTS);
  assert.equal(errors, undefined);
  const distribution = request.demand.distribution;
  assert.equal(distribution.basis, 'weight_pct');
  assert.equal(distribution.step, WEIGHT_STEP);
  assert.equal(distribution.vertiports.length, SCOPE.length);
  const gangnam = distribution.vertiports.find(row => row.vertiport === 'VP013');
  assert.equal(gangnam.departure_weight_pct, 210);
  assert.equal(gangnam.arrival_weight_pct, 160);
  assert.ok(Math.abs(gangnam.departure_share - 210 / 480) < 1e-6);
  assert.equal(gangnam.from_reference, true);
  const shares = distribution.vertiports.reduce((sum, row) => sum + row.departure_share, 0);
  assert.ok(Math.abs(shares - 1) < 1e-5);
  // The whole thing is JSON: whoever runs the generator gets it as it stands.
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(request)));
});

test('a day nobody can depart from or arrive at is refused by name', () => {
  const fleet = {fill: 'all', count: 2, seat_class: 'seat4', overrides: {}};
  const nothing = {};
  for (const id of SCOPE) nothing[id] = {departure: 0, arrival: 100};
  const {errors} = buildRequest(state({fleet, weights: nothing}), VERTIPORTS);
  assert.ok(errors.some(problem => /출발 수요 비율이 모두 0/.test(problem)));
  const noArrivals = {};
  for (const id of SCOPE) noArrivals[id] = {departure: 100, arrival: 0};
  assert.ok(buildRequest(state({fleet, weights: noArrivals}), VERTIPORTS).errors
    .some(problem => /도착 수요 비율이 모두 0/.test(problem)));
});

// ---- the panel -------------------------------------------------------------
function panelHarness() {
  const summaries = [];
  const panel = new DemandPanel({
    api: {list: async () => ({vertiports: VERTIPORTS}),
      demandDefaults: async () => ({source: '서울시 통행 수요 기반 출발·도착 비율',
        default_weight: 100, step: 10, min: 0, max: 300,
        profile: {hourly_departure_pct: [1.9581,1.3959,1.0857,.8918,1.2796,2.7142,4.2458,5.3509,5.6223,5.3121,5.1764,5.1377,
          5.0407,5.1764,5.2927,5.4672,5.7387,5.8938,5.7774,5.2540,4.7111,4.4785,4.0132,2.9857]},
        vertiports: PLACES.map(([id, name]) => ({vertiport: id, name, known: true,
          source: name, ...DEFAULTS[id]}))})},
    document: fakeDocument,
    onSummary: (view, actions) => {summaries.push({view, actions});},
  });
  const body = new FakeElement('div');
  const settle = async () => {for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));};
  return {panel, body, summaries, settle};
}

async function opened() {
  const harness = panelHarness();
  harness.panel.render(harness.body);
  await harness.panel.ready;
  await harness.settle();
  harness.panel.setScope(SCOPE);
  harness.panel.goto('demand');
  return harness;
}

test('the demand step lets each deck be set, in tens, against the average', async () => {
  const {panel, body} = await opened();
  const table = body.querySelector('#demand-weight-table');
  assert.ok(table, 'the weights are part of the demand step');
  const input = body.querySelector('#dm-weight-VP013-departure');
  assert.equal(input.value, '210', 'and start from the forecast we were given');
  assert.equal(input.getAttribute('step'), '10');
  assert.equal(input.getAttribute('min'), '0');
  assert.equal(input.getAttribute('max'), '300');
  assert.equal(body.querySelector('#dm-weight-VP004-arrival').value, '50');
  // Setting one moves that row's share without redrawing the form under the
  // cursor, and the header figure follows.
  panel.setWeight('VP013', 'departure', 137);
  assert.equal(body.querySelector('#dm-weight-VP013-departure').value, '140');
  assert.match(body.querySelector('#demand-weight-summary').textContent, /조정됨/);
  const row = body.querySelectorAll('.dm-row-weight').find(node => node.getAttribute('data-id') === 'VP013');
  assert.equal(row.getAttribute('data-changed'), 'true');
});

test('both ways back: to the forecast, or flat', async () => {
  const {panel, body} = await opened();
  panel.setWeight('VP013', 'departure', 0);
  assert.equal(body.querySelector('#dm-weight-VP013-departure').value, '0');
  body.querySelector('#demand-weight-reference').click();
  assert.equal(body.querySelector('#dm-weight-VP013-departure').value, '210', 'back to what we were given');
  assert.deepEqual(panel.state.weights, {});
  body.querySelector('#demand-weight-flat').click();
  assert.equal(body.querySelector('#dm-weight-VP013-departure').value, '100');
  assert.equal(body.querySelector('#dm-weight-VP004-arrival').value, '100');
  assert.match(body.querySelector('#demand-weight-summary').textContent, /모든 버티포트 100%/);
});

test('the button asks for a summary before it asks for a day', async () => {
  const {panel, body, summaries} = await opened();
  const button = body.querySelector('#demand-summary');
  assert.ok(button, 'the request button is now a summary button');
  assert.equal(body.querySelectorAll('#demand-generate').length, 0);
  assert.equal(button.textContent, '생성 요약');
  button.click();
  assert.equal(summaries.length, 1);
  const {view} = summaries[0];
  assert.equal(view.scope.count, SCOPE.length);
  assert.equal(view.weights.length, SCOPE.length);
  assert.ok(view.trips > 0 && view.hours && view.seed);
  assert.equal(view.operating_trips, 53537);
  assert.equal(view.out_of_window_trips, 13963);
  assert.equal(view.od.operating_trips, 53537);
  assert.equal(view.od.redistributed_trips + view.od.lost_trips, view.od.disconnected_trips);
  assert.ok(view.document.kind === 'aerodt.multi_flight_setup');
  // And the two things it can do are handed over with it.
  assert.equal(typeof summaries[0].actions.generate, 'function');
  assert.equal(typeof summaries[0].actions.download, 'function');
});

// ---- the window ------------------------------------------------------------
const VIEW = {
  request: {version: 1}, errors: null, trips: 67500, operating_trips: 53537, out_of_window_trips: 13963,
  demand: '13,500,000 × 0.5% = 67,500명/일', hours: '06:30–21:30 · 15시간', seed: '매번 랜덤',
  scope: {count: 4, pairs: 5, total_pairs: 6},
  weights: weightRows(SCOPE, {scope: SCOPE, weights: {}}, DEFAULTS, KNOWN),
  fleet: {rows: PLACES.map(([id, name]) => ({id, name, gates: 4, aircraft: 4, seats: 16})),
    totals: {aircraft: 16, seats: 64}, capacity: 80000},
  pairs: [{from: 'VP001', to: 'VP013'}, {from: 'VP002', to: 'VP013'}],
  source: '서울시 통행 수요 기반 출발·도착 비율',
  document: {kind: 'aerodt.multi_flight_setup'},
};

function windowHarness(view = VIEW) {
  const mount = new FakeElement('body');
  const calls = [];
  const summary = new DemandSummary({document: fakeDocument, mount});
  summary.open(view, {generate: async () => {calls.push('generate'); return {flights: 900};},
    download: () => calls.push('download')});
  return {summary, mount, calls};
}

test('the summary window says what is about to be generated', () => {
  const {summary, mount} = windowHarness();
  const panel = mount.querySelector('#demand-summary');
  assert.ok(panel, 'it opens as its own window');
  assert.equal(panel.getAttribute('role'), 'dialog');
  assert.match(panel.textContent, /생성 요약/);
  // The four things worth reading first.
  const figures = mount.querySelectorAll('.ds-figure').map(node => node.textContent.replace(/\s+/g, ' '));
  assert.equal(figures.length, 4);
  assert.match(figures[0], /53,537명/);
  assert.match(figures[0], /24시간 67,500명/);
  assert.match(figures[1], /4곳/);
  assert.match(figures[1], /5 \/ 6쌍/);
  assert.match(figures[3], /16대/);
  summary.destroy();
});

test('the distribution is drawn rather than listed, and edits are marked', () => {
  const edited = {...VIEW,
    weights: weightRows(SCOPE, {scope: SCOPE, weights: {VP004: {departure: 0, arrival: 0}}}, DEFAULTS, KNOWN)};
  const {summary, mount} = windowHarness(edited);
  const rows = mount.querySelectorAll('.ds-bar-row');
  assert.equal(rows.length, SCOPE.length);
  // Busiest first, so the shape of the day is the first thing read.
  assert.match(rows[0].textContent, /강남/);
  assert.match(rows[0].textContent, /210%/);
  const yongsan = rows.find(node => node.getAttribute('data-id') === 'VP004');
  assert.equal(yongsan.getAttribute('data-changed'), 'true');
  assert.equal(yongsan.getAttribute('data-off'), 'true');
  // Both directions on the same row: sends a lot but receives little is the
  // thing worth seeing, and two lists would hide it.
  assert.equal(rows[0].querySelectorAll('.ds-bar').length, 2);
  assert.equal(mount.querySelectorAll('.ds-bar-departure').length, SCOPE.length);
  assert.equal(mount.querySelectorAll('.ds-bar-arrival').length, SCOPE.length);
  assert.match(mount.querySelector('#demand-summary').textContent, /서울시 통행 수요/);
  summary.destroy();
});

test('bars are drawn against the biggest share, not against the whole', () => {
  assert.equal(barWidth(0.2, 0.2), 100);
  assert.equal(barWidth(0.1, 0.2), 50);
  assert.equal(barWidth(0, 0.2), 2, 'a deck at zero still has a row to point at');
  assert.equal(barWidth(0.1, 0), 0);
});

test('the busiest routes are listed with what they would carry', () => {
  const {summary, mount} = windowHarness();
  const rows = mount.querySelectorAll('.ds-pair-row');
  assert.ok(rows.length > 0 && rows.length <= TOP_PAIRS);
  assert.match(rows[0].textContent, /→/);
  assert.match(rows[0].textContent, /명/);
  // It is said to be an estimate, because it is one.
  assert.match(mount.querySelector('#demand-summary').textContent, /참고 추정/);
  summary.destroy();
});

test('seat supply below the day it has to carry is said in the window', () => {
  const {summary, mount} = windowHarness({...VIEW, fleet: {...VIEW.fleet, capacity: 1000}});
  assert.match(mount.querySelector('#demand-summary-capacity').textContent, /공급이 수요보다 적습니다/);
  assert.equal(mount.querySelector('#demand-summary-capacity').className, 'ds-warn');
  summary.destroy();
  const enough = windowHarness();
  assert.equal(enough.mount.querySelector('#demand-summary-capacity').className, 'ds-note');
  enough.summary.destroy();
});

test('the window states how disconnected demand is diffused and reduced', () => {
  const od = {disconnected_trips: 1000, redistributed_trips: 850, lost_trips: 150,
    schedulable_trips: 53387, legs: []};
  const {summary, mount} = windowHarness({...VIEW, od});
  const note = mount.querySelector('#demand-summary-network-demand').textContent;
  assert.match(note, /1,000명 중 850명은 대체 항로로 분산/);
  assert.match(note, /150명은 다른 교통수단·시간대로 이탈/);
  assert.match(note, /최종 항로 반영 수요는 53,387명/);
  summary.destroy();
});

test('the request is made from the window, and closing leaves the settings alone', async () => {
  const {summary, mount, calls} = windowHarness();
  mount.querySelector('#demand-summary-download').click();
  assert.deepEqual(calls, ['download']);
  await mount.querySelector('#demand-summary-run').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['download', 'generate']);
  assert.equal(summary.isOpen, false, 'a request that went through closes the summary of it');
  // Closing by hand asks for nothing.
  const second = windowHarness();
  second.mount.querySelector('#demand-summary-close').click();
  assert.equal(second.summary.isOpen, false);
  assert.deepEqual(second.calls, []);
});

test('a setup that cannot be requested says why and does not offer to', () => {
  const {summary, mount} = windowHarness({...VIEW, request: null,
    errors: ['버티포트를 2곳 이상 선택하세요.', '배치된 기체가 없습니다. 초기 상태에서 기체를 배치하세요.']});
  const problems = mount.querySelector('#demand-summary-problems').querySelectorAll('li')
    .map(node => node.textContent);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /2곳 이상/);
  assert.equal(mount.querySelector('#demand-summary-run').disabled, true);
  summary.destroy();
});

test('the page wires the window to the panel, and the styles exist', () => {
  assert.match(app, /createPanel\(DemandSummary,\{document,mount:document\.body/);
  assert.match(app, /onSummary:\(view,actions\)=>demandSummary\.open\(view,actions\)/);
  assert.match(app, /demandDefaults:\(\)=>getJSON\('\/api\/simulation\/demand\/defaults'\)/);
  assert.match(css, /\.demand-summary\{/);
  // It stands beside the settings it summarises, and follows the drawer the way
  // every other left-anchored panel does.
  assert.match(css, /left:calc\(var\(--left-offset\) \+ var\(--edge\)\)/);
  assert.doesNotMatch(css, /\.demand-summary\{[^}]*right:var\(--edge\)/);
  assert.match(css, /\.ds-bar-row\[data-changed=true\]\{/);
  assert.match(css, /\.dm-row-weight\{/);
});


// A day generated here arrives already read and set out by the server, so it
// goes through the one place a loaded day is shown rather than growing a second.
test('a generated day is adopted the same way the example one is', async () => {
  const {panel} = await opened();
  const loaded = [];
  panel.onPlanLoaded = description => {loaded.push(description);};
  panel.planError = '전에 실패했던 내용';
  const description = {name: '생성된 비행계획 · 1644편',
    schedule: {flights: 1644, model_spans: {a4: 11}}};
  const answer = await panel.adoptPlan(description);
  assert.equal(answer, description);
  assert.equal(panel.plan, description);
  assert.equal(panel.planError, '', 'a day that arrived clears whatever failed before it');
  assert.equal(panel.planBusy, '');
  assert.deepEqual(loaded, [description], 'the map is told what it is about to draw');
  assert.equal(await panel.adoptPlan(null), null, 'nothing to adopt changes nothing');
  assert.equal(panel.plan, description);
  assert.equal(panel.forgetPlan(), true);
  assert.equal(panel.plan, null);
});


test('planning summary shows the edited request without excluded-feature notices', () => {
  const {mount} = windowHarness({...VIEW, request: {...VIEW.request,
    planning: {fato_headway_s: 90, turnaround_recovery_s: 180}}});
  const content = mount.querySelector('#demand-summary-planning').textContent;
  assert.match(content, /FATO별 90초/);
  assert.match(content, /회복여유 180초/);
  assert.doesNotMatch(content, /공중 항로|충돌은 제외/);
});
