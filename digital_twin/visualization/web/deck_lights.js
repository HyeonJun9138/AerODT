// A vertiport lit the way an aerodrome is lit.
//
// The model library says what is lit and in what colour — the touchdown area's
// own perimeter in green, the taxi routes green down the middle and blue along
// their edges, one flashing beacon over the site — and at what spacing. This
// places a lamp every so many metres along the shapes that are already drawn,
// and gives each one its brightness for the moment being drawn.
//
// The shimmer is a display choice and is written as one. Aerodrome lighting is
// mostly steady; what makes a field read as lit rather than as a row of dots is
// that the lamps do not all sit at exactly the same brightness at exactly the
// same instant. So each lamp carries a phase of its own and breathes a little
// around full brightness. The beacon is the one that really flashes, because a
// heliport beacon really does.

export const LIGHT_COLOUR = {
  // Aerodrome colours: green marks where you may touch down and where the
  // centre of a taxi route is; blue marks its edges.
  green: '#4dff9b', blue: '#4aa3ff', white: '#ffffff',
};
export const LIGHT_PIXELS = {fato: 5.5, centreline: 4, edge: 4, beacon: 8};
// FATO and taxiway lamps are inset fittings: only a tiny display clearance is
// needed to keep their point sprites from depth-fighting with the deck paint.
// The site beacon is the one elevated fitting in this layer.
export const INSET_LIGHT_CLEARANCE_M = 0.015;
export const BEACON_STAND_METRES = 0.32;
export const elevationOf = kind => kind === 'beacon' ? BEACON_STAND_METRES : INSET_LIGHT_CLEARANCE_M;
// How far out a lamp is still worth drawing. Beyond this a deck is a shape, not
// a lit surface, and thousands of points would be thousands of pixels of noise.
export const LIGHT_FAR_METRES = 6000;
// How deep the shimmer goes and how long one breath takes. Small and slow: a
// lamp that pulses hard reads as a warning light, which most of these are not.
export const SHIMMER = 0.16;
export const SHIMMER_PERIOD_S = 2.9;
// Brightness is written in these steps. A lamp whose step did not move is not
// touched, so the collection's colour buffer is rewritten a few times a second
// for the lamps that changed instead of twenty-two times a second for all of
// them; thirty-two steps over a sixteen percent breath is far below what the
// eye separates.
export const LIGHT_ALPHA_STEPS = 32;
// Decks farther than this from the camera are not recoloured at all: every
// lamp on them is already faded out by LIGHT_FAR_METRES.
const LIGHT_TICK_METRES = LIGHT_FAR_METRES * 1.25;

const TAU = Math.PI * 2;

// Walk a polyline, dropping a point every `spacing` metres. The ends are always
// lit, because an unlit end is where a taxiway looks like it stops short.
export function alongPolyline(points, spacing) {
  const placed = [];
  if (!points?.length || !(spacing > 0)) return placed;
  let carry = 0;
  placed.push([points[0][0], points[0][1]]);
  for (let index = 1; index < points.length; index++) {
    const [x0, y0] = points[index - 1], [x1, y1] = points[index];
    const run = Math.hypot(x1 - x0, y1 - y0);
    if (run <= 1e-6) continue;
    let along = spacing - carry;
    while (along < run) {
      placed.push([x0 + (x1 - x0) * (along / run), y0 + (y1 - y0) * (along / run)]);
      along += spacing;
    }
    carry = (carry + run) % spacing;
  }
  const last = points[points.length - 1];
  if (Math.hypot(last[0] - placed[placed.length - 1][0], last[1] - placed[placed.length - 1][1]) > spacing * 0.35) {
    placed.push([last[0], last[1]]);
  }
  return placed;
}

// The same polyline offset to one side, for the lamps that mark a taxi route's
// edges rather than its middle.
export function offsetPolyline(points, metres) {
  const out = [];
  for (let index = 0; index < points.length; index++) {
    const before = points[Math.max(0, index - 1)], after = points[Math.min(points.length - 1, index + 1)];
    const dx = after[0] - before[0], dy = after[1] - before[1];
    const length = Math.hypot(dx, dy);
    if (length <= 1e-6) {out.push([points[index][0], points[index][1]]); continue;}
    out.push([points[index][0] + (dy / length) * metres, points[index][1] - (dx / length) * metres]);
  }
  return out;
}

// Every lamp a layout carries, in its own local metres. A layout with no
// lighting design gets none, rather than a pattern invented here.
export function lampsFor(layout) {
  const design = layout?.lighting;
  if (!design) return [];
  const lamps = [];
  const add = (point, kind) => lamps.push({point, kind,
    // A phase from where the lamp is, so the shimmer is fixed to the place and
    // a rebuild does not reshuffle the whole field.
    phase: ((point[0] * 0.7 + point[1] * 1.3) % TAU + TAU) % TAU});

  const ring = design.fato_perimeter;
  if (ring?.spacing_m > 0) {
    for (const fato of layout.fatos ?? []) {
      const radius = Number(fato.radius_m) || 0;
      if (!(radius > 0)) continue;
      const count = Math.max(Number(ring.minimum) || 8, Math.round((TAU * radius) / ring.spacing_m));
      for (let step = 0; step < count; step++) {
        const angle = (step / count) * TAU;
        add([fato.center_m[0] + Math.cos(angle) * radius, fato.center_m[1] + Math.sin(angle) * radius], 'fato');
      }
    }
  }
  const centre = design.taxiway_centreline;
  const edge = design.taxiway_edge;
  for (const lane of layout.edges ?? []) {
    const points = lane.points_m ?? [];
    if (points.length < 2) continue;
    if (centre?.spacing_m > 0) for (const point of alongPolyline(points, centre.spacing_m)) add(point, 'centreline');
    if (edge?.spacing_m > 0) {
      const half = (Number(lane.width_m) || 0) / 2;
      if (half > 0) {
        for (const side of [half, -half]) {
          for (const point of alongPolyline(offsetPolyline(points, side), edge.spacing_m)) add(point, 'edge');
        }
      }
    }
  }
  if (design.beacon?.center_m) add([design.beacon.center_m[0], design.beacon.center_m[1]], 'beacon');
  return lamps;
}

