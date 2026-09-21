import test from 'node:test';
import assert from 'node:assert/strict';
import {ACROSS_SAMPLES, bearing, carveDepth, corridorMesh, distanceMetres, heightProfile, hubArcPositions, hubArcs, hubMesh, hubRadius,
  localVector, neighbourClips, profilePositions, yieldDepth} from '../../../../digital_twin/visualization/web/route_geometry.js';
const geometryExtras = {yieldDepth, neighbourClips, profilePositions};

const A = {longitude: 126.93, latitude: 37.53, height: 400};
const B = {longitude: 126.93 + 3000 / (111320 * Math.cos(37.53 * Math.PI / 180)), latitude: 37.53, height: 700};   // 3 km east, 300 m higher
const close = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) <= tolerance, `${a} ≈ ${b}`);

test('local vectors, distances and bearings are worked out in metres around the first node', () => {
  const v = localVector(A, B);
  close(v.east, 3000, .01); close(v.north, 0, 1e-9);
  close(distanceMetres(A, B), 3000, .01);
  close(bearing(A, B), 0); close(bearing(B, A), Math.PI, 1e-9);
  close(bearing(A, {longitude: A.longitude, latitude: A.latitude + .01}), Math.PI / 2);
});

test('the height profile is level at both ends and monotonic between', () => {
  assert.equal(heightProfile(0), 0); assert.equal(heightProfile(1), 1); assert.equal(heightProfile(.5), .5);
  assert.equal(heightProfile(-1), 0); assert.equal(heightProfile(2), 1);
  const slope = (heightProfile(.001) - heightProfile(0)) / .001;
  assert.ok(slope < .01, 'flat leaving a hub');
  let previous = 0;
  for (let u = .05; u <= 1; u += .05) {assert.ok(heightProfile(u) > previous); previous = heightProfile(u);}
});

test('a corridor is a grid between the two nodes, as wide as asked, that climbs from one height to the other', () => {
  const mesh = corridorMesh(A, B, 300);
  assert.equal(mesh.acrossSamples, ACROSS_SAMPLES, 'no hub: only the even columns');
  assert.equal(mesh.positions.length, (mesh.alongSamples + 1) * (ACROSS_SAMPLES + 1));
  assert.equal(mesh.indices.length, mesh.alongSamples * ACROSS_SAMPLES * 6);
  assert.ok(mesh.indices.every(index => index >= 0 && index < mesh.positions.length));
  const [left, right] = mesh.edges;
  // Width: the two edges are 300 m apart across the direction of travel.
  close(distanceMetres({longitude: left[0][0], latitude: left[0][1]}, {longitude: right[0][0], latitude: right[0][1]}), 300, .05);
  close(left[0][2], A.height, 1e-9); close(left[left.length - 1][2], B.height, 1e-9);
  assert.ok(left.every((point, index) => index === 0 || point[2] >= left[index - 1][2] - 1e-9), 'never dips on the way up');
  assert.equal(corridorMesh(A, A, 300), null, 'no corridor between a node and itself');
});

test('a corridor end is cut back to the hub circle so its edges meet the circle at a tangent', () => {
  const mesh = corridorMesh(A, B, 300, {fromHub: 150, toHub: 150});
  const [left] = mesh.edges;
  // The edge (150 m to the side) starts level with the node: the tangent point of a 150 m circle.
  close(distanceMetres(A, {longitude: left[0][0], latitude: left[0][1]}), 150, .05);
  // The columns now include the hub polygon's vertices inside the mouth, so
  // the mouth coincides with the disc edge by edge.
  assert.ok(mesh.acrossSamples > ACROSS_SAMPLES, 'more columns than the even ones');
  assert.ok(mesh.columns.some(s => Math.abs(s - 150 * Math.sin(2 * Math.PI / 48)) < 1e-6), 'the first disc vertex beside the axis');
  // The centre line starts 150 m along, on the circle's rim.
  const centreColumn = mesh.columns.findIndex(s => Math.abs(s) < 1e-9);
  const first = mesh.positions[centreColumn];
  close(distanceMetres(A, {longitude: first[0], latitude: first[1]}), 150, .05);
  close(first[2], A.height, 1e-9, 'the mouth is at the hub height');
  // And the far end likewise, at the other node's height.
  const last = mesh.positions[mesh.alongSamples * (mesh.acrossSamples + 1) + centreColumn];
  close(distanceMetres(B, {longitude: last[0], latitude: last[1]}), 150, .05);
  close(last[2], B.height, 1e-9);
  assert.equal(carveDepth(150, 0), 150); assert.equal(carveDepth(150, 150), 0); close(carveDepth(150, 90), 120);
  assert.equal(carveDepth(0, 10), 0, 'no hub, no cut');
});

test('a hub smaller than the corridor is not carved, so a degenerate radius cannot leave a step', () => {
  const plain = corridorMesh(A, B, 300, {fromHub: 20, toHub: 20});
  close(distanceMetres(A, {longitude: plain.positions[0][0], latitude: plain.positions[0][1]}), 150, .05, 'the corner sits beside the node');
});

test('the hub is a flat fan at the node height with the radius of the widest corridor', () => {
  assert.equal(hubRadius([300, 120, 200]), 150);
  assert.equal(hubRadius([], 24), 24, 'a lone node keeps its sphere-sized hub');
  const hub = hubMesh(A, 150, 12);
  assert.equal(hub.positions.length, 13);
  assert.equal(hub.indices.length, 36);
  assert.ok(hub.positions.every(p => p[2] === A.height));
  for (const rim of hub.positions.slice(1)) close(distanceMetres(A, {longitude: rim[0], latitude: rim[1]}), 150, .05);
});

