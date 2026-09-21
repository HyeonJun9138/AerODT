import test from 'node:test';
import assert from 'node:assert/strict';
import {cableGeometry, cablePrimitive, tubeMesh, boxMesh, ChargingCables, CABLE_RADIUS_M, CABLE_SIDES, PLUG_SIZE_M, CABINET_BODY_HALF}
  from '../../../../digital_twin/visualization/web/charging_cables.js';
import {uamPhaseName} from '../../../../digital_twin/visualization/web/entity_labels.js';

const METRES_PER_DEGREE = 111319.49;
// Every triangle of a mesh must wind counter-clockwise seen from outside (its
// geometric normal along its stored normals), or a closed appearance culls it.
function outwardWinding(mesh) {
  const p = mesh.positions, n = mesh.normals, at = i => ({x: p[i * 3], y: p[i * 3 + 1], z: p[i * 3 + 2]});
  let bad = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const [a, b, c] = [mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]].map(at);
    const ab = {x: b.x - a.x, y: b.y - a.y, z: b.z - a.z}, ac = {x: c.x - a.x, y: c.y - a.y, z: c.z - a.z};
    const face = {x: ab.y * ac.z - ab.z * ac.y, y: ab.z * ac.x - ab.x * ac.z, z: ab.x * ac.y - ab.y * ac.x};
    const stored = [mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]].reduce((sum, k) => ({x: sum.x + n[k * 3], y: sum.y + n[k * 3 + 1], z: sum.z + n[k * 3 + 2]}), {x: 0, y: 0, z: 0});
    if (face.x * stored.x + face.y * stored.y + face.z * stored.z <= 0) bad++;
  }
  return bad;
}
const meshOf = geometry => ({positions: Array.from(geometry.attributes.position.values), normals: Array.from(geometry.attributes.normal.values), indices: Array.from(geometry.indices)});
const entity = {entity_id: 'a', source: 'scenario', flight_phase: 'parked', longitude_deg: 127, latitude_deg: 37, altitude_m: 50, heading_deg: 0,
  charging_connection: {charger_id: 'C1', vertiport_id: 'VP1', longitude_deg: 127.0001, latitude_deg: 37, altitude_m: 51.1, port_right_m: .9, port_height_m: 1.25}};
const eastScale = METRES_PER_DEGREE * Math.cos(37 * Math.PI / 180);
const metres = (p, q) => Math.hypot((p[0] - q[0]) * eastScale, (p[1] - q[1]) * METRES_PER_DEGREE);

test('the cable leaves the socket, lies on the deck and rises into the port on the cabinet side of the aircraft', () => {
  const g = cableGeometry(entity, 20);
  assert.equal(uamPhaseName('parked', entity), '충전 중');
  assert.equal(uamPhaseName('parked', {charging_connection: {state: 'complete'}}), '충전 완료');
  assert.deepEqual(g.points[0], [127.0001, 37, 71.1], 'from the socket at its lifted height');
  const last = g.points.at(-1);
  assert.equal(last[2], 71.25, 'to the port height on the lifted deck');
  assert.ok(last[0] > 127 && last[0] < 127.0001, 'the port is on the side of the aircraft the cabinet is on');
  assert.ok(Math.abs(metres(last, [127, 37]) - .9) < .01, 'and port_right_m from its centre line');
  assert.equal(g.deck, 70);
  assert.equal(g.radius, CABLE_RADIUS_M);
  const lowest = Math.min(...g.points.map(p => p[2]));
  assert.ok(Math.abs(lowest - (70 + CABLE_RADIUS_M)) < 1e-9, 'it lies on the deck in between');
  assert.ok(g.points.filter(p => Math.abs(p[2] - lowest) < 1e-9).length >= 2, 'a run along the deck, not one sag');
  for (let i = 1; i < g.points.length; i++) {
    const d = metres(g.points[i], g.points[0]), before = metres(g.points[i - 1], g.points[0]);
    assert.ok(d >= before - 1e-9, 'the route only ever moves toward the port');
  }
  assert.ok(g.points.length > 12);
});

