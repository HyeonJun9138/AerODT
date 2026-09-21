// An obstacle put in front of the camera on purpose.
//
// The operator presses a button and something crosses the aircraft's view: a
// bird, or a drone. The point is to watch what the vision model makes of it and
// what the risk side does about it, so the object has to be the same object
// everywhere - the map, the camera image and the risk panel all have to be
// looking at one thing, not at three descriptions of it.
//
// That is why this produces a snapshot entity rather than drawing anything. The
// live snapshot already fans out to the map, the camera's own scene and the
// risk radar; an entity added to it on the way past arrives at all three by the
// route every other aircraft takes. Nothing downstream needs to know it was
// injected - except that it is labelled as injected, plainly, because an
// operator must never mistake one of these for traffic somebody is flying.

// Metres per degree, the flat approximation used throughout this codebase for
// offsets of a few hundred metres.
const M_PER_DEG = 111320;

// Distances are set for the camera that watches them: a 95° lens on a
// 576-pixel frame has about 264 px of focal length, so a 1.1 m bird 55 m out
// was five pixels tall and a drone at 90 m four — a speck the operator could
// not find and the detector could not name. At the distances below they are
// thirteen to fifteen pixels, and the crossing still starts outside the frame:
// the lens sees 1.09 × `ahead_m` to either side, and `lateral_m` is more.
export const INTRUDERS = {
  bird: {
    label: '새', kind: 'bird', detector: 'Bird',
    // A gull crossing a flight path: unhurried, and not in a straight line.
    speed_mps: 12, ahead_m: 20, lateral_m: 30, size_m: 1.1,
    // How far it rises and falls over one crossing, and how many times.
    bob_m: 4, bob_cycles: 2.5,
    asset: 'poly_flying_gull',   // Poly by Google's gull, CC-BY, scaled to a 1.1 m span
  },
  drone: {
    label: '드론', kind: 'drone', detector: 'Drone',
    // A quadcopter transiting: straight, level, and faster than it looks.
    speed_mps: 16, ahead_m: 28, lateral_m: 40, size_m: 1.4,
    bob_m: 0, bob_cycles: 0,
    asset: 'amvlab_drone',
  },
  uam: {
    label: 'UAM', kind: 'uam', detector: 'Airplane',
    // Another air taxi crossing ahead at cruise: the case the detector is
    // least sure how to name, and the one that matters most.
    speed_mps: 50, ahead_m: 90, lateral_m: 100, size_m: 8.1,
    bob_m: 0, bob_cycles: 0,
    asset: 'joby_s4',
  },
};

export const INTRUDER_KINDS = Object.keys(INTRUDERS);
// Long enough to cross the view and be gone; the track removes itself after.
export const LINGER_S = 1.5;

const wrap = degrees => ((degrees % 360) + 360) % 360;

// Geodetic to Earth-fixed, on the WGS84 ellipsoid. The map places an entity
// from `position_ecef_m` and silently drops one that has none, so a crossing
// that only knew its latitude and longitude would never be drawn. Written out
// rather than borrowed from Cesium so this module stays runnable in Node.
const WGS84_A = 6378137.0;
const WGS84_E2 = (2 - 1 / 298.257223563) / 298.257223563;
export function ecefOf(latitude_deg, longitude_deg, altitude_m) {
  const lat = latitude_deg * Math.PI / 180, lon = longitude_deg * Math.PI / 180;
  const sin = Math.sin(lat), cos = Math.cos(lat);
  const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sin * sin);
  return [(n + altitude_m) * cos * Math.cos(lon),
          (n + altitude_m) * cos * Math.sin(lon),
          ((1 - WGS84_E2) * n + altitude_m) * sin];
}

// Where the intruder is, `elapsed` seconds into its crossing.
//
// It starts off one side of the view, passes in front at `ahead_m`, and leaves
// the other side. Crossing rather than approaching is deliberate: something
// flying straight at the camera barely moves in the image, and the whole point
// is to give the detector and the operator something that plainly moves.
export function intruderAt(spec, own, elapsed, {side = 1} = {}) {
  if (!spec || !own || !Number.isFinite(elapsed)) return null;
  const span = (2 * spec.lateral_m) / spec.speed_mps;
  if (elapsed < 0 || elapsed > span + LINGER_S) return null;
  const travelled = Math.min(elapsed, span) * spec.speed_mps;
  // Across the view, from one side to the other.
  const across = side * (spec.lateral_m - travelled);
  const heading = wrap(Number(own.heading_deg) || 0);
  const radians = heading * Math.PI / 180;
  // The aircraft's own frame: forward along its heading, right across it.
  const forward = [Math.cos(radians), Math.sin(radians)];
  // Right of the heading is the heading plus ninety: north's right is east.
  const right = [-Math.sin(radians), Math.cos(radians)];
  const north = forward[0] * spec.ahead_m + right[0] * across;
  const east = forward[1] * spec.ahead_m + right[1] * across;
  const latitude = Number(own.latitude_deg) + north / M_PER_DEG;
  const longitude = Number(own.longitude_deg) +
    east / (M_PER_DEG * Math.cos(Number(own.latitude_deg) * Math.PI / 180));
  const phase = span > 0 ? Math.min(elapsed, span) / span : 0;
  const altitude = Number(own.altitude_m) +
    (spec.bob_m ? spec.bob_m * Math.sin(phase * spec.bob_cycles * 2 * Math.PI) : 0);
  // It is flying across, so that is where it is pointed - not at the camera.
  const course = wrap(heading + (side > 0 ? 90 : -90));
  return {latitude_deg: latitude, longitude_deg: longitude, altitude_m: altitude,
          heading_deg: course, speed_mps: spec.speed_mps,
          // What fraction of the crossing is done, for anything that wants to
          // say how long is left.
          progress: Math.min(1, phase), done: elapsed > span};
}

