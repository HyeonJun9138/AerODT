import test from 'node:test';
import assert from 'node:assert/strict';
import {ICON_KINDS, ICON_PIXELS, ICON_SIZE_PX, iconRotation, paintIcon, turns}
  from '../../../../digital_twin/visualization/web/entity_icon.js';
import {BILLBOARD_PIXELS, chooseLod} from '../../../../digital_twin/visualization/web/display_samples.js';
import {SYMBOL_HEIGHTS, drawsSymbol} from '../../../../digital_twin/visualization/web/render_policy.js';

class RecordingContext {
  constructor() {this.ops = []; this.fillStyle = ''; this.strokeStyle = ''; this.lineWidth = 0;}
  record(op, ...args) {this.ops.push({op, args, fill: this.fillStyle, stroke: this.strokeStyle, width: this.lineWidth});}
  beginPath() {this.record('beginPath');} closePath() {this.record('closePath');}
  moveTo(...a) {this.record('moveTo', ...a);} lineTo(...a) {this.record('lineTo', ...a);}
  fill() {this.record('fill');} stroke() {this.record('stroke');} clearRect(...a) {this.record('clearRect', ...a);}
}
const createCanvas = (width, height) => {const ctx = new RecordingContext(); return {width, height, ctx, getContext: () => ctx};};
const painted = kind => paintIcon(kind, '#8ef2c4', createCanvas);

test('every kind has a glyph, painted once at a size it can be scaled down from', () => {
  assert.deepEqual(ICON_KINDS, ['aircraft', 'uam', 'satellite']);
  for (const kind of ICON_KINDS) {
    const canvas = painted(kind);
    assert.equal(canvas.width, ICON_PIXELS);
    assert.equal(canvas.height, ICON_PIXELS);
    const ops = canvas.ctx.ops.map(item => item.op);
    // Cleared, drawn as one closed shape, filled and then edged.
    assert.equal(ops[0], 'clearRect');
    assert.equal(ops.filter(op => op === 'moveTo').length, 1, 'one shape, not a scatter of strokes');
    assert.ok(ops.filter(op => op === 'lineTo').length >= 3);
    assert.deepEqual(ops.slice(-3), ['closePath', 'fill', 'stroke']);
    // Every point lands inside the canvas.
    for (const {op, args} of canvas.ctx.ops) {
      if (op !== 'moveTo' && op !== 'lineTo') continue;
      for (const value of args) assert.ok(value >= 0 && value <= ICON_PIXELS, `${kind} ${op} ${value}`);
    }
  }
  // Drawn smaller than it is painted: a glyph scaled down reads, one scaled up does not.
  assert.ok(ICON_SIZE_PX < ICON_PIXELS);
});

