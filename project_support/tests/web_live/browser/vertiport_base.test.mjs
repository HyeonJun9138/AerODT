import test from 'node:test';
import assert from 'node:assert/strict';
import {BASE, CANOPY_M, CANOPY_OUT_M, COLUMN_MAX, COLUMN_MIN, ENTRANCE_W_M, PODIUM_FROM_M, PODIUM_MAX_M, PODIUM_MIN_M,
  STEP_COUNT, STEP_RISE_M, TERRACE_BURY_M, TERRACE_OUT_M, TERRACE_RISE_M,
  basePlan, baseMesh, cladHeight, entranceOf, perimeterOf, podiumHeight, pushRing, ringOf, spreadRing}
  from '../../../../digital_twin/visualization/web/vertiport_base.js';
import {facadeWall, roundedOutline, cornerRadius, rotatePoints} from '../../../../digital_twin/visualization/web/vertiport_shell.js';

// A vertiport-sized footprint: the rounded rectangle the layer actually draws.
const corners = [[-71, -51.2], [71, -51.2], [71, 51.2], [-71, 51.2]];
const outlineAt = (heading = 0) => rotatePoints(roundedOutline(corners, cornerRadius(142, 102.4)), heading);

// Every triangle of a closed mesh must wind anticlockwise seen from outside —
// its geometric normal along its stored vertex normals — or the appearance
// that culls back faces drops the face that should be visible.
function backwards(group) {
  const p = group.positions, n = group.normals, at = i => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
  let bad = 0;
  for (let i = 0; i < group.indices.length; i += 3) {
    const [a, b, c] = [group.indices[i], group.indices[i + 1], group.indices[i + 2]].map(at);
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const face = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    const stored = [group.indices[i], group.indices[i + 1], group.indices[i + 2]]
      .reduce((sum, k) => [sum[0] + n[k * 3], sum[1] + n[k * 3 + 1], sum[2] + n[k * 3 + 2]], [0, 0, 0]);
    if (face[0] * stored[0] + face[1] * stored[1] + face[2] * stored[2] <= 0) bad++;
  }
  return bad;
}
const heights = group => {
  const zs = [];
  for (let i = 2; i < group.positions.length; i += 3) zs.push(group.positions[i]);
  return {low: Math.min(...zs), high: Math.max(...zs)};
};
const groupOf = (mesh, name) => mesh.groups.find(group => group.name === name);

test('a base storey belongs to a building tall enough to hold one, and the wall above is painted for what is left', () => {
  assert.equal(podiumHeight(6), 0, 'a six metre deck edge keeps its plain clad wall');
  assert.equal(podiumHeight(PODIUM_FROM_M - 0.01), 0);
  assert.equal(podiumHeight(10), PODIUM_MIN_M, 'never lower than a public ground floor');
  assert.equal(podiumHeight(20), 5.5);
  assert.equal(podiumHeight(30), 8.5);
  assert.equal(podiumHeight(35), PODIUM_MAX_M, 'and never so tall it swallows the tower');
  for (const height of [10, 12, 15, 20, 30, 35]) {
    assert.equal(podiumHeight(height) * 2 % 1, 0, 'half-metre steps, as the cladding cache is keyed');
    assert.equal(cladHeight(height), height - podiumHeight(height), 'the wall above the base is the rest of the building');
  }
  assert.equal(cladHeight(1), facadeWall(1), 'a building with no base keeps the buried skirt the cladding carried');
  assert.equal(cladHeight(6), facadeWall(6));
  assert.equal(podiumHeight(null), 0);
  assert.equal(podiumHeight('tall'), 0);
});

test('the plan spreads a colonnade round the footprint and is refused to anything too small to carry one', () => {
  const ring = outlineAt();
  const plan = basePlan(30, ring);
  assert.equal(plan.podium_m, 8.5);
  assert.equal(plan.soffit_m, 8.5 - CANOPY_M, 'the colonnade stops under the canopy');
  assert.equal(plan.terrace_m, TERRACE_RISE_M);
  assert.ok(plan.columns >= COLUMN_MIN && plan.columns <= COLUMN_MAX);
  assert.ok(Math.abs(plan.pitch_m * plan.columns - plan.perimeter_m) < 0.01, 'the last bay is the same as the first');
  assert.ok(plan.pitch_m > 6 && plan.pitch_m < 12, `a colonnade pitch, not a fence: ${plan.pitch_m}`);
  assert.ok(plan.column_out_m > plan.radius_m, 'the column stands clear of the glass behind it');
  assert.equal(basePlan(6, ring), null, 'too short for a base');
  assert.equal(basePlan(30, [[0, 0], [8, 0], [8, 8], [0, 8]]), null, 'too small to stand a terrace round');
  assert.equal(basePlan(30, []), null);
  assert.equal(basePlan(30, null), null);
});

