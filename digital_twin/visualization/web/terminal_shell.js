// The storey under the deck, as something a person can stand in.
//
// Only the shell here: the floor, the glazed perimeter, the ceiling that is the
// underside of the deck, and the stair cores you arrive through. What goes in
// it -- lounges, security, the board, the people -- is laid out against this,
// so this reads `layout.terminal`, the same plan `walkWorld()` makes walkable.
// Two drawings of one building drift; one plan drawn twice cannot.
//
// Entities rather than a primitive, unlike the close-range apron next door.
// This is static -- built when somebody is at the deck, removed when they
// leave, never touched per frame -- so a primitive buys nothing, and a plain
// colour reuses shader programs the layer has already linked instead of
// stalling the frame that somebody walks through the door on.
//
// Built on demand rather than on distance. An interior under a solid deck is
// invisible from outside, so proximity would pay for geometry nobody can see;
// and it is built when the pilot steps out onto the deck rather than when they
// start down the stairs, which is the one moment they are standing still.

import {terminalFitout} from './terminal_fitout.js?v=20260922-fitout';

const PALETTE = {
  floor: '#3c4a52', ceiling: '#1b262c',
  glass: '#9fd8e6', rail: '#dfe6ea', core: '#586a74', coreEdge: '#cfe6ef',
  lamp: '#eaf7fb', cove: '#7fe9f5',
};
const GLASS_ALPHA = 0.3;
// The luminaires. A polygon facing down is shaded by the sun like any other
// surface, so a pale ceiling under a deck comes out black whatever colour it is
// painted -- which is also what a real terminal ceiling looks like from
// underneath. What makes one read is the light in it, and a polyline is drawn
// unlit, so the lines are the lighting rather than a shade of paint.
const LAMP_SPACING_M = 9, LAMP_MARGIN_M = 2.4, LAMP_DROP_M = 0.25;
// A stair head inside a room is a solid, and a solid drawn to the ceiling is a
// column of nothing. It stops short so the floor above reads as continuous.
const CORE_HEAD_M = 2.4;
const FAR_METRES = 3000;

const centroid = points => points.reduce(
  (sum, [x, y]) => [sum[0] + x / points.length, sum[1] + y / points.length], [0, 0]);

/** Which way round a ring is wound: +1 anticlockwise, -1 clockwise. */
function winding(ring) {
  const area = ring.reduce((sum, [x, y], index) => {
    const [nx, ny] = ring[(index + 1) % ring.length];
    return sum + x * ny - nx * y;
  }, 0);
  return area > 0 ? 1 : -1;
}

/** The part of a segment that lies inside a convex ring, or null for none.
 *
 * Parametric, against every edge at once, because the ring is the deck's own
 * outline set in: it is convex but it is not a rectangle, and a line laid
 * across a turned diamond has to stop at the wall rather than at a bounding box
 * half again as wide.
 */
export function clipToRing(ring, from, to) {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  const turn = winding(ring), step = [to[0] - from[0], to[1] - from[1]];
  let low = 0, high = 1;
  for (let index = 0; index < ring.length; index++) {
    const [px, py] = ring[index], [qx, qy] = ring[(index + 1) % ring.length];
    const inward = [-(qy - py) * turn, (qx - px) * turn];
    const along = inward[0] * step[0] + inward[1] * step[1];
    const reach = inward[0] * (px - from[0]) + inward[1] * (py - from[1]);
    if (Math.abs(along) < 1e-12) {if (reach > 0) return null; continue;}
    const at = reach / along;
    if (along > 0) low = Math.max(low, at); else high = Math.min(high, at);
    if (low > high) return null;
  }
  return [[from[0] + step[0] * low, from[1] + step[1] * low],
    [from[0] + step[0] * high, from[1] + step[1] * high]];
}

/** Runs of ceiling light across a floor, laid along its longest wall.
 *
 * Along the longest wall rather than north, so the lines follow the building
 * instead of cutting across it: the deck is turned to its approach and the
 * storey under it is turned with it.
 */
