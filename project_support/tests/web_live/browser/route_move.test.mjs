// Moving a waypoint that already exists: the card asks for a new place, the map
// carries the point under the cursor with the old one left faint behind it, and
// a click puts it down. Nothing reaches the server until the card is saved.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {FakeElement, fakeDocument} from './fake_dom.mjs';
import {RouteCard} from '../../../../user_application/web/domains/uam/planning/route_card.js';
import {RoutePanel} from '../../../../user_application/web/domains/uam/planning/route_panel.js';
import {RouteLayer} from '../../../../digital_twin/visualization/web/route_layer.js';

const seoul = {latitude: 37.53, longitude: 126.93};
const node = {id: 'rn-a', name: '63빌딩', ...seoul, altitude_m: 304.8, altitude_reference: 'agl'};

function harness() {
  const state = {nodes: [{...node}], links: [], fatos: []};
  const calls = {updated: []};
  const api = {
    network: async () => ({schema_version: 1, ...state}),
    options: async () => ({}),
    place: async () => ({name: '여의도동'}),
    updateNode: async (id, definition) => {
      calls.updated.push([id, definition]);
      const index = state.nodes.findIndex(item => item.id === id);
      state.nodes[index] = {...definition, id};
      return {node: state.nodes[index]};
    },
  };
  const events = {editing: [], moves: [], notices: [], networks: []};
  const mount = new FakeElement('body');
  const card = new RouteCard({document: fakeDocument, mount, viewport: () => ({width: 1200, height: 800})});
  const panel = new RoutePanel({api, document: fakeDocument, card, notify: (s, m) => events.notices.push([s, m]),
    onEditing: editor => events.editing.push(editor), onMoveNode: (id, pose) => events.moves.push([id, pose]),
    onNetwork: network => events.networks.push(network),
    groundAt: async () => 12.5, positionOf: id => ({longitude: seoul.longitude, latitude: seoul.latitude, height: 330, ground: 25, node: {id}}),
    screenOf: () => ({x: 300, y: 200}), setTimer: () => 1, clearTimer: () => {}});
  const body = new FakeElement('div');
  const settle = async () => {for (let index = 0; index < 6; index++) await new Promise(resolve => setImmediate(resolve));};
  const mode = () => body.querySelector('#route-status').dataset.mode;
  const button = text => [...mount.querySelectorAll('button')].find(item => item.textContent === text);
  const positionLine = () => [...mount.querySelectorAll('small')].find(item => item.textContent.startsWith('위치'));
  return {panel, body, mount, card, calls, events, settle, mode, button, positionLine};
}

async function opened() {
  const kit = harness();
  kit.panel.render(kit.body);
  kit.panel.activate();
  await kit.panel.ready;
  await kit.settle();
  kit.panel.openNodeEdit({...node}, {x: 300, y: 200});
  return kit;
}

test('the edit card offers to change the position, which the old card never did', async () => {
  const {button, positionLine} = await opened();
  assert.ok(button('위치 변경'), 'the card can move its own point');
  assert.equal(positionLine().textContent, '위치 37.53000, 126.93000');
});

test('while carrying, every cursor move is where it would land and the old place stays put', async () => {
  const {panel, events, mode, button, positionLine} = await opened();
  button('위치 변경').click();
  assert.equal(mode(), 'moving');
  const armed = events.editing.at(-1);
  assert.equal(armed.crosshair, true, 'the map shows it is waiting for a click');
  assert.equal(typeof armed.onMove, 'function', 'and reports every move, not just the click');
  // Naming a place is a request and can wait a quarter second; carrying a point
  // is a transform and stutters at four reports a second.
  assert.equal(armed.moveInterval, 0, 'the cursor is wanted every frame while carrying');
  assert.deepEqual(events.moves.at(-1), ['rn-a', null], 'the map is told which point is on the move');

  panel.moveTo({latitude: 37.54, longitude: 126.94, height: 20});
  assert.deepEqual(events.moves.at(-1)[1], {latitude: 37.54, longitude: 126.94, height: 20});
  assert.match(positionLine().textContent, /37\.54000, 126\.94000/);
  assert.match(positionLine().textContent, /클릭하면 여기로/, 'it says it has not landed yet');
  assert.equal(panel.moving.node.id, 'rn-a');
});