test('hub arcs are the rim not covered by corridor mouths, merged and wrapped around the circle', () => {
  assert.deepEqual(hubArcs(150, []), [[0, 2 * Math.PI]]);
  const one = hubArcs(150, [{angle: 0, halfWidth: 150}]);
  assert.equal(one.length, 1);
  close(one[0][0], Math.PI / 2); close(one[0][1], 3 * Math.PI / 2, 1e-9);
  // Two full-width corridors at right angles: their mouths overlap, leaving one quarter free.
  const two = hubArcs(150, [{angle: 0, halfWidth: 150}, {angle: Math.PI / 2, halfWidth: 150}]);
  assert.equal(two.length, 1);
  close(two[0][0], Math.PI, 1e-9); close(two[0][1] - two[0][0], Math.PI / 2, 1e-9);
  // Narrower corridors at right angles leave two separate arcs, one wrapping past zero.
  const four = hubArcs(150, [{angle: 0, halfWidth: 75}, {angle: Math.PI / 2, halfWidth: 75}]);
  assert.equal(four.length, 2);
  for (const [start, end] of four) assert.ok(start >= 0 && start < 2 * Math.PI && end > start);
  const narrow = hubArcs(150, [{angle: Math.PI, halfWidth: 75}]);
  close(narrow[0][1] - narrow[0][0], 2 * Math.PI - 2 * Math.asin(.5), 1e-9, 'a narrow corridor hides a smaller arc');
  const overlapping = hubArcs(150, [{angle: 0, halfWidth: 150}, {angle: .2, halfWidth: 150}]);
  assert.equal(overlapping.length, 1, 'mouths that overlap merge into one');
  assert.deepEqual(hubArcs(150, [{angle: 0, halfWidth: 150}, {angle: Math.PI, halfWidth: 150}]), [], 'covered all round');
});

test('arc positions run along the rim at the node height', () => {
  const [points] = hubArcPositions(A, 150, [[0, Math.PI]]);
  assert.ok(points.length >= 3);
  for (const point of points) {close(distanceMetres(A, {longitude: point[0], latitude: point[1]}), 150, .05); assert.equal(point[2], A.height);}
  assert.ok(points[0][0] > A.longitude && Math.abs(points[points.length - 1][0] - (2 * A.longitude - points[0][0])) < 1e-9, 'from east round to west');
});

test('a row inside a neighbouring corridor is given up to it as far as the bisector', () => {
  const {yieldDepth, neighbourClips, profilePositions} = geometryExtras;
  // A neighbour turning 90° with the same half-width: the row at s=100 is inside
  // it until it leaves at 150 m and crosses the bisector at 100 m; the bisector comes first.
  close(yieldDepth(100, {angle: Math.PI / 2, halfWidth: 150}), 100, 1e-9);
  close(yieldDepth(150, {angle: Math.PI / 2, halfWidth: 100}), 100, 1e-9, 'it leaves the narrower neighbour before the bisector');
  assert.equal(yieldDepth(-100, {angle: Math.PI / 2, halfWidth: 150}), 0, 'the other side is not this neighbour');
  assert.equal(yieldDepth(100, null), 0);
  assert.equal(yieldDepth(100, {angle: Math.PI, halfWidth: 150}), 0, 'straight behind: nothing to share');
  const clips = neighbourClips([{angle: 0, halfWidth: 150}, {angle: Math.PI / 2, halfWidth: 100}, {angle: -Math.PI / 3, halfWidth: 50}]);
  close(clips[0].left.angle, Math.PI / 2); assert.equal(clips[0].left.halfWidth, 100);
  close(clips[0].right.angle, Math.PI / 3); assert.equal(clips[0].right.halfWidth, 50);
  close(clips[1].right.angle, Math.PI / 2); assert.equal(clips[1].left, null, 'nothing within a half turn to its left');
  // Clipped corridors: the mouth of the wide corridor gives way on its left to the 90° neighbour.
  const clipped = corridorMesh(A, B, 300, {fromHub: 150, toHub: 150, fromClip: {left: {angle: Math.PI / 2, halfWidth: 150}, right: null}});
  const plain = corridorMesh(A, B, 300, {fromHub: 150, toHub: 150});
  // edges[0] runs at s = -half (the right of the leaving direction), edges[1] at +half (the left).
  const leftEdgeStart = clipped.edges[1][0], plainStart = plain.edges[1][0];
  assert.ok(distanceMetres(A, {longitude: leftEdgeStart[0], latitude: leftEdgeStart[1]}) > distanceMetres(A, {longitude: plainStart[0], latitude: plainStart[1]}) + 50,
    'the left edge starts further along (150 m in, on the bisector), past the shared wedge');
  assert.deepEqual(clipped.edges[0][0], plain.edges[0][0], 'the right edge is untouched');
  assert.ok(clipped.columns.some(s => Math.abs(s - 150 * Math.sin(Math.PI / 4)) < 1e-6), 'a column where the disc meets the bisector');
  assert.ok(clipped.columns.some(s => Math.abs(s - 150) < 1e-6) && clipped.columns.some(s => Math.abs(s - 100) < 1e-6) === false, "the neighbour's half-width is the edge itself here");
  const narrow = corridorMesh(A, B, 300, {fromHub: 150, fromClip: {left: {angle: Math.PI / 2, halfWidth: 100}, right: null}});
  assert.ok(narrow.columns.some(s => Math.abs(s - 100) < 1e-6), "a column at the narrower neighbour's half-width, where the bisector hands over");
  const line = profilePositions(A, B, 4);
  assert.equal(line.length, 5);
  assert.equal(line[0][2], A.height); assert.equal(line[4][2], B.height); close(line[2][2], (A.height + B.height) / 2, 1e-9);
});
