import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {FakeElement, fakeDocument} from './fake_dom.mjs';
import {STAGE_COLORS, alongLeg, bearingDeg, clock, distanceM, legAt, legMarks, metres, mixHeading,
  readRun, sampleFlight, sampleRun, speedKph, totalSeconds} from '../../../../user_application/web/flight_plan.js';
import {FlightLayer, MODEL_HEADING_OFFSET_DEG, VISIBLE_METRES} from '../../../../digital_twin/visualization/web/flight_layer.js';
import {PlanPanel, SPEEDS, arrivalsFor, batteryLevel, firstFlyablePair} from '../../../../user_application/web/domains/uam/planning/plan_panel.js';

const web = new URL('../../../../user_application/web/', import.meta.url);
const app = readFileSync(new URL('app.js', web), 'utf8');
const css = readFileSync(new URL('styles.css', web), 'utf8');
const globe = readFileSync(new URL('../../digital_twin/visualization/web/globe.js', web), 'utf8');
const simulation = readFileSync(new URL('domains/uam/planning/simulation_panel.js', web), 'utf8');

// A plan shaped exactly as the server answers one, small enough to reason about.
const leg = (stage, name, path, start, duration, distance, speed, from, to, extra = {}) => ({
  stage, stage_label: stage, kind: {gate_out: 'ground', gate_in: 'ground', charge: 'ground',
    takeoff: 'vertical', landing: 'vertical'}[stage] ?? 'air',
  segment: 'X', name, path, start_s: start, end_s: start + duration, duration_s: duration,
  distance_m: distance, speed_mps: speed, battery_start_pct: from, battery_end_pct: to,
  energy_kwh: (from - to) / 100 * 110, ...extra});
// The states an engine run produced, as the Data Layer keeps them: a leg and a
// fraction through it, so the display places them against the resolved plan.
const RECORDED = [];
const RUN = {run_id: '20260910T040506Z-abcd1234', label: '여의도 → 봉천',
  summary: {engine: 'kinematic-plan-integrator', states: 0, rate_hz: 5}};
const PLAN = {
  aircraft: {id: 'aerodt_airtaxi', asset_id: 'projectairsim_airtaxi'},
  vehicle: {id: 'UAM-VP1-VP2', label: '에어택시', passengers: 3, capacity: 4},
  departure: {vertiport: 'VP1', name: '여의도', gate: 'G1', fato: 'F1'},
  arrival: {vertiport: 'VP2', name: '봉천', gate: 'G1', fato: 'F2', charger: 'C1'},
  legs: [
    leg('gate_out', 'G1 → F1', [[126.90, 37.50, 20], [126.902, 37.50, 20]], 0, 50, 176, 4, 100, 99.8),
    leg('takeoff', 'F1 이륙', [[126.902, 37.50, 20], [126.902, 37.50, 50]], 50, 10, 0, 3, 99.8, 99),
    leg('cruise', 'F1 → F2', [[126.902, 37.50, 50], [126.92, 37.50, 50]], 60, 40, 1590, 45, 99, 96),
    leg('landing', 'F2 착륙', [[126.92, 37.50, 50], [126.92, 37.50, 20]], 100, 10, 0, 3, 96, 95),
    leg('gate_in', 'F2 → G1', [[126.92, 37.50, 20], [126.922, 37.50, 20]], 110, 50, 176, 4, 95, 94.8),
    leg('charge', 'G1 충전', [[126.922, 37.50, 20], [126.922, 37.50, 20]], 160, 40, 0, 0, 94.8, 100,
      {charge_kwh: 5.7, gate: 'G1', charger: 'C1'}),
  ],
  totals: {duration_s: 200, flight_duration_s: 160, air_distance_m: 1590, ground_distance_m: 352,
    energy_kwh: 5.7, battery_start_pct: 100, battery_landing_pct: 94.8, battery_end_pct: 100, waypoints: 2},
};

// Fill the recorded states from the plan, the way the engine would.
for (let t = 0; t <= 200; t = Math.round((t + 0.2) * 1000) / 1000) {
  const at = sampleFlight(PLAN, Math.min(200, t));
  RECORDED.push({t: Math.min(200, t), leg: at.leg_index, f: at.leg_fraction, stage: at.stage, kind: at.kind,
    mode: at.tilt_deg >= 85 ? 'fixed_wing' : at.tilt_deg <= 5 ? 'multirotor' : 'transition',
    latitude: at.position.latitude, longitude: at.position.longitude,
    altitude_m: at.position.altitude_m, datum: 'msl',
    heading_deg: at.heading_deg, pitch_deg: at.pitch_deg, tilt_deg: at.tilt_deg,
    speed_mps: at.speed_mps, battery_pct: at.battery_pct, distance_done_m: at.distance_done_m});
}
RUN.summary.states = RECORDED.length;

test('a recorded run is read back and looked up, not re-simulated', () => {
  const recorded = readRun(PLAN, RECORDED);
  assert.equal(recorded.length, RECORDED.length);
  assert.equal(recorded[0].stage_label, 'gate_out', 'the leg it belongs to names it');
  assert.equal(recorded[0].passengers, 3, 'and the plan says who is aboard');
  // Between two recorded states the vehicle moves, but what it is doing is one
  // of them rather than an average of two that never happened.
  const between = sampleRun(recorded, 60.1);
  assert.ok(between.time_s === 60.1);
  assert.ok(['takeoff', 'cruise'].includes(between.stage));
  const exact = sampleRun(recorded, 80);
  assert.ok(Math.abs(exact.position.longitude - sampleFlight(PLAN, 80).position.longitude) < 1e-6,
    'a lookup lands where the plan says');
  // Held inside the flight at both ends, like the plan sampler.
  assert.equal(sampleRun(recorded, -10).time_s, 0);
  assert.equal(sampleRun(recorded, 9999).time_s, 200);
  assert.equal(sampleRun(recorded, 9999).done, true);
  assert.equal(sampleRun([], 0), null);
  // Reading back is stateless too.
  assert.deepEqual([0, 40, 120].map(t => sampleRun(recorded, t)),
    [120, 40, 0].map(t => sampleRun(recorded, t)).reverse());
});

