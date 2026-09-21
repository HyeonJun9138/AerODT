import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {TrajectoryLayer} from '../../../../digital_twin/visualization/web/trajectory_layer.js';
import {describeTrajectory, withInstrumental} from '../../../../user_application/web/entity_details.js';
import {DisplaySamples} from '../../../../digital_twin/visualization/web/display_samples.js';

const web = new URL('../../../../user_application/web/', import.meta.url);
const app = readFileSync(new URL('app.js', web), 'utf8');
const panel = readFileSync(new URL('library_panel.js', web), 'utf8');
const globe = readFileSync(new URL('../../../../digital_twin/visualization/web/globe.js', import.meta.url), 'utf8');

class Collection {
  values = [];
  add(item) {this.values.push(item); return item;}
  remove(item) {const before = this.values.length; this.values = this.values.filter(value => value !== item); return before !== this.values.length;}
  removeAll() {this.values = [];}
}
const C = {PolylineCollection: Collection,
  Cartesian3: {fromArray: value => ({x: value[0], y: value[1], z: value[2]})},
  Color: {fromCssColorString: value => ({value, withAlpha(alpha) {return {value, alpha};}}),
    BLACK: {withAlpha: alpha => ({value: 'black', alpha})}, TRANSPARENT: {value: 'transparent'}},
  Material: {fromType: (type, options) => ({type, options})}};

const aircraft = (id = 'opensky:abc') => ({entity_id: id, kind: 'aircraft', name: 'TEST123'});
const satellite = (id = 'gp:25544') => ({entity_id: id, kind: 'satellite', name: 'ISS'});
// As the twin serves it: points every second from the state time, covering a
// little more than the window the display draws.
const prediction = (seconds = 15, covered = seconds + 8) => ({schema_version: 1, kind: 'aircraft',
  reference_frame: 'ecef_m', derivation: 'estimated', span_seconds: seconds, valid_until: 160,
  points: Array.from({length: covered + 1}, (_, i) => [100 + i, 4000000 + 200 * i, 3000000, 4000000]),
  summary: {model: 'coordinated_turn_v1', model_label: '선회 보정 외삽', seconds, requested_seconds: seconds,
    covered_seconds: covered, ground_speed_mps: 200, climb_mps: -2.5, heading_deg: 90, heading_end_deg: 135,
    turn_rate_dps: 3, distance_m: 3000, observation_age_seconds: 12, truncated: false}});
const orbit = () => ({schema_version: 1, kind: 'satellite', derivation: 'gp_propagated', span_seconds: 5574,
  points: [[100, 7000000, 0, 0], [101, 7000001, 1, 1], [102, 7000002, 2, 2]],
  summary: {period_minutes: 92.9, apogee_km: 410, perigee_km: 401, inclination_deg: 51.6, epoch_age_hours: 3}});

function harness(load, {predict = true, at = null} = {}) {
  const scene = {primitives: new Collection()};
  const summaries = [], clock = {value: 0};
  // Where the aircraft is drawn at this instant, in the state clock the points
  // carry. `at.time` is moved by a test the way the display moves it.
  const layer = new TrajectoryLayer(C, {scene}, {load, onSummary: value => summaries.push(value),
    now: () => clock.value, anchor: () => at, supports: entity => entity?.kind === 'satellite' || (predict && entity?.kind === 'aircraft')});
  // Each path is drawn twice: the line, and a faint copy that shows through
  // whatever is in front of it. `lines()` is the visible pair; `line()` is the
  // solid one, which is the one these tests are about.
  return {layer, summaries, clock, lines: () => layer.polylines.values,
    line: () => layer.polylines.values.at(-1), paths: () => layer.polylines.values.length / PER_PATH};
}
const PER_PATH = 2;

