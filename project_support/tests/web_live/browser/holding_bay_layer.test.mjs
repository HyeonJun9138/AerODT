import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {HoldingBayLayer} from '../../../../digital_twin/visualization/web/holding_bay_layer.js';

// A hold used to be a number over open sky. The service knows the bay it
// reserved and where the aircraft rejoins the approach from it; both are
// places, and a place belongs on the map.

class Colour {constructor(r, g, b, a = 1) {Object.assign(this, {r, g, b, a});} withAlpha(a) {return new Colour(this.r, this.g, this.b, a);}}
Colour.BLACK = new Colour(0, 0, 0);
const C = {
  Color: Colour,
  Cartesian2: class {constructor(x, y) {Object.assign(this, {x, y});}},
  Cartesian3: {fromDegrees: (lon, lat, height) => ({lon, lat, height})},
  CallbackProperty: class {constructor(fn) {this.fn = fn;} getValue() {return this.fn();}},
  PolylineDashMaterialProperty: class {constructor(options) {Object.assign(this, options);}},
  LabelStyle: {FILL_AND_OUTLINE: 'fill+outline'},
  VerticalOrigin: {BOTTOM: 'bottom'},
};

function scene() {
  const added = [];
  const viewer = {entities: {
    add(options) {added.push(options); return options;},
    remove(entity) {const at = added.indexOf(entity); if (at >= 0) added.splice(at, 1);},
  }};
  return {viewer, added};
}

const HOLD = {slot: 'VP2/37.49,126.93/R2-H1', fix: [37.492, 126.937, 324.8], rejoin: [37.5, 126.95, 300]};
const AT = {position: {latitude: 37.53, longitude: 126.93, altitude_m: 240}};

const build = (hold, aircraft = AT) => {
  const {viewer, added} = scene();
  const layer = new HoldingBayLayer(C, viewer, {read: () => hold.value, aircraft: () => aircraft});
  return {layer, added, viewer};
};

test('the place is drawn: a post to the ground, a footprint, the bay and its name', () => {
  const hold = {value: HOLD};
  const {layer, added} = build(hold);
  layer.update();
  const labels = added.filter(e => e.label).map(e => e.label.text);
  assert.ok(labels.some(text => text.includes('R2-H1')), '자리 이름이 보인다');
  assert.ok(labels.some(text => text.includes('325 m')), '높이도 읽을 수 있다');
  assert.equal(added.filter(e => e.ellipse).length, 1, '위에서 내려다봐도 찾을 자국');
  assert.ok(added.some(e => e.polyline && Array.isArray(e.polyline.positions)
    && e.polyline.positions.length === 2), '지면에서 올라오는 기둥');
  assert.ok(labels.some(text => text.includes('접근 재개')), '대기가 끝나면 갈 곳도 함께');
});

test('the way there is drawn from wherever the aircraft is now', () => {
  const hold = {value: HOLD};
  const aircraft = {position: {latitude: 37.53, longitude: 126.93, altitude_m: 240}};
  const {layer, added} = build(hold, aircraft);
  layer.update();
  const lead = added.find(e => e.polyline?.positions?.getValue);
  assert.ok(lead, '기체에서 대기점까지 이어지는 선');
  const first = lead.polyline.positions.getValue();
  assert.equal(first.length, 2);
  assert.equal(first[0].lat, 37.53, 'starts where the aircraft is');
  // It follows the aircraft rather than being baked at the moment it was drawn.
  aircraft.position.latitude = 37.55;
  assert.equal(lead.polyline.positions.getValue()[0].lat, 37.55);
});

test('nothing is drawn without a place, and it goes when the place does', () => {
  const hold = {value: null};
  const {layer, added} = build(hold);
  layer.update();
  assert.equal(added.length, 0, '대기점이 없으면 아무것도 안 그린다');
  hold.value = HOLD;
  layer.update();
  assert.ok(added.length > 0);
  hold.value = null;
  layer.update();
  assert.equal(added.length, 0, '허가가 풀리면 지워진다');
});

test('the same place is not redrawn every frame, a different one is', () => {
  const hold = {value: HOLD};
  const {layer, added} = build(hold);
  layer.update();
  const drawn = [...added];
  for (let i = 0; i < 30; i++) layer.update();
  assert.deepEqual(added, drawn, '같은 자리면 장면을 다시 만들지 않는다');
  hold.value = {...HOLD, slot: 'VP2/37.49,126.93/R2-H2', fix: [37.4, 126.9, 300]};
  layer.update();
  assert.notDeepEqual(added, drawn);
  assert.ok(added.some(e => e.label?.text.includes('R2-H2')));
});

test('a half-built hold is not drawn rather than drawn somewhere wrong', () => {
  for (const value of [{slot: 'x'}, {slot: 'x', fix: [1, 2]}, {slot: 'x', fix: [1, 2, NaN]},
                       {fix: [1, 2, 3]}, {slot: '', fix: [1, 2, 3]}]) {
    const {layer, added} = build({value});
    layer.update();
    assert.equal(added.length, 0, JSON.stringify(value));
  }
});

test('an aircraft that is not reporting leaves the line empty, not broken', () => {
  const {layer, added} = build({value: HOLD}, null);
  layer.update();
  const lead = added.find(e => e.polyline?.positions?.getValue);
  assert.deepEqual(lead.polyline.positions.getValue(), []);
});

test('destroying it takes everything off the map', () => {
  const {layer, added} = build({value: HOLD});
  layer.update();
  assert.ok(added.length > 0);
  layer.destroy();
  assert.equal(added.length, 0);
  layer.update();
  assert.equal(added.length, 0, '치운 뒤에는 다시 그리지 않는다');
});

test('the map layer is wired to the pilot, and put away with the session', () => {
  const app = readFileSync(new URL('../../../../user_application/web/app.js', import.meta.url), 'utf8');
  assert.match(app, /read:\(\)=>manualFlight\.readPsu\(\)\?\.hold/, 'it reads what PSU is saying');
  assert.match(app, /onSample:sample=>\{manualFlight\.sample=sample;holdingBayLayer\(\)\?\.update\(\)/);
  assert.match(app, /onClear:\(\)=>\{holdingBay\?\.clear\(\)/, '세션이 끝나면 지도에서 치운다');
});
