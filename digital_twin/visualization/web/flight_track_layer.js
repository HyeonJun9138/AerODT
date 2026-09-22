// The path a UAM has already flown on the flight it is flying.
//
// Not a prediction and not an orbit: this is where the aircraft has been, and
// it is drawn only for the one that is selected. The twin keeps the track — the
// display fetches it, checks it and renders it, and never extends it with a
// position of its own.
//
// Drawn so it cannot be mistaken for the other two paths on this globe: a solid
// green line behind the aircraft, against the prediction's amber dashes ahead
// of it and a satellite's pale blue orbit.
const TRACK_COLOR = '#6fe3a8';
const REFRESH_MS = 3000;
const MAXIMUM_POINTS = 900;

export class FlightTrackLayer {
  constructor(C, viewer, {load, onSummary = () => {}, maximumPoints = MAXIMUM_POINTS,
      supports = entity => entity?.kind === 'uam', anchor = () => null,
      surfaceOffset = () => 0,
      now = () => globalThis.performance?.now?.() ?? Date.now()} = {}) {
    Object.assign(this, {C, viewer, load, onSummary, maximumPoints, supports, anchor, surfaceOffset, now});
    this.polylines = viewer.scene.primitives.add(new C.PolylineCollection());
    // A dirty polyline can rebuild its collection's buffers. Keep the moving
    // two-vertex tip separate from the (up to 900 vertex) recorded history.
    this.tipPolylines = viewer.scene.primitives.add(new C.PolylineCollection());
    this.tipLine = null;
    this.line = null; this.entityId = null; this.token = 0; this.fetchedAt = -Infinity;
    this.track = null; this.drawn = null; this.tip = null;
    this.pending=null;this.retryAt=0;this.failures=0;this.disposed=false;
  }

  material() {
    const color = this.C.Color.fromCssColorString(TRACK_COLOR);
    return this.C.Material.fromType('PolylineOutline', {
      color: color.withAlpha(.8), outlineColor: this.C.Color.BLACK.withAlpha(.4), outlineWidth: 1,
    });
  }

  // [longitude, latitude, altitude, time] rows, thinned to the cap. The oldest
  // are kept as they came: a track is only worth drawing as a whole shape.
  positions(points, references = null) {
    if (!Array.isArray(points) || points.length < 2) return null;
    const step = Math.ceil(points.length / this.maximumPoints);
    const result = [];
    const surfaces = Object.values(references ?? {}).filter((reference, index, all) =>
      reference && typeof reference.vertiport_id === 'string' && Number.isFinite(reference.altitude_m) &&
      all.findIndex(item => item?.vertiport_id === reference.vertiport_id) === index);
    const world = point => {
      const [longitude, latitude, altitude] = point;
      let displayAltitude = altitude;
      if (surfaces.length) {
        const cartographic = this.C.Cartographic?.fromDegrees
          ? this.C.Cartographic.fromDegrees(longitude, latitude, altitude)
          : {longitude: longitude * Math.PI / 180, latitude: latitude * Math.PI / 180, height: altitude};
        // A deck correction already fades to zero outside its own footprint and
        // low terminal column.  Summing distinct endpoint corrections therefore
        // picks the applicable end without inventing a mid-route datum switch.
        for (const reference of surfaces) {
          const offset = Number(this.surfaceOffset(reference, cartographic));
          if (Number.isFinite(offset)) displayAltitude += offset;
        }
      }
      return this.C.Cartesian3.fromDegrees(longitude, latitude, displayAltitude);
    };
    // The twin answers with the whole track every few seconds, and all but
    // its last few points are the ones it answered with last time. A point
    // converted under the same surface references is the same Cartesian, so
    // the converted prefix is kept and only what follows it is made: nine
    // hundred conversions, each with a surface correction per reference near
    // a deck, were a few milliseconds in the frame each answer landed in.
    const signature = step === 1 ? JSON.stringify(surfaces) : null;
    const kept = signature !== null && this.converted?.signature === signature ? this.converted : null;
    let reused = 0;
    if (kept) {
      const limit = Math.min(kept.raw.length, points.length);
      while (reused < limit) {
        const a = kept.raw[reused], b = points[reused];
        if (!Array.isArray(b) || b.length < 3 || a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) break;
        reused++;
      }
      for (let index = 0; index < reused; index++) result.push(kept.world[index]);
    }
    for (let index = reused; index < points.length; index += step) {
      const point = points[index];
      if (!Array.isArray(point) || point.length < 3) return null;
      const [longitude, latitude, altitude] = point;
      if (![longitude, latitude, altitude].every(Number.isFinite)) return null;
      result.push(world(point));
    }
    this.converted = signature === null ? null : {signature, raw: points.slice(0, result.length), world: result.slice()};
    // The last point is the aircraft's own: keep it whatever the thinning did.
    const last = points[points.length - 1];
    if (step > 1 && Array.isArray(last) && last.slice(0, 3).every(Number.isFinite)) {
      result.push(world(last));
    }
    return result.length >= 2 ? result : null;
  }

