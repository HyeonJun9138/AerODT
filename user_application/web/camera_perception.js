// What the camera's detector saw, turned into places on the map.
//
// The detector answers with boxes in a 576x288 image: "a drone, here, this
// big". That is a direction and an apparent size, not a position. Given the
// pose the image was taken from - where the camera was, which way it looked -
// a box centre is a ray, and the box height against the size such a thing is
// known to be is a range along it. Where the ray meets that range is where the
// object is, roughly: the range is the weak part, and its uncertainty is
// carried with the estimate so the risk model weighs it accordingly.
//
// Each track the detector keeps becomes one perceived object. It joins the
// snapshot the way an injected intruder does, so the map and the risk panel
// list it, and it is reported to the server, where the risk model's observation
// history takes it as a sighting with a stated error and predicts from it.
// Nothing here corrects the aircraft or moves anything; it is perception, and
// it is labelled as such everywhere it appears.

const WGS84_A = 6378137.0, WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);

// The detector's classes, what they are on the map, and how big such a thing
// is - the size the range is read from. A near UAM is seen by a model trained
// on airplanes and helicopters; that is what it calls one.
export const CLASSES = {
  'bird':             {kind: 'bird',  label: '새',      size_m: 1.1,  asset: 'poly_flying_gull'},
  'drone':            {kind: 'drone', label: '드론',    size_m: 1.4,  asset: 'amvlab_drone'},
  'fixed-wing drone': {kind: 'drone', label: '고정익 드론', size_m: 2.4, asset: 'amvlab_drone'},
  'airplane':         {kind: 'uam',   label: '비행체',  size_m: 8.1,  asset: 'joby_s4'},
  'helicopter':       {kind: 'uam',   label: '회전익기', size_m: 11.0, asset: 'joby_s4'},
};
export const FRAME = {width: 576, height: 288, fov_deg: 95};
// A track not seen again for this long is gone from the map and the report.
export const TRACK_TTL_MS = 1500;
export const REPORT_INTERVAL_MS = 250;
// Range from apparent size is the weak measurement: a quarter of the range,
// plus a floor for the box's own pixel error.
export const RANGE_SIGMA_FRACTION = .25, RANGE_SIGMA_FLOOR_M = 5;
// A box smaller than this is a speck: its size says nothing about range. A
// detection the model itself is unsure of is not placed either, and a track
// is shown only once it has been seen twice, so a single flicker of the
// detector does not put an object on the map.
export const MIN_BOX_PX = 8, MIN_CONFIDENCE = .45, MIN_SIGHTINGS = 2;

const norm = v => Math.hypot(v[0], v[1], v[2]);
const unit = v => { const n = norm(v); return n > 1e-12 ? v.map(x => x / n) : null; };
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];

// Earth-fixed to geodetic, iterated; a few rounds are far below a metre.
export function geodeticOf(ecef) {
  const [x, y, z] = ecef, p = Math.hypot(x, y);
  const lon = Math.atan2(y, x);
  let lat = Math.atan2(z, p * (1 - WGS84_E2)), h = 0;
  for (let i = 0; i < 6; i++) {
    const s = Math.sin(lat), n = WGS84_A / Math.sqrt(1 - WGS84_E2 * s * s);
    h = p / Math.cos(lat) - n;
    lat = Math.atan2(z, p * (1 - WGS84_E2 * n / (n + h)));
  }
  return {latitude_deg: lat * 180 / Math.PI, longitude_deg: lon * 180 / Math.PI, altitude_m: h};
}

// East/north/up axes at a geodetic point, for headings.
function enuAxes(latitude_deg, longitude_deg) {
  const lat = latitude_deg * Math.PI / 180, lon = longitude_deg * Math.PI / 180;
  return {east: [-Math.sin(lon), Math.cos(lon), 0],
          north: [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)]};
}

