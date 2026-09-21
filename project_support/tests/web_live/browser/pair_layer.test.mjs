import test from 'node:test';
import assert from 'node:assert/strict';
import {BROKEN_COLOR, CUT_LIFT_M, KEPT_COLOR, PAIR_HEIGHT_M, PairLayer} from '../../../../digital_twin/visualization/web/pair_layer.js';

// Enough Cesium for a polyline: the layer is asked what it drew, not how it looks.
const C = {
  DistanceDisplayCondition: class {constructor(near, far) {Object.assign(this, {near, far});}},
  PolylineDashMaterialProperty: class {constructor(options) {Object.assign(this, options); this.dashed = true;}},
  Color: {fromCssColorString: css => ({css, withAlpha(alpha) {return {css, alpha};}})},
  Cartesian3: {fromDegreesArrayHeights: values => values},
};
function viewer() {
  const added = [];
  return {added, entities: {add: description => {const entity = {...description, show: true}; added.push(entity); return entity;},
    remove: entity => {const at = added.indexOf(entity); if (at >= 0) added.splice(at, 1);}}};
}
const PLACES = {'vp-1': {longitude: 126.93, latitude: 37.52, height: 40},
  'vp-2': {longitude: 127.03, latitude: 37.5, height: 120}};
const layerOn = view => new PairLayer(C, view, {placeOf: id => PLACES[id] ?? null});
const pairs = (...list) => list.map(([from, to, kept]) => ({key: `${from}|${to}`, from, to, kept}));

test('a pair is one line over the higher of the two decks', () => {
  const view = viewer(), layer = layerOn(view);
  assert.equal(layer.show(pairs(['vp-1', 'vp-2', true])), 1);
  const [entity] = view.added;
  assert.deepEqual(entity.polyline.positions,
    [126.93, 37.52, 120 + PAIR_HEIGHT_M, 127.03, 37.5, 120 + PAIR_HEIGHT_M]);
  assert.equal(entity.aerodtPair.key, 'vp-1|vp-2');
  // Drawing again replaces what was there rather than piling lines up.
  layer.show(pairs(['vp-1', 'vp-2', true]));
  assert.equal(view.added.length, 1);
});

test('a vertiport the map has not placed yet is simply not joined to anything', () => {
  const view = viewer();
  assert.equal(layerOn(view).show(pairs(['vp-1', 'vp-gone', true])), 0);
});

test('a cut pair is drawn dashed in its own colour so what was removed is visible', () => {
  const view = viewer();
  layerOn(view).show(pairs(['vp-1', 'vp-2', false], ['vp-2', 'vp-1', true]));
  const [cut, kept] = view.added;
  assert.equal(cut.polyline.material.dashed, true);
  assert.equal(cut.polyline.material.color.css, BROKEN_COLOR);
  assert.equal(kept.polyline.material.css, KEPT_COLOR);
  assert.notEqual(BROKEN_COLOR, KEPT_COLOR);
  // A cut pair is rarer and is what is being checked, so it is not the fainter of the two.
  assert.ok(cut.polyline.material.color.alpha > kept.polyline.material.alpha);
  // And it rides above the mesh rather than being buried in it.
  assert.equal(cut.polyline.positions[2] - kept.polyline.positions[2], CUT_LIFT_M);
});

test('the selected vertiport keeps its own lines strong and fades the rest', () => {
  const view = viewer(), layer = layerOn(view);
  const places = {...PLACES, 'vp-3': {longitude: 126.79, latitude: 37.56, height: 10}};
  layer.placeOf = id => places[id] ?? null;
  layer.show(pairs(['vp-1', 'vp-2', true], ['vp-2', 'vp-3', true]), {focus: 'vp-1'});
  const [mine, other] = view.added;
  assert.ok(mine.polyline.material.alpha > other.polyline.material.alpha);
  assert.ok(mine.polyline.width > other.polyline.width);
});

test('the layer says which pair a click landed on, and nothing for anything else', () => {
  const view = viewer(), layer = layerOn(view);
  layer.show(pairs(['vp-1', 'vp-2', true]));
  assert.equal(layer.pick({id: view.added[0]}).key, 'vp-1|vp-2');
  assert.equal(layer.pick({id: {}}), null);
  assert.equal(layer.pick(undefined), null);
});

test('hiding and clearing take every line back', () => {
  const view = viewer(), layer = layerOn(view);
  layer.show(pairs(['vp-1', 'vp-2', true]));
  layer.setVisible(false);
  assert.equal(view.added[0].show, false);
  layer.clear();
  assert.equal(view.added.length, 0);
});
