// The flown track, the people on the decks, and what the mission panel says
// about both.
//
// Two layers and one panel row. The track is where the aircraft has been, drawn
// only for the selected UAM; the passengers are a fixed budget of bodies spent
// on the walks nearest the camera. Neither invents a position: they draw what
// the day served.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {FakeElement, fakeDocument} from './fake_dom.mjs';

const web = new URL('../../../../user_application/web/', import.meta.url);
const visual = new URL('../../../../digital_twin/visualization/web/', import.meta.url);
const details = await import(new URL('entity_details.js', web).href);
const {FlightTrackLayer} = await import(new URL('flight_track_layer.js', visual).href);
const {ScenarioPassengerLayer, PASSENGER_BUDGET} =
  await import(new URL('scenario_passengers.js', visual).href);
const {walkersAt, boardingAt} = await import(new URL('passenger_boarding.js', visual).href);
const panelSource = readFileSync(new URL('selection_panel.js', web), 'utf8')
  .replace("'./entity_details.js'", JSON.stringify(new URL('entity_details.js', web).href))
  .replace("'/visualization/model_preview.js'", JSON.stringify(new URL('model_preview.js', visual).href))
  .replace("'/visualization/entity_labels.js'", JSON.stringify(new URL('entity_labels.js', visual).href))
  .replace("'./physical_uam_panel.js'", JSON.stringify(new URL('physical_uam_panel.js', web).href));
const panel = await import(`data:text/javascript;base64,${Buffer.from(panelSource).toString('base64')}`);
const globe = readFileSync(new URL('globe.js', visual), 'utf8');
const app = readFileSync(new URL('app.js', web), 'utf8');

// ---- a small Cesium ---------------------------------------------------------
class Cartesian3 {
  constructor(x = 0, y = 0, z = 0) {Object.assign(this, {x, y, z});}
  static fromDegrees(longitude, latitude, height = 0, _e, result) {
    const point = result ?? new Cartesian3();
    Object.assign(point, {x: longitude * 1000, y: latitude * 1000, z: height});
    return point;
  }
  static distance(a, b) {return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);}
  clone() {return new Cartesian3(this.x, this.y, this.z);}
}
class Polylines {
  constructor() {this.values = [];}
  add(options) {this.values.push(options); return options;}
  remove(line) {this.values = this.values.filter(item => item !== line);}
}
class Primitives {
  constructor() {this.values = [];}
  add(item) {this.values.push(item); return item;}
  remove(item) {this.values = this.values.filter(value => value !== item);}
}
const C = {
  Cartesian3, PolylineCollection: Polylines, PrimitiveCollection: Primitives,
  Matrix4: class {static IDENTITY = {clone: () => ({})};},
  Color: {fromCssColorString: value => ({value, withAlpha: alpha => ({value, alpha})}),
    BLACK: {withAlpha: alpha => ({black: alpha})}},
  Material: {fromType: (type, options) => ({type, options})},
  Math: {toRadians: degrees => degrees * Math.PI / 180},
  HeadingPitchRoll: class {constructor(h, p, r) {Object.assign(this, {h, p, r});}},
  Transforms: {headingPitchRollToFixedFrame: (position, hpr, _e, _f, result) =>
    Object.assign(result ?? {}, {position: {...position}, heading: hpr.h})},
  Axis: {Z: 'z', Y: 'y'}, ModelAnimationLoop: {REPEAT: 'repeat'},
  Model: {fromGltfAsync: async options => ({...options, show: false, ready: true,
    activeAnimations: {animateWhilePaused: false, add() {}}, destroy() {}})},
};
const viewer = (camera = new Cartesian3()) => ({scene: {primitives: new Primitives(),
  camera: {positionWC: camera},
  requestRender() {this.rendered = (this.rendered ?? 0) + 1;}}});

const trackOf = (count, flying = true) => ({
  aircraft_id: 'UAM0007', flight_id: 'FPL000031', flying, departed_s: 100, time_s: 400,
  points: Array.from({length: count}, (_, index) =>
    [126.92 + index * 0.001, 37.52 + index * 0.001, 300 + index, 100 + index * 2]),
});

