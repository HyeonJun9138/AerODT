// The lower storeys of the building a vertiport stands on: the part a person
// on the ground meets, and the part a clad wall on its own cannot carry.
//
// A vertiport is a 6 to 35 metre building with a deck on top. Painting the
// whole of it with one repeating window tile gives the thing every storey a
// terminal has except the one that matters: the ground floor is where a
// building has its structure, its depth and its way in, and a printed window
// grid at eye level reads as a wall of windows rather than as architecture.
//
// So the bottom of the wall stops being cladding and becomes building: a low
// terrace the whole mass stands on, a colonnade round it carrying the tower's
// canopy, a glazed lobby set behind the columns with a lit line under the
// canopy, and a flight of steps up to the way in. Everything is derived from
// the server layout's own outline, its platform height and its heading. No
// dimension of a vertiport is decided here, and nothing here is simulated:
// this is display geometry, built once per design and afterwards only placed.
//
// The mesh is raw vertex arrays in local metres (east, north, up) around the
// layout frame, grouped by colour so the whole base is one primitive with a
// handful of instances — the same shape the deck's own slab is drawn in.

import {facadeWall} from './vertiport_shell.js?v=20260914-realism';

// A building shorter than this keeps the plain clad wall it has today: below
// about three storeys there is no room for a colonnade under the deck, and a
// terrace round a two-metre plinth reads as a kerb.
export const PODIUM_FROM_M = 9;
// The base storey: tall enough to be a public ground floor, never so tall that
// it swallows the tower. Half-metre steps, so the cladding above it is painted
// at the same coarse pitch its cache already uses.
export const PODIUM_MIN_M = 4.5, PODIUM_MAX_M = 9, PODIUM_OF_BUILDING = 0.28;
// The canopy: the slab the colonnade carries, and the lit line under its edge.
export const CANOPY_M = 0.9, CANOPY_OUT_M = 1.05, COVE_M = 0.16;
// The terrace the building stands on, how far it is buried so a slope still
// meets stone rather than air, and the flight up to it.
export const TERRACE_OUT_M = 2.6, TERRACE_BURY_M = 2.4;
export const STEP_RISE_M = 0.15, STEP_TREAD_M = 0.42, STEP_COUNT = 3;
export const TERRACE_RISE_M = STEP_RISE_M * STEP_COUNT;
// The colonnade. The pitch is a target: the columns are spread evenly round
// the ring so the last bay is the same as the first.
export const COLUMN_SPACING_M = 9, COLUMN_MIN = 12, COLUMN_MAX = 56;
export const COLUMN_SIDES = 6, COLUMN_TAPER = 0.9;
export const COLUMN_SHOE_M = 0.27, COLUMN_SHOE_OF_RADIUS = 1.22;
// The gap between a column and the glass behind it. Without it the two share
// pixels at distance and the colonnade reads as a pattern on the wall.
export const COLUMN_GAP_M = 0.18;
// The way in: how wide the doors and the flight are, and how far the entrance
// canopy reaches over the steps.
export const ENTRANCE_W_M = 12, PORTAL_H_M = 3.4;

// Cool, and lit rather than coloured: a pale structure against dark glass is
// what reads as a terminal at the distance a deck is usually looked at from,
// and the one saturated colour is the light line, which is the map's own.
export const BASE = {
  terrace: '#aab2b8', terraceEdge: '#8f979d', step: '#bcc3c8', cheek: '#a3abb1',
  column: '#e4e9ec', trim: '#9fb0b8',
  glass: '#22323c', door: '#16222a',
  canopy: '#6b747b', soffit: '#4d565d', cove: '#7fe9f5',
};

const round3 = value => Math.round(value * 1000) / 1000 + 0;
// The base is drawn where the rest of the building is drawn, so it never
// appears or goes without its wall.
export const BASE_ID = id => `vertiport:${id}:base`;
// Where a placed base stands, from the frame it was placed by.
const originOf = (C, matrix) => {
  const column = C?.Matrix4?.getTranslation?.(matrix, new C.Cartesian3());
  return column && Number.isFinite(column.x) ? column : null;
};
const distanceBetween = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const clamp = (low, value, high) => Math.min(high, Math.max(low, value));

