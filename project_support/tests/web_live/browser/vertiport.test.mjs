import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {VertiportLayer, deckFurniture, followGround, footprintsOf, geographicPoints, groundSamplePoints, insideFootprint, layoutToWorld, overlapsFootprint, shellOf} from '../../../../digital_twin/visualization/web/vertiport_layer.js';
import {PAINT, paintApron, rotateLayout} from '../../../../digital_twin/visualization/web/vertiport_paint.js';
import {BAY_M, FACADE, FACADE_TILE_M, STOREY_M, boundsOf, cornerRadius, facadeHeight, facadePlan, facadeWall, offsetOutline, outlineTexture, paintFacade, roundedOutline, shellMesh} from '../../../../digital_twin/visualization/web/vertiport_shell.js';
import {BASE, TERRACE_OUT_M, TERRACE_RISE_M, cladHeight, podiumHeight} from '../../../../digital_twin/visualization/web/vertiport_base.js';
import {paintThumbnail} from '../../../../digital_twin/visualization/web/vertiport_thumbnail.js';
import {BEACON_STAND_METRES, INSET_LIGHT_CLEARANCE_M, LIGHT_COLOUR, alongPolyline, brightness, colourOf, elevationOf, lampsFor, offsetPolyline} from '../../../../digital_twin/visualization/web/deck_lights.js';
import {PlaceMenu} from '../../../../user_application/web/place_menu.js';
import {LiveGlobe} from '../../../../digital_twin/visualization/web/globe.js';
import {definitionFromForm, describeVertiport, presetFor, presetSides, roleLabel, SimulationPanel} from '../../../../user_application/web/domains/uam/planning/simulation_panel.js';
import {WorkPanel} from '../../../../user_application/web/work_panel.js';

// A translation-only stand-in for the east-north-up frame keeps the numbers readable.
class Cartesian3 {constructor(x = 0, y = 0, z = 0) {Object.assign(this, {x, y, z});} static fromDegrees(lon, lat, h = 0) {return new Cartesian3(lon * 1000, lat * 1000, h);}}
Cartesian3.ZERO = new Cartesian3(0, 0, 0);
const C = {Cartesian3,
  Transforms: {eastNorthUpToFixedFrame: (origin, ellipsoid, result) => Object.assign(result ?? {}, {origin}),
    headingPitchRollQuaternion: (position, hpr) => ({position, hpr})},
  LabelStyle: {FILL_AND_OUTLINE: 'fo'}, HeightReference: {CLAMP_TO_GROUND: 'ground', NONE: 'none'}, VerticalOrigin: {CENTER: 'c', BOTTOM: 'b'},
  Cartesian2: class {constructor(x, y) {this.x = x; this.y = y;}}, NearFarScalar: class {constructor(...a) {this.a = a;}},
  DistanceDisplayCondition: class {constructor(near, far) {this.near = near; this.far = far;}},
  // Just enough of a point collection to count lamps and read their colours.
  PointPrimitiveCollection: class {
    constructor() {this.items = [];}
    add(options) {const point = {...options}; this.items.push(point); return point;}
    remove(point) {const at = this.items.indexOf(point); if (at >= 0) this.items.splice(at, 1); return at >= 0;}
    isDestroyed() {return false;}
  },
  PolygonHierarchy: class {constructor(positions) {this.positions = positions;}},
  CallbackProperty: class {constructor(fn, isConstant) {this.fn = fn; this.isConstant = isConstant;} getValue() {return this.fn();}},
  ImageMaterialProperty: class {constructor(options) {Object.assign(this, options);}},
  Math: {toRadians: d => d * Math.PI / 180},
  Color: {fromCssColorString: css => ({css, withAlpha(alpha) {return {css, alpha};}})},
  ColorGeometryInstanceAttribute: {fromColor: color => ({color})},
  ShowGeometryInstanceAttribute: class {constructor(show) {this.show = show;}},
  DistanceDisplayConditionGeometryInstanceAttribute: {fromDistanceDisplayCondition: condition => ({condition})},
  PerInstanceColorAppearance: class {constructor(o) {Object.assign(this, o);} static get VERTEX_FORMAT() {return 'per-instance';}},
  MaterialAppearance: Object.assign(class {constructor(o) {Object.assign(this, o);}}, {MaterialSupport: {TEXTURED: {vertexFormat: 'textured'}}}),
  Material: {fromType: (type, options) => ({type, ...options})},
  BoxGeometry: {fromDimensions: options => ({box: options})},
  PlaneGeometry: class {constructor(o) {this.plane = o;}},
  GeometryInstance: class {constructor(o) {Object.assign(this, o);}},
  Primitive: class {constructor(o) {Object.assign(this, o); this.matrices = [];} },
  Matrix3: {fromRotationZ: angle => ({rotationZ: angle})},
  Matrix4: Object.assign(class {constructor() {this.matrix = true;}}, {
    IDENTITY: {identity: true},
    fromTranslation: t => ({translation: [t.x, t.y, t.z]}),
    fromRotationTranslation: (rotation, translation) => ({rotation, translation}),
    multiplyByScale: (matrix, scale) => ({...matrix, scale: [scale.x, scale.y, scale.z]}),
    multiply: (left, right, result) => Object.assign(result, {left, right}),
    clone: (matrix, result) => Object.assign(result ?? {}, matrix),
    multiplyByPoint: (frame, point, result) => Object.assign(result, {x: frame.origin.x + point.x, y: frame.origin.y + point.y, z: frame.origin.z + point.z}),
    getTranslation: (matrix, result) => Object.assign(result, matrix.origin ?? {x: 0, y: 0, z: 0}),
  }),
  HeadingPitchRoll: class {constructor(heading, pitch, roll) {Object.assign(this, {heading, pitch, roll});}},
  Geometry: class {constructor(o) {Object.assign(this, o);}},
  GeometryAttribute: class {constructor(o) {Object.assign(this, o);}},
  ComponentDatatype: {DOUBLE: 'double', FLOAT: 'float'}, PrimitiveType: {TRIANGLES: 'triangles'},
  BoundingSphere: Object.assign(class {constructor(centre, radius) {this.centre = centre; this.radius = radius;}},
    {fromVertices: values => ({vertices: values.length})}),
  ClassificationType: {TERRAIN: 'terrain'}, CornerType: {ROUNDED: 'rounded'}};
const layout = {
  schema_version: 2, pattern: 'row', pattern_label: '가로 일렬',
  frame: {latitude: 37.5, longitude: 127, altitude_m: null, heading_deg: 0},
  dimensions: {vehicle_d_m: 12, fato_radius_m: 9, gate_radius_m: 7.2, taxiway_width_m: 8.4, safety_margin_m: 3, tlof_radius_m: 4.98,
    charger_radius_m: 1.68, charger_size_m: 2.376, charger_height_m: 2.64, charger_offset_m: 11.38},
  platform: {corners_m: [[-40, -30], [40, -30], [40, 30], [-40, 30]], height_m: 1, size_m: [80, 60]},
  ground_reference: 'highest',
  name_area: {center_m: [0, 26], along: 'x', length_m: 70, height_m: 4.8, strip_m: 7.8},
  fatos: [{id: 'F1', role: 'takeoff', marking: 'F', center_m: [-18, 15], radius_m: 9, tlof_radius_m: 4.98, safety_radius_m: 12},
    {id: 'F2', role: 'landing', marking: 'F', center_m: [18, 15], radius_m: 9, tlof_radius_m: 4.98, safety_radius_m: 12}],
  gates: [{id: 'G1', marking: 'G1', center_m: [-10, -15], radius_m: 7.2}, {id: 'G2', marking: 'G2', center_m: [10, -15], radius_m: 7.2}],
  chargers: [{id: 'C1', gate: 'G1', center_m: [-10, -26.38], radius_m: 1.68}, {id: 'C2', gate: 'G2', center_m: [10, -26.38], radius_m: 1.68}],
  edges: [{id: 'E1', from: 'G1', to: 'J1', kind: 'stand', width_m: 8.4, points_m: [[-10, -15], [-10, 0]]}],
  // The people side, as the model library reports it: edge protection right
  // round the deck, and the shelter people come out of beside each cabinet.
  barrier: {height_m: 1.1, inset_m: 0.9, post_pitch_m: 3,
    runs_m: [[[-26.5, -29.1], [26.5, -29.1]], [[-26.5, 29.1], [26.5, 29.1]],
      [[-39.1, -16.5], [-39.1, 16.5]], [[39.1, -16.5], [39.1, 16.5]]]},
  lighting: {fato_perimeter: {colour: 'green', spacing_m: 5, minimum: 8},
    taxiway_centreline: {colour: 'green', spacing_m: 12},
    taxiway_edge: {colour: 'blue', spacing_m: 18},
    beacon: {colour: 'white', period_s: 2, flash_s: 0.35, center_m: [0, 26]}},
  boarding_points: [
    {id: 'B1', gate: 'G1', charger: 'C1', center_m: [-4.5, -26.38], size_m: [3.6, 2.6], height_m: 2.8, along: 'x'},
    {id: 'B2', gate: 'G2', charger: 'C2', center_m: [15.5, -26.38], size_m: [3.6, 2.6], height_m: 2.8, along: 'x'}],
};
const record = {id: 'vp-1', name: '테스트 허브', latitude: 37.5, longitude: 127, heading_deg: 0, gates: 2, pattern: 'row', vehicle_class: 'medium', vehicle_d_m: 12,
  platform_height_m: 1, fatos: [{id: 'F1', role: 'takeoff'}, {id: 'F2', role: 'landing'}], layout};
class Entities {values = []; add(item) {this.values.push(item); return item;} remove(item) {this.values = this.values.filter(v => v !== item);}}
class Primitives {values = []; add(item) {this.values.push(item); return item;} remove(item) {this.values = this.values.filter(v => v !== item); return true;}}
const viewerWith = entities => ({entities, scene: {primitives: new Primitives(), requestRender() {}}});
const byId = (entities, id) => entities.values.find(e => e.id === id);
// A recording 2D context: enough to assert what the painter draws and where.
class RecordingContext {
  constructor() {this.ops = []; this.fillStyle = ''; this.strokeStyle = ''; this.lineWidth = 1; this.font = ''; this.dash = []; this.transform = [0, 0, 0]; this.stack = [];}
  record(op, ...args) {this.ops.push({op, args, fill: this.fillStyle, stroke: this.strokeStyle, width: this.lineWidth, font: this.font, dash: [...this.dash], transform: [...this.transform]});}
  fillRect(...a) {this.record('fillRect', ...a);} strokeRect(...a) {this.record('strokeRect', ...a);}
  beginPath() {} closePath() {} moveTo(...a) {this.record('moveTo', ...a);} lineTo(...a) {this.record('lineTo', ...a);}
  arc(...a) {this.record('arc', ...a);} stroke() {this.record('stroke');} fill() {this.record('fill');}
  setLineDash(d) {this.dash = d;} fillText(...a) {this.record('fillText', ...a);}
  measureText(t) {return {width: t.length * parseFloat(this.font.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? 10) * .6};}
  save() {this.stack.push([...this.transform]);} restore() {this.transform = this.stack.pop() ?? [0, 0, 0];}
  translate(x, y) {this.transform[0] += x; this.transform[1] += y;} rotate(a) {this.transform[2] += a;}
  setTransform(...a) {this.record('setTransform', ...a);} clearRect(...a) {this.record('clearRect', ...a);}
  clip() {this.record('clip');} drawImage(...a) {this.record('drawImage', ...a);}
}
const createCanvas = (width, height) => {const ctx = new RecordingContext(); return {width, height, ctx, getContext: () => ctx};};
const layerOptions = extra => ({createCanvas, ...extra});

test('layout metres are placed relative to the vertiport origin at the requested height', () => {
  const world = layoutToWorld(C, layout, 51);
  assert.deepEqual([world.origin.x, world.origin.y, world.origin.z], [127000, 37500, 51]);
  assert.deepEqual([world.gates[0].center.x, world.gates[0].center.y], [127000 - 10, 37500 - 15]);
  assert.deepEqual([world.fatos[1].center.x, world.fatos[1].center.y], [127000 + 18, 37500 + 15]);
  assert.equal(world.platform.length, 4);
  assert.equal(world.taxiways[0].positions.length, 2);
  assert.equal(world.taxiways[0].width, 8.4);
  assert.equal(world.fatos[0].marking, 'F');
  assert.equal(world.gates[1].marking, 'G2');
});

test('a compiled layout can be turned to another heading without asking the server', () => {
  const turned = rotateLayout(layout, 90);
  assert.equal(turned.frame.heading_deg, 90);
  assert.deepEqual(turned.gates[0].center_m, [-15, 10], 'clockwise from north, as the server rotates');
  assert.deepEqual(turned.fatos[1].center_m, [15, -18]);
  assert.deepEqual(turned.edges[0].points_m, [[-15, 10], [0, 10]]);
  assert.deepEqual(turned.platform.corners_m[0], [-30, 40]);
  assert.deepEqual(turned.bounds_m, {min: [-30, -40], max: [30, 40]});
  assert.deepEqual(rotateLayout(turned, 0).gates[0].center_m, layout.gates[0].center_m, 'turning back restores the original');
  assert.deepEqual(layout.gates[0].center_m, [-10, -15], 'the input is untouched');
  assert.equal(rotateLayout(layout, -90).frame.heading_deg, 270);
});

test('local metres become geographic sampling points around the origin', () => {
  const points = geographicPoints({latitude: 37.5, longitude: 127}, [[0, 0], [1113.2, -1113.2]]);
  assert.deepEqual(points[0], {longitude: 127, latitude: 37.5});
  assert.ok(Math.abs(points[1].latitude - 37.49) < 1e-6, 'north is latitude');
  assert.ok(points[1].longitude > 127.0125 && points[1].longitude < 127.0127, 'east shrinks with the cosine of the latitude');
});

test('ground is sampled over the whole slab and under every marking, not only at the corners', () => {
  const points = groundSamplePoints(layout);
  assert.deepEqual(points[0], [0, 0]);
  for (const corner of layout.platform.corners_m) assert.ok(points.some(p => p[0] === corner[0] && p[1] === corner[1]), 'corner sampled');
  assert.ok(points.some(p => Math.abs(p[0]) < 1e-9 && Math.abs(p[1]) < 1e-9), 'the centre is in the grid');
  assert.ok(points.some(p => p[0] === 0 && p[1] === 30) || points.some(p => p[0] === 20 && p[1] === 15), 'interior grid points exist');
  for (const item of [...layout.fatos, ...layout.gates]) assert.ok(points.includes(item.center_m), `${item.id} centre sampled`);
  assert.equal(points.length, 1 + 25 + 4);
});