test('a cabinet the layer knows moves the outlet from the footprint edge onto the cabinet body at its cable track', () => {
  const cabinet = {longitude: 127.00013, latitude: 37, altitude: 71.6, side: 2.4, height: 2.2, heading_deg: 0};
  const g = cableGeometry(entity, 20, cabinet);
  assert.equal(g.points[0][2], 71.6, 'at the height of the cable track');
  const fromCentre = metres(g.points[0], [cabinet.longitude, cabinet.latitude]);
  assert.ok(Math.abs(fromCentre - CABINET_BODY_HALF * cabinet.side) < .01, 'on the body wall toward the port');
  assert.ok(g.points[0][0] < cabinet.longitude, 'on the side that looks at the aircraft');
  const turned = cableGeometry(entity, 20, {...cabinet, heading_deg: 45});
  assert.ok(Math.abs(metres(turned.points[0], [cabinet.longitude, cabinet.latitude]) - CABINET_BODY_HALF * cabinet.side * Math.SQRT2) < .02,
    'a turned body is met at its corner along the same line');
  const inside = cableGeometry(entity, 20, {...cabinet, longitude: 127.000005});
  assert.ok(Math.abs(metres(inside.points[0], [inside.port[0], inside.port[1]]) - .3) < .01, 'a port inside the body: the cable still has a short way to run');
  assert.equal(cableGeometry(entity, 20, {longitude: NaN}).points[0][2], 71.1, 'a cabinet without a position falls back to the socket');
});

test('an aircraft parked right beside its cabinet gets one sag, and nothing is drawn for anything not parked on a scenario connection', () => {
  const near = cableGeometry({...entity, charging_connection: {...entity.charging_connection, longitude_deg: 127.000013}}, 0);
  assert.ok(near, 'a metre away is still a cable');
  assert.ok(near.points.length >= 10);
  assert.ok(Math.min(...near.points.map(p => p[2])) >= 50 + CABLE_RADIUS_M, 'never below the deck');
  assert.equal(cableGeometry({...entity, flight_phase: 'gate_out'}), null);
  assert.equal(cableGeometry({...entity, source: 'physical_uam'}), null);
  assert.equal(cableGeometry({...entity, charging_connection: null}), null);
  assert.equal(cableGeometry({...entity, charging_connection: {...entity.charging_connection, latitude_deg: 38}}), null, 'a socket on another deck');
  assert.equal(cableGeometry({...entity, altitude_m: NaN}), null);
});

test('the tube is a closed ring of facets per point with outward normals, and the plug a box on its axes', () => {
  const points = [{x: 0, y: 0, z: 0}, {x: 1, y: 0, z: 0}, {x: 2, y: 0, z: -.5}, {x: 3, y: 0, z: -.5}];
  const mesh = tubeMesh(points, .1, 8);
  assert.equal(mesh.positions.length / 3, points.length * 8);
  assert.equal(mesh.indices.length, (points.length - 1) * 8 * 6);
  for (let i = 0; i < 8; i++) {
    const p = {x: mesh.positions[i * 3], y: mesh.positions[i * 3 + 1], z: mesh.positions[i * 3 + 2]};
    assert.ok(Math.abs(Math.hypot(p.y, p.z) - .1) < 1e-9, 'the first ring is a circle of the radius around the first point');
    assert.ok(Math.abs(p.x) < 1e-9);
    const n = {x: mesh.normals[i * 3], y: mesh.normals[i * 3 + 1], z: mesh.normals[i * 3 + 2]};
    assert.ok(Math.abs(n.y * p.y + n.z * p.z - .1) < 1e-9, 'normals point out of the tube');
  }
  assert.ok(mesh.indices.every(i => i < mesh.positions.length / 3));
  assert.equal(outwardWinding(mesh), 0, 'every tube facet winds outward');
  const box = boxMesh({x: 0, y: 0, z: 0}, [{x: 1, y: 0, z: 0}, {x: 0, y: 1, z: 0}, {x: 0, y: 0, z: 1}], [2, 4, 6]);
  assert.equal(box.positions.length / 3, 24);
  assert.equal(box.indices.length, 36);
  assert.equal(outwardWinding(box), 0, 'every box face winds outward on a right-handed frame');
  const xs = box.positions.filter((_, i) => i % 3 === 0), zs = box.positions.filter((_, i) => i % 3 === 2);
  assert.equal(Math.max(...xs), 1); assert.equal(Math.min(...xs), -1); assert.equal(Math.max(...zs), 3);
});

// Enough of the engine to build a cable primitive and count what reaches the scene.
function engine() {
  const made = [];
  const C = {
    Cartesian3: {fromDegrees: (lon, lat, alt) => ({x: (lon - 127) * eastScale, y: (lat - 37) * METRES_PER_DEGREE, z: alt})},
    Geometry: class {constructor(o) {Object.assign(this, o);}},
    GeometryAttribute: class {constructor(o) {Object.assign(this, o);}},
    GeometryInstance: class {constructor(o) {Object.assign(this, o);}},
    Primitive: class {constructor(o) {Object.assign(this, o); made.push(this);}},
    PerInstanceColorAppearance: class {constructor(o) {this.options = o;}},
    ColorGeometryInstanceAttribute: {fromColor: color => ({color})},
    Color: class {constructor(r, g, b, a) {Object.assign(this, {r, g, b, a});}},
    ComponentDatatype: {DOUBLE: 'double', FLOAT: 'float'},
    PrimitiveType: {TRIANGLES: 'triangles'},
    BoundingSphere: {fromVertices: values => ({count: values.length / 3})},
  };
  return {C, made};
}