test('a click puts it down, and nothing reaches the server until the card is saved', async () => {
  const {panel, mount, calls, events, mode, button, positionLine, settle} = await opened();
  button('위치 변경').click();
  panel.moveTo({latitude: 37.54, longitude: 126.94, height: 20});
  panel.mapClick({ground: {latitude: 37.545, longitude: 126.945, height: 21}, screen: {x: 10, y: 10}});
  assert.equal(mode(), 'idle', 'the map is handed back');
  assert.deepEqual(events.moves.at(-1), ['rn-a', null], 'and the ghost is cleared');
  assert.equal(positionLine().textContent, '위치 37.54500, 126.94500', 'the card holds the new place');
  assert.deepEqual(calls.updated, [], 'the server has not been told');

  // The fake DOM has no form submission of its own.
  const form = [...mount.querySelectorAll('form')].at(-1);
  form.onsubmit({preventDefault() {}});
  await settle();
  assert.equal(calls.updated.length, 1);
  const [id, definition] = calls.updated[0];
  assert.equal(id, 'rn-a');
  assert.equal(definition.latitude, 37.545);
  assert.equal(definition.longitude, 126.945);
  assert.equal(definition.name, '63빌딩', 'the rest of the card is unchanged');
});

test('the click moves the point on the map at once, before anything is saved', async () => {
  const {panel, calls, events, mount, button, settle} = await opened();
  const shownAt = () => {
    const network = events.networks.at(-1);
    const moved = network?.nodes?.find(item => item.id === 'rn-a');
    return moved ? [moved.latitude, moved.longitude] : null;
  };
  assert.deepEqual(shownAt(), [37.53, 126.93]);
  button('위치 변경').click();
  panel.mapClick({ground: {latitude: 37.545, longitude: 126.945, height: 21}});
  assert.deepEqual(shownAt(), [37.545, 126.945], 'the map shows it where it was dropped');
  assert.deepEqual(calls.updated, [], 'without telling the server');
  assert.deepEqual(panel.shownPlace('rn-a'), {latitude: 37.545, longitude: 126.945});
  // Closing the card without saving puts the map back where the server has it.
  panel.cardClosed();
  assert.deepEqual(shownAt(), [37.53, 126.93], 'a move given up leaves nothing behind');
  assert.equal(panel.moved, null);
  // Saved, the server's answer is what is drawn.
  panel.openNodeEdit({...node}, {x: 300, y: 200});
  button('위치 변경').click();
  panel.mapClick({ground: {latitude: 37.55, longitude: 126.95, height: 21}});
  const form = [...mount.querySelectorAll('form')].at(-1);
  form.onsubmit({preventDefault() {}});
  await settle();
  assert.equal(panel.moved, null, 'the preview gives way to what came back');
  assert.deepEqual(shownAt(), [37.55, 126.95]);
});

test('a click on another point still lands there: while carrying, the click is the place', async () => {
  const {panel, positionLine, button} = await opened();
  button('위치 변경').click();
  panel.mapClick({hit: {kind: 'node', id: 'rn-other'}, ground: {latitude: 37.55, longitude: 126.95, height: 30}});
  assert.equal(positionLine().textContent, '위치 37.55000, 126.95000');
  assert.equal(panel.moving, null);
});

test('Escape gives up the move and leaves the point where it was', async () => {
  const {panel, events, mode, button, positionLine} = await opened();
  button('위치 변경').click();
  panel.moveTo({latitude: 37.54, longitude: 126.94, height: 20});
  assert.equal(panel.escape(), true);
  assert.equal(mode(), 'idle');
  assert.deepEqual(events.moves.at(-1), ['rn-a', null]);
  assert.equal(positionLine().textContent, '위치 37.53000, 126.93000', 'back to where it stands');
  assert.equal(panel.escape(), true, 'the next Escape closes the card, as before');
});

test('closing the card or leaving the tab lets the map go', async () => {
  const kit = await opened();
  kit.button('위치 변경').click();
  kit.panel.cardClosed();
  assert.equal(kit.panel.moving, null);
  assert.deepEqual(kit.events.moves.at(-1), ['rn-a', null]);
  const other = await opened();
  other.button('위치 변경').click();
  other.panel.deactivate();
  assert.equal(other.panel.moving, null);
  assert.equal(other.events.editing.at(-1), null, 'the map is handed back on the way out');
});

// ---------------------------------------------------------------- the map side

class Entities {
  values = [];
  add(item) {this.values.push(item); return item;}
  remove(item) {this.values = this.values.filter(value => value !== item); return true;}
}