test('missing flown tracks back off and a slow request never overlaps another',async()=>{
  let clock=0,calls=0,resolve;
  const layer=new FlightTrackLayer(C,viewer(),{now:()=>clock,load:()=>{calls++;return new Promise(r=>resolve=r);}});
  const selected={entity_id:'scenario:UAM0037',kind:'uam'};
  const first=layer.show(selected);clock=5000;layer.update();assert.equal(calls,1);
  resolve(null);await first;
  clock=8000;await layer.show(selected);assert.equal(calls,1,'backoff starts after the failed response');
  clock=11000;const retry=layer.show(selected);assert.equal(calls,2);resolve(trackOf(4));await retry;
  clock=14000;const normal=layer.show(selected);assert.equal(calls,3);resolve(trackOf(4));await normal;
  layer.clear();clock=90000;layer.update();assert.equal(calls,3);
});

test('the flown line ends on the aircraft instead of where it was a few seconds ago', async () => {
  // The twin is asked for the track every few seconds, so its last point always
  // lags. Without a live end the line stopped short and jumped forward on each
  // answer, which at replay speed is hundreds of metres at a time.
  const view = viewer();
  let where = null;
  let clock = 0;
  const layer = new FlightTrackLayer(C, view, {load: async () => trackOf(6),
    anchor: () => where, now: () => clock});
  await layer.show({entity_id: 'scenario:UAM0007', kind: 'uam'});
  const history = layer.polylines.values[0].positions.length;

  // The aircraft has moved on since that answer: the line follows it.
  where = {x: 1, y: 2, z: 3};
  assert.equal(layer.update(), true, 'the end of the line moved');
  assert.equal(layer.polylines.values[0].positions.length, history + 1);
  assert.deepEqual(layer.polylines.values[0].positions.at(-1), where, 'and it ends on the aircraft');

  // It keeps following, without asking the twin again.
  where = {x: 40, y: 2, z: 3};
  assert.equal(layer.update(), true);
  assert.deepEqual(layer.polylines.values[0].positions.at(-1), where);

  // Standing still costs nothing: no redraw for a tip that has not moved.
  assert.equal(layer.update(), false, 'an aircraft that has not moved is not redrawn');

  // No live position to be had — a track of an aircraft that is not on screen —
  // and the line is simply the history, as it always was.
  where = null;
  layer.tip = null;
  await layer.show({entity_id: 'scenario:UAM0007', kind: 'uam'}, {force: true});
  assert.equal(layer.polylines.values[0].positions.length, history);
  layer.clear();
});

test('the flown track is drawn for a UAM, replaced on the next answer, and cleared on deselect', async () => {
  const view = viewer();
  const summaries = [];
  const layer = new FlightTrackLayer(C, view, {load: async () => trackOf(6),
    onSummary: summary => summaries.push(summary), now: () => 0});
  await layer.show({entity_id: 'scenario:UAM0007', kind: 'uam'});
  assert.equal(layer.polylines.values.length, 1, 'one line, not one per fetch');
  assert.equal(layer.polylines.values[0].positions.length, 6);
  assert.equal(summaries.at(-1).points, 6);
  assert.equal(summaries.at(-1).flightId, 'FPL000031');

  await layer.show({entity_id: 'scenario:UAM0007', kind: 'uam'}, {force: true});
  assert.equal(layer.polylines.values.length, 1, 'the old line is removed before the new one');

  layer.clear();
  assert.equal(layer.polylines.values.length, 0);
  assert.equal(summaries.at(-1), null);
});

test('nothing is asked for or drawn for anything that is not a scheduled UAM', async () => {
  const view = viewer();
  let asked = 0;
  const layer = new FlightTrackLayer(C, view, {load: async () => {asked += 1; return trackOf(4);}, now: () => 0});
  for (const entity of [{entity_id: 'a', kind: 'aircraft'}, {entity_id: 's', kind: 'satellite'}, null]) {
    await layer.show(entity);
  }
  assert.equal(asked, 0);
  assert.equal(layer.polylines.values.length, 0);
});