test('a heading turns the short way round, so the nose never whips across the compass', () => {
  // The seam at north. A hovering airframe reports 0 and 360 either side of it,
  // and a taxiway corner turns ninety degrees, not two hundred and seventy.
  assert.equal(mixHeading(0, 360, 0.5), 0, 'the same heading twice is not a full turn');
  assert.equal(Math.round(mixHeading(359, 1, 0.5)), 0);
  assert.equal(Math.round(mixHeading(1, 359, 0.5)), 0);
  assert.equal(mixHeading(355, 5, 0.25), 357.5, 'a quarter of the way across the seam');
  assert.equal(Math.round(mixHeading(55, 325, 0.5)), 10, 'the corner turns the near way');
  // Ordinary turns are untouched, and every answer is a heading.
  assert.equal(mixHeading(90, 120, 0), 90);
  assert.equal(mixHeading(90, 120, 1), 120);
  assert.equal(Math.round(mixHeading(90, 120, 0.5)), 105);
  for (const [a, b] of [[0, 179], [10, 350], [200, 20], [359.9, 0.1]]) {
    for (const t of [0, 0.3, 0.5, 0.7, 1]) {
      const at = mixHeading(a, b, t);
      assert.ok(at >= 0 && at < 360, `${a}->${b} at ${t} stays a heading`);
    }
  }
  assert.equal(mixHeading(undefined, 90, 0), 0, 'a missing heading is north, not NaN');
});

test('a recorded run played across the seam turns a degree, not a full circle', () => {
  // Two states either side of north, exactly what a hovering flown airframe
  // records: read between them, the nose must not sweep the long way round.
  const recorded = readRun(PLAN, [
    {t: 0, leg: 1, f: 0, stage: 'takeoff', kind: 'vertical', mode: 'multirotor', latitude: 37.5,
      longitude: 126.902, altitude_m: 20, heading_deg: 359, pitch_deg: 0, tilt_deg: 0,
      speed_mps: 0, battery_pct: 100, distance_done_m: 0},
    {t: 1, leg: 1, f: 1, stage: 'takeoff', kind: 'vertical', mode: 'multirotor', latitude: 37.5,
      longitude: 126.902, altitude_m: 50, heading_deg: 1, pitch_deg: 0, tilt_deg: 0,
      speed_mps: 0, battery_pct: 99, distance_done_m: 0},
  ]);
  for (let t = 0; t <= 1; t += 0.1) {
    const at = sampleRun(recorded, t).heading_deg;
    assert.ok(at > 358 || at < 2, `at ${t.toFixed(1)}s the heading is ${at}, not near north`);
  }
});

test('a plan is sampled by time: any second is a place, a stage and a battery level', () => {
  assert.equal(totalSeconds(PLAN), 200);
  const start = sampleFlight(PLAN, 0);
  assert.equal(start.stage, 'gate_out');
  assert.deepEqual([start.position.longitude, start.position.altitude_m], [126.90, 20]);
  assert.equal(start.battery_pct, 100);
  assert.equal(start.passengers, 3, 'who is aboard travels with the sample');
  // Half way through the taxi is half way along its path and half its battery cost.
  const taxi = sampleFlight(PLAN, 25);
  assert.ok(Math.abs(taxi.position.longitude - 126.901) < 1e-6);
  assert.ok(Math.abs(taxi.battery_pct - 99.9) < 1e-6);
  // The take-off stands still and climbs.
  const lifting = sampleFlight(PLAN, 55);
  assert.equal(lifting.stage, 'takeoff');
  assert.equal(lifting.position.longitude, 126.902, 'a vertical leg does not move over the ground');
  assert.ok(Math.abs(lifting.position.altitude_m - 35) < 1e-6, 'but it does rise');
  assert.equal(lifting.airborne, true);
  // Charging is the only stage the battery climbs in.
  const charging = sampleFlight(PLAN, 180);
  assert.equal(charging.charging, true);
  assert.ok(charging.battery_pct > PLAN.legs[4].battery_end_pct);
  assert.equal(charging.speed_mps, 0);
  assert.equal(charging.color, STAGE_COLORS.charge);
  // Time is held inside the flight at both ends.
  assert.equal(sampleFlight(PLAN, -50).time_s, 0);
  const over = sampleFlight(PLAN, 5000);
  assert.equal(over.time_s, 200);
  assert.equal(over.done, true);
  assert.equal(over.battery_pct, 100);
  assert.equal(sampleFlight({legs: []}, 0), null);
});

test('sampling is stateless, so scrubbing back gives exactly what playing forward gave', () => {
  const forward = [0, 25, 55, 80, 120, 180].map(t => sampleFlight(PLAN, t));
  const backward = [180, 120, 80, 55, 25, 0].map(t => sampleFlight(PLAN, t)).reverse();
  assert.deepEqual(forward, backward);
});

test('a leg that stands still keeps the heading it arrived with, and the distance flown only grows', () => {
  const cruise = sampleFlight(PLAN, 80);
  assert.ok(cruise.heading_deg > 80 && cruise.heading_deg < 100, 'due east along the cruise');
  // Landing and charging do not move, so they hold the cruise heading.
  assert.equal(Math.round(sampleFlight(PLAN, 105).heading_deg), Math.round(cruise.heading_deg));
  assert.equal(Math.round(sampleFlight(PLAN, 180).heading_deg), Math.round(sampleFlight(PLAN, 130).heading_deg));
  let last = -1;
  for (let t = 0; t <= 200; t += 5) {
    const at = sampleFlight(PLAN, t);
    assert.ok(at.distance_done_m >= last, 'distance never goes backwards');
    last = at.distance_done_m;
    assert.ok(at.remaining_s >= 0 && at.remaining_s <= 200);
  }
});

