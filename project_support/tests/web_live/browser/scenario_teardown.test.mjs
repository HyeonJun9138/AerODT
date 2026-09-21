/* Closing the day takes it off the map.

   The operator reset the day and closed the console, and its aircraft were
   still standing on the map. Whatever the wire does afterwards, the console
   closing is the operator saying that day is no longer what the twin shows, so
   the map stops showing it then rather than whenever the stream catches up. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {EntityScene} from '../../../../digital_twin/visualization/web/entity_scene.js';
import {DisplaySamples} from '../../../../digital_twin/visualization/web/display_samples.js';

const web = new URL('../../../../user_application/web/', import.meta.url);
const app = readFileSync(new URL('app.js', web), 'utf8');
const globe = readFileSync(new URL('../../../../digital_twin/visualization/web/globe.js', import.meta.url), 'utf8');

class Collection {
  values = [];
  add(item) {this.values.push(item); return item;}
  remove(item) {this.values = this.values.filter(value => value !== item);}
}
const color = {withAlpha: () => color};
const C = {PointPrimitiveCollection: Collection, LabelCollection: Collection, PrimitiveCollection: Collection,
  Cartesian2: class {constructor(x = 0, y = 0) {Object.assign(this, {x, y});}},
  Cartesian3: {fromArray: (value, _offset, result = {}) => Object.assign(result, {x: value[0], y: value[1], z: value[2]})},
  Color: {CYAN: color, BLACK: color, WHITE: color, GRAY: {gray: true}, fromCssColorString: value => value}};

// The scheduled day is in October; the live clock is a month earlier. Handing
// the twin back therefore moves its time backwards by weeks.
const REPLAY = Date.UTC(2026, 9, 9, 21, 30) / 1000;
const LIVE = Date.UTC(2026, 8, 10, 14, 14) / 1000;

const uam = (id, flight = '') => ({entity_id: `scenario:${id}`, name: flight ? `${id} · ${flight}` : id,
  kind: 'uam', quality: 'nominal', source: 'scenario', position_ecef_m: [1, 2, 3], visual_asset_id: 'plane'});
const satellite = {entity_id: 'sat:1', name: 'SAT', kind: 'satellite', quality: 'valid',
  source: 'celestrak_saved', position_ecef_m: [7e6, 0, 0], visual_asset_id: 'generic'};

function scene() {
  const built = new EntityScene(C, {scene: {primitives: new Collection()}}, () => {});
  built.replace({sequence: 100, state_time: REPLAY, epoch: 1,
    entities: [uam('UAM0065', 'FPL000053'), uam('UAM0071'), satellite]});
  return built;
}

test('the day leaves the map the moment the console closes', () => {
  const built = scene();
  assert.equal(built.items.size, 3);
  assert.equal(built.dropSource('scenario'), 2, 'both of the day\'s aircraft, and only those');
  assert.deepEqual([...built.items.keys()], ['sat:1']);
  // Their samples go too: an interpolator that still held them could put them
  // back on the next frame.
  assert.equal(built.samples.entries.has('scenario:UAM0065'), false);
  assert.equal(built.samples.entries.has('sat:1'), true);
  assert.equal(built.layers.uam.points.values.length, 0, 'no points left behind');
  assert.equal(built.stats.total, 1);
});

// A snapshot encoded before the console closed and delivered after it still
// carries every one of the day's aircraft. Putting them back would leave them
// on the map for good, because the server never sends them again - which is
// what a replay that "will not turn off" looks like from the operator's chair.
test('a snapshot already in flight cannot put the day back on the map', () => {
  const built = scene();
  const held = () => [...built.items.keys()].filter(id => id.startsWith('scenario:')).length;
  assert.equal(built.dropSource('scenario'), 2);
  assert.equal(held(), 0);

  built.replace({sequence: 101, state_time: REPLAY + 0.2, epoch: 1,
    entities: [uam('UAM0065', 'FPL000053'), uam('UAM0071'), satellite]});
  assert.equal(held(), 0, '이미 날아오던 스냅샷이 되살리지 못합니다');
  assert.deepEqual([...built.items.keys()], ['sat:1'], 'and the rest of the sky is untouched');

  // Once the server has caught up, the source is its own again: a day put back
  // on the map draws from the next snapshot that carries it.
  built.replace({sequence: 102, state_time: REPLAY + 0.4, epoch: 2, entities: [satellite]});
  built.replace({sequence: 103, state_time: REPLAY + 0.6, epoch: 2,
    entities: [uam('UAM0065', 'FPL000053'), satellite]});
  assert.equal(held(), 1);
});

test('opening a day again expects it at once, without waiting for a clean snapshot', () => {
  const built = scene();
  built.dropSource('scenario');
  // Closed and opened again inside one snapshot interval: no snapshot without
  // the day ever arrives, so the opening is what lifts the disowning.
  assert.equal(built.ownSource('scenario'), true);
  built.replace({sequence: 101, state_time: REPLAY + 0.2, epoch: 1,
    entities: [uam('UAM0065', 'FPL000053'), satellite]});
  assert.equal([...built.items.keys()].filter(id => id.startsWith('scenario:')).length, 1);
  assert.equal(built.ownSource('scenario'), false, 'nothing was disowned, so nothing was lifted');
});

test('dropping a source nobody is showing changes nothing', () => {
  const built = scene();
  assert.equal(built.dropSource('opensky'), 0);
  assert.equal(built.items.size, 3);
});

test('a model still loading when its aircraft is dropped is not left on the map', async () => {
  let resolve;
  const model = {destroy() {this.destroyed = true;}, errorEvent: {addEventListener() {}}};
  const engine = {...C, Axis: {X: 0, Y: 1},
    Model: {fromGltfAsync: () => new Promise(done => {resolve = () => done(model);})}};
  const built = new EntityScene(engine, {scene: {primitives: new Collection()}}, () => {});
  built.matrix = () => ({});
  built.setAssets({assets: [{asset_id: 'plane', uri: '/visual-assets/a.glb', size_m: 8}]});
  built.replace({sequence: 1, state_time: REPLAY, epoch: 1, entities: [uam('UAM0065')]});
  const item = built.items.get('scenario:UAM0065');
  item.lod = 'model';
  const loading = built.loadModel(item);
  built.dropSource('scenario');
  resolve();
  await loading;
  assert.equal(model.destroyed, true, 'the late model is destroyed, not added to a layer nobody owns');
  assert.equal(built.layers.uam.models.values.length, 0);
});

test('handing the twin back to the live clock removes the day, jump of dates and all', () => {
  const built = scene();
  // What the server actually sends when the console closes: a new epoch, a time
  // weeks earlier, and no scenario entities.
  built.replace({sequence: 101, state_time: LIVE, epoch: 2, entities: [satellite]});
  assert.deepEqual([...built.items.keys()], ['sat:1']);
});

test('a stream refused as out of order for seconds is taken as the new clock', () => {
  // One packet out of order is a packet out of order. A minute of them is a
  // twin whose clock moved without saying so, and refusing those for ever left
  // a map showing a world that had gone, with nothing on screen saying why.
  const samples = new DisplaySamples();
  samples.replace({sequence: 100, state_time: REPLAY, epoch: 1, entities: [uam('UAM0065')]}, 1000);
  assert.equal(samples.entries.size, 1);
  const stale = {sequence: 101, state_time: LIVE, epoch: 1, entities: [satellite]};
  assert.equal(samples.replace(stale, 1100), false, 'the first one is just late');
  assert.equal(samples.replace({...stale, sequence: 102}, 2000), false);
  assert.equal(samples.replace({...stale, sequence: 103}, 4200), true, 'after seconds of it, believe it');
  assert.deepEqual([...samples.entries.keys()], ['sat:1']);
  // And once believed, the stream carries on normally from there.
  assert.equal(samples.replace({...stale, sequence: 104, state_time: LIVE + 1}, 4300), true);
});

test('an ordinary late packet is still refused', () => {
  const samples = new DisplaySamples();
  samples.replace({sequence: 10, state_time: 1000, epoch: 0, entities: [satellite]}, 1000);
  assert.equal(samples.replace({sequence: 9, state_time: 999, epoch: 0, entities: []}, 1050), false);
  assert.equal(samples.replace({sequence: 11, state_time: 1001, epoch: 0, entities: [satellite]}, 1100), true);
  assert.equal(samples.entries.size, 1, 'the good packet after it is not treated as a break');
});

test('the map and the page are wired to let the day go', () => {
  assert.match(globe, /dropSource\(source\)/);
  // Selection and hover let go with it, or a panel would stay open on a state
  // nothing is producing any more.
  assert.match(globe, /dropSource\(source\)\s*\{[\s\S]*?this\.select\(null\)/);
  assert.match(app, /onClose:\(\)=>\{[^}]*dropSource\?\.\('scenario'\)/);
  // And opening it again expects the day back, so a close-then-open inside one
  // snapshot interval does not leave the day disowned.
  assert.match(app, /onOpen:\(\)=>\{[^}]*ownSource\?\.\('scenario'\)/);
  assert.match(globe, /ownSource\(source\)/);
});
