// The shape of a route on the map, in numbers only: a corridor between two
// waypoints as a translucent ribbon, the round hub where corridors meet, and
// the arcs of that hub that are not covered by a corridor. Everything is
// worked out in local metres around the first node and answered as
// longitude/latitude/height triples, so the map converts with one call and
// the shapes can be tested without it.
//
// A junction is where the look is decided. Every corridor is cut back to the
// hub circle at each end instead of ending on a straight edge, and the hub is
// a flat disc at the node's height. A corridor edge then meets the circle at
// a tangent, so however many corridors meet, and at whatever angles, the
// junction reads as one rounded shape with no notch and no gap. Where two
// corridors leaving the same node overlap beyond the hub, the overlap is
// split along the bisector of their directions and each keeps its own side,
// so a translucent surface is never drawn twice over the same ground. The
// height between two nodes follows an ease curve that is level at both ends,
// so a corridor leaves a hub flat and arrives flat rather than meeting the
// disc at an angle.

const METRES_PER_DEGREE = 111320;
export const ACROSS_SAMPLES = 10;
export const HUB_SEGMENTS = 48;
const MIN_ALONG_SAMPLES = 6, MAX_ALONG_SAMPLES = 96, ALONG_STEP_M = 120;

export function degreesPerMetre(latitude) {
  const cosLat = Math.cos(latitude * Math.PI / 180) || 1e-9;
  return {east: 1 / (METRES_PER_DEGREE * cosLat), north: 1 / METRES_PER_DEGREE};
}

// Local east/north metres of `to` seen from `from`.
export function localVector(from, to) {
  const scale = degreesPerMetre(from.latitude);
  return {east: (to.longitude - from.longitude) / scale.east, north: (to.latitude - from.latitude) / scale.north};
}

export function distanceMetres(from, to) {const v = localVector(from, to); return Math.hypot(v.east, v.north);}

// Direction of travel from `from` towards `to`, radians counter-clockwise from east.
export function bearing(from, to) {const v = localVector(from, to); return Math.atan2(v.north, v.east);}

// The ease that carries the height between two levels: zero slope at both ends.
export function heightProfile(u) {const t = Math.max(0, Math.min(1, u)); return t * t * (3 - 2 * t);}

function toDegrees(origin, east, north, height) {
  const scale = degreesPerMetre(origin.latitude);
  return [origin.longitude + east * scale.east, origin.latitude + north * scale.north, height];
}

// How far into a corridor a lateral offset `s` is hidden by a hub of radius R:
// the corridor starts where its cross-line leaves the circle.
export function carveDepth(radius, s) {
  const inside = radius * radius - s * s;
  return inside > 0 ? Math.sqrt(inside) : 0;
}

// How far from a node a corridor row at lateral offset `s` (positive to the
// left of the leaving direction) is given up to the neighbouring corridor on
// that side. `neighbour` is {angle, halfWidth}: the angle between the two
// leaving directions (0..π) and the neighbour's half-width. The part of the
// row that lies inside the neighbour and on the neighbour's side of the
// bisector belongs to the neighbour; the row starts after it.
export function yieldDepth(s, neighbour) {
  if (!neighbour || !(s > 0) || !(neighbour.angle > 1e-6) || !(neighbour.angle < Math.PI - 1e-6)) return 0;
  const {angle, halfWidth} = neighbour;
  const bisector = s / Math.tan(angle / 2);                       // where the row crosses the bisector
  const exit = (s * Math.cos(angle) + halfWidth) / Math.sin(angle); // where the row leaves the neighbour
  return Math.max(0, Math.min(bisector, exit));
}

// For each corridor leaving a node, its nearest neighbour on either side:
// `mouths` are {angle (radians, any origin), halfWidth}; the answer is, per
// mouth, {left, right} as {angle (the turn between the two, 0..π), halfWidth}
// or null when nothing lies within a half turn on that side.
export function neighbourClips(mouths) {
  const TAU = 2 * Math.PI;
  return mouths.map(mouth => {
    let left = null, right = null;
    for (const other of mouths) {
      if (other === mouth) continue;
      const ccw = ((other.angle - mouth.angle) % TAU + TAU) % TAU;   // turn to the left
      if (ccw > 1e-9 && ccw < Math.PI && (!left || ccw < left.angle)) left = {angle: ccw, halfWidth: other.halfWidth};
      const cw = TAU - ccw;                                          // turn to the right
      if (cw > 1e-9 && cw < Math.PI && (!right || cw < right.angle)) right = {angle: cw, halfWidth: other.halfWidth};
    }
    return {left, right};
  });
}