test('a predicted aircraft path is drawn dashed and amber, an orbit solid, so the two never read alike', async () => {
  const {layer, line, paths} = harness(async id => id.startsWith('gp:') ? orbit() : prediction());
  await layer.show(aircraft());
  assert.equal(paths(), 1);
  assert.equal(line().material.type, 'PolylineDash');
  assert.equal(line().material.options.color.value, '#ffb457');
  assert.equal(line().positions.length, 16, 'one point a second for fifteen seconds');
  await layer.show(satellite());
  assert.equal(paths(), 1, 'one path at a time');
  assert.equal(line().material.type, 'PolylineOutline');
  assert.equal(line().material.options.color.value, '#7bddff');
});

test('a prediction is refetched on its own short schedule, an orbit on the slow one', async () => {
  let calls = 0;
  const {layer, clock} = harness(async () => {calls++; return prediction();});
  await layer.show(aircraft());
  assert.equal(layer.refreshMs, 4000, 'fifteen seconds of path goes stale while it is looked at');
  clock.value = 3999; await layer.update(clock.value);
  assert.equal(calls, 1);
  clock.value = 4001; await layer.update(clock.value);
  assert.equal(calls, 2);
  const orbits = harness(async () => orbit());
  await orbits.layer.show(satellite());
  assert.equal(orbits.layer.refreshMs, 180000);
  orbits.layer.clear();
  assert.equal(orbits.layer.refreshMs, 180000, 'cleared, the layer is back on the slow schedule');
});

test('with the prediction switched off an aircraft is never asked for a path', async () => {
  let calls = 0;
  const {layer, lines} = harness(async () => {calls++; return prediction();}, {predict: false});
  await layer.show(aircraft());
  assert.equal(calls, 0, 'the twin serves none, so none is requested');
  assert.equal(lines().length, 0);
  assert.equal(layer.entityId, null);
});

test('between fetches the drawn window slides with the aircraft instead of standing still', async () => {
  // The display draws the twin's state a moment late, so the aircraft sits at
  // 100 while the served path starts there and runs on.
  const at = {time: 100, position: [4000000, 3000000, 4000000]};
  const {layer, lines, line, paths} = harness(async () => prediction(15), {at});
  await layer.show(aircraft());
  const drawn = () => line().positions;
  assert.equal(drawn().length, 16, 'fifteen seconds of it, not the whole served path');
  assert.equal(drawn()[0].x, 4000000, 'the line starts on the aircraft');
  assert.equal(drawn().at(-1).x, 4000000 + 200 * 15, 'and ends fifteen seconds ahead');
  // Four seconds later, with no new path served, the window has moved on.
  at.time = 104; at.position = [4000000 + 200 * 4, 3000000, 4000000];
  assert.equal(layer.follow(), true, 'the line moved');
  assert.equal(drawn()[0].x, 4000000 + 200 * 4, 'still starting on the aircraft');
  assert.equal(drawn().at(-1).x, 4000000 + 200 * 19, 'still fifteen seconds ahead, from the served lead');
  assert.equal(paths(), 1, 'one path, redrawn in place');
  assert.equal(layer.follow(), false, 'an unmoved aircraft redraws nothing');
  // The window is bounded by what was served: once it runs past, the path goes.
  at.time = 130;
  assert.equal(layer.follow(), true);
  assert.equal(lines().length, 0, 'nothing of the served path is ahead any more');
});

test('a path the twin can no longer serve stays drawn until its own window runs out', async () => {
  const at = {time: 100, position: [4000000, 3000000, 4000000]};
  let serve = true;
  const {layer, lines, paths, summaries} = harness(async () => serve ? prediction(15) : null, {at});
  await layer.show(aircraft());
  assert.equal(paths(), 1);
  serve = false;   // the state went stale between fetches: the endpoint answers nothing
  at.time = 106;
  await layer.show(aircraft());
  assert.equal(paths(), 1, 'the last served points are still ahead of the aircraft');
  assert.equal(summaries.at(-1).kind, 'aircraft', 'and the panel still describes what is drawn');
  at.time = 124;
  layer.follow();
  assert.equal(lines().length, 0, 'when they are behind it, it goes');
  assert.equal(summaries.at(-1), null);
});