// A box in the image, seen from `pose`, placed in the world.
//
// `pose` is what the camera rendered from: position, direction, up, all in
// Earth-fixed metres. The lens is `fov_deg` across the wider side of the
// frame, which is how the camera widget sets its frustum.
export function perceivedPosition(detection, pose, frame = FRAME) {
  const spec = CLASSES[String(detection?.class_name ?? '').toLowerCase()];
  const box = detection?.box;
  if (!spec || !pose || !Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite)) return null;
  const forward = unit(pose.direction), up0 = unit(pose.up);
  if (!forward || !up0) return null;
  const right = unit(cross(forward, up0)); if (!right) return null;
  const up = cross(right, forward);
  const [x1, y1, x2, y2] = box;
  const w = Math.max(1, x2 - x1), h = Math.max(1, y2 - y1);
  const focal = (Math.max(frame.width, frame.height) / 2) / Math.tan(frame.fov_deg * Math.PI / 360);
  // The larger side of the box against the object's extent: a bird seen
  // side-on is its wingspan wide, a drone from below is its width.
  const apparent = Math.max(w, h);
  if (apparent < MIN_BOX_PX) return null;
  const range = spec.size_m * focal / apparent;
  const u = (x1 + x2) / 2 - frame.width / 2, v = (y1 + y2) / 2 - frame.height / 2;
  const ray = unit([0, 1, 2].map(i => forward[i] * focal + right[i] * u - up[i] * v));
  if (!ray) return null;
  const position = [0, 1, 2].map(i => pose.position[i] + ray[i] * range);
  const geo = geodeticOf(position);
  return {...geo, position_ecef_m: position, range_m: range,
          sigma_m: Math.max(RANGE_SIGMA_FLOOR_M, range * RANGE_SIGMA_FRACTION),
          kind: spec.kind, label: spec.label, asset: spec.asset, size_m: spec.size_m};
}

// The tracks the detector is following, as objects with a place and a pace.
export class PerceptionTracks {
  constructor({now = () => Date.now()} = {}) {
    this.now = now;
    this.tracks = new Map();   // key -> {id, track_id, class_name, ...}
    this.ownId = null;
    this.onChange = () => {};
    this.lastReport = -Infinity;
  }

  get active() { return this.tracks.size; }

  // A detector answer for a frame taken from `pose` while mounted on `ownId`.
  // `at` is the wall time the frame was captured; motion between two sightings
  // of the same track gives its velocity and heading.
  observe(result, pose, ownId, at = this.now()) {
    if (!result || !Array.isArray(result.detections) || !pose || !ownId) return [];
    if (this.ownId !== ownId) { this.tracks.clear(); this.ownId = ownId; }
    const seen = [];
    for (const detection of result.detections) {
      if (!(Number(detection?.confidence) >= MIN_CONFIDENCE)) continue;
      const placed = perceivedPosition(detection, pose);
      if (!placed) continue;
      const trackId = detection.track_id ?? `${detection.class_name}:${Math.round(detection.box[0])}`;
      const key = `perceived:${ownId}:${trackId}`;
      const previous = this.tracks.get(key);
      let velocity = null, heading = null;
      if (previous && at > previous.at) {
        const dt = (at - previous.at) / 1000;
        if (dt >= .1 && dt <= 3) {
          velocity = [0, 1, 2].map(i => (placed.position_ecef_m[i] - previous.position_ecef_m[i]) / dt);
          const axes = enuAxes(placed.latitude_deg, placed.longitude_deg);
          const east = velocity[0]*axes.east[0] + velocity[1]*axes.east[1] + velocity[2]*axes.east[2];
          const north = velocity[0]*axes.north[0] + velocity[1]*axes.north[1] + velocity[2]*axes.north[2];
          // Below walking pace the direction is noise, not a heading.
          if (Math.hypot(east, north) >= 1.5) heading = ((Math.atan2(east, north) * 180 / Math.PI) + 360) % 360;
          else heading = previous.heading_deg;
        }
      }
      const track = {id: key, track_id: trackId, class_name: detection.class_name,
                     confidence: Number(detection.confidence) || 0, box: detection.box.slice(),
                     ...placed, velocity_ecef_mps: velocity, heading_deg: heading, at,
                     first_at: previous?.first_at ?? at, sightings: (previous?.sightings ?? 0) + 1};
      this.tracks.set(key, track);
      seen.push(track);
    }
    this.expire(at);
    this.onChange(this.active);
    return seen;
  }

