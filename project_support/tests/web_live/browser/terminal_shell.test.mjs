import test from 'node:test';
import assert from 'node:assert/strict';
import {TerminalShells, clipToRing, lampRuns, terminalLevels, terminalShell} from '../../../../digital_twin/visualization/web/terminal_shell.js';

// The storey under the deck, drawn. It is the same plan `walkWorld()` makes
// walkable, so the floor you stand on and the floor you see have to be the one
// height -- the failure this guards against is a shell that looks right from
// the stairs and leaves a walker at ankle height or inside the ceiling.

// A translation-only east-north-up frame keeps the numbers readable: a returned
// position carries its own height in z.
class Cartesian3 {
  constructor(x = 0, y = 0, z = 0) {Object.assign(this, {x, y, z});}
  static fromDegrees(lon, lat, h = 0) {return new Cartesian3(lon * 1000, lat * 1000, h);}
}
const C = {Cartesian3,
  Transforms: {eastNorthUpToFixedFrame: origin => ({origin})},
  Matrix4: {multiplyByPoint: (frame, point, result) =>
    Object.assign(result, {x: frame.origin.x + point.x, y: frame.origin.y + point.y, z: frame.origin.z})},
  PolygonHierarchy: class {constructor(positions) {this.positions = positions;}},
  Color: {fromCssColorString: css => ({css, withAlpha(alpha) {return {css, alpha};}})},
  DistanceDisplayCondition: class {constructor(near, far) {Object.assign(this, {near, far});}},
  ShadowMode: {DISABLED: 'off'}};

// The shape `vertiport_layout._terminal` emits, from a real 여의도 layout.
const TERMINAL = {
  floor_drop_m: 4.6, storey_m: 4.6, clear_height_m: 3.4, ground_clearance_m: 15.4, inset_m: 3,
  outline_m: [[-41.339, -23.674], [19.529, -43.452], [41.339, 23.674], [-19.529, 43.452]],
  cores: [
    {id: 'T1', boarding: 'B1', gate: 'G1', charger: 'C1', center_m: [-24.682, -25.091],
      size_m: [3.6, 2.6], deck_height_m: 2.8, landing_m: [-22.003, -22.367], deck_exit_m: [-27.361, -27.815]},
    {id: 'T2', boarding: 'B2', gate: 'G2', charger: 'C2', center_m: [24.682, 25.091],
      size_m: [3.6, 2.6], deck_height_m: 2.8, landing_m: [22.003, 22.367], deck_exit_m: [27.361, 27.815]}],
  note: 'Derived terminal storey beneath the deck; representative, not a surveyed design.'};
const LAYOUT = {frame: {latitude: 37.525, longitude: 126.92, heading_deg: 18}, terminal: TERMINAL};
const DECK_TOP = 84, EAST = 126.92 * 1000, NORTH = 37.525 * 1000;

const heights = part => {
  if (part.polygon) return part.polygon.hierarchy.positions.map(point => point.z);
  if (part.wall) return [...part.wall.minimumHeights, ...part.wall.maximumHeights];
  if (part.polyline) return part.polyline.positions.map(point => point.z);
  return [part.position.z];
};
const shell = (layout = LAYOUT, deckTop = DECK_TOP) => terminalShell(C, {id: 'VP1', layout, deckTop});
const part = (name, parts = shell()) => parts.find(item => item.id === 'vertiport:VP1:terminal:' + name);
const near = (actual, expected, why) => assert.ok(Math.abs(actual - expected) < 1e-6,
  why + ': ' + actual + ' vs ' + expected);

test('the floor is a storey below the deck and the ceiling is its underside', () => {
  const levels = terminalLevels(LAYOUT, DECK_TOP);
  assert.equal(levels.floor, DECK_TOP - 4.6);
  assert.equal(levels.ceiling, DECK_TOP - 4.6 + 3.4);
  // The slab between that ceiling and the deck above is what is left of the
  // storey; a ceiling drawn at the deck top would swallow it.
  assert.ok(levels.ceiling < DECK_TOP);
});

test('a deck with no storey under it, or none placed yet, is drawn as nothing', () => {
  assert.equal(terminalLevels({frame: {}}, DECK_TOP), null);
  assert.equal(terminalLevels(LAYOUT, null), null);
  assert.deepEqual(shell({frame: {}}), []);
  // A deck whose ground height has not come back yet: the terminal is drawn
  // when there is a height to hang it under, never at a guessed one.
  assert.deepEqual(shell(LAYOUT, null), []);
});