test('the apron is painted like an airport: deck, taxi lanes, stands, FATO markings and the name on its strip', () => {
  const painted = paintApron(layout, '테스트 허브', createCanvas);
  const {canvas, pixelsPerMetre: ppm} = painted;
  assert.equal(ppm, 12, 'capped at 12 px/m');
  assert.deepEqual([canvas.width, canvas.height], [960, 720]);
  const ops = canvas.ctx.ops;
  const X = x => (x + 40) * ppm, Y = y => (30 - y) * ppm;
  assert.equal(ops[0].op, 'fillRect'); assert.equal(ops[0].fill, PAINT.deck);
  const lanes = ops.filter(o => o.op === 'stroke' && o.stroke === PAINT.asphalt);
  assert.equal(lanes.length, 1); assert.equal(lanes[0].width, 8.4 * ppm, 'lane width in metres');
  const centrelines = ops.filter(o => o.op === 'stroke' && o.stroke === PAINT.centreline && o.width === .3 * ppm);
  assert.equal(centrelines.length, 1);
  const standRings = ops.filter(o => o.op === 'stroke' && o.stroke === PAINT.stand && o.width === .25 * ppm);
  assert.equal(standRings.length, 2, 'one yellow circle per stand');
  const arcs = ops.filter(o => o.op === 'arc');
  assert.ok(arcs.some(a => a.args[0] === X(-10) && a.args[1] === Y(-15) && a.args[2] === 7.2 * ppm), 'stand G1 circle at its centre');
  assert.ok(arcs.some(a => a.args[0] === X(-18) && a.args[1] === Y(15) && a.args[2] === 4.98 * ppm), 'TLOF circle of F1');
  const dashed = ops.filter(o => o.op === 'stroke' && o.dash.length === 2);
  assert.equal(dashed.length, 2, 'the FATO perimeter is dashed');
  assert.deepEqual(dashed[0].dash, [1.5 * ppm, 1.5 * ppm]);
  const texts = ops.filter(o => o.op === 'fillText');
  const at = label => texts.find(t => t.args[0] === label);
  assert.ok(at('G1') && at('G2') && at('F'), 'stand numbers and the letter are painted');
  assert.equal(at('F').transform[0], X(-18));
  assert.match(texts.map(t => t.args[0]).join('|'), /F1 이륙/);
  assert.match(texts.map(t => t.args[0]).join('|'), /F2 착륙/);
  const name = at('테스트 허브');
  assert.ok(name, 'the name is painted');
  assert.deepEqual([name.transform[0], name.transform[1]], [X(0), Y(26)], 'on the reserved strip, the FATO side of the deck');
  assert.equal(name.transform[2], 0, 'reads along the strip');
  assert.equal(name.fill, PAINT.name);
  assert.ok(parseFloat(name.font.match(/(\d+(?:\.\d+)?)px/)[1]) <= 4.8 * .8 * ppm + 1e-6, 'letters fit the strip height');
  const turned = paintApron({...layout, name_area: {...layout.name_area, along: 'y', center_m: [-38, 0]}}, '허브', createCanvas);
  assert.equal(turned.canvas.ctx.ops.find(o => o.op === 'fillText' && o.args[0] === '허브').transform[2], -Math.PI / 2, 'a strip along the spine is read north-up');
  const tilted = paintApron(rotateLayout(layout, 37), '허브', createCanvas);
  assert.deepEqual([tilted.canvas.width, tilted.canvas.height], [960, 720], 'painting happens in the unrotated design frame');
  assert.equal(paintApron({...layout, platform: null}, 'x', createCanvas), null);
});

test('the building outline is the platform with its corners taken off, and the deck paint still spans it', () => {
  const shell = shellOf(layout);
  assert.ok(shell.points.length > 4, 'a rounded outline has more points than a rectangle');
  assert.deepEqual(boundsOf(shell.points).min, [-40, -30], 'the platform keeps its size');
  assert.deepEqual(boundsOf(shell.points).max, [40, 30]);
  assert.ok(!shell.points.some(([x, y]) => Math.abs(x) === 40 && Math.abs(y) === 30), 'the square corners are gone');
  assert.equal(shell.texture.length, shell.points.length, 'one texture coordinate per point');
  assert.ok(shell.texture.every(([s, t]) => s >= 0 && s <= 1 && t >= 0 && t <= 1));
  assert.ok(shell.cladding.every(([x, y], index) => Math.hypot(x, y) >= Math.hypot(...shell.points[index]) - 1e-9), 'the cladding stands clear of the mass');
  const turned = shellOf(rotateLayout(layout, 90));
  assert.equal(turned.points.length, shell.points.length);
  assert.ok(Math.abs(boundsOf(turned.points).max[0] - 30) < 1e-6, 'a turned layout turns its outline with it');
  assert.deepEqual(turned.texture, shell.texture, 'the paint stays attached to the shape, not to north');
  assert.equal(shellOf({...layout, platform: null}), null);
  // A ring of stands is generated on a deck that asks to be round; anything
  // beyond half the short side would stop being a deck.
  assert.equal(cornerRadius(80, 60), 12);
  assert.equal(cornerRadius(80, 60, 30), 30);
  assert.equal(cornerRadius(80, 60, 999), 30);
  const spanAt = points => {
    const ys = points.filter(([x]) => Math.abs(x - 40) < 1e-9).map(point => point[1]);
    return ys.length ? Math.max(...ys) - Math.min(...ys) : 0;
  };
  const round = shellOf({...layout, platform: {...layout.platform, corner_radius_m: 30}});
  assert.equal(spanAt(shell.points), 36, 'by default a long straight edge stays');
  assert.equal(spanAt(round.points), 0, 'a layout that asks for a round deck gets one');
});

test('the deck is marked where people come out: a pad under each shelter', () => {
  const painted = paintApron(layout, '테스트 허브', createCanvas);
  const ops = painted.canvas.ctx.ops;
  const pads = ops.filter(o => o.op === 'fillRect' && o.fill === PAINT.boarding);
  assert.equal(pads.length, layout.boarding_points.length, 'a pad per stand, not one shared place');
  // The pad stands a little proud of the shelter on it, so the shelter reads as
  // standing on something rather than dropped on the concrete.
  const [, , padWidth] = pads[0].args;
  assert.ok(padWidth > layout.boarding_points[0].size_m[0] * painted.pixelsPerMetre);
  assert.equal(ops.filter(o => o.op === 'strokeRect' && o.stroke === PAINT.boardingEdge).length, pads.length);
  // Painted before the stands, so a stand circle is never buried by a pad.
  const padAt = ops.findIndex(o => o.fill === PAINT.boarding);
  const standAt = ops.findIndex(o => o.op === 'fillText' && o.args[0] === 'G1');
  assert.ok(padAt >= 0 && standAt > padAt, 'the stands are drawn over the pads, not under them');
});

test('a deck with no people side is painted exactly as it was before there was one', () => {
  const {barrier, boarding_points: boarding, ...bare} = layout;
  const painted = paintApron(bare, '테스트 허브', createCanvas);
  assert.equal(painted.canvas.ctx.ops.filter(o => o.fill === PAINT.boarding).length, 0);
  assert.ok(painted.canvas.ctx.ops.some(o => o.stroke === PAINT.stand), 'and everything else is still there');
});

test('what stands on the deck is what the layout says stands on it', () => {
  const furniture = deckFurniture(layout);
  assert.equal(furniture.barrier.runs.length, 4, 'right round the deck, every side');
  assert.equal(furniture.barrier.height, 1.1, 'low enough to sit under any approach');
  assert.deepEqual(furniture.boarding.map(b => b.gate), ['G1', 'G2'], 'one shelter per stand');
  assert.equal(furniture.boarding[0].height, 2.8);
  assert.equal(furniture.heading, 0);
  // Nothing is invented for a layout that has none: a vertiport saved before
  // any of this still draws, without a barrier round it.
  const {barrier, boarding_points: boarding, ...bare} = layout;
  assert.equal(deckFurniture(bare), null);
  assert.equal(deckFurniture({...layout, barrier: {height_m: 1.1, runs_m: []}, boarding_points: []}), null);
});

test('the people side turns with the layout, so it stays on the deck at any heading', () => {
  const turned = rotateLayout(layout, 90);
  assert.equal(turned.barrier.runs_m.length, layout.barrier.runs_m.length);
  const length = run => Math.hypot(run[1][0] - run[0][0], run[1][1] - run[0][1]);
  assert.deepEqual(turned.barrier.runs_m.map(r => Math.round(length(r))),
    layout.barrier.runs_m.map(r => Math.round(length(r))), 'a rigid turn, not a redesign');
  assert.notDeepEqual(turned.barrier.runs_m[0], layout.barrier.runs_m[0], 'it really did turn');
  assert.notDeepEqual(turned.boarding_points[0].center_m, layout.boarding_points[0].center_m);
  const back = rotateLayout(turned, 0);
  assert.deepEqual(back.boarding_points[0].center_m.map(v => Math.round(v)),
    layout.boarding_points[0].center_m.map(v => Math.round(v)));
});

test('a vertiport hands the building layers the ground it covers', () => {
  const rings = footprintsOf([layout]);
  assert.equal(rings.length, 1);
  const ring = rings[0];
  assert.ok(ring.length > 4, 'the rounded outline, not a bare rectangle');
  assert.ok(ring.every(p => Number.isFinite(p.longitude) && Number.isFinite(p.latitude)));
  // Its own centre is inside it, and a point well away from the deck is not.
  assert.equal(insideFootprint(rings, 127, 37.5), true);
  assert.equal(insideFootprint(rings, 127.01, 37.5), false, 'a kilometre east is ground this deck never covered');
  assert.equal(insideFootprint([], 127, 37.5), false, 'no vertiports, no cleared ground');
  // Pushed out past the deck edge, so a wall stopping exactly at it leaves no
  // sliver of itself beside the cladding.
  const [, north] = [ring[0], ring.reduce((a, b) => (b.latitude > a.latitude ? b : a))];
  const edge = layout.platform.corners_m.reduce((a, b) => Math.max(a, b[1]), 0);
  assert.ok((north.latitude - 37.5) * 111320 > edge, 'the ring reaches past the deck itself');
  assert.deepEqual(footprintsOf([]), [], 'nothing placed, nothing cleared');
  assert.deepEqual(footprintsOf([{frame: layout.frame}]), [], 'a layout with no platform clears nothing');
});

test('a neighbour whose corner runs through the deck is cleared, and one merely beside it is not', () => {
  const rings = footprintsOf([layout], 0);
  const ring = rings[0];
  const west = ring.reduce((a, b) => (b.longitude < a.longitude ? b : a)).longitude;
  const east = ring.reduce((a, b) => (b.longitude > a.longitude ? b : a)).longitude;
  const south = ring.reduce((a, b) => (b.latitude < a.latitude ? b : a)).latitude;
  const north = ring.reduce((a, b) => (b.latitude > a.latitude ? b : a)).latitude;
  const box = (w, s, e, n) => [[w, s], [e, s], [e, n], [w, n]];

  // The building the deck was built on: it is cleared today and must stay so.
  assert.equal(overlapsFootprint(rings, box(west, south, east, north)), true, 'the host building');

  // The case a centre-point test misses: most of this building is off to the
  // east, so its middle is outside the deck, but a corner of it stands on the
  // deck's own ground and used to be left poking through the vertiport.
  const step = east - west;
  const corner = box(east - step * .1, south, east + step * 2, north);
  const middle = corner.reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4], [0, 0]);
  assert.equal(insideFootprint(rings, middle[0], middle[1]), false, 'its centre really is outside');
  assert.equal(overlapsFootprint(rings, corner), true, 'but its corner is on the deck, so it goes');

  // A wall driven straight across with no corner of its own inside, and the
  // deck swallowed whole by something far bigger: both are overlaps too.
  assert.equal(overlapsFootprint(rings, box(west - step, (south + north) / 2 - 1e-6,
    east + step, (south + north) / 2 + 1e-6)), true, 'a slab crossing it');
  assert.equal(overlapsFootprint(rings, box(west - step, south - step, east + step, north + step)),
    true, 'a building that contains the whole deck');

  // And the neighbour that only stands nearby stays standing.
  assert.equal(overlapsFootprint(rings, box(east + step * .2, south, east + step, north)), false,
    'a building beside the deck is a real building');
  assert.equal(overlapsFootprint([], box(west, south, east, north)), false, 'no vertiports, nothing cleared');
  assert.equal(overlapsFootprint(rings, [[west, south]]), false, 'a degenerate outline is not an overlap');
});

test('an L-shaped block beside a deck keeps its building, centre or no centre', () => {
  // A real one: 신동아아파트, 87 x 84 m and 42.9 m tall, standing 5.55 m clear
  // of a deck. Its footprint wraps a courtyard, so the average of its corners
  // lands outside the building itself -- 0.44 m from the deck's corner. Judged
  // by that point the whole block was deleted, though it never touched the
  // vertiport. Judged by its footprint it stays, which is what it should do.
  const rings = footprintsOf([layout], 0);
  const ring = rings[0];
  const west = ring.reduce((a, b) => (b.longitude < a.longitude ? b : a)).longitude;
  const east = ring.reduce((a, b) => (b.longitude > a.longitude ? b : a)).longitude;
  const south = ring.reduce((a, b) => (b.latitude < a.latitude ? b : a)).latitude;
  const north = ring.reduce((a, b) => (b.latitude > a.latitude ? b : a)).latitude;
  const width = east - west, height = north - south;
  // A U opening onto the deck: its arms pass either side, its corners average
  // to a point on the deck, and no part of it stands on the deck.
  const gap = width * .05;
  const arms = [
    [east + gap, south], [east + gap + width, south],
    [east + gap + width, north], [east + gap, north],
    [east + gap, north - height * .2], [east + gap + width * .8, north - height * .2],
    [east + gap + width * .8, south + height * .2], [east + gap, south + height * .2],
  ];
  const average = arms.reduce((a, p) => [a[0] + p[0] / arms.length, a[1] + p[1] / arms.length], [0, 0]);
  assert.equal(insideFootprint([arms.map(p => ({longitude: p[0], latitude: p[1]}))], average[0], average[1]),
    false, 'the average of its corners is not even inside it');
  assert.equal(overlapsFootprint(rings, arms), false, 'and it never reaches the deck, so it stays');
});

test('the globe gives that ground to the building layers and takes it back', () => {
  const globeSource = readFileSync(new URL('../../../../digital_twin/visualization/web/globe.js', import.meta.url), 'utf8');
  assert.match(globeSource, /clearGroundUnderVertiports\(records\)/);
  assert.match(globeSource, /const cleared = footprintsOf\(layouts, 0\);/);
  assert.match(globeSource, /this\.vworldBuildings\?\.setCleared\?\.\(cleared, overlapsFootprint\)/,
    'the extruded cells are told which ground is taken, and test their whole footprint against it');
  assert.match(globeSource, /this\.clipTilesets\(footprintsOf\(layouts\)\)/,
    'while clipping keeps the pushed-out outline, so no wall shows a sliver');
  assert.match(globeSource, /ClippingPolygonCollection/, 'and a streamed tileset is clipped to the same outlines');
  assert.match(globeSource, /if \(tileset\.aerodtClippedRings === rings\.length\) continue;/,
    'a tileset already carrying these outlines is left alone, so its tiles are not dropped every pass');
});

test('a deck is lit the way an aerodrome is: green where you touch down, green and blue on the taxi routes', () => {
  const lamps = lampsFor(layout);
  const kinds = lamps.reduce((count, lamp) => ({...count, [lamp.kind]: (count[lamp.kind] ?? 0) + 1}), {});
  // A lamp every few metres round each FATO, and never fewer than the minimum.
  const perRing = Math.max(8, Math.round(2 * Math.PI * layout.fatos[0].radius_m / 5));
  assert.equal(kinds.fato, perRing * layout.fatos.length);
  assert.ok(kinds.centreline > 0 && kinds.edge > 0, 'the taxi route is lit down the middle and along its edges');
  assert.ok(kinds.edge >= kinds.centreline / 2, 'both sides of a lane carry lamps');
  assert.equal(kinds.beacon, 1, 'one beacon over the site');
  // The colours are the layout's, read off the design rather than chosen here.
  assert.equal(colourOf('fato', layout.lighting), LIGHT_COLOUR.green);
  assert.equal(colourOf('centreline', layout.lighting), LIGHT_COLOUR.green);
  assert.equal(colourOf('edge', layout.lighting), LIGHT_COLOUR.blue);
  assert.equal(colourOf('beacon', layout.lighting), LIGHT_COLOUR.white);
  // The ring really is a ring: every FATO lamp sits on that FATO's edge.
  for (const lamp of lamps.filter(l => l.kind === 'fato')) {
    const near = layout.fatos.map(f => Math.hypot(lamp.point[0] - f.center_m[0], lamp.point[1] - f.center_m[1]));
    assert.ok(near.some(d => Math.abs(d - layout.fatos[0].radius_m) < 0.01), 'on the FATO perimeter');
  }
  // A layout with no lighting design is not lit by guesswork.
  const {lighting, ...dark} = layout;
  assert.deepEqual(lampsFor(dark), []);
});

test('surface lights are inset while only the site beacon stands proud of the deck', () => {
  for (const kind of ['fato', 'centreline', 'edge']) {
    assert.equal(elevationOf(kind), INSET_LIGHT_CLEARANCE_M);
  }
  assert.equal(elevationOf('beacon'), BEACON_STAND_METRES);
  assert.ok(INSET_LIGHT_CLEARANCE_M <= 0.02, 'an inset fitting must read as part of the paint, not a floating lamp');
  assert.ok(BEACON_STAND_METRES > INSET_LIGHT_CLEARANCE_M * 10, 'the actual beacon remains visibly elevated');
});