function signedArea(points) {
  let sum = 0;
  for (let index = 0, count = points.length; index < count; index++) {
    const [x1, y1] = points[index], [x2, y2] = points[(index + 1) % count];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

// The same ring walked anticlockwise, whichever way the layout gave it. Every
// winding rule below depends on it: anticlockwise is what makes an edge normal
// point out of the building and a face wind outward under back-face culling.
export function ringOf(points) {
  const ring = (points ?? []).filter(point => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]))
    .map(([x, y]) => [x, y]);
  return signedArea(ring) < 0 ? ring.reverse() : ring;
}

// Outward normal of each edge of an anticlockwise ring: the edge from point
// `index` to the next one.
function edgeNormals(ring) {
  return ring.map(([x, y], index) => {
    const [nx, ny] = ring[(index + 1) % ring.length];
    const dx = nx - x, dy = ny - y, length = Math.hypot(dx, dy) || 1;
    return [dy / length, -dx / length];
  });
}

// The ring pushed out by `metres` on its own edges: each vertex moves along the
// bisector of its two edges, far enough that both edges land exactly `metres`
// out — a mitre. A radial push from the centroid (what the 8 cm cladding offset
// uses, where the error is under a millimetre) moves the middle of a long side
// by `metres` and its corners by much less, and at the two and a half metres a
// terrace stands out, that difference is a visibly crooked terrace.
export function pushRing(points, metres) {
  const ring = ringOf(points);
  if (ring.length < 3) return ring;
  const normals = edgeNormals(ring);
  return ring.map(([x, y], index) => {
    const previous = normals[(index - 1 + ring.length) % ring.length], current = normals[index];
    const bx = previous[0] + current[0], by = previous[1] + current[1];
    const length = Math.hypot(bx, by) || 1;
    const bisector = [bx / length, by / length];
    // Clamped so a ring that doubles back on itself grows a spike rather than
    // running off to infinity.
    const reach = metres / Math.max(0.25, bisector[0] * current[0] + bisector[1] * current[1]);
    return [round3(x + bisector[0] * reach), round3(y + bisector[1] * reach)];
  });
}

export function perimeterOf(ring) {
  let total = 0;
  for (let index = 0; index < ring.length; index++) {
    const [x, y] = ring[index], [nx, ny] = ring[(index + 1) % ring.length];
    total += Math.hypot(nx - x, ny - y);
  }
  return total;
}

// The base storey of a building this tall, or 0 for one too short to carry one.
// Height alone decides it, so the wall above can be painted for the remaining
// height without knowing anything about the footprint.
export function podiumHeight(buildingHeightM) {
  const height = Number(buildingHeightM) || 0;
  if (!(height >= PODIUM_FROM_M)) return 0;
  return Math.round(clamp(PODIUM_MIN_M, height * PODIUM_OF_BUILDING, PODIUM_MAX_M) * 2) / 2;
}

// The clad wall above the base: what the facade is painted for and what the
// shell's rows are laid out over. A building with no base keeps the buried
// skirt the cladding used to carry on its own.
export function cladHeight(buildingHeightM) {
  const height = Number(buildingHeightM) || 0;
  const podium = podiumHeight(height);
  return podium > 0 ? Math.max(0.2, Math.round((height - podium) * 2) / 2) : facadeWall(height);
}

// What the base of this building is made of, or null when it has none. `ring`
// is the wall face in local metres — the cladding ring, so the glazing lands
// where the wall above it does.
export function basePlan(buildingHeightM, ring) {
  const podium = podiumHeight(buildingHeightM);
  const face = ringOf(ring);
  if (!(podium > 0) || face.length < 3) return null;
  const perimeter = perimeterOf(face);
  // A footprint too small to stand a terrace round without it closing on
  // itself. No vertiport is anywhere near this; it is here so a hand-made
  // layout cannot produce a knot of geometry.
  if (!(perimeter > 16 * TERRACE_OUT_M)) return null;
  const columns = Math.round(clamp(COLUMN_MIN, perimeter / COLUMN_SPACING_M, COLUMN_MAX));
  const radius = round3(clamp(0.34, podium * 0.075, 0.62));
  return {
    podium_m: podium,
    // The canopy hangs under the tower, so the colonnade stops below it.
    soffit_m: round3(podium - CANOPY_M),
    terrace_m: TERRACE_RISE_M,
    perimeter_m: round3(perimeter),
    columns, pitch_m: round3(perimeter / columns), radius_m: radius,
    // The gap keeps the column clear of the glass; the tower above overhangs
    // the whole colonnade by the canopy's own reach.
    column_out_m: round3(radius + COLUMN_GAP_M),
  };
}