test('the ring is pushed out on its own edges, so a terrace keeps its width all the way round', () => {
  const ring = ringOf(outlineAt());
  const out = pushRing(ring, TERRACE_OUT_M);
  assert.equal(out.length, ring.length);
  // Every point of the pushed ring is exactly the offset away from the wall it
  // came from, along that wall's normal — the test a radial push fails.
  for (let index = 0; index < ring.length; index++) {
    const next = (index + 1) % ring.length;
    const dx = ring[next][0] - ring[index][0], dy = ring[next][1] - ring[index][1], length = Math.hypot(dx, dy);
    if (length < 0.05) continue;
    const normal = [dy / length, -dx / length];
    for (const point of [out[index], out[next]]) {
      const reach = (point[0] - ring[index][0]) * normal[0] + (point[1] - ring[index][1]) * normal[1];
      assert.ok(Math.abs(reach - TERRACE_OUT_M) < 2e-3, `edge ${index} pushed ${reach}`);
    }
  }
  assert.ok(perimeterOf(out) > perimeterOf(ring));
  // Whichever way the layout wound its outline, the ring walks anticlockwise.
  const clockwise = [...ring].reverse();
  assert.deepEqual(ringOf(clockwise), ring, 'a clockwise outline is turned round');
  assert.ok(pushRing(clockwise, 2).every((point, index) => Math.abs(point[0] - pushRing(ring, 2)[index][0]) < 1e-9),
    'and pushes the same way, outward');
});

test('the columns are spread evenly round the ring, each with the wall it stands against', () => {
  const ring = ringOf(outlineAt());
  const places = spreadRing(ring, 24);
  assert.equal(places.length, 24);
  const perimeter = perimeterOf(ring);
  for (const {point, normal} of places) {
    assert.ok(Math.abs(Math.hypot(normal[0], normal[1]) - 1) < 1e-9, 'a unit outward normal');
    // Outward: a step along it leaves the footprint by growing the distance
    // from the middle of the building.
    const moved = Math.hypot(point[0] + normal[0], point[1] + normal[1]);
    assert.ok(moved > Math.hypot(point[0], point[1]) - 1e-9);
  }
  // Even spacing: consecutive columns are one pitch apart along the wall.
  const gaps = places.map((place, index) => {
    const next = places[(index + 1) % places.length].point;
    return Math.hypot(next[0] - place.point[0], next[1] - place.point[1]);
  });
  const pitch = perimeter / 24;
  assert.ok(gaps.slice(0, -1).every(gap => Math.abs(gap - pitch) < pitch * 0.25), `gaps ${gaps.slice(0, 3)}`);
});

test('the way in is the middle of the design frame front, and it follows the heading round the building', () => {
  const entrance = entranceOf(outlineAt(), 0);
  assert.ok(Math.abs(entrance.centre[0]) < 1e-6, 'centred on the front');
  assert.ok(Math.abs(entrance.centre[1] + 51.2) < 2e-3, 'on the front itself, not a few centimetres inside it');
  assert.deepEqual(entrance.out.map(v => Math.round(v)), [0, -1], 'facing out of it');
  const turned = entranceOf(outlineAt(90), 90);
  assert.ok(Math.abs(turned.centre[0] + 51.2) < 2e-3, 'a building turned a quarter turn has its doors on the west');
  assert.ok(Math.abs(turned.centre[1]) < 2e-3);
  assert.ok(Math.abs(turned.out[0] + 1) < 1e-9);
  assert.equal(entranceOf([], 0), null);
});

