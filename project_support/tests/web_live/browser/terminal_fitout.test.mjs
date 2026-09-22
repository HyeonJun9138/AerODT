import test from 'node:test';
import assert from 'node:assert/strict';
import {frontEdge, terminalFitout} from '../../../../digital_twin/visualization/web/terminal_fitout.js';

// The fit-out of the terminal floor, drawn. The plan is the server's and
// arrives as corner rings; nothing here decides where anything is. What can go
// wrong is the drawing disagreeing with the plan -- a shop with no front, a
// sign in the wrong place, something standing through the ceiling -- and the
// rings being drawn are the very same ones the walk camera refuses to cross,
// so a shopfront that ends up on the wrong side is a shop you walk into.

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

const rect = (cx, cy, w, d) => [[cx - w / 2, cy - d / 2], [cx + w / 2, cy - d / 2],
  [cx + w / 2, cy + d / 2], [cx - w / 2, cy + d / 2]];
const bench = (cx, cy) => ({outline_m: rect(cx, cy, 3.3, 0.6),
  seats_m: [[cx - 1, cy], [cx, cy], [cx + 1, cy]], facing_m: [0, 1]});

// The shape `terminal_plan.plan()` emits.
const PLAN = {
  entry: {center_m: [0, -40], size_m: [34, 20], outline_m: rect(0, -40, 34, 20),
    core_m: [0, -46.6], core_outline_m: rect(0, -46.6, 6, 6), facing_m: [0, 1]},
  security: {lanes: [{id: 'S1', center_m: [-1.7, -33.8], outline_m: rect(-1.7, -33.8, 1.7, 6.5)},
      {id: 'S2', center_m: [1.7, -33.8], outline_m: rect(1.7, -33.8, 1.7, 6.5)}],
    runs_m: [[[-17, -33.8], [-2.55, -33.8]], [[-0.85, -33.8], [0.85, -33.8]], [[2.55, -33.8], [17, -33.8]]],
    line_m: [[-17, -33.8], [17, -33.8]]},
  lounges: [{id: 'L1', gate: 'G1', core: 'T1', center_m: [-20, 0], outline_m: rect(-20, 0, 3.3, 2.9),
      rows: [bench(-20, -1.15), bench(-20, 1.15)], seats: 10},
    {id: 'L2', gate: 'G2', core: 'T2', center_m: [20, 0], outline_m: rect(20, 0, 3.3, 2.9),
      rows: [bench(20, -1.15), bench(20, 1.15)], seats: 10}],
  rest: [{id: 'R1', center_m: [0, 10], outline_m: rect(0, 10, 3.3, 1.3),
    rows: [bench(0, 9.7), bench(0, 10.3)], seats: 10}],
  units: [{id: 'U1', kind: 'mart', name: '마트 1', center_m: [-40, 20], size_m: [14.4, 10],
      outline_m: rect(-40, 20, 14.4, 10), facing_m: [1, 0]},
    {id: 'U2', kind: 'restaurant', name: '식당 2', center_m: [40, 20], size_m: [14.4, 10],
      outline_m: rect(40, 20, 14.4, 10), facing_m: [-1, 0]},
    {id: 'U3', kind: 'toilet', name: '화장실 3', center_m: [0, 40], size_m: [9, 10],
      outline_m: rect(0, 40, 9, 10), facing_m: [0, -1]}],
  board: {center_m: [0, -20], size_m: [7.2, 2.6], outline_m: rect(0, -20, 7.2, 0.5), facing_m: [0, -1]},
  blocks_m: [], cores_reserved: 2, note: 'x'};
const LAYOUT = {frame: {latitude: 37.5, longitude: 127, heading_deg: 0},
  terminal: {floor_drop_m: 4.6, clear_height_m: 3.4, outline_m: rect(0, 0, 120, 120), cores: [], plan: PLAN}};
const FLOOR = 75.3, CEILING = FLOOR + 3.4;

const build = (plan = PLAN) => terminalFitout(C, {id: 'VP1',
  layout: {...LAYOUT, terminal: {...LAYOUT.terminal, plan}}, floor: FLOOR, ceiling: CEILING});
const part = (name, parts) => parts.find(item => item.id === 'vertiport:VP1:terminal:' + name);
const heights = item => {
  if (item.polygon) return item.polygon.hierarchy.positions.map(point => point.z);
  if (item.wall) return [...item.wall.minimumHeights, ...item.wall.maximumHeights];
  return [item.position.z];
};