// One crossing, as the snapshot entity every screen already knows how to read.
//
// `provenance` says `injected` and the name carries the word, because this
// object is indistinguishable from real traffic once it is in the snapshot and
// the only thing that keeps it honest is saying so on the entity itself.
// `clock` is the snapshot's own state_time. The crossing is paced in wall
// seconds, so the operator sees it at a natural speed whatever the day's
// playback rate - but the entity is stamped with the day's clock, because that
// is the clock every neighbour in the same snapshot carries and the clock the
// display's sample ring orders by. An object stamped with wall time would sit
// in a ring of day-time neighbours with a time nothing else agrees on.
export function intruderEntity(track, at, own, clock = at / 1000) {
  const spec = INTRUDERS[track.kind];
  const point = intruderAt(spec, own, (at - track.started_at) / 1000, {side: track.side});
  if (!point) return null;
  const seconds = Number.isFinite(clock) ? clock : at / 1000;
  return {
    entity_id: track.id,
    name: `${spec.label} (주입)`,
    kind: spec.kind,
    latitude_deg: point.latitude_deg,
    longitude_deg: point.longitude_deg,
    altitude_m: point.altitude_m,
    position_ecef_m: ecefOf(point.latitude_deg, point.longitude_deg, point.altitude_m),
    velocity_ecef_mps: null,
    heading_deg: point.heading_deg,
    pitch_deg: 0, roll_deg: 0, tilt_deg: 0,
    state_time: seconds, observation_time: seconds, received_time: seconds,
    derivation: 'injected', quality: 'nominal', source: 'intruder',
    provenance: 'injected',
    discontinuity: false, continuity_id: 0,
    visual_asset_id: spec.asset,
    // What the detector should be calling it, carried alongside so the risk
    // side is looking at the same object the camera is - the question being
    // asked is what the model does, not whether the two agree on identity.
    intruder: {kind: spec.kind, label: spec.label, expect: spec.detector,
               size_m: spec.size_m, progress: point.progress, injected: true},
  };
}

// The set of crossings currently in the air, and the one job of putting them
// into a snapshot on its way past.
export class IntruderInjector {
  constructor({now = () => Date.now(), makeId = null} = {}) {
    this.now = now;
    this.tracks = [];
    this.sequence = 0;
    const session=globalThis.crypto?.randomUUID?.()??`${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    this.makeId = makeId ?? (kind => `intruder:${session}:${kind}:${++this.sequence}`);
    this.onChange = () => {};
  }

  get active() { return this.tracks.length; }

  // `own` is the entity the camera is mounted on; without one there is nothing
  // to cross in front of, so nothing is launched.
  launch(kind, ownId) {
    const spec = INTRUDERS[kind];
    if (!spec || !ownId) return null;
    const track = {id: this.makeId(kind), kind, own_id: ownId,
                   started_at: this.now(),
                   // Alternate sides, so pressing twice does not put two of
                   // them on the same line through the frame.
                   side: this.tracks.length % 2 ? -1 : 1};
    this.tracks.push(track);
    this.onChange(this.active);
    return track;
  }

  clear() {
    if (!this.tracks.length) return false;
    this.tracks = [];
    this.onChange(0);
    return true;
  }

  // Add whatever is crossing right now. The snapshot is replaced rather than
  // mutated: it is handed to half a dozen panels after this, and one of them
  // keeping a reference to a list that later grew an object is the kind of bug
  // that shows up a week later as a ghost on someone else's screen.
  inject(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.entities) || !this.tracks.length) return snapshot;
    const at = this.now();
    const byId = new Map(snapshot.entities.map(entity => [entity.entity_id, entity]));
    const added = [];
    const alive = [];
    for (const track of this.tracks) {
      const own = byId.get(track.own_id);
      // The aircraft it was launched around has gone: so has the reason for it.
      if (!own) continue;
      const entity = intruderEntity(track, at, own, snapshot.state_time);
      if (!entity) continue;
      alive.push(track);
      added.push(entity);
    }
    if (alive.length !== this.tracks.length) {
      this.tracks = alive;
      this.onChange(this.active);
    }
    return added.length ? {...snapshot, entities: [...snapshot.entities, ...added]} : snapshot;
  }
}
