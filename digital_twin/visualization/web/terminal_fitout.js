// What is in the terminal, drawn: the way in, screening, lounges, shops, board.
//
// The plan is the server's (`layout.terminal.plan`, from
// `digital_twin/model_library/terminal_plan.py`) and arrives as explicit corner
// rings in local metres. Nothing here decides where anything is; this turns a
// plan into something you can see and walk around, and the very same rings are
// what `walkWorld()` hands the walk camera as solid. One plan, drawn once and
// blocked once, cannot drift from itself.
//
// Entities rather than a mesh, for the same reason as the shell: it is built
// when somebody is at this deck and never touched again, and a plain colour
// reuses shader programs the layer has already linked.

const PALETTE = {
  hall: '#44565f', hallEdge: '#9fd8e6',
  core: '#6b8592', coreCap: '#8fa9b6',
  barrier: '#5d6f79', lane: '#2e4552', laneCap: '#7fe9f5',
  bench: '#3f5d6b', benchCap: '#7ea3b3',
  unit: '#33454e', fascia: '#e8b552', glass: '#bfe6f0',
  board: '#0b1418', boardEdge: '#7fe9f5',
  sign: '#cfe6ef', signBack: '#0e1a21',
};
const KIND_LABEL = {mart: '마트', shop: '상점', cafe: '카페', restaurant: '식당', toilet: '화장실'};
const KIND_FASCIA = {mart: '#7fd6a0', shop: '#e8b552', cafe: '#e89a6b', restaurant: '#e8746b', toilet: '#8fb6e8'};
// Heights. The storey is 3.4 m clear, so a shop stops short of the slab and
// its sign sits in the gap -- which is the gap a terminal actually uses.
const UNIT_H = 2.9, FASCIA_H = 0.42, BENCH_H = 0.46, BARRIER_H = 1.15, LANE_H = 1.05;
const CORE_H = 2.6, BOARD_BOTTOM = 0.55, SIGN_H = 2.3;
const FAR_METRES = 3000;

/** The edge of a ring whose outward normal best matches `facing`. */
export function frontEdge(ring, facing) {
  if (!Array.isArray(ring) || ring.length < 3 || !Array.isArray(facing)) return null;
  const middle = ring.reduce((sum, [x, y]) => [sum[0] + x / ring.length, sum[1] + y / ring.length], [0, 0]);
  let best = null;
  for (let index = 0; index < ring.length; index++) {
    const here = ring[index], next = ring[(index + 1) % ring.length];
    const mid = [(here[0] + next[0]) / 2, (here[1] + next[1]) / 2];
    const out = [mid[0] - middle[0], mid[1] - middle[1]];
    const length = Math.hypot(out[0], out[1]) || 1;
    const agrees = (out[0] * facing[0] + out[1] * facing[1]) / length;
    if (!best || agrees > best.agrees) best = {agrees, index, from: here, to: next};
  }
  return best;
}