export function lampRuns(ring, spacing = LAMP_SPACING_M, margin = LAMP_MARGIN_M) {
  if (!Array.isArray(ring) || ring.length < 3) return [];
  let along = [1, 0], longest = 0;
  for (let index = 0; index < ring.length; index++) {
    const [px, py] = ring[index], [qx, qy] = ring[(index + 1) % ring.length];
    const length = Math.hypot(qx - px, qy - py);
    if (length > longest) {longest = length; along = [(qx - px) / length, (qy - py) / length];}
  }
  if (!(longest > 0)) return [];
  const across = [-along[1], along[0]], middle = centroid(ring);
  const offsets = ring.map(([x, y]) => (x - middle[0]) * across[0] + (y - middle[1]) * across[1]);
  const low = Math.min(...offsets) + margin, high = Math.max(...offsets) - margin;
  const reach = ring.reduce((most, [x, y]) =>
    Math.max(most, Math.hypot(x - middle[0], y - middle[1])), 0) + spacing;
  const runs = [];
  // Counted from the middle of the floor, so the lines do not shift along the
  // room when its outline changes by a metre.
  for (let offset = Math.ceil(low / spacing) * spacing; offset <= high + 1e-9; offset += spacing) {
    const seat = [middle[0] + across[0] * offset, middle[1] + across[1] * offset];
    const run = clipToRing(ring, [seat[0] - along[0] * reach, seat[1] - along[1] * reach],
      [seat[0] + along[0] * reach, seat[1] + along[1] * reach]);
    if (!run) continue;
    const length = Math.hypot(run[1][0] - run[0][0], run[1][1] - run[0][1]);
    if (length <= margin * 2) continue;
    // Held off the glass at both ends, so a line never ends in a wall.
    const trim = margin / length;
    runs.push([[run[0][0] + (run[1][0] - run[0][0]) * trim, run[0][1] + (run[1][1] - run[0][1]) * trim],
      [run[1][0] - (run[1][0] - run[0][0]) * trim, run[1][1] - (run[1][1] - run[0][1]) * trim]]);
  }
  return runs;
}

/** The heights one terminal occupies, or null when the layout has no terminal. */
export function terminalLevels(layout, deckTop) {
  const terminal = layout?.terminal;
  if (!terminal || !Array.isArray(terminal.outline_m) || terminal.outline_m.length < 3) return null;
  if (!Number.isFinite(deckTop)) return null;
  const floor = deckTop - (Number(terminal.floor_drop_m) || 0);
  const clear = Number(terminal.clear_height_m) || 3.4;
  return {floor, ceiling: floor + clear, clear, terminal};
}