test('an orbit is drawn whole and never follows anything', async () => {
  const at = {time: 100, position: [1, 2, 3]};
  const {layer, lines} = harness(async () => orbit(), {at});
  await layer.show(satellite());
  assert.equal(lines()[0].positions.length, 3, 'every served point');
  assert.equal(lines()[0].positions[0].x, 7000000, 'the anchor is not applied to an orbit');
  at.time = 200;
  assert.equal(layer.follow(), false);
  assert.equal(lines()[0].positions.length, 3);
});

test('the window helper takes the stretch between two times, ends interpolated', () => {
  const points = Array.from({length: 11}, (_, i) => [100 + i, 10 * i, 0, 0]);
  const rows = TrajectoryLayer.window(points, 102.5, 105);
  assert.deepEqual(rows[0], [102.5, 25, 0, 0], 'the start is interpolated');
  assert.deepEqual(rows.at(-1), [105, 50, 0, 0]);
  assert.deepEqual(rows.map(row => row[0]), [102.5, 103, 104, 105]);
  assert.deepEqual(TrajectoryLayer.window(points, 99, 101).map(row => row[0]), [100, 101], 'clamped to what was served');
  assert.deepEqual(TrajectoryLayer.window(points, 111, 120), [], 'past the end there is nothing to draw');
  assert.deepEqual(TrajectoryLayer.window(points, 105, 105), [], 'a window of no width draws nothing');
  assert.deepEqual(TrajectoryLayer.at(points, 104.25), [42.5, 0, 0]);
});

test('the prediction details name the model, the span and what the path is not', () => {
  const view = describeTrajectory(prediction());
  const value = key => view.fields.find(field => field.key === key).value;
  assert.equal(view.title, '예상 경로');
  assert.equal(value('model'), '선회 보정 외삽');
  assert.match(value('span'), /15/);
  assert.match(value('distance'), /3\.00 km/);
  assert.match(value('ground_speed'), /200/);
  assert.match(value('turn'), /3\.0°\/s 우선회/);
  assert.match(value('climb'), /-2\.5/);
  assert.match(value('age'), /12/);
  assert.match(view.note, /선회 보정 외삽으로 앞으로/, 'the particle follows the model name');
  assert.match(view.note, /15초/);
  assert.match(view.note, /제출된 비행계획이나 측정된 궤적이 아니며/, 'a projection says so where it is read');
  const straight = describeTrajectory({...prediction(), summary: {...prediction().summary, turn_rate_dps: 0}});
  assert.match(straight.fields.find(f => f.key === 'turn').value, /직진/);
  const cut = describeTrajectory({...prediction(), summary: {...prediction().summary, truncated: true}});
  assert.match(cut.note, /유효 한계에서 잘렸습니다/);
});

test('a model name takes the particle its last letter calls for', () => {
  assert.equal(withInstrumental('등속 외삽'), '등속 외삽으로');
  assert.equal(withInstrumental('선회 보정 외삽'), '선회 보정 외삽으로');
  assert.equal(withInstrumental('추정 모델'), '추정 모델로', 'a name ending in a vowel takes the short form');
  assert.equal(withInstrumental('칼만 필터'), '칼만 필터로');
  assert.equal(withInstrumental('SGP4'), 'SGP4로', 'read as 사, a vowel');
  assert.equal(withInstrumental('constant_velocity_v1'), 'constant_velocity_v1로', 'read as 일, a final ㄹ');
  assert.equal(withInstrumental('EKF3'), 'EKF3으로', 'read as 삼, a final ㅁ');
  assert.equal(withInstrumental('IMM'), 'IMM으로', 'read as 엠');
  assert.equal(withInstrumental(''), '');
});