test('the glyph is filled in its kind colour and edged dark enough to read over anything', () => {
  const canvas = paintIcon('uam', '#8ef2c4', createCanvas);
  const fill = canvas.ctx.ops.find(item => item.op === 'fill');
  const stroke = canvas.ctx.ops.find(item => item.op === 'stroke');
  assert.equal(fill.fill, '#8ef2c4');
  // Over water, city and cloud alike a fill on its own disappears into the pale ones.
  assert.match(stroke.stroke, /^rgba\(8,18,26/);
  assert.ok(stroke.width >= 1.5);
});

test('the glyph is turned by the heading, and only where a heading means something', () => {
  // Painted nose-up; Cesium turns a billboard anticlockwise, a heading is
  // clockwise from north, so the rotation is the heading negated.
  assert.equal(iconRotation('uam', 0), 0, 'north is square on, not negative zero');
  assert.equal(iconRotation('uam', 90), -Math.PI / 2);
  assert.equal(iconRotation('aircraft', 180), -Math.PI);
  assert.equal(iconRotation('uam', -90), Math.PI / 2);
  // A satellite has no heading worth drawing; its glyph is a diamond and reads
  // the same whichever way it is turned.
  assert.equal(turns('satellite'), false);
  assert.equal(iconRotation('satellite', 90), 0);
  // Nothing to turn by is square on rather than NaN.
  assert.equal(iconRotation('uam', undefined), 0);
  assert.equal(iconRotation('uam', NaN), 0);
});

test('by apparent size the glyph tier sits between a model and a dot', () => {
  const at = (pixels, previous = 'point') => chooseLod({distance: 10000, previous,
    sizeM: pixels * 2 * 10000 * Math.tan(Math.PI / 6) / 1000, viewportHeight: 1000, fov: Math.PI / 3});
  assert.equal(at(8), 'model', 'big enough on screen to be worth its own draw call');
  assert.equal(at(4), 'billboard', 'too small for a model, large enough that its heading reads');
  assert.equal(at(1), 'point', 'a mark, and nothing more');
  // Each step down asks a little less than the step up did.
  assert.equal(at(5, 'model'), 'model', 'a model holds on below the promotion size');
  assert.equal(at(BILLBOARD_PIXELS * 0.9, 'billboard'), 'billboard', 'and so does a glyph');
  assert.equal(at(BILLBOARD_PIXELS * 0.9, 'point'), 'point', 'but a dot is not promoted at that size');
  // Without a size there is no apparent size to judge, so this route does not
  // promote at all; the symbol route below is what carries those kinds.
  assert.equal(chooseLod({distance: 45000, previous: 'point'}), 'point');
  assert.equal(chooseLod({distance: 45000, previous: 'billboard'}), 'point');
  assert.equal(chooseLod({distance: 10, visible: false}), 'hidden');
});

// ---- an aircraft and a satellite are symbols too -------------------------
// A glyph was reachable only by apparent size, which is the right rule for
// deciding whether a 3D model is worth its own draw call and the wrong one for
// deciding whether something is worth a shape: sixteen metres at five hundred
// kilometres will never be two pixels across, and which one it is still reads
// at a glance from its shape and colour.
test('something too small to measure is still worth a shape, where the view is not crowded', () => {
  const satellite = {distance: 600000, sizeM: 16, viewportHeight: 1000, fov: Math.PI / 3};
  assert.equal(chooseLod({...satellite, symbol: false}), 'point');
  assert.equal(chooseLod({...satellite, symbol: true}), 'billboard');
  const aircraft = {distance: 25000, sizeM: 32, viewportHeight: 1000, fov: Math.PI / 3};
  assert.equal(chooseLod({...aircraft, symbol: false}), 'point');
  assert.equal(chooseLod({...aircraft, symbol: true}), 'billboard');
  // Close enough to be worth a model, it is still a model.
  assert.equal(chooseLod({distance: 3000, sizeM: 32, viewportHeight: 1000, fov: Math.PI / 3, symbol: true}), 'model');
  // And nothing is promoted where the kind is not drawn at all.
  assert.equal(chooseLod({distance: 10, visible: false, symbol: true}), 'hidden');
});

test('a kind gives up its shape before the view gets crowded, by camera height', () => {
  // It is the view that gets crowded, not the object that gets small, so this
  // is a camera height rather than an object distance.
  assert.equal(drawsSymbol('aircraft', 500), true);
  assert.equal(drawsSymbol('uam', 400000), true);
  assert.equal(drawsSymbol('aircraft', 400001), false, 'aircraft fly the city, and stop being shapes when it does');
  // Satellites are hundreds of kilometres up: they stay shapes far longer, and
  // give up before the camera holds a large part of the sky at once.
  assert.equal(drawsSymbol('satellite', 2999999), true);
  assert.equal(drawsSymbol('satellite', 3000001), false);
  assert.equal(drawsSymbol('mystery', 100), false, 'a kind with no policy is not guessed at');
  assert.equal(drawsSymbol('satellite', NaN), false);
  // A drone and a bird are drawn as symbols at the same scale a UAM is: they
  // are small, low things over a city, and an injected one has to be a shape
  // in the camera image, not a dot.
  assert.deepEqual(Object.keys(SYMBOL_HEIGHTS).sort(), ['aircraft', 'bird', 'drone', 'satellite', 'uam']);
});