  draw(track) {
    const positions = this.positions(track?.points, track?.surface_references);
    if (!positions) {this.remove(); return false;}
    this.drawn = positions;
    if (this.line) this.line.positions = positions;
    else this.line = this.polylines.add({positions, width: 2.5, material: this.material()});
    this.updateTip(true);
    return true;
  }

  // The flown path, ending where the aircraft is being drawn this instant.
  //
  // The twin is asked for the track every few seconds, so the last point it
  // gave is always a little behind: the line stopped short and then jumped
  // forward when the next answer came, which at replay speed is hundreds of
  // metres at a time. The aircraft's own displayed position closes that gap and
  // slides with it, the same way the prediction ahead of it starts on the
  // aircraft rather than where it was when the projection was made. Nothing is
  // invented — this is where the aircraft is, not a guess about where it went.
  updateTip(force = false) {
    const before = this.tip;
    const anchor = this.anchor(this.entityId);
    const xyz = anchor?.displayPosition;
    const source = Array.isArray(xyz) ? {x: xyz[0], y: xyz[1], z: xyz[2]} : anchor;
    if (!source || ![source.x, source.y, source.z].every(Number.isFinite)) {
      this.tip = null;
      if (this.tipLine) {this.tipPolylines.remove(this.tipLine); this.tipLine = null;}
      return Boolean(before);
    }
    // Own the vertex: the renderer may reuse and mutate its position object.
    const at = {x: source.x, y: source.y, z: source.z};
    this.tip = at;
    const last = this.drawn?.at(-1);
    // Already there: a duplicated vertex would draw nothing and cost a redraw.
    if (!last || this.C.Cartesian3.distance(last, at) < .001) {
      const removed = Boolean(this.tipLine);
      if (this.tipLine) {this.tipPolylines.remove(this.tipLine); this.tipLine = null;}
      return removed;
    }
    if (!force && before && this.tipLine && this.C.Cartesian3.distance(before, at) <= .001) return false;
    const positions = [last, at];
    if (this.tipLine) this.tipLine.positions = positions;
    else this.tipLine = this.tipPolylines.add({positions, width: 2.5, material: this.material()});
    return true;
  }

  remove() {
    if (this.line) this.polylines.remove(this.line);
    if (this.tipLine) this.tipPolylines.remove(this.tipLine);
    this.tipLine = null; this.tip = null;
    this.line = null;
  }

  summaryOf(track) {
    const points = track?.points;
    if (!Array.isArray(points) || points.length < 2) return null;
    return {points: points.length, flightId: track.flight_id ?? null,
      flying: Boolean(track.flying), seconds: Number(points[points.length - 1][3]) - Number(points[0][3])};
  }

  // Called on selection and again on a timer while it stays selected: a track
  // grows behind a moving aircraft, so a drawn one goes stale in seconds.
  async show(entity, {force = false} = {}) {
    if(this.disposed)return;
    const id = entity?.entity_id ?? null;
    if (id === null || !this.supports(entity)) {this.clear(); return;}
    if(id===this.entityId && this.pending)return;
    if (id !== this.entityId) {this.remove(); this.track = null; this.fetchedAt = -Infinity;this.retryAt=0;this.failures=0;}
    this.entityId = id;
    if (!force && (this.now()<this.retryAt || this.now() - this.fetchedAt < REFRESH_MS)) return;
    const token = ++this.token;
    this.fetchedAt = this.now();
    let track = null;
    try {this.pending=Promise.resolve(this.load(id));track=await this.pending;} catch {track = null;}
    finally {if(token===this.token)this.pending=null;}
    // A slower earlier answer must not paint over the current selection.
    if (token !== this.token || this.entityId !== id) return;
    if(track==null){this.failures=Math.min(4,this.failures+1);this.retryAt=this.now()+Math.min(30000,REFRESH_MS*2**this.failures);}
    else {this.failures=0;this.retryAt=0;}
    this.track = track;
    if (!this.draw(track)) {this.onSummary(null); return;}
    this.onSummary(this.summaryOf(track));
    this.viewer.scene.requestRender?.();
  }

  // Driven from the render loop, so a track that is being flown keeps up.
  //
  // Two rates, because the two halves of the line move at different speeds: the
  // history behind the aircraft only changes when the twin is asked again,
  // while the end of the line follows the aircraft every frame.
  update() {
    let moved = false;
    if (this.line && this.drawn) {
      moved = this.updateTip();
    }
    if (!this.pending && this.entityId && this.now()>=this.retryAt && this.now() - this.fetchedAt >= REFRESH_MS) {
      void this.show({entity_id: this.entityId, kind: 'uam'});
      moved = true;
    }
    return moved;
  }

  clear() {
    this.token++; this.entityId = null; this.track = null; this.fetchedAt = -Infinity;
    this.pending=null;this.retryAt=0;this.failures=0;
    this.drawn = null; this.tip = null;
    this.remove(); this.onSummary(null);
  }

  destroy() {
    this.disposed=true;
    this.clear();
    this.viewer.scene.primitives.remove(this.polylines);
    this.viewer.scene.primitives.remove(this.tipPolylines);
    this.tipPolylines = null;
    this.polylines = null;
  }
}