test('a track is thinned to its cap but still ends where the aircraft is', async () => {
  const view = viewer();
  const layer = new FlightTrackLayer(C, view, {load: async () => trackOf(50), maximumPoints: 10, now: () => 0});
  await layer.show({entity_id: 'scenario:UAM0007', kind: 'uam'});
  const positions = layer.polylines.values[0].positions;
  assert.ok(positions.length <= 12, `thinned to ${positions.length}`);
  const last = positions.at(-1);
  assert.equal(last.x, Cartesian3.fromDegrees(126.92 + 49 * 0.001, 0, 0).x, 'the newest point survives');
  // A track with fewer than two points is not a line.
  const short = new FlightTrackLayer(C, viewer(), {load: async () => trackOf(1), now: () => 0});
  await short.show({entity_id: 'scenario:UAM0007', kind: 'uam'});
  assert.equal(short.polylines.values.length, 0);
});

// ---- the people -------------------------------------------------------------
const walkOf = (id, count, elapsed, longitude = 126.92) => ({
  aircraft_id: id, flight_id: `F${id}`, phase: 'boarding', vertiport: 'VP001', stand: 'G1',
  elapsed_s: elapsed, duration_s: 40, count, on_board: 0, deck_m: 20,
  walk: {count, path: [[longitude, 37.52], [longitude + 0.0002, 37.5202]],
    distances_m: [0, 25], walk_mps: 1.2, walk_s: 20.8, enter_s: 2, duration_s: 40,
    release_s: Array.from({length: count}, (_, index) => 1 + index * 1.5),
    asset_id: 'kenney_blocky_person_a', height_m: 1.75, alighting: false},
});

test('the day draws people from the served walk, nearest deck first, inside its budget', async () => {
  // Two decks: one under the camera, one far away.
  const far = 126.92 + 5;
  const view = viewer(Cartesian3.fromDegrees(126.92, 37.52, 20.03));
  const layer = new ScenarioPassengerLayer(C, view.scene, {
    load: async () => ({aircraft: [walkOf('A', 6, 12, far), walkOf('B', 6, 12)]}),
    assets: () => ({uri: 'person.glb'}), budget: 4, visible_m: 900, now: () => 0});
  layer.setShown(true);
  await layer.refresh();
  layer.fetchedAt = 0;
  layer.update();
  await new Promise(resolve => setImmediate(resolve));
  layer.update();
  assert.equal(layer.slots.length, 4, 'the pool is the budget, not the crowd');
  const shown = layer.slots.filter(slot => slot.model.show).length;
  assert.ok(shown > 0 && shown <= 4, `drew ${shown}`);
  // Only the near deck's people; the far one is out of range entirely.
  const walking = layer.people(view.scene.camera.positionWC);
  assert.ok(walking.length > 0);
  assert.ok(walking.every(item => item.distance < 900));
  assert.ok(walking.every(item => item.height === 20.03), 'they stand on the deck');

  layer.setShown(false);
  assert.equal(layer.slots.filter(slot => slot.model.show).length, 0);
});

test('a walk places people along its own path and finishes', () => {
  const schedule = walkOf('A', 3, 0).walk;
  assert.equal(walkersAt(schedule, -5).passengers.every(person => !person.visible), true);
  const midway = walkersAt(schedule, 8);
  assert.ok(midway.passengers.some(person => person.visible));
  for (const person of midway.passengers.filter(item => item.visible)) {
    assert.ok(person.longitude >= 126.92 && person.longitude <= 126.9202);
    assert.ok(Number.isFinite(person.heading));
  }
  const done = walkersAt(schedule, 60);
  assert.equal(done.active, false);
  assert.equal(done.passengers.every(person => !person.visible), true);
  assert.equal(walkersAt(null, 1), null);
  // The single-flight replay still reads its plan through the same maths.
  const plan = {legs: [{stage: 'gate_out', path: [[126.92, 37.52, 20]]}], boarding: schedule};
  assert.equal(boardingAt(plan, 8).phase, 'boarding');
  assert.equal(boardingAt(plan, Number.NaN), null);
});

