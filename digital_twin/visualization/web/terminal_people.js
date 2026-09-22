// The people in the terminal.
//
// A pool of bodies reused across refreshes, in the same idiom as the day's
// boarding walks (`scenario_passengers.js`): one model per slot, hidden when
// not needed, never rebuilt because the schedule moved. Only one terminal is
// ever occupied -- the pilot can be in exactly one building -- so the pool is
// small and is filled when they step onto that deck rather than when they open
// the door, which is the moment they are standing still.
//
// Who is here and why is decided in `terminal_board.js` from the board's own
// rows. This only puts bodies where it is told.

// Bodies. Enough to read as a terminal at a quiet hour and not so many that
// walking in costs a second of model loading.
export const PEOPLE_BUDGET = 40;
// The Kenney figures are 2.7 m tall as authored, and people are not all one
// height: each slot is a little taller or shorter than 1.75 m, so a queue
// reads as people rather than as copies of one person.
const MODEL_M = 2.7, NOMINAL_M = 1.75;
// A blocky figure has no sitting pose. Sunk by this much at a seat its head
// lands at about the height a seated head is, which is what reads as seated
// from across a concourse; standing it on the bench would not.
const SEATED_SINK_M = 0.42;

export class TerminalPeople {
  constructor(C, scene, {assets = () => null, budget = PEOPLE_BUDGET, warning = () => {}} = {}) {
    Object.assign(this, {C, scene, assets, budget, warning});
    this.models = scene?.primitives && C?.PrimitiveCollection
      ? scene.primitives.add(new C.PrimitiveCollection()) : null;
    this.slots = []; this.loading = false; this.failed = false; this.disposed = false;
    this.shown = 0;
  }

  get ready() {return this.slots.length;}

  /** Build the pool. Safe to call again; it fills up to the budget and stops. */
  async fill(assetId = 'kenney_blocky_person_a') {
    const C = this.C;
    if (!this.models || this.loading || this.failed || this.disposed) return this.slots.length;
    if (this.slots.length >= this.budget) return this.slots.length;
    const asset = this.assets(assetId);
    if (!asset?.uri) return this.slots.length;          // the catalogue may still be loading
    this.loading = true;
    try {
      for (let index = this.slots.length; index < this.budget; index += 1) {
        const height = NOMINAL_M + ((index * 7) % 11 - 5) * 0.02;
        const scale = height / MODEL_M;
        const model = await C.Model.fromGltfAsync({url: asset.uri, show: false,
          modelMatrix: C.Matrix4.IDENTITY.clone(), scale, minimumPixelSize: 0, maximumScale: scale,
          forwardAxis: C.Axis.Z, upAxis: C.Axis.Y, id: {aerodtTerminalPerson: {index}}});
        if (this.disposed) {model.destroy?.(); return this.slots.length;}
        this.slots.push({model: this.models.add(model), matrix: new C.Matrix4(), height});
      }
      this.scene?.requestRender?.();
    } catch {
      this.failed = true;
      this.warning('터미널 인원 모델을 불러오지 못했습니다. 시간표와 운항은 그대로 진행합니다.');
    } finally {this.loading = false;}
    return this.slots.length;
  }

  /** Stand these people on this floor. `people` is local metres from the plan. */
  show(people, frame, floorHeight) {
    const C = this.C;
    if (!this.models || !frame || !Number.isFinite(floorHeight)) return 0;
    const list = Array.isArray(people) ? people : [];
    let drawn = 0;
    for (const slot of this.slots) {
      const person = list[drawn];
      if (!person || !Array.isArray(person.at)) {slot.model.show = false; continue;}
      const height = floorHeight - (person.seated ? SEATED_SINK_M : 0);
      const origin = C.Cartesian3.fromDegrees(frame.longitude, frame.latitude, height);
      const enu = C.Transforms.eastNorthUpToFixedFrame(origin);
      const point = C.Matrix4.multiplyByPoint(enu,
        new C.Cartesian3(person.at[0], person.at[1], 0), new C.Cartesian3());
      // Kenney faces glTF +Z, which `forwardAxis: Z` maps onto the frame's
      // east; the quarter turn is what makes a heading of 0 face north.
      C.Transforms.headingPitchRollToFixedFrame(point,
        new C.HeadingPitchRoll(C.Math.toRadians((person.heading ?? 0) - 90), 0, 0),
        undefined, undefined, slot.matrix);
      C.Matrix4.clone(slot.matrix, slot.model.modelMatrix);
      slot.model.show = true;
      drawn += 1;
    }
    this.shown = drawn;
    this.scene?.requestRender?.();
    return drawn;
  }

  hide() {
    for (const slot of this.slots) slot.model.show = false;
    this.shown = 0;
    this.scene?.requestRender?.();
  }

  destroy() {
    this.disposed = true;
    if (this.models) this.scene?.primitives?.remove(this.models);
    this.models = null; this.slots = []; this.shown = 0;
  }
}