test('the base is built as colour groups whose every face is wound outward', () => {
  const ring = outlineAt();
  const plan = basePlan(30, ring);
  const mesh = baseMesh(ring, plan);
  const names = mesh.groups.map(group => group.name);
  for (const name of ['terrace', 'terraceEdge', 'step', 'cheek', 'column', 'trim', 'glass', 'canopy', 'soffit', 'cove', 'door']) {
    assert.ok(names.includes(name), `the base carries its ${name}`);
    assert.ok(BASE[name], `${name} has a colour`);
  }
  for (const group of mesh.groups) {
    assert.equal(backwards(group), 0, `${group.name} winds outward`);
    assert.equal(group.positions.length % 3, 0);
    assert.equal(group.normals.length, group.positions.length);
    assert.ok(group.indices.every(index => index < group.positions.length / 3), `${group.name} indexes its own vertices`);
    assert.ok(group.positions.length / 3 < 65536, 'within one 16-bit index buffer');
  }
  // Cheap enough to stand on every deck: the whole base is a fraction of one
  // aircraft, and it is one primitive per vertiport.
  assert.ok(mesh.triangles > 600 && mesh.triangles < 4000, `triangles ${mesh.triangles}`);
  assert.equal(baseMesh(ring, null), null);
});

test('the parts of the base stand where a building has them', () => {
  const ring = ringOf(outlineAt());
  const plan = basePlan(30, ring);
  const mesh = baseMesh(ring, plan);
  const terrace = heights(groupOf(mesh, 'terrace')), column = heights(groupOf(mesh, 'column'));
  const glass = heights(groupOf(mesh, 'glass')), canopy = heights(groupOf(mesh, 'canopy'));
  const cove = heights(groupOf(mesh, 'cove')), step = heights(groupOf(mesh, 'step'));
  assert.equal(heights(groupOf(mesh, 'terraceEdge')).low, -TERRACE_BURY_M, 'the terrace is buried, so a slope meets stone');
  assert.equal(terrace.high, TERRACE_RISE_M);
  assert.equal(column.low, TERRACE_RISE_M, 'the columns stand on the terrace');
  assert.ok(Math.abs(column.high - plan.soffit_m) < 1e-9, 'and carry the canopy');
  assert.equal(glass.low, TERRACE_RISE_M);
  assert.ok(Math.abs(glass.high - plan.soffit_m) < 1e-9, 'the lobby fills the storey behind them');
  assert.ok(Math.abs(canopy.high - plan.podium_m) < 1e-9, 'the canopy finishes the base, and the clad wall starts there');
  assert.ok(cove.high <= plan.soffit_m + 0.17, 'the light line sits under the canopy edge');
  assert.equal(step.low, -TERRACE_BURY_M);
  assert.ok(Math.abs(step.high - (TERRACE_RISE_M - STEP_RISE_M)) < 1e-9, 'the top step is one riser below the terrace');
  assert.ok(heights(groupOf(mesh, 'cheek')).high > TERRACE_RISE_M, 'a parapet either side of the flight');
  assert.equal(Math.round(TERRACE_RISE_M / STEP_RISE_M), STEP_COUNT, 'the flight climbs exactly the terrace');
  // Reach: the terrace is the widest thing, the canopy overhangs the colonnade.
  const reach = (name, ...rest) => {
    const group = groupOf(mesh, name);
    let far = 0;
    for (let i = 0; i < group.positions.length; i += 3) far = Math.max(far, Math.abs(group.positions[i + 1]));
    return far;
  };
  assert.ok(Math.abs(reach('terrace') - (51.2 + TERRACE_OUT_M)) < 0.35, 'the terrace stands out round the building');
  assert.ok(Math.abs(reach('canopy') - (51.2 + CANOPY_OUT_M)) < ENTRANCE_W_M, 'the canopy overhangs the colonnade');
  assert.ok(reach('glass') <= 51.2 + 0.1, 'the lobby is the wall face itself');
});

test('a building with no base builds nothing, and a turned one builds the same base turned', () => {
  assert.equal(basePlan(6, outlineAt()), null);
  const straight = baseMesh(outlineAt(0), basePlan(20, outlineAt(0)), {headingDeg: 0});
  const turned = baseMesh(outlineAt(35), basePlan(20, outlineAt(35)), {headingDeg: 35});
  assert.equal(straight.triangles, turned.triangles, 'the same building, wherever it points');
  assert.equal(straight.columns, turned.columns);
  // Back from the display frame into the design frame it was laid out in.
  const [[x, y]] = rotatePoints([turned.entrance.centre], -35);
  assert.ok(Math.abs(x - straight.entrance.centre[0]) < 0.01 && Math.abs(y - straight.entrance.centre[1]) < 0.01,
    'and its doors are in the same place on it');
});