test('lamps are spaced along a route and its ends are always lit', () => {
  const line = [[0, 0], [30, 0]];
  const placed = alongPolyline(line, 12);
  assert.deepEqual(placed[0], [0, 0], 'the start');
  assert.deepEqual(placed[placed.length - 1], [30, 0], 'and the end');
  const gaps = placed.slice(1).map(([x], at) => x - placed[at][0]);
  assert.ok(gaps.every(gap => gap > 0 && gap <= 12.001), `evenly spaced: ${gaps}`);
  assert.deepEqual(alongPolyline([], 12), []);
  assert.deepEqual(alongPolyline(line, 0), [], 'no spacing, no lamps');
  // The edge lamps run beside the route, not on it.
  const beside = offsetPolyline(line, 4);
  assert.ok(beside.every(([, y]) => Math.abs(y + 4) < 1e-6), 'offset across the line');
});

test('the lamps breathe and the beacon flashes, and neither runs away with itself', () => {
  const beacon = layout.lighting.beacon;
  // A steady lamp stays near full and never goes out.
  const steady = [0, 0.4, 1.1, 2.3, 5].map(t => brightness('centreline', t, 1.2));
  assert.ok(steady.every(value => value > 0.8 && value <= 1), `a steady lamp stays lit: ${steady}`);
  assert.ok(new Set(steady.map(v => Math.round(v * 1000))).size > 1, 'but it does not sit still');
  // Two lamps in different places are not in step, which is what makes a field
  // read as lit rather than as one blinking sign.
  assert.notEqual(brightness('fato', 0.5, 0), brightness('fato', 0.5, 2));
  // The beacon is dark between flashes and bright inside one.
  assert.equal(brightness('beacon', 0.1, 0, beacon), 1);
  assert.ok(brightness('beacon', 1.2, 0, beacon) < 0.2, 'dark between flashes');
  assert.equal(brightness('beacon', 2.1, 0, beacon), 1, 'and it comes round again');
});

test('the layer lights every deck it places and takes the lamps away with it', async () => {
  const entities = new Entities();
  const viewer = viewerWith(entities);
  const layer = new VertiportLayer(C, viewer, layerOptions({groundHeights: async p => p.map(() => 5)}));
  await layer.show([{id: 'vp-1', name: '테스트 허브', layout}]);
  const lit = layer.lights.points.items.length;
  assert.equal(lit, lampsFor(layout).length, 'every lamp the design calls for');
  assert.ok(lit > 20, `a lit deck, not a handful of dots: ${lit}`);
  const lamps = lampsFor(layout), points = layer.lights.points.items;
  const deckSurface = 6.02; // sampled ground 5 m + platform 1 m + paint clearance 0.02 m
  lamps.forEach((lamp, index) => assert.ok(Math.abs(points[index].position.z
    - (deckSurface + elevationOf(lamp.kind))) < 1e-9,
  `${lamp.kind} follows its fitting height`));
  // They burn brighter and dimmer as the seconds pass.
  const before = layer.lights.points.items.map(p => p.color.alpha);
  layer.tickLights(0.7);
  const after = layer.lights.points.items.map(p => p.color.alpha);
  assert.notDeepEqual(before, after, 'the field is alive');
  // Off means off, and a removed vertiport takes its lamps with it.
  layer.setLightsEnabled(false);
  assert.ok(layer.lights.points.items.every(p => p.show === false));
  layer.setLightsEnabled(true);
  layer.remove('vp-1');
  assert.equal(layer.lights.points.items.length, 0, 'the lamps go when the deck goes');
});

test('the facade is painted for the wall it clads: a plinth and a coping always, storeys only where there is room', () => {
  assert.equal(facadeWall(1), 3, 'the clad wall is the platform height plus the ground band');
  assert.equal(facadeHeight(1.7), 3.5, 'painting is done in half-metre steps, and reported at the same step');
  const low = paintFacade(facadeWall(1), createCanvas);
  assert.equal(low.storeys, 0, 'a one-metre platform is a deck edge, not a building');
  const tall = paintFacade(facadeWall(12), createCanvas);
  assert.equal(tall.storeys, Math.max(1, Math.round(tall.band_m / STOREY_M)));
  assert.ok(tall.storeys >= 3);
  // Punched windows, so a wall reads as windows and not as one long slot: a
  // bay about every metre and a half, each its own pane with wall in between.
  const bays = Math.max(1, Math.round((FACADE_TILE_M - 2 * Math.min(0.6, FACADE_TILE_M * 0.12)) / BAY_M));
  const glass = tall.canvas.ctx.ops.filter(o => o.op === 'fillRect' && o.fill === FACADE.glass);
  assert.equal(glass.length, tall.storeys * bays, 'a window in every bay of every storey');
  assert.ok(bays >= 3, 'a six-metre tile carries at least three windows');
  // A window is taller than it is wide — the squashed slot was the other way
  // round — and the panes are separated by wall, not only by a mullion.
  const [, , paneWidth, paneHeight] = glass[0].args;
  assert.ok(paneHeight > paneWidth, `a window stands up: ${paneWidth} x ${paneHeight}`);
  const lefts = glass.slice(0, bays).map(o => o.args[0]).sort((a, b) => a - b);
  const gaps = lefts.slice(1).map((x, at) => x - lefts[at] - paneWidth);
  assert.ok(gaps.every(gap => gap > 0), 'there is wall between one window and the next');
  for (const painted of [low, tall]) {
    const ops = painted.canvas.ctx.ops;
    assert.equal(ops[0].fill, FACADE.wall, 'the wall is laid first');
    assert.ok(ops.some(o => o.fill === FACADE.plinth), 'a plinth at the foot');
    assert.ok(ops.some(o => o.fill === FACADE.coping), 'a coping at the parapet');
  }
  assert.equal(facadePlan(facadeWall(0)).storeys, 0);
  // The same wall without glazing, which is what goes round a corner radius: a
  // window texture wrapped round a tight curve is a smear, not a window.
  const blank = paintFacade(facadeWall(12), createCanvas, {windows: false});
  assert.equal(blank.storeys, 0, 'no storeys means no glazing');
  assert.equal(blank.canvas.ctx.ops.filter(o => o.fill === FACADE.glass).length, 0);
  assert.ok(blank.canvas.ctx.ops.some(o => o.fill === FACADE.plinth), 'still a clad wall');
  assert.equal(blank.height_m, tall.height_m, 'and the same height, so the two meet');
});

test('the shell mesh wraps the facade once per tile and repeats its foot below the cladding', () => {
  const outline = roundedOutline([[-10, -10], [10, -10], [10, 10], [-10, 10]], 2);
  const texture = outlineTexture(outline, boundsOf(outline));
  const mesh = shellMesh(outline, texture, {rows: [[-9, 0], [-3, 0], [0, 1]], capHeight: 0.03});
  assert.equal(mesh.sides.positions.length / 3, outline.length * 2 * 4, 'two bands of quads around the ring');
  assert.equal(mesh.facade_repeats, Math.max(1, Math.round(mesh.perimeter_m / 6)));
  const heights = [], verticals = [];
  for (let index = 0; index < mesh.sides.positions.length; index += 3) heights.push(mesh.sides.positions[index + 2]);
  for (let index = 1; index < mesh.sides.st.length; index += 2) verticals.push(mesh.sides.st[index]);
  assert.deepEqual([...new Set(heights)].sort((a, b) => a - b), [-9, -3, 0]);
  assert.ok(verticals.every(value => value === 0 || value === 1), 'the buried band repeats the foot of the texture');
  const horizontals = [];
  for (let index = 0; index < mesh.sides.st.length; index += 2) horizontals.push(mesh.sides.st[index]);
  // Cesium compresses a vertex texture coordinate into twelve bits per axis and
  // reads back nonsense from anything outside 0..1; the tiling belongs to the
  // material, not to the mesh. This is what left the facade a flat grey.
  assert.ok(horizontals.every(value => value >= 0 && value <= 1), 'the walk around the ring is a fraction');
  assert.equal(Math.max(...horizontals), 1);
  assert.equal(mesh.cap.positions[2], 0.03, 'the cap carries the deck lift');
  assert.equal(mesh.cap.positions.length / 3, outline.length + 1, 'a fan from the centre');
  assert.equal(mesh.cap.indices.length, outline.length * 3);
  const outward = mesh.sides.normals[0] * mesh.sides.positions[0] + mesh.sides.normals[1] * mesh.sides.positions[1];
  assert.ok(outward > 0, 'the sides face away from the centre');
  const reversed = shellMesh([...outline].reverse(), [...texture].reverse(), {rows: [[-1, 0], [0, 1]]});
  assert.ok(reversed.sides.normals[0] * reversed.sides.positions[0] + reversed.sides.normals[1] * reversed.sides.positions[1] > 0,
    'an outline given the other way round still faces outwards');
});

test('every stand gets a small charging cabinet standing on the deck beside it', async () => {
  const entities = new Entities();
  const layer = new VertiportLayer(C, viewerWith(entities), layerOptions({groundHeights: async points => points.map(() => 10)}));
  await layer.show([record]);
  const cabinets = entities.values.filter(entity => String(entity.id).includes(':charger:'));
  assert.deepEqual(cabinets.map(entity => entity.id), ['vertiport:vp-1:charger:C1', 'vertiport:vp-1:charger:C2'], 'one per stand');
  const [one] = cabinets;
  assert.deepEqual([one.model.nodeTransformations.Facility.scale.x, one.model.nodeTransformations.Facility.scale.z, one.model.nodeTransformations.Facility.scale.y], [2.376, 2.376, 2.64], 'a small square building');
  assert.equal(one.position.z, 11 + 0.02 + 2.64 / 2, 'standing on the deck, neither sunk into it nor floating');
  assert.equal(one.position.x, 127000 - 10, 'beside its stand, where the layout put it');
  assert.match(one.model.uri, /charging_station\.glb/);
  assert.equal(one.model.minimumPixelSize, 0, 'facility does not grow beyond its reserved footprint');
  assert.ok(one.orientation, 'square to the deck rather than to north');
  assert.equal(one.box, undefined);
  const deck = byId(entities, 'vertiport:vp-1:deck');
  assert.ok(!deck.polygon.material.image.ctx.ops.some(op => op.fill === PAINT.bolt), 'nothing is painted on the deck for it');
  assert.ok(!deck.polygon.material.image.ctx.ops.some(op => op.stroke === PAINT.chargerEdge), 'and no cable run');
  // A vertiport saved before charging cabinets still draws.
  await layer.show([{...record, layout: {...layout, chargers: undefined}}]);
  assert.equal(entities.values.filter(entity => String(entity.id).includes(':charger:')).length, 0);
});

test('the layer raises a platform slab over the highest ground beneath it and lays the painted deck on top', async () => {
  const entities = new Entities();
  const sampled = [];
  const layer = new VertiportLayer(C, viewerWith(entities), layerOptions({groundHeights: async points => {sampled.push(points); return points.map((_, i) => (i === 7 ? 52 : i === 3 ? 48 : 50));}}));
  await layer.show([record]);
  assert.equal(sampled.length, 1, 'one sampling request per placement');
  assert.equal(sampled[0].length, 30, 'origin, 5x5 grid and four marking centres');
  assert.deepEqual(sampled[0][0], {longitude: 127, latitude: 37.5});
  const platform = byId(entities, 'vertiport:vp-1:platform');
  assert.ok(platform, 'the slab exists');
  assert.equal(platform.polygon.extrudedHeight, 53, 'the slab top clears the highest sample plus the platform height');
  assert.ok(platform.polygon.height < 48, 'the slab base sinks below the lowest sample so slopes show no gap');
  assert.ok(platform.polygon.hierarchy.positions.length > 4, 'the footprint is rounded, not a bare rectangle');
  // The wall is clad span by span: the flats carry windows, the corner radii
  // carry plain cladding, and between them they cover the whole ring.
  const walls = entities.values.filter(e => typeof e.id === 'string' && e.id.startsWith('vertiport:vp-1:facade:'));
  assert.ok(walls.length >= 8, `the sides are clad in spans: ${walls.length}`);
  assert.equal(walls[0].wall.maximumHeights[0], 53, 'the cladding reaches the deck');
  assert.equal(Math.round((53 - walls[0].wall.minimumHeights[0]) * 10) / 10, facadeWall(1), 'and covers the platform height plus the ground band');
  assert.ok(walls.every(w => w.wall.material.image.ctx), 'every span is a painted canvas');
  assert.ok(walls.every(w => w.wall.material.repeat.x >= 1), 'each span carries whole tiles');
  // A one-metre platform is a deck edge, so no span carries glazing; what the
  // spans are for is that a taller one glazes its flats and not its curves,
  // which is asserted where the facade itself is painted.
  const clad = new Set(walls.flatMap(w => w.wall.positions));
  assert.equal(clad.size, platform.polygon.hierarchy.positions.length, 'every outline point is clad');
  const deck = byId(entities, 'vertiport:vp-1:deck');
  assert.ok(deck, 'the painted deck exists');
  assert.ok(deck.polygon.height > 53 && deck.polygon.height < 53.1, 'the deck lies just on the slab');
  assert.ok(deck.polygon.material.image.ctx, 'the deck material is the painted canvas');
  assert.equal(deck.polygon.material.image.ctx.ops.find(o => o.op === 'fillText' && o.args[0] === '테스트 허브').fill, PAINT.name);
  const st = deck.polygon.textureCoordinates.positions.map(p => [p.x, p.y]);
  assert.equal(st.length, deck.polygon.hierarchy.positions.length, 'one texture coordinate per outline point');
  assert.ok(st.every(([s0, t0]) => s0 >= 0 && s0 <= 1 && t0 >= 0 && t0 <= 1));
  assert.ok(st.some(([s0]) => s0 === 0) && st.some(([s0]) => s0 === 1), 'the paint still spans the platform rectangle');
  assert.ok(st.some(([, t0]) => t0 === 0) && st.some(([, t0]) => t0 === 1));
  assert.equal(deck.polygon.heightReference, undefined, 'nothing is clamped to terrain');
  assert.ok(!entities.values.some(e => e.id === 'vertiport:vp-1:F1' || e.id === 'vertiport:vp-1:G1:label' || e.id === 'vertiport:vp-1:E1'), 'markings are paint, not entities');
  // Slab, facade, deck, two charging cabinets, near name and far marker, plus
  // the people side: three protected sides (a wall and its rail each), the way
  // down with its name, and two boards with theirs.
  const ids = entities.values.map(e => e.id);
  assert.equal(ids.filter(id => id.includes(':barrier:')).length, layout.barrier.runs_m.length, 'a wall per run');
  assert.equal(ids.filter(id => id.includes(':barrier-rail:')).length, layout.barrier.runs_m.length, 'and a rail on it');
  assert.equal(ids.filter(id => id.includes(':boarding:')).length, layout.boarding_points.length, 'a shelter per stand');
  assert.equal(ids.filter(id => id.includes(':core') || id.includes(':sign')).length, 0,
    'nothing stands on the deck that the layout did not put there');
});