test('the pieces a sample is built from', () => {
  assert.ok(Math.abs(distanceM({latitude: 37.5, longitude: 126.9}, {latitude: 37.5, longitude: 126.902}) - 176.6) < 1);
  assert.equal(Math.round(bearingDeg({latitude: 37.5, longitude: 126.9}, {latitude: 37.5, longitude: 126.91})), 90);
  assert.equal(Math.round(bearingDeg({latitude: 37.5, longitude: 126.9}, {latitude: 37.51, longitude: 126.9})), 0);
  const marks = legMarks(PLAN.legs[0]);
  assert.equal(marks.marks.length, 2);
  assert.ok(marks.total > 170);
  assert.equal(legMarks(PLAN.legs[1]).total, 0, 'a vertical leg covers no ground');
  assert.equal(alongLeg(PLAN.legs[1], 0.5).altitude_m, 35);
  assert.equal(alongLeg({path: []}, 0.5), null);
  assert.equal(legAt(PLAN, 60).index, 2, 'a boundary belongs to the leg that starts there');
  assert.equal(legAt(PLAN, 59.9).index, 1);
  assert.equal(clock(65), '1:05');
  assert.equal(clock(3725), '1:02:05');
  assert.equal(metres(950), '950 m');
  assert.equal(metres(1590), '1.59 km');
  assert.equal(speedKph(45), '162 km/h');
  assert.equal(batteryLevel(80), 'ready');
  assert.equal(batteryLevel(45), 'caution');
  assert.equal(batteryLevel(20), 'low');
});

// ---- the map ----------------------------------------------------------
class Cartesian3 {constructor(x, y, z) {Object.assign(this, {x, y, z});} static fromDegrees(lon, lat, h = 0) {return new Cartesian3(lon, lat, h);}}
class Entities {constructor() {this.values = [];} add(d) {const e = {...d}; this.values.push(e); return e;} remove(e) {this.values = this.values.filter(v => v !== e);}}
class Primitives {constructor() {this.values = [];} add(p) {this.values.push(p); return p;} remove(p) {this.values = this.values.filter(v => v !== p);}}
const C = {Cartesian3, Cartesian2: class {constructor(x, y) {this.x = x; this.y = y;}},
  Color: {fromCssColorString: css => ({css, withAlpha(alpha) {return {css, alpha};}})},
  LabelStyle: {FILL_AND_OUTLINE: 'fo'}, VerticalOrigin: {BOTTOM: 'b'},
  DistanceDisplayCondition: class {constructor(near, far) {this.near = near; this.far = far;}},
  PolylineDashMaterialProperty: class {constructor(o) {Object.assign(this, o); this.dashed = true;}},
  ArcType: {NONE: 'none'}, PrimitiveCollection: Primitives,
  HeadingPitchRoll: class {constructor(h, p, r) {Object.assign(this, {heading: h, pitch: p, roll: r});}},
  Math: {toRadians: degrees => degrees * Math.PI / 180},
  Transforms: {headingPitchRollToFixedFrame: (position, hpr) => ({position, hpr, scale: 1})},
  Matrix4: {multiplyByUniformScale: (matrix, scale) => {matrix.scale = scale; return matrix;}}};

test('the map draws the whole plan once and then only moves the aircraft', () => {
  const entities = new Entities();
  const layer = new FlightLayer(C, {entities, scene: {primitives: new Primitives()}});
  assert.equal(layer.show(PLAN), 6, 'a line per leg, including the ones that stand still');
  const lines = entities.values.filter(e => e.polyline && e.aerodtFlight?.kind === 'leg');
  assert.equal(lines.length, 6);
  assert.equal(lines[2].polyline.material.css, STAGE_COLORS.cruise, 'each leg in its own colour');
  assert.equal(lines[0].polyline.distanceDisplayCondition.far, VISIBLE_METRES);
  const marker = entities.values.find(e => e.point);
  assert.ok(marker && marker.label.text === 'UAM-VP1-VP2');
  assert.equal(marker.label.showBackground,true);
  assert.equal(marker.label.backgroundColor.alpha,.78);
  assert.equal(marker.label.disableDepthTestDistance,0,'boxed flight name still respects opaque occluders');
  const count = entities.values.length;
  // Moving writes positions; nothing is added or removed.
  assert.equal(layer.moveTo(sampleFlight(PLAN, 80)), true);
  assert.equal(entities.values.length, count, 'a played second rebuilds nothing');
  assert.equal(marker.position.x, sampleFlight(PLAN, 80).position.longitude);
  assert.equal(marker.point.color.css, STAGE_COLORS.cruise);
  assert.match(marker.label.text, /cruise/);
  const drop = entities.values.find(e => e.polyline && !e.aerodtFlight);
  assert.equal(drop.polyline.positions[0].z, 0, 'a line down to the ground under it');
  assert.equal(drop.polyline.positions[1].z, marker.position.z);
  assert.equal(layer.moveTo(null), false);
  layer.setVisible(false);
  assert.ok(entities.values.every(e => e.show === false));
  assert.equal(layer.show(null), 0);
  assert.equal(entities.values.length, 0, 'clearing the plan takes it all off');
});

test('the model is turned to fly the path it is on, not ninety degrees across it', () => {
  const entities = new Entities();
  const layer = new FlightLayer(C, {entities, scene: {primitives: new Primitives()}},
    {assets: () => ({uri: '/visual-assets/x.glb', size_m: 8})});
  layer.show(PLAN);
  // The library loads a glTF forward-axis X, but a heading frame points its +Y
  // along the heading, so the frame is built a quarter turn back. Without this
  // the aircraft crabs sideways down the whole cruise — which is what it did.
  assert.equal(MODEL_HEADING_OFFSET_DEG, 90);
  const cruise = sampleFlight(PLAN, 80);
  const matrix = layer.matrixFor(cruise);
  const degrees = radians => Math.round(radians * 180 / Math.PI) || 0;   // no negative zero
  assert.equal(degrees(matrix.hpr.heading), Math.round(cruise.heading_deg) - 90);
  // Metre-authored geometry keeps its native size; no 15 m normalization.
  assert.equal(matrix.scale, 1, 'pose must preserve native metre scale');
  // A leg that stands still keeps the heading it arrived with, so a hover on
  // the deck faces the way it taxied rather than snapping north.
  const hovering = layer.matrixFor(sampleFlight(PLAN, 105));
  assert.equal(degrees(hovering.hpr.heading), degrees(matrix.hpr.heading));
});