  expire(at = this.now()) {
    let dropped = false;
    for (const [key, track] of this.tracks) if (at - track.at > TRACK_TTL_MS) { this.tracks.delete(key); dropped = true; }
    if (dropped) this.onChange(this.active);
    return dropped;
  }

  clear() {
    if (!this.tracks.size) return false;
    this.tracks.clear(); this.onChange(0);
    return true;
  }

  // One snapshot entity per live track. Labelled as perception on the entity
  // itself: `provenance` says where it came from, and the name says so too.
  entity(track, clock) {
    return {
      entity_id: track.id,
      name: `${track.label} 인식 #${track.track_id} · ${Math.round(track.range_m)} m · ${Math.round(track.confidence * 100)}%`,
      kind: track.kind,
      latitude_deg: track.latitude_deg, longitude_deg: track.longitude_deg, altitude_m: track.altitude_m,
      position_ecef_m: track.position_ecef_m.slice(),
      velocity_ecef_mps: track.velocity_ecef_mps ? track.velocity_ecef_mps.slice() : null,
      heading_deg: track.heading_deg, pitch_deg: 0, roll_deg: 0, tilt_deg: 0,
      state_time: clock, observation_time: clock, received_time: clock,
      derivation: 'observed', quality: 'nominal', source: 'perception', provenance: 'camera_ai',
      orientation_source: Number.isFinite(track.heading_deg) ? 'ground_track' : 'unavailable',
      discontinuity: false, continuity_id: 0,
      visual_asset_id: track.asset,
      perceived: {class_name: track.class_name, confidence: track.confidence, track_id: track.track_id,
                  range_m: track.range_m, sigma_m: track.sigma_m, sightings: track.sightings,
                  box: track.box.slice(), own_id: this.ownId},
    };
  }

  // Add the live tracks to a snapshot on its way past, without mutating it.
  inject(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.entities) || !this.tracks.size) return snapshot;
    this.expire();
    if (!this.tracks.size) return snapshot;
    const ids = new Set(snapshot.entities.map(e => e.entity_id));
    // The aircraft the camera is on has left the snapshot: so has the view.
    if (this.ownId && !ids.has(this.ownId)) { this.clear(); return snapshot; }
    const added = [...this.tracks.values()].filter(t => !ids.has(t.id) && t.sightings >= MIN_SIGHTINGS).map(t => this.entity(t, snapshot.state_time));
    return added.length ? {...snapshot, entities: [...snapshot.entities, ...added]} : snapshot;
  }

  // What the server is told, for the risk model's observation history.
  report(stateTime) {
    this.expire();
    return {ownship_id: this.ownId, state_time: stateTime,
            objects: [...this.tracks.values()].filter(t => t.sightings >= MIN_SIGHTINGS).map(t => ({
              track_id: String(t.track_id), class_name: t.class_name, kind: t.kind, confidence: t.confidence,
              latitude_deg: t.latitude_deg, longitude_deg: t.longitude_deg, altitude_m: t.altitude_m,
              position_ecef_m: t.position_ecef_m, sigma_m: t.sigma_m, heading_deg: t.heading_deg,
              velocity_ecef_mps: t.velocity_ecef_mps, range_m: t.range_m, sightings: t.sightings}))};
  }

  // Send the report, at most a few times a second, only while there is
  // something to say. Fire and forget: a lost report is one missed slot in
  // the history, which the model treats as a missed detection, not as truth.
  async publish(fetch, stateTime, now = this.now()) {
    if (!this.ownId || !Number.isFinite(stateTime) || now - this.lastReport < REPORT_INTERVAL_MS) return false;
    if (![...this.tracks.values()].some(t => t.sightings >= MIN_SIGHTINGS)) return false;
    this.lastReport = now;
    try {
      const response = await fetch('/api/perception/observations', {method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify(this.report(stateTime))});
      return Boolean(response?.ok);
    } catch { return false; }
  }
}