test('a vertiport being edited stays where it is but goes faint, without measuring the ground again', async () => {
  const entities = new Entities();
  let sampled = 0;
  const layer = new VertiportLayer(C, viewerWith(entities), layerOptions({groundHeights: async points => {sampled++; return points.map(() => 10);}}));
  await layer.show([record]);
  assert.equal(sampled, 1);
  assert.equal(byId(entities, 'vertiport:vp-1:platform').polygon.material.alpha, 1);
  assert.equal(layer.setDimmed(['vp-1']), true);
  assert.equal(sampled, 1, 'a change of emphasis is a redraw, not a fresh terrain sample');
  const platform = byId(entities, 'vertiport:vp-1:platform');
  assert.equal(platform.polygon.material.alpha, 0.3);
  assert.equal(platform.polygon.extrudedHeight, 11, 'and it stays exactly where it was placed');
  const deck = byId(entities, 'vertiport:vp-1:deck');
  assert.equal(deck.polygon.material.color.alpha, 0.3);
  assert.equal(deck.polygon.material.transparent, true);
  assert.ok(deck.polygon.material.image.ctx, 'the paint is the same, only fainter');
  assert.equal(byId(entities, 'vertiport:vp-1:facade:0').wall.material.color.alpha, 0.3);
  assert.equal(byId(entities, 'vertiport:vp-1:marker').point.color.alpha, 0.3);
  assert.equal(byId(entities, 'vertiport:vp-1:name').label.fillColor.alpha, 0.3);
  assert.equal(layer.setDimmed(['vp-1']), false, 'asking for the same emphasis twice redraws nothing');
  layer.setDimmed([]);
  assert.equal(byId(entities, 'vertiport:vp-1:platform').polygon.material.alpha, 1, 'and it comes back solid');
  assert.equal(byId(entities, 'vertiport:vp-1:deck').polygon.material.color, undefined);
  // A vertiport placed again while it is being edited is faint from the start.
  layer.setDimmed(['vp-1']);
  await layer.show([record]);
  assert.equal(byId(entities, 'vertiport:vp-1:platform').polygon.material.alpha, 0.3);
  layer.remove('vp-1');
  assert.equal(layer.grounds.has('vp-1'), false, 'a removed vertiport leaves no ground behind');
});

test('the vertiport names are drawn at the size the display setting asks for', async () => {
  const entities = new Entities();
  const layer = new VertiportLayer(C, viewerWith(entities), layerOptions({groundHeights: async p => p.map(() => 0)}));
  await layer.show([record]);
  const near = byId(entities, 'vertiport:vp-1:name'), marker = byId(entities, 'vertiport:vp-1:marker');
  assert.equal(near.label.font, 'bold 13px sans-serif', 'the size the layer was designed at');
  assert.equal(marker.label.font, 'bold 12px sans-serif');
  const count = entities.values.length;
  assert.equal(layer.setLabelScale(1.5), true);
  assert.equal(byId(entities, 'vertiport:vp-1:name').label.font, 'bold 19.5px sans-serif');
  assert.equal(byId(entities, 'vertiport:vp-1:marker').label.font, 'bold 18px sans-serif');
  assert.equal(entities.values.length, count, 'the names are rewritten, nothing is rebuilt');
  assert.equal(layer.setLabelScale(1.5), false);
  assert.equal(layer.setLabelScale(0), false, 'a size of nothing is not a size');
});

test('a far marker keeps the vertiport visible from any distance while the painted deck carries the near view', async () => {
  const entities = new Entities();
  const layer = new VertiportLayer(C, viewerWith(entities), layerOptions({groundHeights: async p => p.map(() => 0)}));
  await layer.show([record]);
  const marker = byId(entities, 'vertiport:vp-1:marker');
  assert.ok(marker.point && marker.label, 'a point with the name');
  assert.equal(marker.label.text, '테스트 허브');
  assert.equal(marker.point.disableDepthTestDistance, 0);
  assert.equal(marker.label.disableDepthTestDistance, 0);
  // It used to stay on to orbit; eighteen vertiports in one city then drew a
  // knot of names at any distance, so the marker now leaves with the region.
  assert.ok(marker.label.distanceDisplayCondition.far <= 400000, 'the marker leaves once the region does');
  assert.ok(marker.label.distanceDisplayCondition.far >= 210000, 'and not before a view from 200 km up holds the whole area');
  assert.ok(marker.label.distanceDisplayCondition.far > marker.label.distanceDisplayCondition.near);
  assert.equal(marker.point.distanceDisplayCondition.far, marker.label.distanceDisplayCondition.far, 'the dot and its name go together');
  const near = byId(entities, 'vertiport:vp-1:name');
  assert.ok(near.label.distanceDisplayCondition.near >= 300, 'close up the painted name is enough');
  assert.ok(near.label.distanceDisplayCondition.far <= marker.label.distanceDisplayCondition.near, 'near and far names never overlap');
  assert.equal(byId(entities, 'vertiport:vp-1:deck').polygon.distanceDisplayCondition.far, 8000, 'paint detail ends where the marker takes over');
});

test('the deck height follows the chosen ground reference or a manual altitude', async () => {
  const heights = p => p.map((_, i) => (i === 7 ? 60 : i === 3 ? 40 : 50));
  const place = async (extra) => {
    const entities = new Entities();
    const placed = [];
    const layer = new VertiportLayer(C, viewerWith(entities), layerOptions({groundHeights: async p => heights(p), onPlaced: (id, info) => placed.push({id, ...info})}));
    await layer.show([{...record, layout: {...layout, ...extra}}]);
    return {top: byId(entities, 'vertiport:vp-1:platform').polygon.extrudedHeight, placed};
  };
  assert.equal((await place({})).top, 61, 'highest by default');
  assert.equal((await place({ground_reference: 'lowest'})).top, 41);
  const mean = await place({ground_reference: 'mean'});
  assert.ok(Math.abs(mean.top - (28 * 50 + 60 + 40) / 30 - 1) < 1e-9);
  const manual = await place({ground_reference: 'manual', frame: {...layout.frame, altitude_m: 30}});
  assert.equal(manual.top, 31, 'a manual altitude is the reference');
  assert.deepEqual(manual.placed.at(-1), {id: 'vp-1', reference: 'manual', top: 31, min: 30, max: 30, mean: 30});
  const auto = (await place({})).placed.at(-1);
  assert.equal(auto.min, 40); assert.equal(auto.max, 60); assert.equal(auto.top, 61);
  assert.ok(Math.abs(auto.mean - (28 * 50 + 60 + 40) / 30) < 1e-9);
  const fallback = new VertiportLayer(C, viewerWith(new Entities()), layerOptions({groundHeights: async () => {throw new Error('no terrain');}}));
  await fallback.show([record]);
  assert.equal(byId(fallback.entities, 'vertiport:vp-1:platform').polygon.extrudedHeight, 1, 'a failed sample falls back to the ellipsoid');
});

test('showing again does not duplicate, a slow sample cannot resurrect a removed vertiport, and hiding hides everything', async () => {
  const entities = new Entities();
  let resolveSlow;
  const slow = new Promise(resolve => {resolveSlow = resolve;});
  let calls = 0;
  const layer = new VertiportLayer(C, viewerWith(entities), layerOptions({groundHeights: p => (++calls === 1 ? slow : Promise.resolve(p.map(() => 5)))}));
  const slowHeights = Array.from({length: 30}, () => 99);
  const first = layer.show([record]);
  const second = layer.show([{...record, name: '수정된 허브'}]);
  await second;
  const count = entities.values.length;
  assert.ok(count > 0);
  resolveSlow(slowHeights);
  await first;
  assert.equal(entities.values.length, count, 'the stale first placement is discarded');
  assert.equal(byId(entities, 'vertiport:vp-1:platform').polygon.extrudedHeight, 6, 'the latest sample wins');
  await layer.show([]);
  assert.equal(entities.values.length, 0);
  await layer.show([record]);
  layer.setVisible(false);
  assert.ok(entities.values.every(e => e.show === false));
  await layer.preview(layout, '새 허브');
  assert.ok(entities.values.filter(e => e.id.startsWith('vertiport:__preview__:')).every(e => e.show === false), 'new entities respect the hidden state');
  layer.setVisible(true);
  assert.ok(entities.values.every(e => e.show === true));
  await layer.preview(null);
  assert.ok(!entities.values.some(e => e.id.startsWith('vertiport:__preview__:')));
  layer.destroy();
  assert.equal(entities.values.length, 0);
});

test('a design edit at a known position shows at once and is corrected only if the ground sample disagrees', async () => {
  const entities = new Entities();
  const pending = [];
  const layer = new VertiportLayer(C, viewerWith(entities), layerOptions({groundHeights: points => new Promise(resolve => pending.push(heights => resolve(points.map(() => heights))))}));
  const first = layer.preview(layout, '허브');
  assert.equal(entities.values.length, 1, 'a lightweight location marker precedes the terrain sample');
  assert.equal(layer.deckTop('__preview__'), null, 'the marker is not a provisional flight contact height');
  pending.shift()(10);
  await first;
  assert.equal(byId(entities, 'vertiport:__preview__:platform').polygon.extrudedHeight, 11);
  const edited = {...layout, gates: [...layout.gates, {id: 'G3', marking: 'G3', center_m: [30, -15], radius_m: 7.2}]};
  const second = layer.preview(edited, '허브');
  const deck = byId(entities, 'vertiport:__preview__:deck');
  assert.ok(deck.polygon.material.image.ctx.ops.some(o => o.op === 'fillText' && o.args[0] === 'G3'), 'the edit is painted before the new sample answers');
  assert.equal(byId(entities, 'vertiport:__preview__:platform').polygon.extrudedHeight, 11, 'at the cached ground');
  pending.shift()(10);
  await second;
  assert.equal(byId(entities, 'vertiport:__preview__:deck'), deck, 'an agreeing sample leaves the entities alone');
  const third = layer.preview({...edited, platform: {...edited.platform, size_m: [90, 60]}}, '허브');
  pending.shift()(25);
  await third;
  assert.equal(byId(entities, 'vertiport:__preview__:platform').polygon.extrudedHeight, 26, 'a differing sample rebuilds at the new ground');
  const elsewhere = layer.preview({...layout, frame: {...layout.frame, latitude: 38}}, '허브');
  assert.equal(byId(entities, 'vertiport:__preview__:platform').polygon.extrudedHeight, 26, 'a new position waits for its own sample');
  pending.shift()(3);
  await elsewhere;
  assert.equal(byId(entities, 'vertiport:__preview__:platform').polygon.extrudedHeight, 4);
});

test('ground that could not be measured is placed on the ellipsoid for now but never remembered', async () => {
  const entities = new Entities();
  let ready = false;
  let asked = 0;
  const layer = new VertiportLayer(C, viewerWith(entities), layerOptions({groundHeights: async p => {asked++; return ready ? p.map(() => 20) : null;}}));
  await layer.show([record]);
  assert.equal(byId(entities, 'vertiport:vp-1:platform').polygon.extrudedHeight, 1, 'no terrain yet: the ellipsoid');
  assert.equal(layer.groundCache.size, 0, 'an unknown ground is not cached');
  ready = true;
  await layer.refresh();
  assert.equal(byId(entities, 'vertiport:vp-1:platform').polygon.extrudedHeight, 21, 'terrain arrived: re-placed on it');
  assert.equal(asked, 2);
  await layer.show([record]);
  assert.equal(asked, 2, 'unchanged saved records preserve the measured ground; refresh explicitly resamples');
});

test('an unchanged list reuses pending terrain work, resolved geometry and deck textures', async () => {
  const entities = new Entities();
  let resolve, calls = 0;
  const layer = new VertiportLayer(C, viewerWith(entities), layerOptions({
    groundHeights: points => {calls++; return new Promise(done => {resolve = () => done(points.map(() => 12));});},
  }));
  const first = layer.show([record]);
  const second = layer.show([JSON.parse(JSON.stringify(record))]);
  assert.equal(calls, 1, 'two list responses share the same terrain request');
  assert.equal(entities.values.length, 1, 'the saved location is immediately visible');
  assert.equal(layer.deckTop(record.id), null);
  resolve();
  await Promise.all([first, second]);
  const deck = byId(entities, 'vertiport:vp-1:deck');
  const paint = deck.polygon.material.image;
  const lamps = layer.lights.byId.get(record.id);
  await layer.show([JSON.parse(JSON.stringify(record))]);
  assert.equal(calls, 1);
  assert.equal(byId(entities, 'vertiport:vp-1:deck'), deck);
  assert.equal(deck.polygon.material.image, paint);
  assert.equal(layer.lights.byId.get(record.id), lamps, 'individual lamp points are not removed and re-added');
  const changed = layer.show([{...record, name: '다른 이름'}]);
  assert.equal(calls, 2, 'a design/name edit invalidates display reuse');
  resolve();
  await changed;
  assert.notEqual(byId(entities, 'vertiport:vp-1:deck'), deck);
  layer.destroy();
});

test('a pending location disappears immediately on deletion and never becomes a deck later', async () => {
  const entities = new Entities();
  let resolve;
  const layer = new VertiportLayer(C, viewerWith(entities), layerOptions({
    groundHeights: points => new Promise(done => {resolve = () => done(points.map(() => 12));}),
  }));
  const waiting = layer.show([record]);
  assert.equal(entities.values.length, 1);
  await layer.show([]);
  resolve(); await waiting;
  assert.equal(entities.values.length, 0);
  assert.equal(layer.deckTop(record.id), null);
  assert.equal(layer.placements.size, 0);
});

test('the cabinet a charging connection names is answered where the cabinet model stands, at its cable track height', async () => {
  const entities = new Entities();
  const layer = new VertiportLayer(C, viewerWith(entities), layerOptions({groundHeights: async points => points.map(() => 40)}));
  await layer.show([record]);
  const contact = layer.deckTop(record.id);
  const cabinet = layer.chargerCabinet({vertiport_id: record.id, charger_id: 'C1'});
  assert.ok(cabinet);
  assert.equal(cabinet.side, 2.376);
  assert.equal(cabinet.height, 2.64);
  assert.equal(cabinet.heading_deg, 0);
  assert.ok(Math.abs(cabinet.altitude - (contact + 0.02 + 1.32)) < 1e-9, 'mid-height of the body, where the track band runs, above the displayed deck');
  const cosLat = Math.cos(37.5 * Math.PI / 180);
  assert.ok(Math.abs(cabinet.longitude - (127 - 10 / (111320 * cosLat))) < 1e-9, 'west of the frame origin by the layout offset');
  assert.ok(Math.abs(cabinet.latitude - (37.5 - 26.38 / 111320)) < 1e-9);
  assert.equal(layer.chargerCabinet({vertiport_id: record.id, charger_id: 'C9'}), null, 'a cabinet the layout does not carry');
  assert.equal(layer.chargerCabinet({vertiport_id: 'vp-9', charger_id: 'C1'}), null, 'a vertiport this layer has not placed');
  assert.equal(layer.chargerCabinet(null), null);
});