test('scenario passengers stand on the rendered deck even when its terrain differs from the server DEM',()=>{
  const view=viewer(Cartesian3.fromDegrees(126.92,37.52,95.03));
  let top=95;
  const layer=new ScenarioPassengerLayer(C,view.scene,{deckTop:id=>id==='VP001'?top:null});
  const walk=walkOf('A',3,8);layer.walks=[walk];
  assert.ok(layer.people(view.scene.camera.positionWC).every(p=>p.height===95.03));
  top=0;assert.ok(layer.people(view.scene.camera.positionWC).every(p=>p.height===.03));
  top=null;assert.ok(layer.people(view.scene.camera.positionWC).every(p=>p.height===20.03));
  assert.equal(walk.deck_m,20,'the received schedule is not edited');
});

test('a walk carries on between answers instead of standing still and teleporting', async () => {
  // The server is asked once every refresh. At four times speed that is six
  // seconds of walking per answer, so without carrying the clock forward
  // everybody stands still and then jumps.
  const view = viewer(Cartesian3.fromDegrees(126.92, 37.52, 20.03));
  let wall = 0, day = 1000;
  const layer = new ScenarioPassengerLayer(C, view.scene, {
    load: async () => ({time_s: day, aircraft: [walkOf('A', 4, day - 1000)]}),
    assets: () => ({uri: 'person.glb'}), now: () => wall});
  layer.setShown(true);
  const where = () => layer.people(view.scene.camera.positionWC)[0]?.person.longitude;

  await layer.refresh();                       // the first answer sets no rate
  assert.equal(layer.rate, 0, 'one answer says nothing about how fast the day runs');
  const still = where();
  wall = 1000;
  assert.equal(where(), still, 'and until it does, nobody is moved on a guess');

  day = 1004; wall = 1000;                     // one second of wall, four of day
  await layer.refresh();
  assert.equal(Math.round(layer.rate), 4, 'two answers do: four day-seconds per wall-second');
  const atFetch = where();
  wall = 1500;
  const halfway = where();
  assert.ok(halfway > atFetch, 'the walk goes on between answers');
  wall = 1750;
  assert.ok(where() > halfway, 'and keeps going');

  // It must never run past where the next answer will put it: a walker who
  // pauses reads as a walker, one who jumps backwards reads as a broken screen.
  wall = 9000;
  const runaway = where();
  wall = 90000;
  assert.equal(where(), runaway, 'a late answer stops the walk rather than letting it run away');
});

test('moving the clock is not a speed, and a paused day does not walk', async () => {
  const view = viewer(Cartesian3.fromDegrees(126.92, 37.52, 20.03));
  let wall = 0, day = 1000;
  const layer = new ScenarioPassengerLayer(C, view.scene, {
    load: async () => ({time_s: day, aircraft: [walkOf('A', 4, 8)]}),
    assets: () => ({uri: 'person.glb'}), now: () => wall});
  layer.setShown(true);
  await layer.refresh();
  wall = 1000; day = 1004;
  await layer.refresh();
  assert.equal(Math.round(layer.rate), 4);

  // Paused: the day's clock stops, so the walk does.
  wall = 2000;
  await layer.refresh();
  assert.equal(layer.rate, 0, 'a paused day measures no speed');
  const stopped = layer.people(view.scene.camera.positionWC)[0].person.longitude;
  wall = 3500;
  assert.equal(layer.people(view.scene.camera.positionWC)[0].person.longitude, stopped);

  // Somebody dragging the clock is not the day passing.
  wall = 4000; day = 40000;
  await layer.refresh();
  assert.equal(layer.rate, 0, 'a leap is a seek, not a speed');
  wall = 5000; day = 20000;
  await layer.refresh();
  assert.equal(layer.rate, 0, 'and neither is going backwards');
  // An answer with no clock in it leaves nothing to carry from.
  layer.measure(Number.NaN, 6000);
  assert.equal(layer.rate, 0);
  assert.equal(layer.carried(), 0);
});