test('the primitive carries the tube and a plug that sits against the fuselage, opaque and closed like the deck it stands on', () => {
  const {C} = engine();
  const g = cableGeometry(entity, 0);
  const primitive = cablePrimitive(C, g);
  assert.equal(primitive.asynchronous, false, 'built now, on the main thread: it is a few hundred vertices');
  assert.deepEqual(primitive.appearance.options, {translucent: false, closed: true}, 'opaque and closed, as the warm-up draws its cable entry');
  assert.equal(primitive.allowPicking, false, 'never picked: an id-less hit would defeat the slack pick and the hover around the aircraft');
  const [tubeInstance, plugInstance] = primitive.geometryInstances;
  assert.deepEqual(Object.keys(tubeInstance.attributes), ['color'], 'a colour per instance and nothing else, the attribute set the warm-up entry carries');
  assert.deepEqual(Object.keys(plugInstance.attributes), ['color']);
  const [tube, plug] = primitive.geometryInstances;
  assert.equal(tube.geometry.attributes.position.values.length / 3, g.points.length * CABLE_SIDES);
  assert.equal(tube.geometry.primitiveType, 'triangles');
  assert.equal(tube.geometry.boundingSphere.count, g.points.length * CABLE_SIDES);
  assert.equal(plug.geometry.attributes.position.values.length / 3, 24);
  const port = C.Cartesian3.fromDegrees(...g.port);
  const xs = plug.geometry.attributes.position.values.filter((_, i) => i % 3 === 0);
  // The cable arrives from the cabinet on the east, moving west into the port.
  assert.ok(Math.abs(Math.min(...xs) - (port.x - .01)) < 1e-3, 'the plug face sits a centimetre into the fuselage side, hiding the seam');
  assert.ok(Math.abs(Math.max(...xs) - (port.x - .01 + PLUG_SIZE_M[0])) < 1e-3, 'and the plug body points back along the cable, level');
  const [prev, last] = g.points.slice(-2);
  assert.equal(prev[2], last[2], 'the cable itself runs level into the port');
  assert.notDeepEqual(tube.attributes.color, plug.attributes.color, 'rubber cable, metal plug');
  assert.equal(outwardWinding(meshOf(tube.geometry)), 0, 'the tube is seen from outside');
  assert.equal(outwardWinding(meshOf(plug.geometry)), 0, 'and so is the plug: its frame is right-handed whichever way the cable arrives');
  const mirrored = cablePrimitive(C, cableGeometry({...entity, charging_connection: {...entity.charging_connection, longitude_deg: 126.9999}}, 0));
  assert.equal(outwardWinding(meshOf(mirrored.geometryInstances[1].geometry)), 0, 'from the other side too');
});

test('the layer keeps one primitive per charging aircraft, rebuilds only when the route moves, and never creates another WebGL context', () => {
  const {C, made} = engine();
  const primitives = {values: [], add(x) {this.values.push(x); return x;}, remove(x) {this.values = this.values.filter(v => v !== x);}};
  const cabinets = [];
  const layer = new ChargingCables(C, {scene: {primitives}}, {cabinet: connection => {cabinets.push(connection.charger_id); return null;}});
  const item = {entity, lod: 'model', model: {show: true}, position: {}};
  layer.update([item], () => true, () => 20);
  assert.equal(layer.items.size, 1);
  assert.equal(primitives.values.length, 1);
  assert.deepEqual(cabinets, ['C1'], 'the cabinet is asked for by the connection');
  layer.update([item], () => true, () => 20);
  assert.equal(made.length, 1, 'the same route is not rebuilt');
  layer.update([item], () => true, () => 21);
  assert.equal(made.length, 2, 'a moved deck rebuilds the cable');
  assert.equal(primitives.values.length, 1, 'and replaces the old one');
  layer.update([item], () => false, () => 21);
  assert.equal(layer.items.size, 0);
  assert.equal(primitives.values.length, 0);
  layer.update([{...item, lod: 'point'}], () => true, () => 21);
  assert.equal(layer.items.size, 0, 'only an aircraft drawn as a model gets a cable');
  layer.update([item], () => true, () => 21);
  layer.retain([]);
  assert.equal(layer.items.size, 0, 'a connection the wire no longer carries is taken away');
  layer.update([item], () => true, () => 21);
  layer.destroy();
  assert.equal(primitives.values.length, 0);
});