test('a building tall enough for a base gets one, and its clad wall starts on the canopy the colonnade carries', async () => {
  const entities = new Entities();
  const viewer = viewerWith(entities);
  const layer = new VertiportLayer(C, viewer, layerOptions({groundHeights: async points => points.map(() => 40)}));
  const tall = {...record, layout: {...layout, platform: {...layout.platform, height_m: 30}}};
  await layer.show([tall]);
  const deck = 70;
  const walls = entities.values.filter(e => typeof e.id === 'string' && e.id.startsWith('vertiport:vp-1:facade:'));
  assert.equal(walls[0].wall.maximumHeights[0], deck, 'the cladding still reaches the deck');
  assert.equal(walls[0].wall.minimumHeights[0], 40 + podiumHeight(30),
    'but starts on the canopy: the windows no longer run down to the pavement');
  assert.equal(cladHeight(30), 21.5);
  const base = viewer.scene.primitives.values.find(item => item.geometryInstances?.[0]?.id === 'vertiport:vp-1:base');
  assert.ok(base, 'the base storey is one primitive of its own');
  assert.equal(base.appearance.translucent, false, 'opaque and closed: the colour program the map already carries');
  assert.equal(base.appearance.closed, true);
  assert.equal(base.asynchronous, false);
  assert.equal(base.allowPicking, true, 'clicking the building selects the vertiport, as clicking its deck does');
  assert.equal(base.modelMatrix.origin.z, 40, 'placed on the ground the building stands on, not under its deck');
  const colours = base.geometryInstances.map(instance => instance.attributes.color.color.css);
  for (const part of ['terrace', 'column', 'glass', 'canopy', 'cove', 'step']) {
    assert.ok(colours.includes(BASE[part]), `the base carries its ${part}`);
  }
  for (const instance of base.geometryInstances) {
    assert.equal(instance.attributes.color.color.alpha, 1);
    assert.deepEqual(Object.keys(instance.attributes), ['show', 'color'],
      'shown or not, and a colour: Cesium cannot evaluate a per-instance distance condition under a model matrix, so how far a base is drawn is the layer’s own business');
    assert.equal(instance.geometry.primitiveType, 'triangles');
    assert.ok(instance.geometry.attributes.normal, 'lit, not flat');
  }
  // It reaches further than the wall it stands under: that is the terrace.
  const terrace = base.geometryInstances.find(instance => instance.attributes.color.color.css === BASE.terrace);
  let far = 0;
  for (let index = 1; index < terrace.geometry.attributes.position.values.length; index += 3) {
    far = Math.max(far, Math.abs(terrace.geometry.attributes.position.values[index]));
  }
  assert.ok(far > 30 + TERRACE_OUT_M - 0.5 && far < 30 + TERRACE_OUT_M + 8, `terrace reach ${far}`);
  // A shorter building keeps the wall it had, and grows no base.
  const short = {...record, id: 'vp-2', layout: {...layout, platform: {...layout.platform, height_m: 6}}};
  await layer.show([tall, short]);
  assert.equal(podiumHeight(6), 0);
  assert.equal(viewer.scene.primitives.values.filter(item => item.geometryInstances?.[0]?.id === 'vertiport:vp-2:base').length, 0);
  const shortWall = entities.values.find(e => e.id === 'vertiport:vp-2:facade:0');
  assert.equal(Math.round((46 - shortWall.wall.minimumHeights[0]) * 10) / 10, facadeWall(6), 'the buried skirt it always had');
  // How far it is drawn: the layer walks the bases on the beat the lamps use.
  viewer.scene.camera = {positionWC: {x: 0, y: 0, z: 0}};
  layer.tickLights(1);
  assert.equal(base.show, false, 'a base the camera is nowhere near is not drawn');
  viewer.scene.camera.positionWC = {x: base.modelMatrix.origin.x, y: base.modelMatrix.origin.y, z: base.modelMatrix.origin.z};
  layer.tickLights(2);
  assert.equal(base.show, true, 'and one it is standing at is');
  // Taken away with the vertiport it belongs to.
  layer.remove('vp-1');
  assert.equal(viewer.scene.primitives.values.filter(item => item.geometryInstances?.[0]?.id === 'vertiport:vp-1:base').length, 0);
});

test('a base is drawn faint with the building it belongs to, and is rebuilt only when something about it changed', async () => {
  const entities = new Entities();
  const viewer = viewerWith(entities);
  const layer = new VertiportLayer(C, viewer, layerOptions({groundHeights: async points => points.map(() => 40)}));
  const tall = {...record, layout: {...layout, platform: {...layout.platform, height_m: 30}}};
  await layer.show([tall]);
  const first = viewer.scene.primitives.values.find(item => item.geometryInstances?.[0]?.id === 'vertiport:vp-1:base');
  layer.setPerformanceOptions({detailDistance: 4000});
  assert.equal(viewer.scene.primitives.values.find(item => item.geometryInstances?.[0]?.id === 'vertiport:vp-1:base'), first,
    'a range change moves nothing on the ground');
  layer.setDimmed(['vp-1']);
  const dimmed = viewer.scene.primitives.values.find(item => item.geometryInstances?.[0]?.id === 'vertiport:vp-1:base');
  assert.notEqual(dimmed, first, 'the faint building has a faint base');
  assert.equal(dimmed.appearance.translucent, true);
  assert.equal(dimmed.geometryInstances[0].attributes.color.color.alpha, 0.3);
  layer.setVisible(false);
  assert.equal(dimmed.show, false);
  layer.setVisible(true);
  assert.equal(dimmed.show, true);
  layer.destroy();
  assert.equal(viewer.scene.primitives.values.length, 0, 'and it goes with the layer');
});

test('vertiport detail ranges change in place while nearby geometry and contact heights stay intact', async () => {
  const entities = new Entities();
  let calls = 0;
  const layer = new VertiportLayer(C, viewerWith(entities), layerOptions({
    groundHeights: async points => {calls++; return points.map(() => 40);},
  }));
  await layer.show([record]);
  const original = [...entities.values];
  const deck = byId(entities, 'vertiport:vp-1:deck');
  const contact = layer.deckTop(record.id);
  const paint = deck.polygon.material.image;
  assert.equal(byId(entities, 'vertiport:vp-1:charger:C1').model.distanceDisplayCondition.far, 3000);
  assert.equal(byId(entities, 'vertiport:vp-1:platform').polygon.distanceDisplayCondition.far, 32000);
  assert.equal(layer.setPerformanceOptions({detailDistance: 4000}), true);
  assert.deepEqual(entities.values, original, 'no entity replacement or texture upload');
  assert.equal(deck.polygon.material.image, paint);
  assert.equal(deck.polygon.distanceDisplayCondition.far, 4000);
  assert.equal(byId(entities, 'vertiport:vp-1:facade:0').wall.distanceDisplayCondition.far, 8000);
  assert.equal(byId(entities, 'vertiport:vp-1:name').label.distanceDisplayCondition.far, 4000);
  assert.equal(byId(entities, 'vertiport:vp-1:marker').point.distanceDisplayCondition.near, 4000);
  assert.equal(layer.deckTop(record.id), contact);
  assert.equal(calls, 1);
  assert.equal(layer.setPerformanceOptions({detailDistance: 4000}), false);
  assert.equal(layer.setPerformanceOptions({detailDistance: NaN}), false);
  layer.setPerformanceOptions({detailDistance: 100});
  assert.equal(deck.polygon.distanceDisplayCondition.far, 1000);
  assert.equal(byId(entities, 'vertiport:vp-1:charger:C1').model.distanceDisplayCondition.far, 1000);
  layer.setPerformanceOptions({detailDistance: 100000});
  assert.equal(deck.polygon.distanceDisplayCondition.far, 8000);
  assert.equal(byId(entities, 'vertiport:vp-1:marker').label.distanceDisplayCondition.near, 8000);
});

test('a deck replacement batches Cesium collection notifications and always resumes them', async () => {
  const entities = new Entities();
  let suspended = 0, notifications = 0, dirty = false;
  const add = entities.add.bind(entities), remove = entities.remove.bind(entities);
  const changed = () => {if (suspended) dirty = true; else notifications++;};
  entities.add = value => {const result = add(value); changed(); return result;};
  entities.remove = value => {const result = remove(value); changed(); return result;};
  entities.suspendEvents = () => {suspended++;};
  entities.resumeEvents = () => {suspended--; if (!suspended && dirty) {notifications++; dirty = false;}};
  const layer = new VertiportLayer(C, viewerWith(entities), layerOptions());
  await layer.show([record]);
  assert.equal(notifications, 3, 'initial marker, batched removal, then complete deck addition');
  const before = notifications;
  layer.setDimmed([record.id]);
  assert.equal(notifications - before, 2, 'remove/add use separate batched notifications so reused IDs are rebound');
  assert.equal(suspended, 0);
  const build = layer.build;
  layer.build = () => {throw new Error('failed geometry');};
  assert.throws(() => layer.rebuild(record.id, record, layer.grounds.get(record.id)), /failed geometry/);
  assert.equal(suspended, 0, 'a failed paint/build cannot leave Cesium notifications suspended');
  layer.build = build;
});

test('replacing a deck rebinds every visualizer when Cesium cancels same-id remove/add within a batch',async()=>{
  // Cesium 1.143 EntityCollection deliberately cancels an ID removed and added
  // in one suspension. A render consumer therefore sees no replacement event.
  class ObservedEntities extends Entities {
    suspended=0;added=new Map();removed=new Map();rendered=new Map();
    flush(){if(this.suspended)return;
      for(const id of this.removed.keys())this.rendered.delete(id);
      for(const [id,entity] of this.added)this.rendered.set(id,entity);
      this.removed.clear();this.added.clear();}
    add(entity){super.add(entity);if(!this.removed.delete(entity.id))this.added.set(entity.id,entity);this.flush();return entity;}
    remove(entity){super.remove(entity);if(!this.added.delete(entity.id))this.removed.set(entity.id,entity);this.flush();}
    suspendEvents(){this.suspended++;}
    resumeEvents(){this.suspended--;this.flush();}
  }
  const entities=new ObservedEntities(),layer=new VertiportLayer(C,viewerWith(entities),layerOptions());
  await layer.show([record]);const first=byId(entities,'vertiport:vp-1:deck');
  layer.setDimmed([record.id]);const changed=byId(entities,first.id);assert.notEqual(changed,first);
  for(const entity of layer.owned.get(record.id))assert.equal(entities.rendered.get(entity.id),entity,
    `${entity.id} visualizer must bind to the replacement object`);
  await layer.refresh();
  for(const entity of layer.owned.get(record.id))assert.equal(entities.rendered.get(entity.id),entity);
  layer.destroy();assert.equal(entities.rendered.size,0);assert.equal(entities.suspended,0);
});

test('toggling terrain re-places every vertiport at the new ground height', async () => {
  const entities = new Entities();
  let height = 10;
  const layer = new VertiportLayer(C, viewerWith(entities), layerOptions({groundHeights: async p => p.map(() => height)}));
  await layer.show([record]);
  height = 0;
  await layer.refresh();
  assert.equal(byId(entities, 'vertiport:vp-1:platform').polygon.extrudedHeight, 1);
});

test('the ground under a following preview is the whole footprint, not just the point under the cursor', () => {
  const pose = {latitude: 37.5, longitude: 127, height: 12};
  const hills = (longitude, latitude) => (latitude > 37.5001 ? 40 : 10);
  const high = followGround(layout, pose, hills);
  assert.equal(high.top, 40, 'highest ground under the platform, so the deck is never buried');
  assert.equal(high.bottom, 10, 'the base still reaches the lowest ground');
  assert.equal(followGround({...layout, ground_reference: 'lowest'}, pose, hills).top, 10);
  assert.equal(followGround({...layout, ground_reference: 'mean'}, pose, hills).reference, 'mean');
  assert.equal(followGround({...layout, ground_reference: 'manual', frame: {...layout.frame, altitude_m: 55}}, pose, hills).top, 55);
  const unloaded = followGround(layout, pose, () => undefined);
  assert.equal(unloaded.top, 12, 'with no terrain loaded the cursor height carries the preview');
  assert.equal(unloaded.bottom, 12);
  // Coarse tiles answer with heights kilometres away from the ground the cursor
  // is on; trusting them drops the preview underground or into the sky.
  const coarse = followGround(layout, pose, (longitude, latitude) => (latitude > 37.5001 ? -18700 : 11));
  assert.equal(coarse.top, 12, 'the implausible sample is ignored; the cursor ground still counts');
  assert.equal(coarse.bottom, 11, 'the plausible sample still lowers the base');
  assert.equal(followGround(layout, pose, () => -18700).top, 12, 'all implausible: the cursor height stands');
  assert.equal(followGround(layout, {latitude: 37.5, longitude: 127}, () => 250).top, 250, 'without a cursor height any sample is taken');
});

test('a following preview is built once and afterwards only its transform changes', () => {
  const entities = new Entities();
  const viewer = viewerWith(entities);
  let sampled = 0;
  const layer = new VertiportLayer(C, viewer, layerOptions({
    groundHeights: async () => {throw new Error('a follow must not wait for terrain requests');},
    heightAt: () => {sampled++; return 30;}}));
  layer.follow(layout, '따라오기', {latitude: 37.5, longitude: 127, height: 12});
  // The lamp collection is added when the layer is made and stays for its
  // life, so a follow adds three primitives on top of it.
  const primitives = viewer.scene.primitives.values.filter(item => item !== layer.lights?.points);
  assert.equal(primitives.length, 3, 'one clad shell, one painted deck and every charging cabinet in one');
  const [slab, deck, boxes] = primitives;
  assert.equal(boxes.geometryInstances.length, 2, 'a box per stand');
  assert.ok(boxes.geometryInstances[0].geometry.box, 'built from box dimensions');
  const at = boxes.geometryInstances[0].modelMatrix.translation;
  assert.deepEqual([at.x, at.y, at.z], [-10, -26.38, 0.03 + 2.64 / 2], 'on the deck beside its stand');
  const positions = slab.geometryInstances.geometry.attributes.position.values;
  assert.ok(positions.length > 0, 'the shell is a mesh built in local metres');
  assert.ok(slab.appearance.material.image.ctx, 'its sides carry the painted facade');
  assert.ok(deck.appearance.material.image.ctx, 'the deck carries the painted canvas');
  const capHeight = deck.geometryInstances.geometry.attributes.position.values[2];
  assert.ok(capHeight > 0 && capHeight < 0.1, 'the deck lies just on top of the shell');
  assert.equal(slab.asynchronous, false, 'nothing waits a frame to appear');
  assert.ok(sampled > 1, 'the footprint is sampled, not one point');
  const before = slab.modelMatrix;
  assert.ok(before, 'placed at once');
  const created = sampled;
  layer.moveFollow({latitude: 37.6, longitude: 127.1, height: 20});
  assert.equal(viewer.scene.primitives.values.filter(item => item !== layer.lights?.points).length, 3,
    'moving creates nothing');
  assert.equal(viewer.scene.primitives.values.filter(item => item !== layer.lights?.points)[0], slab,
    'the same primitive is re-used');
  assert.notEqual(slab.modelMatrix, before, 'only the transform changed');
  assert.ok(sampled > created, 'the new footprint is measured');
  assert.equal(entities.values.filter(e => e.label).length, 2, 'name and far marker stay as labels');
  layer.setVisible(false);
  assert.equal(slab.show, false);
  layer.setVisible(true);
  assert.equal(deck.show, true);
  layer.preview(null);
  assert.equal(viewer.scene.primitives.values.filter(item => item !== layer.lights?.points).length, 0,
    'clearing the preview removes the primitives');
  assert.equal(entities.values.length, 0);
});

test('a follow is replaced by a static placement and never leaks primitives', async () => {
  const entities = new Entities();
  const viewer = viewerWith(entities);
  const layer = new VertiportLayer(C, viewer, layerOptions({groundHeights: async p => p.map(() => 5), heightAt: () => 5}));
  // The lamp collection lives as long as the layer does, so it is counted out
  // of what a follow puts on the scene and back in when the layer goes.
  const following = () => viewer.scene.primitives.values.filter(item => item !== layer.lights?.points).length;
  layer.follow(layout, '따라오기', {latitude: 37.5, longitude: 127, height: 5});
  assert.equal(following(), 3);
  await layer.preview(layout, '고정');
  assert.equal(following(), 0, 'the moving preview is gone');
  assert.ok(byId(entities, 'vertiport:__preview__:deck'), 'the fixed preview is an entity again');
  layer.follow(layout, '다시', {latitude: 37.5, longitude: 127, height: 5});
  assert.equal(following(), 3);
  assert.equal(byId(entities, 'vertiport:__preview__:deck'), undefined, 'the fixed entities are gone while following');
  // A design or heading edit mid-placement follows again at the same pose; the
  // previous shell has to go with it, or it stays on the map as a second deck.
  layer.follow(rotateLayout(layout, 45), '다시', {latitude: 37.5, longitude: 127, height: 5});
  layer.follow(rotateLayout(layout, 90), '다시', {latitude: 37.5, longitude: 127, height: 5});
  assert.equal(following(), 3, 'a follow that replaces a follow leaves nothing behind');
  layer.destroy();
  assert.equal(viewer.scene.primitives.values.length, 0, 'and the lamps go with the layer');
  assert.equal(entities.values.length, 0);
});