// ---- the panel --------------------------------------------------------
const OPTIONS = {
  vertiports: [{id: 'VP1', name: '여의도', gates: ['G1'], takeoff_fato: 'F1', landing_fato: 'F2'},
    {id: 'VP2', name: '봉천', gates: ['G1'], takeoff_fato: 'F1', landing_fato: 'F2'},
    {id: 'VP3', name: '외딴곳', gates: ['G1'], takeoff_fato: 'F1', landing_fato: 'F2'}],
  reachable: {VP1: ['VP2', 'VP3'], VP2: [], VP3: []},
  aircraft: [{id: 'aerodt_airtaxi', passenger_capacity: 4}],
  stages: [], defaults: {passengers: 3, battery_start_pct: 100},
};

function harness({fail = false, options = OPTIONS, run = RUN} = {}) {
  const body = new FakeElement("div"), dock = new FakeElement("div"), page = new FakeElement("main");
  page.append(body, dock);
  const asked = [], preparedAsked = [], plans = [], samples = [], focused = [], followed = [], notices = [];
  let time = 0;
  // A stand-in for requestAnimationFrame: one callback is pending at a time and
  // the player re-books it each frame, which is what a timer cannot model.
  let pending = null, id = 0;
  const panel = new PlanPanel({
    api: {
      options: async () => options,
      prepare: async body => {preparedAsked.push(body); return {plan_id: "plan-test", plan: PLAN};},
      // The engine flies it and the Data Layer keeps it; the panel is handed
      // the recorded run, not a plan to simulate itself.
      fly: async body => {
        asked.push(body);
        if (fail) throw Object.assign(new Error('no'), {data: {message: '항로가 이어지지 않습니다.'}});
        return {run, plan: PLAN, states: RECORDED};
      },
    },
    document: fakeDocument, controlHost: dock, notify: (s, m) => notices.push([s, m]),
    onPlan: plan => plans.push(plan), onSample: sample => samples.push(sample), onFocus: s => focused.push(s),
    onFollow: s => followed.push(s),
    setTimer: fn => {pending = fn; return ++id;}, clearTimer: () => {pending = null;},
    now: () => time,
  });
  const settle = () => new Promise(resolve => setImmediate(resolve));
  // Frames of a fifth of a second, which is inside the step the player clamps
  // a long stall to, so playing `seconds` really advances that many seconds.
  const advance = seconds => {
    for (let left = seconds; left > 1e-9; left -= 0.2) {
      time += Math.min(0.2, left) * 1000;
      const frame = pending; pending = null;
      if (frame) frame();
    }
  };
  return {panel, body, page, dock, asked, preparedAsked, plans, samples, focused, followed, notices, settle, advance,
    frames: () => pending};
}

test('the tab opens on a pair the network can actually fly, and only offers arrivals it reaches', async () => {
  const {panel, body, page} = harness();
  panel.render(body);
  await panel.ready;
  assert.equal(page.querySelector('[name=from_vertiport]').value, 'VP1');
  const values = select => page.querySelector(select).children.map(option => option.attributes.value);
  assert.deepEqual(values('#plan-to_vertiport'), ['VP2', 'VP3']);
  assert.deepEqual(values('#plan-from_vertiport'), ['VP1'], 'VP2 and VP3 reach nowhere, so they are not departures');
  assert.deepEqual(arrivalsFor(OPTIONS, 'VP1').map(item => item.id), ['VP2', 'VP3']);
  assert.deepEqual(firstFlyablePair(OPTIONS), {from: 'VP1', to: 'VP2'});
  assert.equal(firstFlyablePair({vertiports: [], reachable: {}}), null);
  assert.equal(page.querySelector('[name=passengers]').value, '3');
});

test('nothing to fly is said plainly rather than offering an empty form', async () => {
  const {panel, body, page} = harness({options: {...OPTIONS, reachable: {VP1: [], VP2: [], VP3: []}}});
  panel.render(body);
  await panel.ready;
  assert.match(page.querySelector('#plan-no-pair').textContent, /항로 탭에서/);
  assert.equal(page.querySelector('#plan-build'), null);
});

test('생성 asks for the flight, draws it on the map and opens the monitor at the first second', async () => {
  const {panel, body, page, asked, plans, samples, notices, settle} = harness();
  panel.render(body);
  await panel.ready;
  await panel.prepare();
  page.querySelector('#plan-build').click();
  await settle();
  assert.deepEqual(asked, [{plan_id: 'plan-test'}]);
  assert.equal(plans.length, 1, 'the map is given the plan once');
  assert.equal(panel.recorded.length, RECORDED.length, 'and the panel plays the stored states');
  // The provenance line names the engine, so a run walked through the plan is
  // never read as one the airframe and its controller actually flew.
  assert.match(page.querySelector('#plan-source').textContent, /계획 적분 \(동역학 없음\) · \d+개 상태 @ 5 Hz/);
  assert.match(page.querySelector('#plan-source').textContent, /20260910T040506Z-abcd1234/);
  assert.match(notices.at(-1)[1], /저장 20260910T040506Z-abcd1234/);
  assert.equal(samples.at(-1).time_s, 0);
  assert.match(notices.at(-1)[1], /여의도 → 봉천/);
  assert.equal(page.querySelector('#plan-summary').textContent.includes('탑승 3/4명'), true);
  assert.equal(page.querySelector('#plan-stage').textContent, 'gate_out');
  assert.equal(page.querySelector('#plan-clock').textContent, '0:00 / 3:20');
  // The vehicle's own readings are the vehicle's to give when it is selected;
  // the console says where the replay is and what it is flying.
  assert.equal(page.querySelector('#plan-battery-text'), null);
  assert.equal(page.querySelector('#plan-altitude'), null);
  assert.equal(Math.round(samples.at(-1).position.altitude_m), 20, 'the map still gets the height');
  assert.equal(page.querySelectorAll('.flight-phase').length, 6, 'the flight is listed stage by stage');
  assert.equal(page.querySelector('#plan-leg-0').getAttribute('data-state'), 'now');
  assert.equal(page.querySelector('#plan-leg-3').getAttribute('data-state'), 'next');
  assert.match(page.querySelector('#plan-summary').textContent, /비행 2:40 · 충전 포함 3:20/);
});