test('the face of a unit is the edge that looks the way the plan says it does', () => {
  const ring = rect(0, 0, 10, 6);
  // rect() runs (-,-) (+,-) (+,+) (-,+), so edge 0 is the south wall.
  assert.equal(frontEdge(ring, [0, -1]).index, 0);
  assert.equal(frontEdge(ring, [1, 0]).index, 1);
  assert.equal(frontEdge(ring, [0, 1]).index, 2);
  assert.equal(frontEdge(ring, [-1, 0]).index, 3);
  assert.equal(frontEdge(ring, null), null);
  assert.equal(frontEdge([[0, 0], [1, 1]], [0, 1]), null);
});

test('a floor with no plan on it draws nothing rather than guessing one', () => {
  assert.deepEqual(terminalFitout(C, {id: 'VP1', layout: {frame: {}}, floor: FLOOR}), []);
  assert.deepEqual(terminalFitout(C, {id: 'VP1', layout: LAYOUT, floor: null}), []);
});

test('everything in the plan is drawn, and named for what it is', () => {
  const parts = build(), ids = parts.map(item => item.id);
  assert.equal(new Set(ids).size, ids.length, '아이디 중복 없음');
  assert.ok(ids.every(id => id.startsWith('vertiport:VP1:terminal:')));
  assert.ok(part('hall', parts) && part('hall:core', parts), '입구 홀과 승강장');
  assert.ok(part('screen:S1', parts) && part('screen:S2', parts), '검색대');
  assert.equal(parts.filter(item => item.id.includes(':screen:wall:')).length, PLAN.security.runs_m.length);
  for (const lounge of PLAN.lounges) {
    assert.ok(part(`lounge:${lounge.id}:0`, parts) && part(`lounge:${lounge.id}:1`, parts));
    assert.equal(part(`lounge:${lounge.id}:sign`, parts).label.text, `${lounge.gate} 탑승 대기`);
  }
  assert.ok(part('rest:R1:0', parts), '콩코스 벤치');
  // The case is the box and the face is the one flat panel the schedule is
  // painted onto; a picture wrapped round four sides is not a schedule.
  assert.ok(part('board:case', parts) && part('board:face', parts), '시간표 자리');
  assert.equal(part('board:face', parts).wall.positions.length, 2, '한 장의 판');
  for (const unit of PLAN.units) {
    assert.equal(part(`unit:${unit.id}:sign`, parts).label.text, unit.name);
  }
});

test('a shop is three walls and a front, not a closed box', () => {
  const parts = build();
  for (const unit of PLAN.units) {
    const front = part(`unit:${unit.id}:front`, parts);
    assert.ok(front, `${unit.id} 정면`);
    // Glazed, so you can see in. A solid fourth wall is a cabinet.
    assert.ok(front.wall.material.alpha < 0.5, '정면은 유리');
    const walls = parts.filter(item => /:unit:U\d+:\d+$/.test(item.id) && item.id.includes(unit.id + ':'));
    assert.equal(walls.length, 3, '나머지 세 면은 벽');
    // The fascia carries the trade and sits above the opening.
    const fascia = part(`unit:${unit.id}:fascia`, parts);
    assert.ok(Math.min(...fascia.wall.minimumHeights) >= Math.max(...front.wall.maximumHeights) - 1e-9);
  }
});

test('the shopfront is on the side the plan says people walk up to', () => {
  const parts = build();
  for (const unit of PLAN.units) {
    const front = part(`unit:${unit.id}:front`, parts).wall.positions;
    const mid = [(front[0].x + front[1].x) / 2 - 127 * 1000, (front[0].y + front[1].y) / 2 - 37.5 * 1000];
    const out = [mid[0] - unit.center_m[0], mid[1] - unit.center_m[1]];
    const length = Math.hypot(out[0], out[1]) || 1;
    assert.ok((out[0] * unit.facing_m[0] + out[1] * unit.facing_m[1]) / length > 0.9,
      `${unit.id} 정면이 반대쪽에 있다`);
  }
});

test('nothing stands through the ceiling or under the floor', () => {
  for (const item of build()) {
    for (const height of heights(item)) {
      assert.ok(height >= FLOOR - 1e-9 && height <= CEILING + 1e-9,
        `${item.id} 이 ${height} 에 있다 (바닥 ${FLOOR}, 천장 ${CEILING})`);
    }
  }
});

test('a plan missing a piece draws the rest of the floor rather than nothing', () => {
  // The placer works by rejection, so a small port legitimately has no board
  // and no benches. The drawing has to survive that.
  const bare = {...PLAN, board: null, rest: [], units: [], lounges: []};
  const parts = build(bare);
  assert.ok(part('hall', parts), '입구는 남는다');
  assert.ok(part('screen:S1', parts));
  assert.equal(parts.filter(item => item.id.includes(':unit:')).length, 0);
  assert.equal(part('board:case', parts), undefined);
  assert.equal(part('board:face', parts), undefined);
});