test('the thumbnail draws the deck on its own sides, seen from a corner', () => {
  const canvas = createCanvas(300, 186);
  assert.equal(paintThumbnail(layout, '테스트 허브', canvas, {createCanvas}), true);
  const ops = canvas.ctx.ops;
  assert.equal(ops[0].op, 'setTransform', 'the picture starts from a clean transform');
  assert.ok(ops.some(op => op.op === 'clearRect'), 'and a clean canvas');
  const outline = roundedOutline([[-40, -30], [40, -30], [40, 30], [-40, 30]], cornerRadius(80, 60));
  assert.equal(ops.filter(op => op.op === 'fill' && op.fill === FACADE.wall).length, outline.length, 'a side hung from every edge');
  assert.equal(ops.filter(op => op.op === 'fill' && op.fill === FACADE.coping).length, outline.length);
  assert.equal(ops.filter(op => op.op === 'fill' && op.fill === FACADE.plinth).length, outline.length);
  const clipped = ops.findIndex(op => op.op === 'clip');
  const drawn = ops.findIndex(op => op.op === 'drawImage');
  assert.ok(clipped >= 0 && drawn > clipped, 'the deck is laid inside the outline, over the sides');
  assert.ok(ops[drawn].args[0].ctx.ops.some(op => op.op === 'fillText' && op.args[0] === '테스트 허브'), 'and it is the painted deck');
  const placed = ops[drawn - 1];
  assert.equal(placed.op, 'setTransform');
  assert.ok(placed.args.slice(0, 4).some(value => Math.abs(value) > 1e-9), 'mapped onto the tilted plane');
  assert.equal(ops.filter(op => op.op === 'fill' && op.fill === PAINT.chargerPanel).length, layout.chargers.length,
    'a charging cabinet stands on the deck for every stand');
  assert.ok(ops.findIndex(op => op.op === 'fill' && op.fill === PAINT.chargerPanel) > drawn, 'on the deck, not under it');
  const storeyed = createCanvas(300, 186);
  paintThumbnail({...layout, platform: {...layout.platform, height_m: 12}}, '허브', storeyed, {createCanvas});
  assert.ok(storeyed.ctx.ops.some(op => op.op === 'fill' && op.fill === FACADE.glass), 'a tall deck shows its storeys');
  assert.equal(paintThumbnail(layout, 'x', {width: 10, height: 10}, {createCanvas}), false, 'a canvas that cannot be drawn on draws nothing');
  assert.equal(paintThumbnail(null, 'x', createCanvas(10, 10), {createCanvas}), false);
  assert.equal(paintThumbnail({...layout, platform: null}, 'x', createCanvas(10, 10), {createCanvas}), false);
});

// ---------------------------------------------------------------- globe: picking a ground position

function globeHarness() {
  const globe = Object.create(LiveGlobe.prototype);
  const selections = [];
  Object.assign(globe, {
    C: {Cartographic: {fromCartesian: p => ({latitude: p.y / 1000, longitude: p.x / 1000, height: p.z})}, Math: {toDegrees: r => r * 180 / Math.PI}},
    viewer: {canvas: {style: {cursor: ''}, clientWidth: 100, clientHeight: 100},
      camera: {getPickRay: () => 'ray'}, scene: {pick:()=>undefined,globe: {pick: (_ray, _scene, r) => Object.assign(r, {x: 2000, y: 1000, z: 0})}, requestRender() {}}},
    scratch: {}, center: {}, items: new Map(), selected: null, groundPick: null, hoverPointer: null, pickMoveDirty: false,
    select: id => selections.push(id), pickEntity: () => 'a',
  });
  return {globe, selections};
}

test('while a pick is armed the ground under the cursor is reported whenever it changes, with its height', () => {
  const {globe} = globeHarness();
  const moves = [];
  void globe.pickGroundOnce({onMove: position => moves.push(position)});
  globe.hoverPointer = {x: 5, y: 5};
  globe.trackGroundPick();
  assert.equal(moves.length, 1);
  assert.ok(Math.abs(moves[0].longitude - 2 * 180 / Math.PI) < 1e-9);
  assert.equal(moves[0].height, 0);
  globe.trackGroundPick();
  assert.equal(moves.length, 1, 'the same ground is not reported twice');
  // Terrain tiles arrive under a still cursor: the height changes, so it is reported.
  globe.viewer.scene.globe.pick = (_ray, _scene, r) => Object.assign(r, {x: 2000, y: 1000, z: 50});
  globe.trackGroundPick();
  assert.equal(moves.length, 2);
  assert.equal(moves[1].height, 50);
  globe.cancelGroundPick();
  globe.viewer.scene.globe.pick = (_ray, _scene, r) => Object.assign(r, {x: 1, y: 1, z: 1});
  globe.trackGroundPick();
  assert.equal(moves.length, 2, 'nothing after cancel');
});

test('while a ground pick is armed, the next click yields a position instead of selecting', async () => {
  const {globe, selections} = globeHarness();
  const picked = globe.pickGroundOnce();
  assert.equal(globe.viewer.canvas.style.cursor, 'crosshair');
  globe.handleClick({x: 10, y: 10});
  const position = await picked;
  assert.ok(Math.abs(position.longitude - 2 * 180 / Math.PI) < 1e-9 && Math.abs(position.latitude - 1 * 180 / Math.PI) < 1e-9);
  assert.equal(position.height, 0, 'the click also carries the ground height');
  assert.deepEqual(selections, [], 'the click did not select the entity under it');
  assert.equal(globe.viewer.canvas.style.cursor, '', 'the cursor is restored');
  globe.handleClick({x: 10, y: 10});
  assert.deepEqual(selections, ['a'], 'the pick was one-shot');
});

test('a ground pick can be cancelled and a second arm replaces the first', async () => {
  const {globe} = globeHarness();
  const first = globe.pickGroundOnce();
  const second = globe.pickGroundOnce();
  assert.equal(await first, null, 'superseded');
  globe.cancelGroundPick();
  assert.equal(await second, null);
  assert.equal(globe.viewer.canvas.style.cursor, '');
  globe.cancelGroundPick();
});

test('a right click while a placement is armed holds the preview and offers the tools there', async () => {
  const {globe} = globeHarness();
  const moves = [], tools = [], released = [];
  const picked = globe.pickGroundOnce({onMove: pose => moves.push(pose), onTools: (pose, screen) => tools.push({pose, screen}),
    onRelease: () => released.push(true)});
  globe.hoverPointer = {x: 5, y: 5};
  globe.trackGroundPick();
  assert.equal(moves.length, 1);
  globe.handleRightClick({x: 40, y: 60});
  assert.equal(tools.length, 1, 'the tools are offered at the ground under the right click');
  assert.deepEqual(tools[0].screen, {x: 40, y: 60});
  assert.equal(tools[0].pose.height, 0);
  globe.viewer.scene.globe.pick = (_ray, _scene, r) => Object.assign(r, {x: 3000, y: 1000, z: 7});
  globe.trackGroundPick();
  assert.equal(moves.length, 1, 'a held preview stays where it was parked');
  globe.handleClick({x: 5, y: 5});
  assert.equal(released.length, 1, 'a click on the map releases the hold instead of placing');
  globe.trackGroundPick();
  assert.equal(moves.length, 2, 'and the preview follows the cursor again');
  globe.commitGroundPick({latitude: 1, longitude: 2, height: 3});
  assert.deepEqual(await picked, {latitude: 1, longitude: 2, height: 3}, 'the tools can finish the placement themselves');
  assert.equal(globe.viewer.canvas.style.cursor, '', 'the cursor is restored');
  globe.commitGroundPick({latitude: 9, longitude: 9});
});

test('without the tools a right click changes nothing about an armed placement', () => {
  const {globe, selections} = globeHarness();
  void globe.pickGroundOnce();
  globe.handleRightClick({x: 10, y: 10});
  assert.equal(globe.groundPick.held, false);
  assert.deepEqual(selections, []);
});

// ---------------------------------------------------------------- panel: form, list, picking, categories

class FakeElement {
  constructor(tag) {this.tagName = tag.toUpperCase(); this.attributes = {}; this.children = []; this.dataset = {}; this.style = {}; this._text = ''; this.value = ''; this.hidden = false; this.disabled = false; this.parent = null;}
  get textContent() {return this.children.length ? this.children.map(c => c.textContent).join('') + this._text : this._text;}
  set textContent(v) {this.children = []; this._text = String(v);}
  get className() {return this.attributes.class ?? '';}
  set className(v) {this.attributes.class = v;}
  setAttribute(k, v) {this.attributes[k] = String(v); if (k === 'value') this.value = String(v); if (k === 'hidden') this.hidden = true; if (k === 'disabled') this.disabled = true;}
  getAttribute(k) {return this.attributes[k] ?? null;}
  removeAttribute(k) {delete this.attributes[k]; if (k === 'disabled') this.disabled = false;}
  append(...nodes) {for (const n of nodes) {if (typeof n === 'string') {this._text += n; continue;} n.parent = this; this.children.push(n);}}
  replaceChildren(...nodes) {this.children = []; this._text = ''; this.append(...nodes);}
  remove() {if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this);}
  *walk() {for (const c of this.children) {yield c; yield* c.walk();}}
  matches(selector) {
    const [tag, rest] = selector.match(/^([a-z]*)(.*)$/).slice(1);
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    if (!rest) return true;
    if (rest.startsWith('#')) return this.attributes.id === rest.slice(1);
    if (rest.startsWith('.')) return (this.attributes.class ?? '').split(/\s+/).includes(rest.slice(1));
    const attribute = rest.match(/^\[([a-z_-]+)=(.+)\]$/);
    return attribute ? this.attributes[attribute[1]] === attribute[2] : false;
  }
  querySelector(selector) {for (const n of this.walk()) if (n.matches(selector)) return n; return null;}
  querySelectorAll(selector) {return [...this.walk()].filter(n => n.matches(selector));}
  reset() {for (const n of this.walk()) if (n.tagName === 'INPUT') n.value = n.attributes.value ?? ''; else if (n.tagName === 'SELECT') n.value = (n.children.find(o => 'selected' in o.attributes) ?? n.children[0])?.attributes.value ?? '';}
  click() {this.onclick?.({preventDefault() {}});}
}
const fakeDocument = {createElement: tag => new FakeElement(tag)};
const options = {
  patterns: [{id: 'row', label: '가로 일렬', description: '', fato_sides: true}, {id: 'column', label: '세로 일렬', description: '', fato_sides: true},
    {id: 'double', label: '양옆 이중', description: '', fato_sides: true}, {id: 'flank', label: 'FATO 중앙', description: '', fato_sides: false},
    {id: 'radial', label: '원형 배치', description: '', fato_sides: false}, {id: 'court', label: '중정 사각', description: '', fato_sides: false}],
  fato_sides: [{id: 'front', label: '앞'}, {id: 'back', label: '뒤'}, {id: 'left', label: '왼쪽'}, {id: 'right', label: '오른쪽'}],
  vehicle_classes: [{id: 'small', label: '소형', d_m: 8}, {id: 'medium', label: '중형', d_m: 12}, {id: 'large', label: '대형', d_m: 16}, {id: 'custom', label: '직접 입력', d_m: null}],
  ground_references: [{id: 'highest', label: '최고 지면 (기본)'}, {id: 'mean', label: '평균 지면'}, {id: 'lowest', label: '최저 지면'}, {id: 'manual', label: '직접 입력'}],
  defaults: {pattern: 'row', vehicle_class: 'medium', vehicle_d_m: 12, platform_height_m: 1, ground_reference: 'highest', gates: 4, fatos: 1},
  limits: {gates: [1, 20], fatos: [1, 8], vehicle_d_m: [4, 30], platform_height_m: [0, 60]},
};
function panelHarness({records = [], pickLocation = async () => null, previewLayout = layout, previewDelay = null, placeMenu = null,
  drawThumbnail = () => true} = {}) {
  const shown = [], previews = [], focused = [], notices = [], saved = [], follows = [], moves = [], commits = [], resumes = [], editing = [];
  const timers = new Map();
  let timerId = 0;
  const api = {
    list: async () => ({vertiports: records}),
    options: async () => options,
    preview: async definition => {previews.push(definition); if (previewDelay) await previewDelay(definition); return {layout: {...previewLayout, frame: {...previewLayout.frame, latitude: definition.latitude, longitude: definition.longitude, heading_deg: definition.heading_deg}}};},
    create: async definition => {saved.push(definition); return {vertiport: {...definition, id: 'vp-new', layout: previewLayout}};},
    update: async (id, definition) => ({vertiport: {...definition, id, layout: previewLayout}}),
    remove: async () => {},
  };
  const panel = new SimulationPanel({api, document: fakeDocument, notify: (s, m) => notices.push([s, m]),
    onShow: r => shown.push(r), onPreview: (l, n) => previews.push({layout: l, name: n}), onFocus: r => focused.push(r),
    onFollow: (l, n, pose) => follows.push({layout: l, name: n, pose}), onFollowMove: pose => moves.push(pose),
    onEditing: id => editing.push(id), rotateLayout,
    pickLocation, drawThumbnail,
    placeMenu, commitPick: pose => commits.push(pose), resumePick: () => resumes.push(true),
    setTimer: fn => {timers.set(++timerId, fn); return timerId;}, clearTimer: id => {timers.delete(id);}});
  // The page wires the menu to the panel the same way; a test that opens the
  // tools has to do it too or the controls report to nobody.
  if (placeMenu) Object.assign(placeMenu, {onChange: (name, value) => panel.toolChanged(name, value),
    onPlace: () => panel.placeWithTools(), onResume: () => panel.resumeTools()});
  const body = new FakeElement('div');
  const flush = () => {const pending = [...timers.values()]; timers.clear(); for (const fn of pending) fn();};
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return {panel, body, api, shown, previews, focused, notices, saved, follows, moves, commits, resumes, editing, flush, settle};
}

test('form values become a definition with vehicle size, pattern and platform, or name every problem', () => {
  const ok = definitionFromForm({name: ' 김포 ', latitude: '37.558', longitude: '126.79', heading_deg: '-90', gates: '6',
    pattern: 'double', vehicle_class: 'custom', vehicle_d_m: '9.5', platform_height_m: '2', fatos: ['takeoff', 'landing', 'nonsense']});
  // A form that says nothing about the network the deck belongs to still makes
  // a definition; it is filed as unsorted rather than refused.
  assert.deepEqual(ok.definition, {name: '김포', group: '미분류', latitude: 37.558, longitude: 126.79, heading_deg: 270, gates: 6, pattern: 'double',
    vehicle_class: 'custom', vehicle_d_m: 9.5, platform_height_m: 2, takeoff_height_m:30, landing_height_m:30, ground_reference: 'highest', fatos: [{role: 'takeoff', side: 'front'}, {role: 'landing', side: 'front'}, {role: 'both', side: 'front'}]});
  assert.equal(definitionFromForm({...ok.definition, group: ' 수도권 '}).definition.group, '수도권');
  assert.ok(definitionFromForm({...ok.definition, group: '가'.repeat(41)}).errors.some(m => m.includes('분류')));
  const classed = definitionFromForm({name: 'a', latitude: '1', longitude: '1', gates: '1', vehicle_class: 'large', fatos: ['both']});
  assert.equal(classed.definition.vehicle_class, 'large');
  assert.equal(classed.definition.vehicle_d_m, undefined, 'a class carries its own size');
  assert.equal(classed.definition.pattern, 'row');
  assert.equal(classed.definition.platform_height_m, 1);
  const bad = definitionFromForm({name: '', latitude: '95', longitude: '', gates: '0', vehicle_class: 'custom', vehicle_d_m: '2', platform_height_m: '-3', fatos: []});
  assert.ok(bad.errors.length >= 6);
  for (const word of ['이름', '위도', '경도', '게이트', 'FATO', 'D값', '높이']) assert.ok(bad.errors.some(m => m.includes(word)), word);
});

test('a list row summarises pattern, design size, capacity, roles, network and position', () => {
  const text = describeVertiport(record);
  assert.match(text, /가로 일렬/);
  assert.match(text, /D 12 m/);
  assert.match(text, /게이트 2/);
  assert.match(text, /FATO 2 \(이륙 1 · 착륙 1\)/);
  assert.match(text, /지상 경로 1/);
  assert.match(text, /37\.5000, 127\.0000/);
  assert.equal(roleLabel('both'), '이착륙');
});

test('the panel loads the list, hands it to the map and reports failures without throwing', async () => {
  const shown = [], notices = [];
  const panel = new SimulationPanel({api: {list: async () => ({vertiports: [record]})}, onShow: r => shown.push(r), notify: (s, m) => notices.push([s, m])});
  await panel.refresh();
  assert.equal(shown[0][0].id, 'vp-1');
  const failing = new SimulationPanel({api: {list: async () => {throw new Error('offline');}}, notify: (s, m) => notices.push([s, m])});
  await failing.refresh();
  assert.ok(notices.some(([status]) => status === 'error'));
});