test('a flight the physics flew says so, and says the taxi was not', async () => {
  const {panel, body, page, settle} = harness({run: {...RUN, summary: {
    ...RUN.summary, engine: 'native-fastphysics-simpleflight',
    ground_engine: 'kinematic-plan-integrator'}}});
  panel.render(body);
  await panel.ready;
  await panel.prepare();
  page.querySelector('#plan-build').click();
  await settle();
  const source = page.querySelector('#plan-source').textContent;
  assert.match(source, /동역학·제어 비행 \(FastPhysics \+ SimpleFlight\)/);
  assert.match(source, /지상 구간은 계획 적분/, 'the ground is not claimed as flown');
});

test('playing advances the flight, the monitor follows it and it stops at the end', async () => {
  const {panel, body, page, samples, advance, settle} = harness();
  panel.render(body);
  await panel.ready;
  await panel.prepare();
  page.querySelector('#plan-build').click();
  await settle();
  panel.setSpeed(1);
  page.querySelector('#plan-play').click();
  assert.equal(page.querySelector('#plan-play').textContent, '일시정지');
  advance(80);
  assert.equal(Math.round(panel.time), 80);
  assert.equal(page.querySelector('#plan-stage').textContent, 'cruise');
  assert.equal(page.querySelector('#plan-rate').textContent, '×1');
  assert.equal(Math.round(samples.at(-1).speed_mps * 3.6), 162, 'the speed goes to the map, not to a readout here');
  assert.equal(page.querySelector('#plan-leg-2').getAttribute('data-state'), 'now');
  assert.equal(page.querySelector('#plan-leg-0').getAttribute('data-state'), 'done');
  assert.ok(samples.at(-1).airborne, 'the map is told where it is on every tick');
  assert.equal(page.querySelector('#plan-scrub').value, '80');
  // Pausing holds it; playing again carries on from there.
  page.querySelector('#plan-play').click();
  const held = panel.time;
  advance(30);
  assert.equal(panel.time, held, 'a paused flight does not move');
  assert.equal(page.querySelector('#plan-play').textContent, '재생');
  page.querySelector('#plan-play').click();
  advance(200);
  assert.equal(panel.time, 200, 'it ends where the plan ends');
  assert.equal(panel.timer, null, 'and stops itself there rather than looping');
  assert.equal(samples.at(-1).charging, true, 'the flight ends plugged in at the stand');
  assert.equal(Math.round(samples.at(-1).battery_pct), 100, 'charged back to full');
});

test('the scrubber, the leg list and the speed button move the same clock', async () => {
  const {panel, body, page, samples, followed, advance, settle} = harness();
  panel.render(body);
  await panel.ready;
  await panel.prepare();
  page.querySelector('#plan-build').click();
  await settle();
  const scrub = page.querySelector('#plan-scrub');
  scrub.value = '150'; scrub.oninput();
  assert.equal(panel.time, 150);
  assert.equal(page.querySelector('#plan-stage').textContent, 'gate_in');
  assert.equal(samples.at(-1).time_s, 150);
  // A leg in the list jumps to where it begins.
  page.querySelector('#plan-leg-5').click();
  assert.equal(panel.time, 160);
  assert.equal(samples.at(-1).charging, true);
  // 처음으로 rewinds and stops.
  page.querySelector('#plan-stop').click();
  assert.equal(panel.time, 0);
  assert.equal(panel.timer, null);
  // The speed button cycles what the server offered.
  // 1, 2, 4, 10, 30: the steps an operator asked for, in that order.
  assert.deepEqual(SPEEDS, [1, 2, 4, 10, 30]);
  const button = page.querySelector('#plan-rate');
  const before = panel.speed;
  button.click();
  assert.equal(panel.speed, SPEEDS[(SPEEDS.indexOf(before) + 1) % SPEEDS.length]);
  // And the right button on it puts the replay back to real time from anywhere.
  button.oncontextmenu({preventDefault: () => {}});
  assert.equal(panel.speed, 1);
  assert.equal(page.querySelector('#plan-rate').textContent, '×1');
  // 기체 추적 rides the camera along, and pressing it again hands it back.
  const follow = page.querySelector('#plan-follow');
  assert.equal(follow.textContent, '추적 중', 'new execution attaches the camera without an extra click');
  assert.equal(panel.following, true);
  assert.equal(follow.textContent, '추적 중');
  assert.equal(followed.at(-1).time_s, 0, 'the camera is put on the aircraft at once');
  const rode = followed.length;
  panel.setSpeed(1);
  panel.play();
  advance(2);
  assert.ok(followed.length > rode + 5, 'and moves with it on every frame, not once a tick');
  panel.pause();
  follow.click();
  assert.equal(panel.following, false);
  assert.equal(followed.at(-1), null, 'letting go hands the camera back');
});