test('driven by the display clock itself, the path keeps step with the aircraft it belongs to', async () => {
  // The real display: snapshots arrive, the clock runs a little behind them so
  // positions can be interpolated, and the globe reads both back as the anchor.
  const samples = new DisplaySamples({minBufferMs: 500, maxBufferMs: 500, marginMs: 0});
  const id = 'opensky:abc';
  const state = (t, x) => ({sequence: t, state_time: t, entities: [{entity_id: id, kind: 'aircraft',
    position_ecef_m: [x, 3000000, 4000000], heading_deg: 90, orientation_source: 'ground_track',
    continuity_id: 0, discontinuity: false}]});
  // 200 m/s east, a snapshot a second, arriving with no lag.
  for (const t of [100, 101, 102]) samples.replace(state(t, 4000000 + 200 * (t - 100)), t * 1000);
  // The globe's own anchor: where and when this object is being drawn.
  const scratch = [0, 0, 0];
  const anchorAt = nowMs => {
    samples.position(id, nowMs, scratch);   // what refreshPosition does each frame
    const time = samples.renderTime(id);
    const position = samples.positionAt(id, time, [0, 0, 0]);
    return {time, position};
  };
  let at = anchorAt(102000);
  const layer = new TrajectoryLayer(C, {scene: {primitives: new Collection()}},
    {load: async () => prediction(15), anchor: () => at, supports: () => true, now: () => 0});
  await layer.show(aircraft(id));
  const drawn = () => layer.polylines.values[0].positions;
  // The window's ends fall between served samples, so it carries one more point
  // than the fifteen whole seconds it spans.
  assert.ok(drawn().length === 16 || drawn().length === 17, `${drawn().length} points`);
  const first = drawn()[0].x, last = drawn().at(-1).x;
  assert.equal(first, at.position[0], 'the line starts where the aircraft is drawn');
  assert.equal(last - first, 200 * 15, 'and covers the fifteen seconds asked for');
  // Half a second of display time later, with no new path fetched.
  at = anchorAt(102500);
  assert.ok(at.time > 101.4 && at.time < 102.1, `the display clock advanced to ${at.time}`);
  assert.equal(layer.follow(), true);
  assert.ok(drawn()[0].x > first, 'the line moved with it');
  assert.equal(Math.round(drawn().at(-1).x - drawn()[0].x), 200 * 15, 'without losing its span');
  assert.equal(drawn()[0].x, at.position[0], 'still starting on the aircraft');
  // And the whole way is covered in small steps rather than one jump. The
  // display never runs ahead of the newest snapshot, so they keep arriving.
  const noses = [];
  for (let ms = 102600; ms <= 104400; ms += 100) {
    if (ms % 1000 === 0) samples.replace(state(ms / 1000, 4000000 + 200 * (ms / 1000 - 100)), ms);
    at = anchorAt(ms);
    layer.follow();
    noses.push(drawn()[0].x);
  }
  const steps = noses.slice(1).map((value, index) => value - noses[index]);
  assert.ok(steps.every(step => step >= 0), 'never backwards');
  // A tenth of a second of display time is at most a fraction of a second of
  // flight. Refetching alone would have moved it four seconds' worth at once.
  assert.ok(Math.max(...steps) < 200, `biggest step ${Math.round(Math.max(...steps))} m, under a second of flight`);
  assert.ok(noses.at(-1) - noses[0] > 200, 'and over the run it really does move');
});

test('the page stores the estimator choice with the other live settings and hands the map the switch', () => {
  assert.match(panel, /DISPLAY_SOURCES = new Set\(\[[^\]]*'trajectory_prediction'/, 'the choice is applied to the map as well as stored');
  assert.match(app, /id==='trajectory_prediction'\)liveGlobe\?\.setTrajectoryPrediction\(enabled\)/);
  // A satellite always has an orbit; an aircraft and a UAM each have their own
  // switch, because they are different predictions with different models.
  assert.match(globe, /supports:entity=>entity\?\.kind==='satellite'/);
  assert.match(globe, /this\.predictAircraft && entity\?\.kind==='aircraft'/);
  assert.match(globe, /this\.predictUam && entity\?\.kind==='uam'/);
  assert.match(globe, /setTrajectoryPrediction\(enabled\) \{/);
  assert.match(globe, /anchor:id=>this\.displayAnchor\(id\)/, 'the layer is told where the object is drawn');
  assert.match(globe, /if\(this\.trajectory\.follow\(\)\)v\.scene\.requestRender\(\);/, 'and follows it every frame');
});