test('the section is classified: the vertiport tools live under UAM and the other classes say so', async () => {
  const {panel, body} = panelHarness();
  panel.render(body);
  await panel.ready;
  const categories = body.querySelectorAll('.sim-category');
  assert.deepEqual(categories.map(b => b.textContent), ['항공기', '위성', 'UAM']);
  assert.equal(body.querySelector('#sim-category-uam').getAttribute('aria-pressed'), 'true', 'UAM is the default class');
  assert.ok(body.querySelector('#vertiport-form'), 'the vertiport form is offered under UAM');
  body.querySelector('#sim-category-aircraft').click();
  assert.equal(body.querySelector('#vertiport-form'), null);
  assert.match(body.textContent, /준비 중/);
  body.querySelector('#sim-category-uam').click();
  assert.ok(body.querySelector('#vertiport-form'));
});

test('the form offers patterns and vehicle classes from the server and derives the size from the class', async () => {
  const {panel, body, previews, flush} = panelHarness();
  panel.render(body);
  await panel.ready;
  const pattern = body.querySelector('[name=pattern]');
  assert.deepEqual(pattern.children.map(o => o.attributes.value), ['row', 'column', 'double', 'flank', 'radial', 'court']);
  const klass = body.querySelector('[name=vehicle_class]');
  const size = body.querySelector('[name=vehicle_d_m]');
  assert.equal(klass.value, 'medium');
  assert.equal(size.value, '12');
  assert.equal(size.disabled, true, 'a class fixes the size');
  klass.value = 'large'; klass.onchange();
  assert.equal(size.value, '16');
  klass.value = 'custom'; klass.onchange();
  assert.equal(size.disabled, false, 'custom lets the operator type the D-value');
  assert.equal(body.querySelector('[name=platform_height_m]').value, '1');
  body.querySelector('[name=name]').value = '허브'; body.querySelector('[name=latitude]').value = '37.5'; body.querySelector('[name=longitude]').value = '127';
  size.value = '10'; pattern.value = 'double'; pattern.onchange();
  flush();
  await new Promise(resolve => setImmediate(resolve));
  const sent = previews.find(p => p.pattern);
  assert.equal(sent.pattern, 'double');
  assert.equal(sent.vehicle_d_m, 10);
  assert.match(body.querySelector('#vertiport-dimensions').textContent, /FATO Ø18 m/, 'the derived dimensions are shown');
  assert.match(body.querySelector('#vertiport-dimensions').textContent, /80 × 60 m/);
});