const C = {
  Cartesian3: Object.assign(class {constructor(x, y, z) {Object.assign(this, {x, y, z});}},
    {fromDegrees: (lon, lat, h = 0) => ({lon, lat, h})}),
  Cartesian2: class {constructor(x, y) {Object.assign(this, {x, y});}},
  Color: {fromCssColorString: css => ({css, withAlpha(alpha) {return {css, alpha};}})},
  DistanceDisplayCondition: class {constructor(near, far) {Object.assign(this, {near, far});}},
  NearFarScalar: class {constructor(...a) {this.a = a;}},
  LabelStyle: {FILL_AND_OUTLINE: 'fo'}, VerticalOrigin: {BOTTOM: 'b'}, ArcType: {NONE: 'none'},
  PolylineDashMaterialProperty: class {constructor(options) {Object.assign(this, options);}},
  ComponentDatatype: {DOUBLE: 'double'}, PrimitiveType: {TRIANGLES: 't'},
  Geometry: class {constructor(o) {Object.assign(this, o);}},
  GeometryAttribute: class {constructor(o) {Object.assign(this, o);}},
  GeometryInstance: class {constructor(o) {Object.assign(this, o);}},
  BoundingSphere: {fromVertices: values => ({values})},
  ColorGeometryInstanceAttribute: {fromColor: color => ({color}), toValue: value => value},
  Primitive: class {constructor(o) {Object.assign(this, o);}},
  PerInstanceColorAppearance: class {constructor(o) {Object.assign(this, o);}},
  Math: {toRadians: d => d * Math.PI / 180},
};

async function layerWith() {
  const entities = new Entities();
  const layer = new RouteLayer(C, {entities, scene: {primitives: {add: item => item, remove: () => true}, requestRender() {}}},
    {groundHeights: async points => points.map(() => 10)});
  await layer.show({nodes: [{...node}], fatos: [], links: []});
  return {layer, entities};
}

test('the map draws the point it is leaving faint and a ghost where it would land', async () => {
  const {layer, entities} = await layerWith();
  const marker = layer.markers.get('rn-a').entity;
  assert.equal(marker.point.color.alpha, 1, 'solid while it stands still');
  const before = entities.values.length;

  assert.equal(layer.moveNode('rn-a', {latitude: 37.54, longitude: 126.94, height: 20}), true);
  assert.ok(layer.markers.get('rn-a').entity.point.color.alpha < .5, 'the old place goes faint');
  const added = entities.values.length - before;
  assert.equal(added, 3, 'a ghost, a line back to where it stands, and its drop to the ground');
  const ghost = entities.values.at(-3);
  assert.deepEqual([ghost.position.lon, ghost.position.lat, ghost.position.h], [126.94, 37.54, 20 + 304.8],
    'the ghost stands at its own altitude over the cursor');
  assert.equal(ghost.label.text, '63빌딩 → 위치변경');

  assert.equal(layer.moveNode('rn-a', {latitude: 37.54, longitude: 126.94, height: 20}), false, 'the same place redraws nothing');
  // A cursor still carrying the same point only moves what is already drawn:
  // rebuilding every marker, line and corridor on each frame is what stuttered.
  const drawn = entities.values.slice(-3);
  layer.moveNode('rn-a', {latitude: 37.55, longitude: 126.95, height: 20});
  assert.equal(entities.values.length - before, 3, 'moving on replaces nothing');
  assert.deepEqual(entities.values.slice(-3), drawn, 'the same three entities are still the ones on screen');
  assert.equal(drawn[0].position.lat, 37.55, 'they were moved, not made again');
  assert.equal(drawn[1].polyline.positions.at(-1).lat, 37.55);

  assert.equal(layer.moveNode(null, null), true);
  assert.equal(entities.values.length, before, 'putting it down clears the ghost');
  assert.equal(layer.markers.get('rn-a').entity.point.color.alpha, 1, 'and the point is solid again');
});

test('the page hands the cursor to the map and the map to the layer', () => {
  const web = new URL('../../../../', import.meta.url);
  const app = readFileSync(new URL('user_application/web/app.js', web), 'utf8');
  const globe = readFileSync(new URL('digital_twin/visualization/web/globe.js', web), 'utf8');
  assert.match(app, /onMoveNode:\(id,pose\)=>liveGlobe\?\.moveRouteNode\(id,pose\)/);
  assert.match(globe, /moveRouteNode\(id,pose\)\s*\{[^}]*routeLayer\.moveNode\(id,pose\)/);
  assert.match(globe, /this\.routeEditor\.moveInterval \?\? 250/, 'the editor decides how often the cursor is reported');
});