test('the people are moved every frame, not on the slow surface schedule', () => {
  // Five updates a second is a walk in stop motion, and on a deck the camera is
  // close to that is all anyone sees. The fetch inside the layer keeps its own
  // slower schedule.
  const walk = globe.indexOf('scenarioPassengers?.update()');
  const gate = globe.indexOf('now-this.lastSurface<200');
  assert.ok(walk > 0 && gate > 0);
  assert.ok(walk < gate, 'the walk update must run before the surface-work gate returns');
});

test('people are on the map only while a day is being replayed', () => {
  assert.match(globe, /setScenarioPassengers\(shown\)/);
  assert.match(app, /setScenarioPassengers\?\.\(true\)/, 'switched on when the console opens');
  assert.match(app, /setScenarioPassengers\?\.\(false\)/, 'and off when it closes');
  assert.equal(PASSENGER_BUDGET > 0 && PASSENGER_BUDGET <= 64, true);
});

// ---- what the panel says about them ----------------------------------------
const missionOf = extra => ({
  state: {aircraft_id: 'UAM0007', flight_id: 'FPL000031', phase: 'cruise', airborne: true,
    speed_mps: 44.5, seats: 4, passengers: 4, on_board: 4, tilt_deg: 90,
    flight_mode: 'fixed_wing', flight_mode_label: '고정익',
    adherence: {progress: 0.42, plan_share: 0.5, remaining_s: 300, delay_s: 95,
      planned_touchdown_s: 1000, expected_touchdown_s: 1095},
    origin: 'VP001', destination: 'VP013', holding: false, hold_seconds: 0, sequence: null,
    ...extra},
  flight: {origin_name: '여의도', destination_name: '강남'}, clearance: null, remaining: 12,
});
const value = (view, key) => view.fields.find(field => field.key === key)?.value;

test('the panel says the mode, the progress, the plan it is against, and the tilt', () => {
  const view = details.describeMission(missionOf());
  assert.equal(value(view, 'mode'), '고정익');
  assert.equal(view.mode, '고정익');
  assert.match(value(view, 'progress'), /42%/);
  assert.match(value(view, 'progress'), /착륙까지 5분/);
  assert.equal(value(view, 'adherence'), '2분 늦음 (+95초)');
  assert.equal(value(view, 'tilt'), '90°');
  assert.equal(view.progress, 0.42);
  assert.equal(view.plannedShare, 0.5);
  // On time is said as on time, not as zero minutes late.
  const punctual = details.describeMission(missionOf({adherence: {progress: 0.5, delay_s: -4}}));
  assert.match(value(punctual, 'adherence'), /계획대로/);
  assert.equal(details.adherenceText({}), null, 'a flight with no planned time claims nothing');
  assert.equal(details.adherenceText({delay_s: -400}), '7분 빠름 (-400초)');
});

test('the mode falls back to the tilt, and a parked aircraft is on the ground', () => {
  assert.equal(details.flightMode({tilt_deg: 90}), '고정익');
  assert.equal(details.flightMode({tilt_deg: 40}), '모드 전환 (천이)');
  assert.equal(details.flightMode({tilt_deg: 0}), '멀티로터');
  assert.equal(details.flightMode({flight_mode: 'ground'}), '지상');
  assert.equal(details.flightMode({}), '정보 없음');
  const parked = details.describeMission({state: {phase: 'parked', airborne: false, seats: 4,
    passengers: 0, on_board: 0, vertiport: 'VP001', stand: 'G1', flight_mode: 'ground',
    flight_mode_label: '지상'}});
  assert.equal(value(parked, 'mode'), '지상');
  assert.equal(value(parked, 'tilt'), undefined, 'a parked aircraft is not reporting a tilt');
  assert.equal(value(parked, 'progress'), undefined);
});