test('nothing in the shell is above the deck or below its own floor', () => {
  const {floor} = terminalLevels(LAYOUT, DECK_TOP);
  const parts = shell();
  assert.ok(parts.length >= 4 + TERMINAL.cores.length * 2);
  for (const item of parts) for (const height of heights(item)) {
    assert.ok(height >= floor - 1e-9 && height <= DECK_TOP,
      item.id + ' 이 ' + height + ' 에 있다 (바닥 ' + floor + ', 데크 ' + DECK_TOP + ')');
  }
});

test('the floor is a slab at its own height, not something draped on the ground', () => {
  const {floor} = terminalLevels(LAYOUT, DECK_TOP);
  const slab = part('floor');
  assert.equal(slab.polygon.perPositionHeight, true);
  assert.deepEqual(slab.polygon.hierarchy.positions.map(point => point.z), TERMINAL.outline_m.map(() => floor));
  // The plan is the layout's, corner for corner. This is the polygon a person
  // is allowed to stand on, so a second outline here would be a second floor.
  slab.polygon.hierarchy.positions.forEach((point, index) => {
    near(point.x - EAST, TERMINAL.outline_m[index][0], '바닥 동쪽');
    near(point.y - NORTH, TERMINAL.outline_m[index][1], '바닥 북쪽');
  });
});

test('the perimeter is closed, so there is no gap to walk out of the building through', () => {
  const glass = part('glass');
  assert.ok(glass, '유리 외벽');
  assert.equal(glass.wall.positions.length, TERMINAL.outline_m.length + 1);
  const first = glass.wall.positions[0], last = glass.wall.positions.at(-1);
  assert.deepEqual([last.x, last.y], [first.x, first.y]);
});

test('a stair head stops below the ceiling rather than reading as a column of nothing', () => {
  const {floor, ceiling} = terminalLevels(LAYOUT, DECK_TOP);
  const parts = shell(), shafts = TERMINAL.cores.map(core => part('core:' + core.id, parts));
  assert.ok(shafts.every(Boolean), '계단실마다 하나씩');
  for (const shaft of shafts) {
    assert.ok(Math.max(...shaft.wall.maximumHeights) < ceiling);
    assert.deepEqual([...new Set(shaft.wall.minimumHeights)], [floor]);
  }
});

test('each way up is named for the gate it belongs to, at the landing you arrive on', () => {
  const {floor} = terminalLevels(LAYOUT, DECK_TOP);
  const parts = shell(), labels = TERMINAL.cores.map(core => part('sign:' + core.id, parts));
  assert.deepEqual(labels.map(item => item.label.text), ['G1 ↑', 'G2 ↑']);
  // At the landing, not at the shaft: the sign has to be where somebody who has
  // just walked out of the stair is standing.
  labels.forEach((item, index) => {
    near(item.position.x - EAST, TERMINAL.cores[index].landing_m[0], '표지 동쪽');
    near(item.position.y - NORTH, TERMINAL.cores[index].landing_m[1], '표지 북쪽');
  });
  assert.ok(labels.every(item => item.position.z > floor));
});

test('every part carries its own id under the deck it belongs to', () => {
  const ids = shell().map(item => item.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every(id => id.startsWith('vertiport:VP1:terminal:')));
  // Named, not numbered: a part that changes place in the list is still the
  // same part, and the fittings to come have to be able to ask for one.
  assert.deepEqual(ids.slice(0, 4).map(id => id.split(':').at(-1)),
    ['floor', 'ceiling', 'glass', 'cove']);
});

test('the ceiling is lit, because a slab facing down is shaded black whatever colour it is', () => {
  // A polygon overhead takes the sun like any other surface and comes out
  // near-black under a deck. Polylines are drawn unlit, so the lighting is the
  // lines rather than a paler paint that would change nothing.
  const {ceiling} = terminalLevels(LAYOUT, DECK_TOP);
  const parts = shell();
  const lamps = parts.filter(item => item.id.includes(':lamp:'));
  assert.ok(lamps.length >= 4, '천장등 ' + lamps.length + '줄');
  assert.ok(lamps.every(item => item.polyline), '선이어야 조명으로 읽힌다');
  for (const lamp of lamps) {
    assert.deepEqual([...new Set(lamp.polyline.positions.map(point => point.z))], [ceiling - 0.25]);
    // Straight through the building, not along a great circle, or the light
    // and the floor under it are different lines.
    assert.equal(lamp.polyline.arcType, undefined, '스텁에 ArcType 이 없으면 undefined');
  }
  const cove = part('cove', parts);
  assert.equal(cove.polyline.positions.length, TERMINAL.outline_m.length + 1, '둘레를 한 바퀴');
});