// Where the way in is: the middle of the side the layout's own design frame
// calls front (its south side), turned with the building. Deterministic, so
// the same design always has its doors in the same place, and it follows a
// heading edit round the building without anything else being told.
export function entranceOf(ring, headingDeg = 0) {
  const face = ringOf(ring);
  if (face.length < 3) return null;
  const angle = (Number(headingDeg) || 0) * Math.PI / 180;
  // `rotatePoints` maps a design point to the display; the design frame's
  // south, [0, -1], arrives here.
  // `+ 0` so a heading of zero gives north as 0 rather than -0.
  const out = [-Math.sin(angle) + 0, -Math.cos(angle) + 0];
  const reach = face.map(([x, y]) => x * out[0] + y * out[1]);
  const far = Math.max(...reach);
  const front = face.filter((_, index) => reach[index] >= far - 0.5);
  const middle = front.reduce((sum, [x, y]) => [sum[0] + x / front.length, sum[1] + y / front.length], [0, 0]);
  // Slid back out onto the wall itself: the mean of the front points sits a
  // few centimetres inside it wherever the corner curves reach into the side,
  // and the doors and the flight are measured from the face.
  const inside = far - (middle[0] * out[0] + middle[1] * out[1]);
  const centre = [middle[0] + out[0] * inside, middle[1] + out[1] * inside];
  return {centre: [round3(centre[0]), round3(centre[1])], out, along: [-out[1], out[0]]};
}

// ---------------------------------------------------------------------------
// Mesh building. Positions are [east, north, up] in metres around the layout
// frame; every face is wound anticlockwise seen from outside, because the
// appearance that draws this culls back faces.