test('a refused flight is reported, while closing the editor does not stop independent replay', async () => {
  const {panel, body, page, settle, advance} = harness({fail: true});
  panel.render(body);
  await panel.ready;
  await panel.prepare();
  page.querySelector('#plan-build').click();
  await settle();
  assert.equal(page.querySelector('#plan-error').textContent, '항로가 이어지지 않습니다.');
  assert.equal(page.querySelector('#plan-vehicle'), null, 'and no monitor is opened for a flight that is not there');
  const other = harness();
  other.panel.render(other.body);
  await other.panel.ready;
  await other.panel.prepare();
  other.page.querySelector('#plan-build').click();
  await other.settle();
  other.page.querySelector('#plan-play').click();
  other.panel.deactivate();
  assert.notEqual(other.panel.timer, null, 'closing the editor leaves the independent replay clock running');
  const held = other.panel.time;
  other.advance(60);
  assert.ok(other.panel.time > held);
  other.panel.destroy();assert.equal(other.panel.timer,null);
});

test('the page and the globe carry the flight plan through to the map', () => {
  assert.match(app, /import \{PlanPanel\} from '\.\/domains\/uam\/planning\/plan_panel\.js(?:\?v=[^']+)?'/);
  assert.match(app, /\/api\/simulation\/plans\/options/);
  assert.match(app, /fly:definition=>sendJSON\('POST','\/api\/simulation\/runs',definition\)/,
    'the page asks the engine to fly it and the Data Layer to keep it');
  assert.match(app, /\/api\/simulation\/runs\/\$\{encodeURIComponent\(runId\)\}\/states/,
    'and can read a stored run back');
  assert.match(app, /onPlan:plan=>\{liveGlobe\?\.showFlightPlan\(plan\);if\(!plan\)liveGlobe\?\.clearHover\(\)/);
  assert.match(app, /onSample:sample=>\{?liveGlobe\?\.moveFlight\(sample\)/);
  assert.match(globe, /this\.flightLayer=new FlightLayer\(C,v,\{assets:/, 'the layer is given the asset catalogue');
  assert.match(globe, /deckTopOf\(id\)/, 'and the deck heights a plan is resolved against');
  assert.match(globe, /this\.flightLayer\?\.pick\(/, 'a click on the aircraft is answered');
  assert.match(app, /groundHeights:points=>liveGlobe\?liveGlobe\.groundHeights\(points\)/);
  assert.match(app, /deckTop:id=>liveGlobe\?\.deckTopOf\(id\)/);
  assert.match(app, /onFlightPick:/, 'the page hears the click');
  assert.match(globe, /showFlightPlan\(plan\)/);
  assert.match(globe, /moveFlight\(sample\)/);
  assert.match(globe, /this\.flightLayer\?\.destroy\(\)/);
  assert.match(simulation, /this\.planPanel\.render\(slot\)/, 'the plans tab delegates like the routes tab');
  assert.match(simulation, /this\.planPanel\?\.deactivate\(\)/);
  assert.match(css, /\.plan-battery-fill\{[^}]*background:#7fe0a3/);
  assert.match(css, /\.plan-leg\[data-state=now\]/);
});

test('single and multi tabs preserve the chosen visual model and never launch on selection', async () => {
  const visual_models=['projectairsim_airtaxi','x_57','joby_s4','kp2a','amvlab_evtol'].map(id=>({id,name:id,note:'visual only'}));
  const h=harness({options:{...OPTIONS,visual_models}});await h.panel.render(h.body);
  assert.equal(h.page.querySelector('#plan-visual_asset_id').children.length,5);
  h.page.querySelector('#plan-visual_asset_id').value='joby_s4';h.panel.showModel();
  h.page.querySelector('#plan-tab-multi').click();
  assert.equal(h.panel.single.hidden,true);assert.equal(h.panel.multi.hidden,false);assert.equal(h.asked.length,0);
  h.page.querySelector('#plan-tab-single').click();assert.equal(h.panel.values().visual_asset_id,'joby_s4');
  h.panel.deactivate();await h.panel.render(h.body);assert.equal(h.panel.values().visual_asset_id,'joby_s4');
  await h.panel.prepare();await h.panel.build();assert.equal(h.preparedAsked[0].visual_asset_id,'joby_s4');assert.equal(h.asked[0].plan_id,'plan-test');
});

test('double-clicking generation cannot create duplicate runs, and failure releases the button', async () => {
  const h=harness({fail:true});await h.panel.render(h.body);
  await h.panel.prepare();const first=h.panel.build(),second=h.panel.build();await Promise.all([first,second]);
  assert.equal(h.asked.length,1);assert.equal(h.page.querySelector('#plan-build').disabled,false);
  await h.panel.build();assert.equal(h.asked.length,2);
});

test('flight model selection is separate from the library and rejects stale model loads', async () => {
  let finish, destroyed=0;
  const loading=new Promise(resolve=>{finish=resolve;});
  const cesium={...C,Axis:{X:0,Y:1},Model:{fromGltfAsync:()=>loading}};
  const original={uri:'/original.glb',metadata_uri:'/asset.json',flight_visual:{uri:'/flight.glb',rotors:{nodes:[]}}};
  const layer=new FlightLayer(cesium,{entities:new Entities(),scene:{primitives:new Primitives()}},{assets:()=>original});
  layer.show({...PLAN,aircraft:{asset_id:'joby_s4'}});
  assert.equal(layer.asset().uri,'/flight.glb');assert.equal(original.uri,'/original.glb');
  layer.sample=sampleFlight(PLAN,0);
  const pending=layer.loadModel();
  layer.show({...PLAN,aircraft:{asset_id:'kp2a'}});
  finish({destroy:()=>destroyed++});await pending;
  assert.equal(destroyed,1);assert.equal(layer.model,null);assert.equal(layer.modelFailed,false);
});

test('reopening the panel during generation keeps its guard and releases the new button', async () => {
  const h=harness();let finish;h.panel.api.fly=()=>new Promise(resolve=>{finish=resolve;});
  await h.panel.render(h.body);await h.panel.prepare();const pending=h.panel.build();h.panel.deactivate();await h.panel.render(h.body);
  assert.equal(h.page.querySelector('#plan-build').disabled,true);
  finish({plan:PLAN,run:RUN,states:RECORDED});await pending;
  assert.equal(h.page.querySelector('#plan-build').disabled,false);
});


test('planning and execution are separate actions; preparation never starts flight or replay', async () => {
  const h=harness();await h.panel.render(h.body);
  assert.equal(h.page.querySelector('#plan-build').disabled,true);
  await h.panel.build();assert.equal(h.asked.length,0);
  h.page.querySelector('#plan-prepare').click();await h.settle();
  assert.equal(h.preparedAsked.length,1);assert.equal(h.asked.length,0);
  assert.equal(h.plans.length,0);assert.equal(h.samples.length,0);
  assert.match(h.page.querySelector('#plan-review-slot').textContent,/plan-test/);
  assert.equal(h.page.querySelector('#plan-build').disabled,false);
  await h.panel.build();assert.deepEqual(h.asked,[{plan_id:'plan-test'}]);
});

test('editing invalidates a prepared plan, including edits without a DOM change event', async () => {
  const h=harness();await h.panel.render(h.body);await h.panel.prepare();
  h.page.querySelector('#plan-passengers').value='1';h.panel.formSlot.oninput();
  assert.equal(h.page.querySelector('#plan-build').disabled,true);
  assert.equal(h.panel.prepared,null);await h.panel.build();assert.equal(h.asked.length,0);
  await h.panel.prepare();h.page.querySelector('#plan-passengers').value='2';
  await h.panel.build();assert.equal(h.asked.length,0);
});

test('late preparation cannot authorize edited inputs and reopening preserves a matching plan', async () => {
  const h=harness();await h.panel.render(h.body);
  let finish,calls=0;h.panel.api.prepare=()=>{calls++;return new Promise(resolve=>{finish=resolve;});};
  const pending=h.panel.prepare();await h.panel.prepare();assert.equal(calls,1);
  h.page.querySelector('#plan-passengers').value='1';
  finish({plan_id:'late',plan:PLAN});await pending;
  assert.equal(h.panel.prepared,null);assert.match(h.panel.error.textContent,/입력이 변경/);
  h.panel.api.prepare=async()=>({plan_id:'current',plan:PLAN});await h.panel.prepare();
  h.panel.deactivate();await h.panel.render(h.body);
  assert.equal(h.panel.prepared.plan_id,'current');assert.equal(h.page.querySelector('#plan-build').disabled,false);
});

test('preparation errors release controls without creating a run', async () => {
  const h=harness();await h.panel.render(h.body);
  h.panel.api.prepare=async()=>{throw new Error('offline');};await h.panel.prepare();
  assert.equal(h.page.querySelector('#plan-prepare').disabled,false);
  assert.equal(h.page.querySelector('#plan-build').disabled,true);assert.equal(h.asked.length,0);
  assert.match(h.panel.error.textContent,/계획을 저장하지 못/);
});

test('the floating controls are outside the editor and keep one clock through fold/reopen', async()=>{
  const h=harness();await h.panel.render(h.body);await h.panel.prepare();await h.panel.build();
  assert.equal(h.body.querySelector('#plan-play'),null);assert.ok(h.dock.querySelector('#plan-play'));
  const bar=h.panel.controls.root;h.panel.play();h.panel.setFollowing(true);
  h.panel.controls.setCollapsed(true);h.panel.deactivate();h.advance(1);
  assert.ok(h.panel.time>0);assert.equal(h.panel.following,true);
  await h.panel.render(h.body);assert.equal(h.panel.controls.root,bar);assert.equal(h.panel.controls.collapsed,true);
  h.page.querySelector('#plan-open-controls').click();assert.equal(h.panel.controls.collapsed,false);
  h.page.querySelector('#flight-focus').click();assert.equal(h.focused.at(-1).time_s,h.panel.time);
  const before=h.panel.time;h.page.querySelector('#flight-forward').click();assert.equal(h.panel.time,before+10);
  h.panel.destroy();assert.equal(h.frames(),null);assert.equal(h.dock.children.length,0);
});

test('destroying the panel during generation cannot resurrect a floating bar',async()=>{
  const h=harness();await h.panel.render(h.body);await h.panel.prepare();
  let finish;h.panel.api.fly=()=>new Promise(resolve=>{finish=resolve;});
  const pending=h.panel.build();h.panel.destroy();finish({plan:PLAN,run:RUN,states:RECORDED});await pending;
  assert.equal(h.plans.length,0);assert.equal(h.dock.children.length,0);assert.equal(h.frames(),null);
});

test('execution auto-follows, manual release persists, the next execution attaches again',async()=>{
  const h=harness();await h.panel.render(h.body);await h.panel.prepare();
  assert.equal(h.followed.length,0,'saving a plan does not move the camera');
  await h.panel.build();assert.equal(h.panel.following,true);assert.equal(h.followed.at(-1).time_s,0);
  h.page.querySelector('#plan-follow').click();assert.equal(h.followed.at(-1),null);
  const released=h.followed.length;h.panel.play();h.advance(1);h.panel.seek(40);
  h.panel.deactivate();await h.panel.render(h.body);
  assert.equal(h.panel.following,false);assert.equal(h.followed.length,released);
  await h.panel.build();assert.equal(h.panel.following,true);assert.equal(h.followed.at(-1).time_s,0);
});

test('cancel clears selected plan, replay, map and camera but preserves editing values',async()=>{
  const h=harness();await h.panel.render(h.body);assert.equal(h.page.querySelector('#plan-clear').disabled,true);
  await h.panel.prepare();await h.panel.build();h.panel.play();h.advance(1);
  const values=h.panel.values();h.page.querySelector('#plan-clear').click();
  assert.equal(h.frames(),null);assert.equal(h.panel.following,false);assert.equal(h.followed.at(-1),null);
  assert.equal(h.plans.at(-1),null);assert.equal(h.samples.at(-1),null);
  assert.equal(h.panel.plan,null);assert.equal(h.panel.run,null);assert.equal(h.panel.recorded,null);
  assert.equal(h.panel.prepared,null);assert.equal(h.panel.time,0);assert.equal(h.dock.children.length,0);
  assert.equal(h.page.querySelector('#plan-build').disabled,true);
  assert.match(h.page.querySelector('#plan-clear-note').textContent,/저장된 계획·실행 기록은 유지/);
  h.panel.deactivate();await h.panel.render(h.body);assert.deepEqual(h.panel.values(),values);
  assert.equal(h.dock.children.length,0);await h.panel.prepare();await h.panel.build();
  assert.ok(h.panel.plan);assert.equal(h.panel.following,true);
});

test('cancel is reachable from a folded bar even when the editor is closed',async()=>{
  const h=harness();await h.panel.render(h.body);await h.panel.prepare();await h.panel.build();
  h.panel.controls.setCollapsed(true);h.panel.deactivate();
  h.page.querySelector('#flight-console-dismiss').click();
  assert.equal(h.dock.children.length,0);assert.equal(h.plans.at(-1),null);assert.equal(h.followed.at(-1),null);
});

test('cancel before execution removes the prepared selection without creating a run',async()=>{
  const h=harness();await h.panel.render(h.body);await h.panel.prepare();
  h.page.querySelector('#plan-clear').click();await h.panel.build();
  assert.equal(h.asked.length,0);assert.equal(h.panel.prepared,null);
});

test('late save after cancellation cannot overwrite a newly saved selection',async()=>{
  const h=harness();await h.panel.render(h.body);let finish;
  h.panel.api.prepare=()=>new Promise(resolve=>{finish=resolve;});const pending=h.panel.prepare();
  h.panel.clearFlight();h.panel.api.prepare=async()=>({plan_id:'new',plan:PLAN});await h.panel.prepare();
  finish({plan_id:'old',plan:PLAN});await pending;
  assert.equal(h.panel.prepared.plan_id,'new');assert.equal(h.panel.preparing,false);
  assert.doesNotMatch(h.page.querySelector('#plan-clear-note').textContent,/취소했습니다/);
});

test('late run success or failure cannot resurrect a cancelled flight or unlock a newer request',async()=>{
  for(const failure of [false,true]){
    const h=harness();await h.panel.render(h.body);await h.panel.prepare();let finish,reject;
    h.panel.api.fly=()=>new Promise((ok,no)=>{finish=ok;reject=no;});const pending=h.panel.build();
    h.panel.clearFlight();assert.match(h.panel.clearNote.textContent,/서버의 저장·계산은 계속될 수/);
    await h.panel.prepare();let finishNew;h.panel.api.fly=()=>new Promise(ok=>{finishNew=ok;});
    const next=h.panel.build();
    if(failure)reject(new Error('old failure'));else finish({plan:PLAN,run:RUN,states:RECORDED});
    await pending;assert.equal(h.panel.building,true);assert.equal(h.panel.plan,null);
    assert.equal(h.dock.children.length,0);assert.equal(h.panel.error.textContent,'');
    finishNew({plan:PLAN,run:RUN,states:RECORDED});await next;
    assert.ok(h.panel.plan);assert.equal(h.panel.following,true);
  }
});

test('cancellation during terrain resolution does not publish a late plan',async()=>{
  const h=harness();await h.panel.render(h.body);await h.panel.prepare();let finish;
  h.panel.groundHeights=()=>new Promise(ok=>{finish=ok;});const pending=h.panel.build();await h.settle();
  assert.equal(typeof finish,'function');h.panel.clearFlight();finish(null);await pending;
  assert.equal(h.panel.plan,null);assert.equal(h.dock.children.length,0);
  assert.ok(h.plans.every(p=>p===null));assert.ok(h.followed.every(s=>s===null));
});

test('simulation selection shares current Library portraits and refreshes when catalog arrives late', async()=>{
  const visual_models=['kp2a','joby_s4'].map(id=>({id,name:id,note:'visual only'}));
  const h=harness({options:{...OPTIONS,visual_models}});await h.panel.render(h.body);
  h.page.querySelector('#plan-visual_asset_id').value='kp2a';h.panel.showModel();
  assert.equal(h.panel.modelPreview.querySelector('img'),null,'no old hard-coded portrait while catalog loads');
  h.panel.setAssets({assets:[{asset_id:'kp2a',thumbnail:'/visual-assets/kp2a/thumbnail_flight_new.jpg'},
    {asset_id:'joby_s4',thumbnail:'/visual-assets/joby_s4/thumbnail_flight_new.jpg'}]});
  assert.equal(h.panel.modelPreview.querySelector('img').getAttribute('src'),'/visual-assets/kp2a/thumbnail_flight_new.jpg');
  h.page.querySelector('#plan-visual_asset_id').value='joby_s4';h.panel.showModel();
  assert.equal(h.panel.modelPreview.querySelector('img').getAttribute('src'),'/visual-assets/joby_s4/thumbnail_flight_new.jpg');
  h.panel.setAssets({assets:[{asset_id:'joby_s4',thumbnail:'/visual-assets/joby_s4/thumbnail_flight_v2.jpg'}]});
  assert.equal(h.panel.modelPreview.querySelector('img').getAttribute('src'),'/visual-assets/joby_s4/thumbnail_flight_v2.jpg');
  assert.equal(h.asked.length,0,'photo refresh never executes a flight');
});

test('seeking explicitly resets the camera spring while normal playback does not',async()=>{
 const h=harness();await h.panel.render(h.body);await h.panel.prepare();await h.panel.build();
 const options=[];h.panel.onFollow=(_sample,option)=>options.push(option);
 h.panel.seek(40);assert.equal(options.at(-1).reset,true);
 h.panel.emit();assert.equal(options.at(-1).reset,false);
 h.panel.pause();
});