test('picking on the map fills the position, previews, and can be cancelled', async () => {
  let resolvePick;
  const {panel, body, previews, flush} = panelHarness({pickLocation: () => new Promise(resolve => {resolvePick = resolve;})});
  panel.render(body);
  await panel.ready;
  const button = body.querySelector('#vertiport-pick');
  button.click();
  assert.equal(panel.picking, true);
  assert.match(button.textContent, /클릭/);
  resolvePick({latitude: 37.123456789, longitude: 126.98765432});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(panel.picking, false);
  assert.equal(body.querySelector('[name=latitude]').value, '37.123457');
  assert.equal(body.querySelector('[name=longitude]').value, '126.987654');
  body.querySelector('[name=name]').value = '허브';
  flush();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(previews.some(p => p.latitude === 37.123457), 'the picked position is previewed');
  button.click();
  resolvePick(null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(panel.picking, false);
  assert.match(body.querySelector('#vertiport-error').textContent, /취소/);
});

test('saving resets the form to the server defaults, not to the first option', async () => {
  const {panel, body, saved} = panelHarness();
  panel.render(body);
  await panel.ready;
  const set = (name, value) => {body.querySelector(`[name=${name}]`).value = value;};
  set('name', '허브'); set('latitude', '37.5'); set('longitude', '127'); set('pattern', 'flank'); set('vehicle_class', 'small'); set('gates', '2');
  await panel.save();
  assert.equal(saved.length, 1);
  assert.equal(body.querySelector('[name=pattern]').value, 'row');
  assert.equal(body.querySelector('[name=vehicle_class]').value, 'medium');
  assert.equal(body.querySelector('[name=vehicle_d_m]').value, '12');
  assert.match(body.querySelector('#vertiport-dimensions').textContent, /자동 산출/);
});

test('while picking, the preview follows the cursor and the click fixes it as a static preview', async () => {
  let resolvePick, onMove;
  const {panel, body, previews, follows, moves, flush, settle} = panelHarness({pickLocation: options => {onMove = options.onMove; return new Promise(resolve => {resolvePick = resolve;});}});
  panel.render(body);
  await panel.ready;
  body.querySelector('[name=gates]').value = '3';
  body.querySelector('#vertiport-pick').click();
  assert.equal(typeof onMove, 'function', 'the pick hands the panel a move hook');
  onMove({latitude: 37.2, longitude: 127.2, height: 12});
  await settle();
  assert.equal(follows.length, 1, 'the first move fetches a layout at the cursor and starts following');
  assert.equal(follows[0].layout.frame.latitude, 37.2);
  assert.equal(follows[0].pose.height, 12);
  assert.ok(previews.some(p => p.gates === 3 && p.name), 'a name is substituted so the layout can be generated before one is typed');
  onMove({latitude: 37.3, longitude: 127.3, height: 13});
  onMove({latitude: 37.4, longitude: 127.4, height: 14});
  await settle();
  assert.deepEqual(moves.map(m => m.latitude), [37.3, 37.4], 'later moves only move the pose');
  assert.equal(follows.length, 1, 'no second layout fetch while the design is unchanged');
  body.querySelector('[name=heading_deg]').value = '45'; body.querySelector('[name=heading_deg]').oninput();
  flush();
  await settle();
  assert.equal(follows.length, 2, 'a design change while picking re-fetches and keeps following');
  assert.equal(follows[1].layout.frame.heading_deg, 45);
  assert.equal(follows[1].pose.latitude, 37.4, 'at the last cursor pose');
  resolvePick({latitude: 37.4, longitude: 127.4, height: 14});
  await settle();
  flush();
  await settle();
  assert.equal(body.querySelector('[name=latitude]').value, '37.400000');
  const fixed = previews.filter(p => p.layout !== undefined).at(-1);
  assert.ok(fixed && fixed.layout, 'the click fixes a static preview');
  assert.equal(fixed.layout.frame.latitude, 37.4);
});

test('an unchanged design starts following on the first cursor report, before the server answers', async () => {
  const gates = [];
  let onMove;
  const {panel, body, follows, flush, settle} = panelHarness({
    previewDelay: definition => new Promise(resolve => gates.push([definition, resolve])),
    pickLocation: options => {onMove = options.onMove; return new Promise(() => {});}});
  panel.render(body);
  await panel.ready;
  const set = (name, value) => {const el = body.querySelector(`[name=${name}]`); el.value = value; el.oninput?.(); el.onchange?.();};
  set('name', '허브'); set('latitude', '37.5'); set('longitude', '127');
  flush(); await settle();
  gates.shift()[1](); await settle();          // one layout is now known
  body.querySelector('#vertiport-pick').click();
  onMove({latitude: 37.2, longitude: 127.2, height: 12});
  assert.equal(follows.length, 1, 'the known layout is placed at the cursor at once');
  assert.equal(follows[0].pose.latitude, 37.2);
  assert.equal(gates.length, 1, 'the server is asked in parallel, not waited for');
  await settle();
  gates.shift()[1](); await settle();
  assert.equal(follows.length, 2);
  // A design change means the known layout no longer describes the form.
  set('gates', '7');
  flush(); await settle();
  const before = follows.length;
  onMove({latitude: 37.25, longitude: 127.25, height: 12});
  assert.equal(follows.length, before, 'a stale design is not shown at the new pose');
});

test('cancelling a pick drops the following preview and restores what the form describes', async () => {
  let resolvePick, onMove;
  const {panel, body, previews, follows, flush, settle} = panelHarness({pickLocation: options => {onMove = options.onMove; return new Promise(resolve => {resolvePick = resolve;});}});
  panel.render(body);
  await panel.ready;
  body.querySelector('#vertiport-pick').click();
  onMove({latitude: 37.2, longitude: 127.2, height: 12});
  await settle();
  assert.equal(follows.length, 1);
  resolvePick(null);
  await settle();
  flush();
  await settle();
  assert.deepEqual(previews.at(-1), {layout: null, name: undefined}, 'nothing valid to show: the preview is cleared');
});

test('design changes preview quickly and a stale answer never overwrites a newer one', async () => {
  const gates = [];
  const {panel, body, previews, flush, settle} = panelHarness({previewDelay: definition => new Promise(resolve => gates.push([definition, resolve]))});
  panel.render(body);
  await panel.ready;
  const set = (name, value) => {const el = body.querySelector(`[name=${name}]`); el.value = value; el.oninput?.(); el.onchange?.();};
  set('name', '허브'); set('latitude', '37.5'); set('longitude', '127');
  set('heading_deg', '10');
  flush();
  await settle();
  set('heading_deg', '20');
  flush();
  await settle();
  assert.equal(gates.length, 2, 'both requests were sent');
  gates[1][1](); await settle();
  gates[0][1](); await settle();
  const shown = previews.filter(p => p.layout);
  assert.equal(shown.at(-1).layout.frame.heading_deg, 20, 'the newer heading stays even though the older answer arrived last');
  assert.ok(panel.previewDelayMs <= 100, 'the debounce is short enough to feel live');
});

test('a heading edit turns the shown layout immediately and needs no server answer', async () => {
  const gates = [];
  const {panel, body, previews, follows, flush, settle} = panelHarness({previewDelay: definition => new Promise(resolve => gates.push([definition, resolve]))});
  panel.render(body);
  await panel.ready;
  const set = (name, value) => {const el = body.querySelector(`[name=${name}]`); el.value = value; el.oninput?.(); el.onchange?.();};
  set('name', '허브'); set('latitude', '37.5'); set('longitude', '127');
  flush(); await settle();
  gates.shift()[1](); await settle();
  const shownBefore = previews.filter(p => p.layout).length;
  set('heading_deg', '90');
  const immediate = previews.filter(p => p.layout);
  assert.equal(immediate.length, shownBefore + 1, 'the turn shows before any timer or request');
  assert.equal(immediate.at(-1).layout.frame.heading_deg, 90);
  assert.deepEqual(immediate.at(-1).layout.gates[0].center_m, [-15, 10]);
  assert.equal(gates.length, 0, 'no request yet');
  flush(); await settle();
  // The server would only answer with the same shape turned the same way,
  // and the map would then rebuild the same deck a second time (measured:
  // 50-75 ms of painting and shell building per answer). A turn is final.
  assert.equal(gates.length, 0, 'a turn is a rigid transform of the last answer: the server is not asked');
  assert.equal(previews.filter(p => p.layout).at(-1).layout.frame.heading_deg, 90, 'the shown layout keeps the turned heading');
  set('gates', '3');
  assert.equal(previews.filter(p => p.layout).length, shownBefore + 1, 'a gate edit is not turned locally: it needs the server');
  flush(); await settle();
  gates.shift()[1](); await settle();
  set('heading_deg', '45');
  assert.equal(previews.filter(p => p.layout).at(-1).layout.frame.heading_deg, 45, 'once confirmed, the next heading edit turns the new layout at once');
  assert.equal(follows.length, 0);
});

test('the deck height can be tuned: a ground reference, a manual altitude, and the measured ground shown after placement', async () => {
  const {panel, body, previews, flush, settle} = panelHarness();
  panel.render(body);
  await panel.ready;
  const reference = body.querySelector('[name=ground_reference]');
  const altitude = body.querySelector('[name=altitude_m]');
  assert.deepEqual(reference.children.map(o => o.attributes.value), ['highest', 'mean', 'lowest', 'manual']);
  assert.equal(reference.value, 'highest');
  assert.equal(altitude.disabled, true, 'automatic references need no altitude');
  const set = (name, value) => {const el = body.querySelector(`[name=${name}]`); el.value = value; el.oninput?.(); el.onchange?.();};
  set('name', '허브'); set('latitude', '37.5'); set('longitude', '127');
  flush(); await settle();
  panel.groundPlaced('__preview__', {reference: 'highest', top: 75.8, min: 41.2, max: 74.8, mean: 55.1});
  assert.match(body.querySelector('#vertiport-dimensions').textContent, /지면 41\.2~74\.8 m/);
  assert.match(body.querySelector('#vertiport-dimensions').textContent, /상면 75\.8 m/);
  panel.groundPlaced('vp-other', {reference: 'highest', top: 1, min: 0, max: 0, mean: 0});
  assert.match(body.querySelector('#vertiport-dimensions').textContent, /상면 75\.8 m/, 'other vertiports do not overwrite the preview readout');
  set('ground_reference', 'mean');
  flush(); await settle();
  assert.equal(previews.filter(p => p.pattern).at(-1).ground_reference, 'mean');
  set('ground_reference', 'manual');
  assert.equal(altitude.disabled, false);
  assert.equal(altitude.value, '74.8', 'manual starts from the last measured reference');
  set('altitude_m', '60');
  flush(); await settle();
  const sent = previews.filter(p => p.pattern).at(-1);
  assert.equal(sent.ground_reference, 'manual'); assert.equal(sent.altitude_m, 60);
  set('altitude_m', '');
  flush(); await settle();
  assert.equal(previews.at(-1).layout, null, 'manual without an altitude is not previewed');
  const parsed = definitionFromForm({name: 'a', latitude: '1', longitude: '1', gates: '1', fatos: ['both'], ground_reference: 'manual', altitude_m: ''});
  assert.ok(parsed.errors.some(m => m.includes('기준 고도')));
});

test('one FATO is always take-off and landing; two or more can be chosen', async () => {
  const {panel, body} = panelHarness();
  panel.render(body);
  await panel.ready;
  const single = body.querySelector('[name=fato_role_0]');
  assert.equal(single.value, 'both');
  assert.equal(single.disabled, true, 'a single FATO cannot be limited to one role');
  body.querySelector('[name=fato_count]').value = '2'; body.querySelector('[name=fato_count]').oninput();
  const roles = [...body.querySelectorAll('select[name=fato_role_0]'), ...body.querySelectorAll('select[name=fato_role_1]')];
  assert.equal(roles.length, 2);
  assert.ok(roles.every(select => select.disabled === false));
  roles[0].value = 'takeoff';
  body.querySelector('[name=fato_count]').value = '1'; body.querySelector('[name=fato_count]').oninput();
  assert.equal(body.querySelector('[name=fato_role_0]').value, 'both', 'back to one FATO means both again');
  assert.deepEqual(definitionFromForm({name: 'a', latitude: '1', longitude: '1', gates: '1', fatos: ['takeoff']}).definition.fatos, [{role: 'both', side: 'front'}]);
});

test('a FATO can stand off any edge of a lined-up deck; one choice places them all; a deck with FATOs in the middle offers no side', async () => {
  const {panel, body} = panelHarness();
  panel.render(body);
  await panel.ready;
  const count = body.querySelector('[name=fato_count]');
  count.value = '4'; count.oninput();
  const sideOf = index => body.querySelector(`[name=fato_side_${index}]`);
  const sides = () => [0, 1, 2, 3].map(index => sideOf(index).value);
  assert.deepEqual(sides(), ['front', 'front', 'front', 'front'], 'the approach edge until asked otherwise');
  assert.equal(sideOf(0).disabled, false, 'a row of stands can have its FATOs anywhere');
  const preset = body.querySelector('#fato-preset');
  assert.equal(preset.value, 'front');
  // Two at one end, two at the other: departures leave one way, arrivals meet the other.
  preset.value = 'ends'; preset.onchange();
  assert.deepEqual(sides(), ['front', 'front', 'back', 'back']);
  assert.deepEqual(definitionFromForm(panel.previewValues(), options).definition.fatos.map(f => f.side), ['front', 'front', 'back', 'back'], 'and that is what the server is asked for');
  preset.value = 'around'; preset.onchange();
  assert.deepEqual(sides(), ['front', 'back', 'left', 'right']);
  // One moved by hand: the preset no longer claims to describe them.
  sideOf(3).value = 'left'; sideOf(3).onchange();
  assert.equal(preset.value, 'custom');
  assert.deepEqual(panel.fatoRoles().map(f => f.side), ['front', 'back', 'left', 'left']);
  // The count changing keeps the sides that still exist.
  count.value = '2'; count.oninput();
  assert.deepEqual([0, 1].map(index => sideOf(index).value), ['front', 'back']);
  // The ring keeps its FATOs in the middle: the sides are offered no more, and none is sent.
  const pattern = body.querySelector('[name=pattern]');
  pattern.value = 'radial'; pattern.onchange();
  assert.equal(sideOf(0).disabled, true);
  assert.equal(preset.disabled, true);
  assert.deepEqual(definitionFromForm(panel.previewValues(), options).definition.fatos.map(f => f.side), ['front', 'front']);
  pattern.value = 'double'; pattern.onchange();
  assert.equal(sideOf(0).disabled, false, 'and back on a lined-up deck they are offered again');
  assert.deepEqual(presetSides('sides', 3), ['left', 'left', 'right']);
  assert.deepEqual(presetSides('around', 6), ['front', 'back', 'left', 'right', 'front', 'back']);
  assert.equal(presetFor(['front', 'front', 'back']), 'ends');
  assert.equal(presetFor(['back', 'front']), 'custom');
  // A record with sides fills the rows with them; one without is at the front.
  panel.fill({...record, pattern: 'double', fatos: [{role: 'takeoff', side: 'front'}, {role: 'landing', side: 'back'}, {role: 'both', side: 'right'}]});
  assert.deepEqual([0, 1, 2].map(index => sideOf(index).value), ['front', 'back', 'right']);
  assert.equal(preset.value, 'custom');
  panel.fill({...record, pattern: 'row', fatos: [{role: 'takeoff'}, {role: 'landing'}]});
  assert.deepEqual([0, 1].map(index => sideOf(index).value), ['front', 'front']);
});

test('editing a saved vertiport fills every field including the new ones', async () => {
  const {panel, body} = panelHarness({records: [record]});
  panel.render(body);
  await panel.ready;
  body.querySelector('#vertiport-list-toggle').click();
  body.querySelector('[data-id=vp-1]').querySelectorAll('button')[1].click();
  assert.equal(body.querySelector('[name=pattern]').value, 'row');
  assert.equal(body.querySelector('[name=vehicle_class]').value, 'medium');
  assert.equal(body.querySelector('[name=vehicle_d_m]').value, '12');
  assert.equal(body.querySelector('[name=platform_height_m]').value, '1');
  assert.equal(body.querySelector('[name=gates]').value, '2');
  assert.deepEqual(body.querySelectorAll('select[name=fato_role_0]').map(s => s.value), ['takeoff']);
});

test('editing tells the map which vertiport is now the old shape, and stops when the edit does', async () => {
  const {panel, body, editing} = panelHarness({records: [record]});
  panel.render(body);
  await panel.ready;
  assert.deepEqual(editing, [], 'nothing is old until an edit starts');
  body.querySelector('#vertiport-list-toggle').click();
  body.querySelector('[data-id=vp-1]').querySelectorAll('button')[1].click();
  assert.deepEqual(editing, ['vp-1']);
  body.querySelector('#vertiport-cancel').click();
  assert.deepEqual(editing, ['vp-1', null], 'cancelling gives the map its solid shape back');
  body.querySelector('[data-id=vp-1]').querySelectorAll('button')[1].click();
  const set = (name, value) => {body.querySelector(`[name=${name}]`).value = value;};
  set('name', '허브'); set('latitude', '37.5'); set('longitude', '127'); set('gates', '2');
  await panel.save();
  assert.equal(editing.at(-1), null, 'saving ends the edit too');
});

test('the form shows the shape it is designing before a position is chosen', async () => {
  const drawn = [];
  const {panel, body, previews, flush, settle} = panelHarness({
    drawThumbnail: (shape, name, canvas) => {drawn.push({shape, name, canvas}); return Boolean(shape);}});
  panel.render(body);
  await panel.ready;
  assert.ok(body.querySelector('#vertiport-thumb'), 'the form carries a picture of the design');
  assert.equal(body.querySelector('#vertiport-here'), null, 'the map-centre button is gone');
  flush();
  await settle();
  assert.equal(previews.filter(item => item.pattern).length, 1, 'the default design is asked for as soon as the form opens');
  assert.ok(drawn.at(-1).shape, 'and drawn');
  assert.match(drawn.at(-1).name, /새 버티포트/, 'under a stand-in name until one is typed');
  assert.equal(drawn.at(-1).canvas, body.querySelector('#vertiport-thumb'));
  assert.deepEqual(previews.filter(item => 'layout' in item).at(-1), {layout: null, name: undefined},
    'but nothing goes on the map while it has no position');
  const set = (name, value) => {const node = body.querySelector(`[name=${name}]`); node.value = value; node.oninput?.(); node.onchange?.();};
  set('gates', '7');
  flush();
  await settle();
  assert.equal(previews.filter(item => item.pattern).at(-1).gates, 7, 'a design change previews without a position');
  assert.equal(drawn.length, 2, 'the picture follows every answer the server gives');
  set('latitude', '37.5'); set('longitude', '127');
  flush();
  await settle();
  assert.equal(previews.filter(item => item.layout).at(-1).layout.frame.latitude, 37.5, 'once it has a position it goes on the map too');
});

test('the shape frame is never blank: it waits hidden and comes back drawn', async () => {
  const drawn = [];
  const {panel, body, flush, settle} = panelHarness({drawThumbnail: shape => {drawn.push(shape); return Boolean(shape);}});
  panel.render(body);
  await panel.ready;
  // An undrawn canvas left in the frame stands beside the waiting line and
  // squeezes it into a column one letter wide, which is what a tab switch showed.
  assert.equal(body.querySelector('#vertiport-thumb').hidden, true, 'an undrawn canvas keeps out of the frame');
  assert.equal(body.querySelector('#vertiport-thumb-empty').hidden, false, 'and the waiting line has it to itself');
  flush();
  await settle();
  assert.equal(body.querySelector('#vertiport-thumb').hidden, false, 'the picture takes the frame once it is drawn');
  assert.equal(body.querySelector('#vertiport-thumb-empty').hidden, true);
  const before = drawn.length;
  panel.render(body);
  await panel.ready;
  assert.equal(drawn.length, before + 1, 'coming back to the tab redraws the shape it already knows');
  assert.equal(body.querySelector('#vertiport-thumb').hidden, false, 'so the frame is never empty on the way back');
});

test('a section can render its own content into the work panel body', () => {
  const element = () => ({attributes: {}, dataset: {}, textContent: '', inert: false, setAttribute(k, v) {this.attributes[k] = String(v);}});
  const body = element();
  const panel = new WorkPanel({root: element(), title: element(), body, owner: element(), buttons: {}});
  panel.open('simulation', {label: 'Simulation', render: target => {target.textContent = 'rendered';}});
  assert.equal(body.textContent, 'rendered');
  panel.open('live', {label: 'Live Twinning'});
  assert.notEqual(body.textContent, 'rendered', 'the next section starts from a clean body');
});

// ---------------------------------------------------------------- placement tools

function menuHarness() {
  const mount = new FakeElement('div');
  const changes = [], placed = [], resumed = [];
  const menu = new PlaceMenu({document: fakeDocument, mount, viewport: () => ({width: 1200, height: 800}),
    describeHeight: metres => {const base = podiumHeight(metres), storeys = facadePlan(cladHeight(metres)).storeys;
      return base > 0 ? `기단 ${base} m + 외벽 ${storeys}층` : `외벽 ${storeys}층`;},
    onChange: (name, value) => changes.push([name, value]), onPlace: () => placed.push(true), onResume: () => resumed.push(true)});
  return {menu, mount, changes, placed, resumed};
}

test('the placement tools offer height, layout and heading where the operator right-clicked', () => {
  const {menu, mount, changes, placed, resumed} = menuHarness();
  const card = menu.open({screen: {x: 400, y: 300}, options,
    values: {platform_height_m: '6', heading_deg: '350', pattern: 'double', gates: '4', fato_count: '2'}, limits: options.limits});
  assert.equal(mount.children.length, 1, 'the card is mounted on the page, not in the work panel');
  assert.deepEqual(card.querySelectorAll('.place-tool-head').map(head => head.children[0].textContent), ['높이 조정', '각도 조정', '레이아웃 조정']);
  assert.equal(card.style.left, '410px');
  assert.equal(card.style.top, '310px');

  const height = card.querySelector('[name=platform_height_m]');
  assert.equal(height.getAttribute('type'), 'range', 'the height is dragged, not typed');
  assert.equal(height.getAttribute('step'), '5', 'a deck goes up by storeys, not by hand-widths');
  assert.equal(height.value, '6');
  height.value = '12'; height.oninput();
  assert.deepEqual(changes.at(-1), ['platform_height_m', 12]);
  assert.match(card.querySelector('.place-value').textContent, /12\.0 m/);
  assert.match(card.querySelector('.place-value').textContent, /외벽 \d층/, 'the readout says what a deck this tall becomes');

  const heading = card.querySelector('[name=heading_deg]');
  assert.equal(heading.value, '350');
  const turns = card.querySelector('.place-turns').children;
  assert.equal(turns.length, 5);
  turns[2].click();
  assert.deepEqual(changes.at(-1), ['heading_deg', 5], 'a turn past north wraps instead of running off the slider');
  assert.equal(heading.value, '5');
  turns.at(-1).click();
  assert.deepEqual(changes.at(-1), ['heading_deg', 0], 'north is one press away');

  const pattern = card.querySelector('[name=pattern]');
  assert.deepEqual(pattern.children.map(option => option.attributes.value), options.patterns.map(item => item.id));
  assert.equal(pattern.value, 'double', 'the tools open on what the form already says');
  pattern.value = 'flank'; pattern.onchange();
  assert.deepEqual(changes.at(-1), ['pattern', 'flank']);
  const gates = card.querySelector('[name=gates]');
  gates.value = '99'; gates.oninput();
  assert.notDeepEqual(changes.at(-1), ['gates', 99], 'a count the server would refuse is not reported');
  gates.value = '6'; gates.oninput();
  assert.deepEqual(changes.at(-1), ['gates', 6]);

  card.querySelector('.place-confirm').click();
  assert.deepEqual(placed, [true]);
  card.querySelector('.place-close').click();
  assert.deepEqual(resumed, [true]);
  menu.setNote('지면 41.2~74.8 m · 상면 75.8 m');
  assert.match(card.querySelector('.place-note').textContent, /상면 75\.8 m/);
  menu.close();
  assert.equal(mount.children.length, 0);
  assert.equal(menu.isOpen, false);
});

test('the tools stay on screen when the right click lands near an edge', () => {
  const {menu} = menuHarness();
  const card = menu.open({screen: {x: 1190, y: 790}, options, values: {}, limits: options.limits});
  assert.equal(card.style.left, '958px');
  assert.equal(card.style.top, '450px');
});

test('the tools write into the form, turn the preview at once and can finish the placement', async () => {
  let resolvePick, onMove, onTools, onRelease;
  const {menu, mount} = menuHarness();
  const {panel, body, previews, follows, commits, resumes, flush, settle} = panelHarness({placeMenu: menu,
    pickLocation: hooks => {onMove = hooks.onMove; onTools = hooks.onTools; onRelease = hooks.onRelease; return new Promise(resolve => {resolvePick = resolve;});}});
  panel.render(body);
  await panel.ready;
  body.querySelector('[name=name]').value = '허브';
  body.querySelector('#vertiport-pick').click();
  onMove({latitude: 37.2, longitude: 127.2, height: 12});
  await settle();
  assert.equal(follows.length, 1);
  assert.equal(panel.toolsOpen, false);

  onTools({latitude: 37.2, longitude: 127.2, height: 12}, {x: 300, y: 200});
  assert.equal(panel.toolsOpen, true, 'the right click opened the tools');
  const card = mount.children[0];
  const heading = card.querySelector('[name=heading_deg]');
  heading.value = '90'; heading.oninput();
  assert.equal(body.querySelector('[name=heading_deg]').value, '90', 'the tool writes into the form');
  assert.equal(follows.at(-1).layout.frame.heading_deg, 90, 'and the map turns before the server answers');
  assert.equal(follows.at(-1).pose.latitude, 37.2, 'at the parked pose');
  const height = card.querySelector('[name=platform_height_m]');
  height.value = '9'; height.oninput();
  const count = card.querySelector('[name=fato_count]');
  count.value = '3'; count.oninput();
  assert.equal(body.querySelectorAll('select[name=fato_role_2]').length, 1, 'a FATO count from the tools rebuilds the role rows');
  flush();
  await settle();
  const sent = previews.filter(item => item.pattern).at(-1);
  assert.equal(sent.platform_height_m, 9);
  assert.equal(sent.fatos.length, 3);
  assert.equal(sent.heading_deg, 90);

  card.querySelector('.place-confirm').click();
  assert.equal(panel.toolsOpen, false, 'placing closes the tools');
  assert.deepEqual(commits.at(-1), {latitude: 37.2, longitude: 127.2, height: 12});
  resolvePick(commits.at(-1));
  await settle();
  assert.equal(body.querySelector('[name=latitude]').value, '37.200000');
  assert.equal(panel.picking, false);
  assert.deepEqual(resumes, [], 'a placement from the tools never asks the map to follow again');
  assert.equal(typeof onRelease, 'function');
});

test('the tools give the cursor back on demand, and a cancelled placement takes them with it', async () => {
  let resolvePick, onTools, onRelease;
  const {menu, mount} = menuHarness();
  const {panel, body, resumes, settle} = panelHarness({placeMenu: menu,
    pickLocation: hooks => {onTools = hooks.onTools; onRelease = hooks.onRelease; return new Promise(resolve => {resolvePick = resolve;});}});
  panel.render(body);
  await panel.ready;
  body.querySelector('#vertiport-pick').click();
  onTools({latitude: 37.2, longitude: 127.2, height: 12}, {x: 10, y: 10});
  mount.children[0].querySelectorAll('button').find(node => node.textContent === '이동 계속').click();
  assert.equal(panel.toolsOpen, false);
  assert.deepEqual(resumes, [true], 'the map is told to follow the cursor again');
  onTools({latitude: 37.3, longitude: 127.3, height: 12}, {x: 20, y: 20});
  assert.equal(panel.toolsOpen, true);
  // A click on the map releases the hold; the tools close with it.
  onRelease();
  assert.equal(panel.toolsOpen, false);
  onTools({latitude: 37.4, longitude: 127.4, height: 12}, {x: 30, y: 30});
  resolvePick(null);
  await settle();
  assert.equal(panel.toolsOpen, false, 'a cancelled placement leaves no tools behind');
  assert.equal(mount.children.length, 0);
});

test('show() says how many decks it actually placed or removed, so an unchanged list costs no route redraw', async () => {
  const entities = new Entities();
  const layer = new VertiportLayer(C, viewerWith(entities), layerOptions({groundHeights: async p => p.map(() => 5)}));
  await layer.show([record]);
  assert.equal(layer.showChanged, 1, 'the first list places one deck');
  await layer.show([{...record}]);
  assert.equal(layer.showChanged, 0, 'a fresh copy of the same record changes nothing');
  await layer.show([{...record, name: '새 이름'}]);
  assert.equal(layer.showChanged, 1, 'a changed record is placed again');
  await layer.show([]);
  assert.equal(layer.showChanged, 1, 'a removal counts too');
  const globe = readFileSync(new URL('../../../../digital_twin/visualization/web/globe.js', import.meta.url), 'utf8');
  assert.match(globe, /const changed=this\.vertiportLayer\.showChanged!==0;[\s\S]{0,400}changed\?this\.routeLayer\.refresh\(\):undefined/,
    'the map only resamples and redraws the whole route network when a deck changed');
});
