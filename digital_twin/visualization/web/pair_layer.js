// Visualization: the origin–destination pairs a multi-flight setup is working
// with, drawn as one line between two decks. The layer draws what it is handed
// and says which line a click landed on; whether a pair carries demand is the
// panel's business, not the map's.
//
// The lines stand well above the decks so they read as a network rather than as
// a route: these are not flight paths and must not be mistaken for them.

export const PAIR_HEIGHT_M = 420;
export const CUT_LIFT_M = 260;
// Joined is the map's own live colour; cut is a warning colour, because a cut
// pair is a decision the operator made and has to be able to find again. Grey
// would read as "not drawn yet" rather than as "I removed this".
export const KEPT_COLOR = '#7fe9f5';
export const BROKEN_COLOR = '#ff8a94';
// Everything joined to everything is a lot of lines: eighteen vertiports make
// a hundred and fifty-three. Drawn at full strength they read as a wall, so the
// whole network is deliberately quiet and the selected facility's own lines are
// what stands out.
const KEPT_WIDTH = 2.8, FOCUS_WIDTH = 5, FAINT_WIDTH = 1.4, BROKEN_WIDTH = 2.6;
// Far enough that a city-wide network is still visible from a high view, near
// enough that the lines are gone once the camera is down among the buildings.
export const PAIR_FAR_METRES = 600000;
export const PAIR_NEAR_METRES = 400;

export class PairLayer {
  // `placeOf(id)` answers where a vertiport stands — {longitude, latitude,
  // height} — or null when the map has not placed it yet.
  constructor(C, viewer, {placeOf = () => null} = {}) {
    this.C = C; this.entities = viewer.entities; this.placeOf = placeOf;
    this.owned = []; this.pairs = []; this.focus = null; this.visible = true;
  }
  within() {
    const C = this.C;
    return C.DistanceDisplayCondition ? new C.DistanceDisplayCondition(PAIR_NEAR_METRES, PAIR_FAR_METRES) : undefined;
  }
  color(css, alpha) {return this.C.Color.fromCssColorString(css).withAlpha(alpha);}
  clear() {
    for (const entity of this.owned) this.entities.remove(entity);
    this.owned = [];
  }
  setVisible(visible) {
    this.visible = Boolean(visible);
    for (const entity of this.owned) entity.show = this.visible;
    return this.owned.length > 0;
  }
  // `focus` is the vertiport the list has selected: its own lines are drawn
  // full strength and the rest fade back, so one facility's connections can be
  // read out of a network that joins everything to everything.
  show(pairs = [], {focus = null} = {}) {
    this.clear();
    this.pairs = pairs; this.focus = focus ?? null;
    const C = this.C;
    for (const pair of pairs) {
      const from = this.placeOf(pair.from), to = this.placeOf(pair.to);
      if (!from || !to) continue;
      // Cut pairs ride a little higher than the rest. Eighteen vertiports joined
      // to each other are a hundred and fifty-three crossing lines, and a cut
      // one drawn among them is buried whatever colour it is; lifted clear, it
      // reads as what it is - a decision taken out of the network.
      const height = Math.max(from.height ?? 0, to.height ?? 0) + PAIR_HEIGHT_M + (pair.kept ? 0 : CUT_LIFT_M);
      const focused = Boolean(focus);
      const mine = !focused || pair.from === focus || pair.to === focus;
      const css = pair.kept ? KEPT_COLOR : BROKEN_COLOR;
      // A cut pair is drawn a little stronger than a kept one at the same
      // distance: there are far fewer of them and they are what is being checked.
      // Measured over V-World satellite imagery: below about 0.7 a cyan line
      // disappears into a bright city, which defeats the point of drawing the
      // whole network at once.
      const alpha = pair.kept ? (focused ? (mine ? 0.95 : 0.16) : 0.78) : (focused ? (mine ? 0.98 : 0.22) : 0.85);
      const width = pair.kept ? (focused ? (mine ? FOCUS_WIDTH : FAINT_WIDTH) : KEPT_WIDTH) : BROKEN_WIDTH;
      // A cut pair is still drawn, dashed: the operator has to see what is not
      // joined to click it back on.
      const material = pair.kept || !C.PolylineDashMaterialProperty
        ? this.color(css, alpha)
        : new C.PolylineDashMaterialProperty({color: this.color(css, alpha), dashLength: 18});
      const entity = this.entities.add({
        polyline: {positions: C.Cartesian3.fromDegreesArrayHeights([from.longitude, from.latitude, height, to.longitude, to.latitude, height]),
          width, material, distanceDisplayCondition: this.within()},
        aerodtPair: {key: pair.key, from: pair.from, to: pair.to, kept: pair.kept},
      });
      entity.show = this.visible;
      this.owned.push(entity);
    }
    return this.owned.length;
  }
  pick(picked) {
    const id = picked?.id;
    return id?.aerodtPair ? {...id.aerodtPair} : null;
  }
}