test('a run of light stops at the wall, not at a box drawn round the room', () => {
  // The floor is the deck's outline set in: convex, but not square to anything.
  // A run laid across a turned diamond has to end on the glass.
  const diamond = [[0, -30], [40, 0], [0, 30], [-40, 0]];
  for (const run of lampRuns(diamond, 6, 2)) {
    for (const [x, y] of run) {
      assert.ok(Math.abs(x) / 40 + Math.abs(y) / 30 <= 1 + 1e-9,
        '[' + x.toFixed(1) + ', ' + y.toFixed(1) + '] 이 바닥 밖');
    }
  }
  // And a line that misses the room altogether is no line, not a zero-length one.
  assert.equal(clipToRing(diamond, [-200, 200], [200, 200]), null);
  assert.deepEqual(clipToRing(diamond, [-200, 0], [200, 0]), [[-40, 0], [40, 0]]);
});

test('the runs follow the building rather than north', () => {
  // Square to the world, a turned room gets lines cutting across it. Along its
  // own longest wall they read as a ceiling.
  const turn = 18 * Math.PI / 180;
  const spin = ([x, y]) => [x * Math.cos(turn) - y * Math.sin(turn), x * Math.sin(turn) + y * Math.cos(turn)];
  const room = [[-50, -20], [50, -20], [50, 20], [-50, 20]].map(spin);
  const runs = lampRuns(room, 8, 2);
  assert.ok(runs.length >= 3);
  // Parallel to the longest wall, taken from the room rather than written down,
  // so the claim is the one the code makes and not a number that happens to match.
  const wall = [room[1][0] - room[0][0], room[1][1] - room[0][1]];
  for (const [from, to] of runs) {
    const run = [to[0] - from[0], to[1] - from[1]];
    const cross = run[0] * wall[1] - run[1] * wall[0];
    assert.ok(Math.abs(cross) < 1e-6, '긴 벽과 평행하지 않다: ' + cross.toFixed(4));
  }
});

// ---------------------------------------------------------------------------

function collection() {
  const items = new Set();
  return {items, add: part => {const entity = {...part, show: true}; items.add(entity); return entity;},
    remove: entity => items.delete(entity)};
}

test('an interior stands up once, comes down whole, and leaves nothing behind', () => {
  const entities = collection(), shells = new TerminalShells(C, entities);
  assert.equal(shells.set('VP1', true, {layout: LAYOUT, deckTop: DECK_TOP}), true);
  const standing = entities.items.size;
  assert.ok(standing > 0);
  // Asking twice is what a caller does on every frame it is unsure.
  assert.equal(shells.set('VP1', true, {layout: LAYOUT, deckTop: DECK_TOP}), true);
  assert.equal(entities.items.size, standing, '두 번 세우지 않는다');
  assert.equal(shells.has('VP1'), true);
  assert.equal(shells.set('VP1', false), false);
  assert.equal(entities.items.size, 0, '치우면 하나도 남지 않는다');
  assert.equal(shells.has('VP1'), false);
  assert.equal(shells.clear('VP1'), false, '없는 것을 치웠다고 하지 않는다');
});

test('a deck with no storey under it is refused rather than half-built', () => {
  const entities = collection(), shells = new TerminalShells(C, entities);
  assert.equal(shells.set('VP2', true, {layout: {frame: {}}, deckTop: DECK_TOP}), false);
  assert.equal(shells.set('VP3', true, {layout: LAYOUT, deckTop: null}), false);
  assert.equal(entities.items.size, 0);
});

test('hiding the layer hides the interior with it, and a later one is born hidden', () => {
  const entities = collection(), shells = new TerminalShells(C, entities);
  shells.set('VP1', true, {layout: LAYOUT, deckTop: DECK_TOP});
  shells.setVisible(false);
  assert.ok([...entities.items].every(entity => entity.show === false));
  shells.set('VP2', true, {layout: LAYOUT, deckTop: 60});
  assert.ok([...entities.items].every(entity => entity.show === false), '숨긴 뒤에 세운 것도 숨어 있다');
  shells.setVisible(true);
  assert.ok([...entities.items].every(entity => entity.show === true));
  shells.destroy();
  assert.equal(entities.items.size, 0);
});