test('boarding and alighting are counted on the panel, and the map line says what is drawn', () => {
  const boarding = details.describeMission(missionOf({phase: 'gate_out', airborne: false,
    on_board: 2, passenger_flow: {phase: 'boarding', count: 4, moved: 2, on_board: 2, share: 0.5}}));
  assert.equal(value(boarding, 'seats'), '4석 · 2명');
  assert.equal(value(boarding, 'flow'), '2 / 4명 (50%)');
  assert.equal(boarding.fields.find(field => field.key === 'flow').label, '탑승');

  const alighting = details.describeMission(missionOf({phase: 'parked', airborne: false,
    flight_id: null, on_board: 1,
    passenger_flow: {phase: 'alighting', count: 4, moved: 3, on_board: 1, share: 0.75}}));
  assert.equal(alighting.fields.find(field => field.key === 'flow').label, '하기');
  assert.equal(value(alighting, 'flow'), '3 / 4명 (75%)');

  const drawn = details.describeMission({...missionOf(), paths: '지나온 항적 120점 · 예상 경로'});
  assert.equal(value(drawn, 'paths'), '지나온 항적 120점 · 예상 경로');
  assert.equal(value(details.describeMission(missionOf()), 'paths'), undefined);
});

test('the panel paints a progress bar and marks where the plan said it would be', () => {
  const nodes = Object.fromEntries(['mission', 'mission-title', 'mission-detail', 'mission-note',
    'mission-progress', 'mission-planned'].map(id => [id, new FakeElement('div')]));
  const saved = globalThis.document;
  globalThis.document = fakeDocument;
  try {
    const {SelectionPanel} = panel;
    const view = Object.assign(Object.create(SelectionPanel.prototype),
      {entityId: 'scenario:UAM0007', $: id => nodes[id]});
    SelectionPanel.prototype.setMission.call(view, missionOf());
    assert.equal(nodes['mission-progress'].hidden, false);
    assert.equal(nodes['mission-progress'].style['--done'], '42.0%');
    assert.equal(nodes['mission-planned'].hidden, false);
    assert.equal(nodes['mission-planned'].style['--planned'], '50.0%');
    assert.equal(nodes.mission.dataset.mode, '고정익');

    // A parked aircraft has no flight to be part-way through.
    SelectionPanel.prototype.setMission.call(view, {state: {phase: 'parked', airborne: false,
      seats: 4, passengers: 0, vertiport: 'VP001', stand: 'G1'}});
    assert.equal(nodes['mission-progress'].hidden, true);
  } finally {globalThis.document = saved;}
});

test('flown track follows structured display anchors on every frame without refetch', async () => {
  let requests=0;
  const anchor={displayPosition:[1,2,3],time:100,epoch:1};
  const layer=new FlightTrackLayer(C,viewer(),{
    load:async()=>{requests++;return trackOf(6);},anchor:()=>anchor,now:()=>0});
  await layer.show({entity_id:'scenario:UAM0007',kind:'uam'});
  const line=layer.line;
  for(let frame=1;frame<=60;frame++){
    anchor.displayPosition[0]=1+frame*.02;
    assert.equal(layer.update(),true);
    assert.equal(line.positions.at(-1).x,anchor.displayPosition[0]);
  }
  assert.equal(requests,1);
  assert.equal(layer.update(),false);
  await layer.show({entity_id:'scenario:UAM0007',kind:'uam'},{force:true});
  assert.equal(layer.line,line,'history refresh retains the primitive');
  anchor.displayPosition=null;
  assert.equal(layer.update(),true);
  assert.equal(layer.line.positions.length,6);
  assert.equal(layer.update(),false);
  layer.destroy();
});

test('flown track runs before the slow surface gate',()=>{
  assert.ok(globe.indexOf('flightTrack?.update()')<globe.indexOf('now-this.lastSurface<200'));
});