class Mesh {
  constructor() {this.positions = []; this.normals = []; this.indices = [];}
  vertex([x, y, z], [nx, ny, nz]) {
    this.positions.push(x, y, z); this.normals.push(nx, ny, nz);
    return this.positions.length / 3 - 1;
  }
  // Four corners in order round the face, seen from outside.
  quad(a, b, c, d, normal) {
    const base = this.vertex(a, normal);
    this.vertex(b, normal); this.vertex(c, normal); this.vertex(d, normal);
    this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  get triangles() {return this.indices.length / 3;}
}

// The outside face of a ring between two heights.
function band(mesh, ring, lowZ, highZ) {
  const normals = edgeNormals(ring);
  for (let index = 0; index < ring.length; index++) {
    const [x, y] = ring[index], [nx, ny] = ring[(index + 1) % ring.length];
    const [ex, ey] = normals[index];
    mesh.quad([x, y, lowZ], [nx, ny, lowZ], [nx, ny, highZ], [x, y, highZ], [ex, ey, 0]);
  }
}

// The flat ring between an outer and an inner outline at one height, facing up
// or (`up` false) down — a terrace top, a canopy's upper face, a soffit.
function deck(mesh, outer, inner, z, up = true) {
  const normal = [0, 0, up ? 1 : -1];
  for (let index = 0; index < outer.length; index++) {
    const next = (index + 1) % outer.length;
    const a = [outer[index][0], outer[index][1], z], b = [outer[next][0], outer[next][1], z];
    const c = [inner[next][0], inner[next][1], z], d = [inner[index][0], inner[index][1], z];
    if (up) mesh.quad(a, b, c, d, normal); else mesh.quad(d, c, b, a, normal);
  }
}

// A regular prism standing on its axis, with a top cap and no bottom: a column
// foot sits in the terrace and its head in the soffit, so neither is ever seen.
function column(mesh, [x, y], lowRadius, highRadius, lowZ, highZ, sides = COLUMN_SIDES) {
  const at = (radius, z, step) => {
    const angle = step / sides * Math.PI * 2;
    return [x + Math.cos(angle) * radius, y + Math.sin(angle) * radius, z];
  };
  for (let step = 0; step < sides; step++) {
    const angle = (step + 0.5) / sides * Math.PI * 2;
    const normal = [Math.cos(angle), Math.sin(angle), 0];
    mesh.quad(at(lowRadius, lowZ, step), at(lowRadius, lowZ, step + 1),
      at(highRadius, highZ, step + 1), at(highRadius, highZ, step), normal);
  }
  const centre = mesh.vertex([x, y, highZ], [0, 0, 1]);
  const rim = [];
  for (let step = 0; step < sides; step++) rim.push(mesh.vertex(at(highRadius, highZ, step), [0, 0, 1]));
  for (let step = 0; step < sides; step++) mesh.indices.push(centre, rim[step], rim[(step + 1) % sides]);
}

// A box standing on the ground plane, `depth` along `out` and `width` across
// it: every part of the entrance is one of these.
function block(mesh, centre, out, {width, depth, lowZ, highZ, offset = 0}) {
  // A right-handed frame: `out` across the depth, `side` across the width, up.
  // Each face is laid down in the order that winds it anticlockwise from
  // outside for that frame; the two horizontal ones close the box.
  const side = [-out[1], out[0]];
  const at = (a, b, z) => [
    centre[0] + out[0] * (offset + depth / 2 * b) + side[0] * (width / 2 * a),
    centre[1] + out[1] * (offset + depth / 2 * b) + side[1] * (width / 2 * a), z];
  const forward = [out[0], out[1], 0], across = [side[0], side[1], 0];
  const back = value => [-value[0], -value[1], -value[2]];
  mesh.quad(at(-1, 1, lowZ), at(1, 1, lowZ), at(1, 1, highZ), at(-1, 1, highZ), forward);
  mesh.quad(at(1, -1, lowZ), at(-1, -1, lowZ), at(-1, -1, highZ), at(1, -1, highZ), back(forward));
  mesh.quad(at(1, -1, lowZ), at(1, -1, highZ), at(1, 1, highZ), at(1, 1, lowZ), across);
  mesh.quad(at(-1, 1, lowZ), at(-1, 1, highZ), at(-1, -1, highZ), at(-1, -1, lowZ), back(across));
  mesh.quad(at(-1, -1, highZ), at(-1, 1, highZ), at(1, 1, highZ), at(1, -1, highZ), [0, 0, 1]);
  mesh.quad(at(1, -1, lowZ), at(1, 1, lowZ), at(-1, 1, lowZ), at(-1, -1, lowZ), [0, 0, -1]);
}

// Positions evenly spread round a ring, with the outward normal of the edge
// each one landed on: where the columns stand.
export function spreadRing(ring, count) {
  const normals = edgeNormals(ring);
  const lengths = ring.map(([x, y], index) => {
    const [nx, ny] = ring[(index + 1) % ring.length];
    return Math.hypot(nx - x, ny - y);
  });
  const perimeter = lengths.reduce((sum, length) => sum + length, 0) || 1;
  const places = [];
  let edge = 0, walked = 0;
  for (let step = 0; step < count; step++) {
    const target = (step + 0.5) * perimeter / count;
    while (edge < ring.length - 1 && walked + lengths[edge] < target) {walked += lengths[edge]; edge++;}
    const t = lengths[edge] > 0 ? (target - walked) / lengths[edge] : 0;
    const [x, y] = ring[edge], [nx, ny] = ring[(edge + 1) % ring.length];
    places.push({point: [round3(x + (nx - x) * t), round3(y + (ny - y) * t)], normal: normals[edge]});
  }
  return places;
}

// The whole base as colour groups. `face` is the wall face in local metres
// (the cladding ring the facade above is drawn on) and heights are metres
// above the ground the building stands on.
export function baseMesh(face, plan, {headingDeg = 0} = {}) {
  if (!plan) return null;
  const glass = ringOf(face);
  const terraceRing = pushRing(glass, TERRACE_OUT_M);
  const canopyRing = pushRing(glass, CANOPY_OUT_M);
  const groups = new Map();
  const into = name => {
    if (!groups.has(name)) groups.set(name, new Mesh());
    return groups.get(name);
  };
  const {podium_m: podium, soffit_m: soffit, terrace_m: rise, radius_m: radius, column_out_m: out} = plan;

  // The terrace: a low stone platform the whole building stands on, buried
  // deep enough that a slope meets stone and not the underside of a slab.
  band(into('terraceEdge'), terraceRing, -TERRACE_BURY_M, rise - 0.08);
  band(into('terrace'), terraceRing, rise - 0.08, rise);
  deck(into('terrace'), terraceRing, glass, rise);

  // The colonnade: a shoe, then a shaft tapering into the soffit.
  const columns = into('column');
  for (const {point, normal} of spreadRing(glass, plan.columns)) {
    const centre = [point[0] + normal[0] * out, point[1] + normal[1] * out];
    column(columns, centre, radius * COLUMN_SHOE_OF_RADIUS, radius * COLUMN_SHOE_OF_RADIUS, rise, rise + COLUMN_SHOE_M);
    column(columns, centre, radius, radius * COLUMN_TAPER, rise + COLUMN_SHOE_M, soffit);
  }

  // The lobby behind them, and the line that divides it into floors: a two
  // storey lobby without one reads as a single impossibly tall pane.
  band(into('glass'), glass, rise, soffit);
  const transom = round3(rise + (soffit - rise) / 2);
  if (soffit - rise > 5) band(into('trim'), pushRing(glass, 0.06), transom - 0.07, transom + 0.07);

  // The canopy the colonnade carries, with the tower standing back on top of
  // it: an overhanging edge, a lit line under it, and the shaded underside
  // that makes the whole storey read as sheltered rather than printed.
  band(into('canopy'), canopyRing, soffit + COVE_M, podium);
  band(into('cove'), canopyRing, soffit, soffit + COVE_M);
  deck(into('soffit'), canopyRing, glass, soffit, false);
  deck(into('canopy'), canopyRing, glass, podium);

  // The way in: doors in the glass, a flight down off the terrace with a lit
  // parapet either side, and a canopy of its own over the steps.
  const entrance = entranceOf(glass, headingDeg);
  if (entrance) {
    const {centre, out: forward} = entrance;
    block(into('trim'), centre, forward, {width: ENTRANCE_W_M * 0.62, depth: 0.3, offset: 0.1, lowZ: rise, highZ: rise + PORTAL_H_M});
    block(into('door'), centre, forward, {width: ENTRANCE_W_M * 0.62 - 0.5, depth: 0.32, offset: 0.16, lowZ: rise, highZ: rise + PORTAL_H_M - 0.35});
    const steps = into('step');
    for (let step = 0; step < STEP_COUNT; step++) {
      block(steps, centre, forward, {width: ENTRANCE_W_M, depth: STEP_TREAD_M,
        offset: TERRACE_OUT_M + STEP_TREAD_M * (step + 0.5), lowZ: -TERRACE_BURY_M, highZ: rise - STEP_RISE_M * (step + 1)});
    }
    const flight = STEP_TREAD_M * STEP_COUNT;
    for (const side of [-1, 1]) {
      const cheek = [centre[0] - forward[1] * side * (ENTRANCE_W_M / 2 + 0.3), centre[1] + forward[0] * side * (ENTRANCE_W_M / 2 + 0.3)];
      block(into('cheek'), cheek, forward, {width: 0.6, depth: flight + TERRACE_OUT_M * 0.4,
        offset: TERRACE_OUT_M * 0.8 + flight / 2, lowZ: -TERRACE_BURY_M, highZ: rise + 0.55});
      block(into('cove'), cheek, forward, {width: 0.6, depth: flight + TERRACE_OUT_M * 0.4,
        offset: TERRACE_OUT_M * 0.8 + flight / 2, lowZ: rise + 0.55, highZ: rise + 0.63});
    }
    const reach = TERRACE_OUT_M + flight + 0.6;
    block(into('canopy'), centre, forward, {width: ENTRANCE_W_M + 3, depth: reach,
      offset: reach / 2, lowZ: soffit - 0.62, highZ: soffit - 0.2});
    block(into('cove'), centre, forward, {width: ENTRANCE_W_M + 3, depth: 0.14,
      offset: reach - 0.07, lowZ: soffit - 0.72, highZ: soffit - 0.62});
  }

  const built = [...groups.entries()].map(([name, mesh]) => ({name, color: BASE[name],
    positions: mesh.positions, normals: mesh.normals, indices: mesh.indices, triangles: mesh.triangles}));
  return {groups: built, triangles: built.reduce((sum, group) => sum + group.triangles, 0),
    podium_m: podium, columns: plan.columns, entrance};
}

// ---------------------------------------------------------------------------

// The bases of every placed vertiport: one primitive each, because a colonnade
// is fifty small solids and fifty entities per deck is a different order of
// cost from one. Each colour group is an instance carrying the batch
// attributes the map's other colour geometry carries, so they share its
// compiled program; the whole base is placed by one matrix, and a design that
// has not changed is not rebuilt.
export class BaseStructures {
  constructor(C, scene) {this.C = C; this.scene = scene; this.byId = new Map(); this.visible = true;}
  // `mesh` from baseMesh, `matrix` the layout frame standing on the ground,
  // `far` how far away the base is still drawn, `fade` 1 or the dimmed alpha.
  set(id, {mesh, matrix, far = Infinity, fade = 1, key = null}) {
    const held = this.byId.get(id);
    if (held && key !== null && held.key === key) {
      // The same base in the same place: only the transform can have moved.
      held.primitive.modelMatrix = matrix;
      held.far = far;
      held.origin = originOf(this.C, matrix);
      return held.primitive;
    }
    this.clear(id);
    if (!mesh?.groups?.length || !matrix) return null;
    const C = this.C;
    const attribute = (values, size, datatype) => new C.GeometryAttribute({componentDatatype: datatype, componentsPerAttribute: size, values});
    const instances = mesh.groups.map(group => new C.GeometryInstance({
      id: BASE_ID(id),
      geometry: new C.Geometry({
        attributes: {
          position: attribute(new Float64Array(group.positions), 3, C.ComponentDatatype.DOUBLE),
          normal: attribute(new Float32Array(group.normals), 3, C.ComponentDatatype.FLOAT),
        },
        indices: new Uint16Array(group.indices),
        primitiveType: C.PrimitiveType.TRIANGLES,
        boundingSphere: C.BoundingSphere.fromVertices(group.positions),
      }),
      // Show and colour. Not the distance condition the map's entity batches
      // carry: Cesium evaluates that one against a per-instance bounding
      // sphere it fixes when the primitive is built, and under a model matrix
      // that is the wrong sphere — measured, the whole base disappears at any
      // distance. How far a base is drawn is `tick`'s business instead.
      attributes: {
        show: new C.ShowGeometryInstanceAttribute(this.visible),
        color: C.ColorGeometryInstanceAttribute.fromColor(C.Color.fromCssColorString(group.color).withAlpha(fade)),
      },
    }));
    const primitive = this.scene.primitives.add(new C.Primitive({geometryInstances: instances, modelMatrix: matrix,
      appearance: new C.PerInstanceColorAppearance({translucent: fade < 1, closed: true}),
      asynchronous: false, allowPicking: true, show: this.visible}));
    this.byId.set(id, {primitive, key, far, origin: originOf(C, matrix)});
    return primitive;
  }
  // Which bases the camera is near enough to. A base is the size of a doorway
  // and there are at most a couple of dozen of them, so this is one distance
  // each, on the frame the lamps are already being walked on.
  tick() {
    const camera = this.scene?.camera?.positionWC;
    let shown = 0;
    for (const held of this.byId.values()) {
      const near = !camera || !held.origin || !Number.isFinite(held.far)
        ? true : distanceBetween(camera, held.origin) <= held.far;
      const show = this.visible && near;
      if (held.primitive.show !== show) held.primitive.show = show;
      if (show) shown++;
    }
    return shown;
  }
  clear(id) {
    const held = this.byId.get(id);
    if (!held) return false;
    this.scene.primitives.remove(held.primitive);
    this.byId.delete(id);
    return true;
  }
  setVisible(visible) {
    this.visible = Boolean(visible);
    this.tick();
  }
  destroy() {for (const id of [...this.byId.keys()]) this.clear(id);}
}