/** Every part of the fit-out of one placed vertiport, as entity descriptions. */
export function terminalFitout(C, {id, layout, floor, ceiling}) {
  const plan = layout?.terminal?.plan;
  if (!C || !plan || !Number.isFinite(floor)) return [];
  const frame = layout.frame, prefix = `vertiport:${id}:terminal:`;
  const at = (points, height) => points.map(([east, north]) => C.Matrix4.multiplyByPoint(
    C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromDegrees(frame.longitude, frame.latitude, height)),
    new C.Cartesian3(east, north, 0), new C.Cartesian3()));
  const paint = (css, alpha = 1) => C.Color.fromCssColorString(css).withAlpha(alpha);
  const near = new C.DistanceDisplayCondition(0, FAR_METRES);
  const parts = [];
  const put = (name, part) => parts.push({...part, id: `${prefix}${name}`});

  const wall = (points, bottom, top, css, alpha = 1, edge = null) => {
    // A ring is closed back to its first corner; a run of two points is a
    // single panel and closing it would draw the same quad twice, back to back.
    const loop = points.length > 2
      && !(points[0][0] === points.at(-1)[0] && points[0][1] === points.at(-1)[1]);
    const closed = loop ? [...points, points[0]] : points;
    const positions = at(closed, bottom);
    return {wall: {positions, minimumHeights: closed.map(() => bottom), maximumHeights: closed.map(() => top),
      material: paint(css, alpha), shadows: C.ShadowMode?.DISABLED,
      ...(edge ? {outline: true, outlineColor: paint(edge, 0.85), outlineWidth: 1} : {}),
      distanceDisplayCondition: near}};
  };
  const cap = (points, height, css, alpha = 1) => ({polygon: {
    hierarchy: new C.PolygonHierarchy(at(points, height)), perPositionHeight: true,
    material: paint(css, alpha), shadows: C.ShadowMode?.DISABLED, distanceDisplayCondition: near}});
  // Unlit, like the ceiling lines: a sign that takes the sun is a sign nobody
  // can read at four in the morning, which is when this floor is busiest.
  const sign = (point, height, text, size = 13) => ({position: at([point], height)[0],
    label: {text, font: `bold ${size}px sans-serif`, fillColor: paint(PALETTE.sign),
      showBackground: true, backgroundColor: paint(PALETTE.signBack, 0.78),
      distanceDisplayCondition: near}});

  // The way in: the hall you arrive in from the street lobby, its lift core,
  // and the screening you clear to reach everything else.
  const entry = plan.entry;
  if (entry?.outline_m) {
    put('hall', cap(entry.outline_m, floor + 0.02, PALETTE.hall));
    put('hall:edge', wall(entry.outline_m, floor + 0.02, floor + 0.06, PALETTE.hallEdge, 0.9));
    if (entry.core_outline_m) {
      put('hall:core', wall(entry.core_outline_m, floor, floor + CORE_H, PALETTE.core, 1, PALETTE.coreCap));
      put('hall:core:cap', cap(entry.core_outline_m, floor + CORE_H, PALETTE.coreCap));
      put('hall:sign', sign(entry.core_m ?? entry.center_m, floor + SIGN_H, '↓ 1층 · 출입구', 13));
    }
  }
  for (const [index, run] of (plan.security?.runs_m ?? []).entries()) {
    put(`screen:wall:${index}`, wall(run, floor, floor + BARRIER_H, PALETTE.barrier, 1, PALETTE.coreCap));
  }
  for (const lane of plan.security?.lanes ?? []) {
    put(`screen:${lane.id}`, wall(lane.outline_m, floor, floor + LANE_H, PALETTE.lane, 1, PALETTE.laneCap));
    put(`screen:${lane.id}:cap`, cap(lane.outline_m, floor + LANE_H, PALETTE.laneCap, 0.85));
  }
  if (plan.security?.lanes?.length) {
    const middle = plan.security.lanes[Math.floor(plan.security.lanes.length / 2)];
    put('screen:sign', sign(middle.center_m, floor + SIGN_H, '보안 검색', 14));
  }

  // The gate lounges. Benches rather than a carpet: what says "wait here" is
  // somewhere to sit, and the rows already face the stair they belong to.
  for (const lounge of plan.lounges ?? []) {
    for (const [index, row] of (lounge.rows ?? []).entries()) {
      put(`lounge:${lounge.id}:${index}`, wall(row.outline_m, floor, floor + BENCH_H, PALETTE.bench));
      put(`lounge:${lounge.id}:${index}:cap`, cap(row.outline_m, floor + BENCH_H, PALETTE.benchCap));
    }
    put(`lounge:${lounge.id}:sign`, sign(lounge.center_m, floor + SIGN_H, `${lounge.gate} 탑승 대기`, 14));
  }

  // The concourse benches. No sign: a bench in the middle of a floor is a
  // bench, and a label on every one of them is a floor made of labels.
  for (const bench of plan.rest ?? []) {
    for (const [index, row] of (bench.rows ?? []).entries()) {
      put(`rest:${bench.id}:${index}`, wall(row.outline_m, floor, floor + BENCH_H, PALETTE.bench));
      put(`rest:${bench.id}:${index}:cap`, cap(row.outline_m, floor + BENCH_H, PALETTE.benchCap));
    }
  }

  // The concourse. Three walls and a shopfront: a shop drawn as a closed box
  // is a box, and the one face that makes it a shop is the one you walk up to.
  for (const unit of plan.units ?? []) {
    const ring = unit.outline_m, front = frontEdge(ring, unit.facing_m);
    const back = front ? ring.map((point, index) => [point, ring[(index + 1) % ring.length], index])
      .filter(([, , index]) => index !== front.index) : [];
    if (front) {
      for (const [from, to, index] of back) {
        put(`unit:${unit.id}:${index}`, wall([from, to], floor, floor + UNIT_H, PALETTE.unit));
      }
      put(`unit:${unit.id}:front`, wall([front.from, front.to], floor, floor + UNIT_H, PALETTE.glass, 0.26,
        PALETTE.glass));
    } else {
      put(`unit:${unit.id}`, wall(ring, floor, floor + UNIT_H, PALETTE.unit));
    }
    // The fascia carries the trade, so a concourse reads as shops rather than
    // as a row of identical cabinets.
    const band = front ? [front.from, front.to] : ring;
    put(`unit:${unit.id}:fascia`, wall(band, floor + UNIT_H, floor + UNIT_H + FASCIA_H,
      KIND_FASCIA[unit.kind] ?? PALETTE.fascia, 0.95));
    const where = front ? [(front.from[0] + front.to[0]) / 2, (front.from[1] + front.to[1]) / 2] : unit.center_m;
    put(`unit:${unit.id}:sign`, sign(where, floor + UNIT_H + FASCIA_H / 2,
      unit.name ?? KIND_LABEL[unit.kind] ?? unit.kind, 13));
  }

  // The board. The face is a single flat panel rather than the whole case,
  // because a wall of one segment is one quad and a picture maps across it
  // once -- the schedule is painted onto it, and a picture wrapped round four
  // sides of a box is a schedule written down the edges.
  const board = plan.board;
  if (board?.outline_m) {
    const top = Math.min(ceiling ?? floor + 3.4, floor + BOARD_BOTTOM + (board.size_m?.[1] ?? 2.6)) - 0.08;
    put('board:case', wall(board.outline_m, floor + BOARD_BOTTOM, top, PALETTE.board, 1, PALETTE.boardEdge));
    const face = frontEdge(board.outline_m, board.facing_m);
    if (face) {
      // A hair proud of the case, or the two fight for the same pixels.
      const out = board.facing_m, lift = 0.03;
      const panel = [[face.from[0] + out[0] * lift, face.from[1] + out[1] * lift],
        [face.to[0] + out[0] * lift, face.to[1] + out[1] * lift]];
      put('board:face', wall(panel, floor + BOARD_BOTTOM, top, PALETTE.board, 1, null));
    }
    put('board:sign', sign(board.center_m, top + 0.3, '운항 시간표', 15));
  }
  return parts;
}