// The ribbon of one corridor. `from`/`to` are {longitude, latitude, height}
// with the hub radius each end is cut back to (`hubRadius`), `width` in metres.
// `fromClip`/`toClip` are the neighbours at each end ({left, right}, seen from
// that node looking along the corridor). Answers a grid of positions ([lon,
// lat, height] each), triangle indices, the two long edges as position lists,
// and the sample counts.
export function corridorMesh(from, to, width, {acrossSamples = ACROSS_SAMPLES, fromHub = 0, toHub = 0, fromClip = null, toClip = null, hubSegments = HUB_SEGMENTS} = {}) {
  const half = width / 2;
  const vector = localVector(from, to);
  const length = Math.hypot(vector.east, vector.north);
  if (!(length > 1e-6)) return null;
  const ux = vector.east / length, uy = vector.north / length;   // along
  const lx = -uy, ly = ux;                                       // lateral (left)
  // Hubs smaller than the corridor are not carved: the cut would lie inside the
  // corridor's own end and leave a step. A hub is normally at least half the
  // widest corridor at the node, so this only guards a degenerate input.
  const cutFrom = fromHub >= half ? fromHub : 0, cutTo = toHub >= half ? toHub : 0;
  const alongSamples = Math.max(MIN_ALONG_SAMPLES, Math.min(MAX_ALONG_SAMPLES, Math.ceil(length / ALONG_STEP_M)));
  const heading = Math.atan2(uy, ux);
  const columns = columnOffsets(width, acrossSamples, [
    {radius: cutFrom, heading, clip: fromClip, mirror: false},
    {radius: cutTo, heading: heading + Math.PI, clip: toClip, mirror: true}], hubSegments);
  const across = columns.length - 1;
  const positions = [], edges = [[], []];
  const rise = to.height - from.height;
  // The level part of a corridor: between where the two hubs end.
  const levelStart = cutFrom, levelEnd = Math.max(levelStart + 1e-6, length - cutTo);
  for (let i = 0; i <= alongSamples; i++) {
    for (let j = 0; j <= across; j++) {
      const s = columns[j];
      // Leaving `from`, +s is its left; leaving `to` the other way, +s is its right.
      const yieldFrom = Math.max(yieldDepth(s, fromClip?.left), yieldDepth(-s, fromClip?.right));
      const yieldTo = Math.max(yieldDepth(-s, toClip?.left), yieldDepth(s, toClip?.right));
      const start = Math.max(carveDepth(cutFrom, s), yieldFrom), end = length - Math.max(carveDepth(cutTo, s), yieldTo);
      const along = start + (Math.max(end, start) - start) * i / alongSamples;
      const u = (along - levelStart) / (levelEnd - levelStart);
      const height = from.height + rise * heightProfile(u);
      const position = toDegrees(from, ux * along + lx * s, uy * along + ly * s, height);
      positions.push(position);
      if (j === 0) edges[0].push(position);
      if (j === across) edges[1].push(position);
    }
  }
  const stride = across + 1;
  const indices = [];
  for (let i = 0; i < alongSamples; i++) {
    for (let j = 0; j < across; j++) {
      const a = i * stride + j, b = a + 1, c = a + stride, d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  return {positions, indices, edges, alongSamples, acrossSamples: across, columns, length};
}

// The lateral offsets a corridor is sampled at: evenly spaced columns plus,
// for each end, the offsets where its boundary changes shape, so the mesh
// edge is exact there instead of cutting a corner. Those are the hub's own
// polygon vertices inside the mouth (the mouth then coincides with the disc
// edge by edge), the point where the disc meets a neighbour's bisector
// (R·sin(θ/2)) and the neighbour's half-width, where the bisector hands over
// to the neighbour's edge. `ends` are {radius, heading, clip, mirror}: mirror
// flips left and right for the far end, which is walked the other way.
export function columnOffsets(width, acrossSamples, ends, hubSegments = HUB_SEGMENTS) {
  const half = width / 2;
  const offsets = new Set();
  for (let j = 0; j <= acrossSamples; j++) offsets.add(-half + width * j / acrossSamples);
  const add = s => {if (s > -half + 1e-6 && s < half - 1e-6) offsets.add(s);};
  for (const {radius, heading, clip, mirror} of ends) {
    if (radius > 0) {
      for (let k = 0; k < hubSegments; k++) {
        const angle = 2 * Math.PI * k / hubSegments - heading;
        if (Math.cos(angle) > 0) add(radius * Math.sin(angle) * (mirror ? -1 : 1));
      }
    }
    for (const [side, sign] of [['left', 1], ['right', -1]]) {
      const neighbour = clip?.[side];
      if (!neighbour) continue;
      const orientation = sign * (mirror ? -1 : 1);
      if (radius > 0) add(orientation * radius * Math.sin(neighbour.angle / 2));
      add(orientation * neighbour.halfWidth);
    }
  }
  const sorted = [...offsets].sort((a, b) => a - b);
  const merged = [];
  for (const s of sorted) if (!merged.length || s - merged[merged.length - 1] > 1e-6) merged.push(s);
  return merged;
}

// The centre line of a link as positions along the same ease profile, for a
// link drawn as a line rather than a corridor.
export function profilePositions(from, to, samples = null) {
  const length = distanceMetres(from, to);
  const count = samples ?? Math.max(MIN_ALONG_SAMPLES, Math.min(MAX_ALONG_SAMPLES, Math.ceil(length / ALONG_STEP_M)));
  const positions = [];
  for (let i = 0; i <= count; i++) {
    const u = i / count;
    positions.push([from.longitude + (to.longitude - from.longitude) * u, from.latitude + (to.latitude - from.latitude) * u,
      from.height + (to.height - from.height) * heightProfile(u)]);
  }
  return positions;
}

// The flat disc at a node: a fan around the centre at the node's height.
export function hubMesh(centre, radius, segments = HUB_SEGMENTS) {
  const positions = [[centre.longitude, centre.latitude, centre.height]];
  for (let k = 0; k < segments; k++) {
    const angle = 2 * Math.PI * k / segments;
    positions.push(toDegrees(centre, radius * Math.cos(angle), radius * Math.sin(angle), centre.height));
  }
  const indices = [];
  for (let k = 1; k <= segments; k++) indices.push(0, k, k === segments ? 1 : k + 1);
  return {positions, indices};
}

// The hub radius at a node: half the widest corridor that meets it, or the
// given floor for a node with no corridor yet.
export function hubRadius(widths, floor = 0) {
  return Math.max(floor, ...widths.map(width => width / 2));
}

const TAU = 2 * Math.PI;
const wrap = angle => ((angle % TAU) + TAU) % TAU;

// The parts of a hub's rim not covered by a corridor mouth: `mouths` are
// {angle, halfWidth} for each corridor leaving the node. Each mouth hides the
// arc within asin(halfWidth / radius) of its direction. Answers arcs as
// [start, end] in radians going counter-clockwise, or one full turn when
// nothing meets the node.
export function hubArcs(radius, mouths) {
  const spans = mouths.filter(m => m.halfWidth > 0 && radius > 0).map(m => {
    const spread = Math.asin(Math.min(1, m.halfWidth / radius));
    return [wrap(m.angle - spread), 2 * spread];
  }).sort((a, b) => a[0] - b[0]);
  if (!spans.length) return [[0, TAU]];
  // Merge on the circle: sort by start, join overlaps, then the complement.
  const merged = [];
  for (const [start, span] of spans) {
    const end = start + span;
    const last = merged[merged.length - 1];
    if (last && start <= last[1] + 1e-9) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  // A span past a full turn wraps onto the first one.
  if (merged.length > 1 && merged[merged.length - 1][1] >= TAU + merged[0][0]) {
    const last = merged.pop();
    merged[0][0] = last[0] - TAU;
    merged[0][1] = Math.max(merged[0][1], last[1] - TAU);
  }
  if (merged.length === 1 && merged[0][1] - merged[0][0] >= TAU - 1e-9) return [];
  const arcs = [];
  for (let k = 0; k < merged.length; k++) {
    const end = merged[k][1];
    const next = k + 1 < merged.length ? merged[k + 1][0] : merged[0][0] + TAU;
    if (next - end > 1e-6) arcs.push([wrap(end), wrap(end) + (next - end)]);   // start normalised to one turn
  }
  return arcs;
}

// Positions along the rim arcs of a hub, for drawing its free edge.
export function hubArcPositions(centre, radius, arcs, step = TAU / HUB_SEGMENTS) {
  return arcs.map(([start, end]) => {
    const count = Math.max(2, Math.ceil((end - start) / step) + 1);
    const points = [];
    for (let k = 0; k < count; k++) {
      const angle = start + (end - start) * k / (count - 1);
      points.push(toDegrees(centre, radius * Math.cos(angle), radius * Math.sin(angle), centre.height));
    }
    return points;
  });
}