/** The shell of one placed vertiport, as entity descriptions in world space. */
export function terminalShell(C, {id, layout, deckTop}) {
  const levels = terminalLevels(layout, deckTop);
  if (!C || !levels) return [];
  const {floor, ceiling, terminal} = levels;
  const frame = layout.frame, prefix = `vertiport:${id}:terminal:`;
  const at = (points, height) => points.map(([east, north]) => C.Matrix4.multiplyByPoint(
    C.Transforms.eastNorthUpToFixedFrame(C.Cartesian3.fromDegrees(frame.longitude, frame.latitude, height)),
    new C.Cartesian3(east, north, 0), new C.Cartesian3()));
  const paint = (css, alpha = 1) => C.Color.fromCssColorString(css).withAlpha(alpha);
  const near = new C.DistanceDisplayCondition(0, FAR_METRES);
  const slab = (points, height, css) => ({
    polygon: {hierarchy: new C.PolygonHierarchy(at(points, height)), perPositionHeight: true,
      material: paint(css), shadows: C.ShadowMode?.DISABLED, distanceDisplayCondition: near}});
  // Straight in the plan, not along a great circle: these are metres of
  // building, and a geodesic through one is a different line to the floor
  // beneath it.
  const line = (points, height, css, width) => ({polyline: {positions: at(points, height),
    width, arcType: C.ArcType?.NONE, material: paint(css), distanceDisplayCondition: near}});
  const band = (points, bottom, top, css, alpha, edge) => {
    const closed = [...points, points[0]], positions = at(closed, bottom);
    return {wall: {positions,
      minimumHeights: closed.map(() => bottom), maximumHeights: closed.map(() => top),
      material: paint(css, alpha), shadows: C.ShadowMode?.DISABLED,
      ...(edge ? {outline: true, outlineColor: paint(edge, 0.9), outlineWidth: 1} : {}),
      distanceDisplayCondition: near}};
  };

  // Named parts, in the layer's own `vertiport:<id>:<part>` idiom: what a
  // thing is has to survive being put in a collection, and the fittings that
  // go in here next have to be able to find the shell they hang on.
  const parts = [
    ['floor', slab(terminal.outline_m, floor, PALETTE.floor)],
    ['ceiling', slab(terminal.outline_m, ceiling, PALETTE.ceiling)],
    // Glazed, because the point of a departure level under a deck 120 m up is
    // that you can see out of it. It is inside the clad wall for now, so what
    // you see through it is the back of the facade.
    ['glass', band(terminal.outline_m, floor, ceiling, PALETTE.glass, GLASS_ALPHA, PALETTE.rail)],
    // The cove: the lit line where the ceiling meets the glass, which is what
    // makes a flat slab overhead read as a ceiling rather than as a lid.
    ['cove', line([...terminal.outline_m, terminal.outline_m[0]], ceiling - 0.14, PALETTE.cove, 2)],
  ];
  lampRuns(terminal.outline_m).forEach((run, index) => {
    parts.push([`lamp:${index}`, line(run, ceiling - LAMP_DROP_M, PALETTE.lamp, 3)]);
  });
  for (const core of terminal.cores ?? []) {
    if (!Array.isArray(core?.center_m) || !Array.isArray(core?.size_m)) continue;
    const half = [core.size_m[0] / 2, core.size_m[1] / 2];
    const foot = [[-half[0], -half[1]], [half[0], -half[1]], [half[0], half[1]], [-half[0], half[1]]]
      .map(([x, y]) => [core.center_m[0] + x, core.center_m[1] + y]);
    parts.push([`core:${core.id}`,
      band(foot, floor, Math.min(ceiling, floor + CORE_HEAD_M), PALETTE.core, 1, PALETTE.coreEdge)]);
    // Named at the landing: a stair you arrive at with no idea which gate it
    // belongs to is a stair you cannot use to get back to your aircraft.
    parts.push([`sign:${core.id}`, {position: at([core.landing_m ?? core.center_m], floor + 2.1)[0],
      label: {text: `${core.gate ?? core.id} ↑`, font: 'bold 13px sans-serif',
        fillColor: paint(PALETTE.coreEdge), showBackground: true,
        backgroundColor: paint('#0e1a21', 0.72), distanceDisplayCondition: near}}]);
  }
  // The fit-out hangs on this shell and reads the same plan, so it is built
  // with it rather than beside it: one call raises a floor, one takes it away.
  return parts.map(([name, part]) => ({...part, id: `${prefix}${name}`}))
    .concat(terminalFitout(C, {id, layout, floor, ceiling}));
}

/** The terminal interiors currently standing, owned apart from the deck's own entities. */
export class TerminalShells {
  constructor(C, entities) {Object.assign(this, {C, entities}); this.built = new Map(); this.visible = true;}

  /** Stand this deck's interior up, or take it down. Answers whether it is up. */
  set(id, on, {layout, deckTop} = {}) {
    if (!on) {this.clear(id); return false;}
    if (this.built.has(id)) return true;
    let parts = [];
    try {parts = terminalShell(this.C, {id, layout, deckTop});}
    catch (error) {console.warn('Vertiport interior unavailable', id, error); return false;}
    if (!parts.length) return false;
    this.entities.suspendEvents?.();
    try {
      this.built.set(id, parts.map(part => {
        const entity = this.entities.add(part);
        entity.show = this.visible;
        return entity;
      }));
    } finally {this.entities.resumeEvents?.();}
    return true;
  }

  has(id) {return this.built.has(id);}

  clear(id) {
    const parts = this.built.get(id);
    if (!parts) return false;
    for (const entity of parts) this.entities.remove(entity);
    this.built.delete(id);
    return true;
  }

  setVisible(value) {
    this.visible = Boolean(value);
    for (const parts of this.built.values()) for (const entity of parts) entity.show = this.visible;
  }

  destroy() {for (const id of [...this.built.keys()]) this.clear(id);}
}
