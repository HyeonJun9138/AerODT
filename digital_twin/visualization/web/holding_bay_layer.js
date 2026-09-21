// The place the service told this pilot to wait, drawn where they can fly to it.
//
// A hold used to be a number in a panel -- "착륙 슬롯까지 4475초" -- over open
// sky. The service knows the bay it reserved and where the aircraft rejoins the
// approach from it; both are places, and a place belongs on the map.
//
// Three things are drawn, and no more: the bay, a line to it from wherever the
// aircraft is now, and the point it goes back to when the slot comes round.
// Everything is an Entity rather than a Primitive because all of it moves or
// disappears with the clearance, and a distanceDisplayCondition is deliberately
// not used -- on this Cesium build it drops dynamic geometry out of the scene.

const AMBER = [1, .82, .4];
const GREEN = [.56, .89, .78];

export class HoldingBayLayer {
  constructor(C, viewer, {read, aircraft}) {
    Object.assign(this, {C, viewer, read, aircraft});
    this.entities = [];
    this.slot = null;
    this.disposed = false;
  }

  colour(rgb, alpha = 1) {
    return new this.C.Color(rgb[0], rgb[1], rgb[2], alpha);
  }

  position(point) {
    return this.C.Cartesian3.fromDegrees(point[1], point[0], point[2]);
  }

  // Where the aircraft is this frame, or null when nothing is flying.
  here() {
    const at = this.aircraft?.()?.position;
    if (!at || !Number.isFinite(at.latitude) || !Number.isFinite(at.longitude)) return null;
    return this.C.Cartesian3.fromDegrees(at.longitude, at.latitude, at.altitude_m ?? 0);
  }

  clear() {
    for (const entity of this.entities) this.viewer.entities.remove(entity);
    this.entities = [];
    this.slot = null;
  }

  // `hold` is what the service is saying: {slot, fix:[lat,lon,alt], rejoin:[...]}.
  // Redrawn only when the place changes, so the scene is not rebuilt every tick.
  update() {
    if (this.disposed) return;
    const hold = this.read?.();
    const fix = hold?.fix;
    if (!hold?.slot || !Array.isArray(fix) || fix.length < 3 || !fix.every(Number.isFinite)) {
      if (this.slot !== null) this.clear();
      return;
    }
    if (hold.slot === this.slot) return;
    this.clear();
    this.slot = hold.slot;
    const C = this.C, add = options => {
      const entity = this.viewer.entities.add(options);
      this.entities.push(entity);
      return entity;
    };
    const bay = this.position(fix);
    const name = String(hold.slot).split('/').pop();

    // A post from the ground to the bay: a point in the sky is impossible to
    // judge the height of, and impossible to find at all from above.
    add({polyline: {positions: [this.position([fix[0], fix[1], 0]), bay],
      width: 2, material: new C.PolylineDashMaterialProperty({
        color: this.colour(AMBER, .55), dashLength: 12})}});
    // The deck-level footprint, so it can be found by looking down.
    add({position: this.position([fix[0], fix[1], 0]),
      ellipse: {semiMajorAxis: 28, semiMinorAxis: 28, height: 0,
        material: this.colour(AMBER, .1), outline: true, outlineColor: this.colour(AMBER, .7)}});
    // The bay itself, named, at the height it is held at.
    add({position: bay,
      point: {pixelSize: 11, color: this.colour(AMBER, .95),
        outlineColor: C.Color.BLACK.withAlpha(.6), outlineWidth: 2},
      label: {text: `대기점 ${name}\n${Math.round(fix[2])} m`, font: '600 13px sans-serif',
        fillColor: this.colour(AMBER), outlineColor: C.Color.BLACK, outlineWidth: 3,
        style: C.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new C.Cartesian2(0, -22),
        verticalOrigin: C.VerticalOrigin.BOTTOM}});

    // The way there from wherever the aircraft is now, redrawn each frame.
    add({polyline: {width: 2, material: this.colour(AMBER, .8),
      positions: new C.CallbackProperty(() => {
        const from = this.here();
        return from ? [from, bay] : [];
      }, false)}});

    const rejoin = hold.rejoin;
    if (Array.isArray(rejoin) && rejoin.length >= 3 && rejoin.every(Number.isFinite)) {
      // And where it goes when the slot comes round, so the wait has an exit
      // on screen rather than only in the text.
      const point = this.position(rejoin);
      add({position: point,
        point: {pixelSize: 8, color: this.colour(GREEN, .9),
          outlineColor: C.Color.BLACK.withAlpha(.6), outlineWidth: 2},
        label: {text: '접근 재개', font: '600 12px sans-serif', fillColor: this.colour(GREEN),
          outlineColor: C.Color.BLACK, outlineWidth: 3, style: C.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new C.Cartesian2(0, -18), verticalOrigin: C.VerticalOrigin.BOTTOM}});
      add({polyline: {positions: [bay, point], width: 2,
        material: new C.PolylineDashMaterialProperty({color: this.colour(GREEN, .6), dashLength: 10})}});
    }
  }

  destroy() {
    this.clear();
    this.disposed = true;
  }
}