export function colourOf(kind, design) {
  const named = kind === 'fato' ? design?.fato_perimeter?.colour
    : kind === 'centreline' ? design?.taxiway_centreline?.colour
      : kind === 'edge' ? design?.taxiway_edge?.colour : design?.beacon?.colour;
  return LIGHT_COLOUR[named] ?? LIGHT_COLOUR.white;
}

// How bright a lamp is at this instant, 0 to 1. Steady lamps breathe around
// full; the beacon is dark between flashes, which is what a beacon is.
export function brightness(kind, seconds, phase, beacon = {}) {
  if (kind === 'beacon') {
    const period = Number(beacon.period_s) || 2;
    const flash = Math.min(period * 0.6, Number(beacon.flash_s) || 0.35);
    return (seconds % period) < flash ? 1 : 0.12;
  }
  return 1 - SHIMMER * 0.5 * (1 - Math.cos(seconds * TAU / SHIMMER_PERIOD_S + phase));
}

// The lamps of every placed vertiport in one primitive collection. Points, not
// entities: a field of them is thousands, and thousands of entities is a
// different order of cost from thousands of points.
export class DeckLights {
  constructor(C, scene) {
    this.C = C;
    this.scene = scene;
    this.points = scene.primitives.add(new C.PointPrimitiveCollection());
    this.byId = new Map();
    this.visible = true;
    this.enabled = true;
  }
  // The lamps of one vertiport, at the height its deck came out at. Replaces
  // whatever that vertiport had before, so a moved or re-designed deck relights.
  set(id, layout, positions) {
    this.clear(id);
    if (!layout?.lighting || !positions?.length) return 0;
    const C = this.C;
    const design = layout.lighting;
    const lamps = lampsFor(layout);
    const held = [];
    lamps.forEach((lamp, index) => {
      const position = positions[index];
      if (!position) return;
      const colour = C.Color.fromCssColorString(colourOf(lamp.kind, design));
      held.push({kind: lamp.kind, phase: lamp.phase, colour, beacon: design.beacon,
        point: this.points.add({position, color: colour, pixelSize: LIGHT_PIXELS[lamp.kind] ?? 4,
          // Depth-tested like everything else: a lamp on a deck is behind the
          // building when you are under it, which is what tells you the deck is
          // above you. It sits a few centimetres proud of the paint so the two
          // never fight for the same pixels.
          disableDepthTestDistance: 0,
          translucencyByDistance: new C.NearFarScalar(0, 1, LIGHT_FAR_METRES, 0),
          distanceDisplayCondition: new C.DistanceDisplayCondition(0, LIGHT_FAR_METRES),
          show: this.visible && this.enabled})});
    });
    // Where the deck is, for the distance test in tick(): its first lamp.
    held.origin = held.length ? positions[lamps.findIndex((_, index) => positions[index])] ?? null : null;
    this.byId.set(id, held);
    return held.length;
  }
  clear(id) {
    for (const lamp of this.byId.get(id) ?? []) this.points.remove(lamp.point);
    this.byId.delete(id);
  }
  clearAll() {for (const id of [...this.byId.keys()]) this.clear(id);}
  setVisible(visible) {
    this.visible = Boolean(visible);
    this.apply();
  }
  setEnabled(enabled) {
    if (this.enabled === Boolean(enabled)) return false;
    this.enabled = Boolean(enabled);
    this.apply();
    return true;
  }
  apply() {
    const show = this.visible && this.enabled;
    for (const lamps of this.byId.values()) for (const lamp of lamps) lamp.point.show = show;
  }
  // Brightness for the moment being drawn. Alpha only: a lamp's colour and size
  // are what it is, and only how brightly it is burning changes.
  tick(seconds) {
    if (!this.visible || !this.enabled) return false;
    const eye = this.scene?.camera?.positionWC ?? null;
    let touched = false;
    for (const lamps of this.byId.values()) {
      const origin = lamps.origin;
      if (eye && origin && Math.hypot(origin.x - eye.x, origin.y - eye.y, origin.z - eye.z) > LIGHT_TICK_METRES) continue;
      for (const lamp of lamps) {
        const level = Math.round(brightness(lamp.kind, seconds, lamp.phase, lamp.beacon) * LIGHT_ALPHA_STEPS) / LIGHT_ALPHA_STEPS;
        if (level === lamp.level) continue;
        lamp.level = level;
        lamp.point.color = lamp.colour.withAlpha(level);
        touched = true;
      }
    }
    return touched;
  }
  destroy() {
    this.clearAll();
    if (this.scene?.primitives && !this.points.isDestroyed?.()) this.scene.primitives.remove(this.points);
  }
}
