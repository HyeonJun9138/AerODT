// The moving parts of an airframe whose model does not animate any of them:
// propellers that turn, and — on a tiltrotor — the ducts that swing them from
// lifting to pulling as the aircraft transitions.
//
// None of the UAM models in the library carries an animation, so the blades sit
// still and the ducts stay up however the aircraft is flying. What they do carry
// is those parts as their own nodes, and the library records which nodes they
// are, which way each propeller goes round, and which axis the ducts hinge on —
// all read off the export and off the vehicle model package the airframe came
// from, none of it chosen here. This moves them.
//
// A part is written as its own authored matrix with the movement inserted, never
// as last frame's result with a little more added: compounding matrices frame
// after frame drifts the parts off their mounts over a long flight.
//
// Where the movement is inserted is the whole of the arithmetic:
//
//   position × hinge × (the part's own orientation) × spin
//
// The hinge goes on the *outside* of the part's own rotation because that is how
// the vehicle model states it — the tilt axis is given in the airframe's
// coordinates, not the duct's, and these ducts are canted, so applying it inside
// would swing them about their own canted axis instead of the aircraft's lateral
// one. The spin goes on the inside, because a propeller turns about its own
// shaft wherever the duct has carried it.
//
// How fast the blades look is a display decision and is written as one. A rotor
// of this class turns something like twenty times a second, which no sixty-frame
// display can draw: sampled that fast the blades stand still or crawl backwards,
// which reads as broken rather than fast. So the angle advances in real seconds
// at a legible rate that rises with the rotor speed the simulation actually
// produced, and is capped where it stops being readable. The tilt is not scaled
// like that: it is the angle the simulation's tilt actuators reached, drawn as
// it is.

// The fastest the blades are drawn turning, in radians of real time a second.
// Four turns a second: twice the previous visual rate, without using physical
// rotor RPM directly (which aliases heavily on ordinary displays).
export const VISIBLE_MAX_RADPS = 8 * Math.PI;
// Airborne presentation is deliberately much faster than ground spool-up.
// This remains an animation rate, not a change to measured actuator RPM.
export const FLIGHT_MAX_RADPS = 24 * Math.PI;
export const FLIGHT_FULL_SCALE_RADPS = 300;
// The rotor speed that reaches that cap. Above it the blades cannot look any
// faster, which is a limit of the display, not of the aircraft. Measured off
// the native engine: this airframe's actuators hold about 270 rad/s in a steady
// climb and reach 550 accelerating, so the whole flown range is legible.
export const FULL_SCALE_RADPS = 550;
// What a rotor is doing when nothing measured it: the airframe is flying, so
// the blades turn, but the state carries no rotor speed of its own and this is
// an indication rather than a reading. A run flown by the native engine
// replaces it with what the rotor actuators actually did.
export const ASSUMED_RADPS = 300;
// The most real time one frame may advance the blades by. A tab that was in the
// background for a minute comes back to a frame a minute long, and without this
// the blades would jump. Deliberately not a whole turn at the fastest rate —
// half of one — so a long stall resumes somewhere visibly different rather than
// landing back exactly where it left off, which looks like nothing happened.
export const MAX_STEP_S = 1 / 24;

export const AXIS_ROTATION = {x: 'fromRotationX', y: 'fromRotationY', z: 'fromRotationZ'};
const rotationFor = name => AXIS_ROTATION[String(name || '').toLowerCase()] ?? null;

// How fast to draw the blades turning, given what the rotors are really doing.
// A stopped rotor is drawn stopped: an aircraft parked at a stand should look
// parked, not idling.
export function visibleRate(radiansPerSecond, flying = false) {
  const real = Number(radiansPerSecond);
  if (!Number.isFinite(real) || real <= 0) return 0;
  if (flying) {
    const share = Math.min(1, real / FLIGHT_FULL_SCALE_RADPS);
    // Smooth ramp at startup; no nonzero minimum that would jump at ignition.
    return share * share * (3 - 2 * share) * FLIGHT_MAX_RADPS;
  }
  return Math.min(1, real / FULL_SCALE_RADPS) * VISIBLE_MAX_RADPS;
}

export function flightSpinOf(sample) {
  if (!sample || sample.motor_state === 'off' || sample.motor_state === 'shutdown'
      || sample.stage === 'charge' || sample.kind === 'ground') return false;
  return sample.airborne === true || sample.kind === 'air' || sample.kind === 'vertical';
}

// The rotor speed a sample implies. A flown state carries what the rotor
// actuators reached; one integrated from a plan carries no rotors at all, so
// the airframe is taken to be turning them whenever it is off its wheels.
export function rateOf(sample) {
  const measured = sample?.rotor_radps == null ? NaN : Number(sample.rotor_radps);
  if (Number.isFinite(measured) && measured >= 0) return measured;
  if (!sample) return 0;
  if (Number.isFinite(sample.rotor_visual_radps)) return Math.max(0, sample.rotor_visual_radps);
  if (sample.stage === 'charge' || sample.speed_mps === 0) return 0;
  return sample.airborne || sample.kind === 'air' || sample.kind === 'vertical' ? ASSUMED_RADPS : 0;
}

// Where the ducts are pointing, in radians. Every state carries the tilt its
// actuators reached — nought lifting, ninety degrees pulling — so this is a
// reading rather than a guess, and a state without one leaves them lifting.
export function tiltOf(sample) {
  const degrees = Number(sample?.tilt_deg);
  return Number.isFinite(degrees) ? degrees * Math.PI / 180 : 0;
}

export class RotorSpin {
  // `rotors` is the library's own record: {axis, nodes:[{name, turn}], tilt?}.
  constructor(C, rotors) {
    this.C = C;
    this.spinAxis = rotationFor(rotors?.axis) ?? AXIS_ROTATION.y;
    const tilt = rotors?.tilt ?? null;
    this.tiltAxis = tilt ? rotationFor(tilt.axis) ?? AXIS_ROTATION.z : null;
    this.tiltSign = Number(tilt?.sign) < 0 ? -1 : 1;
    this.spinning = (rotors?.nodes ?? []).filter(node => node?.name);
    this.tilting = new Map((tilt?.nodes ?? []).filter(Boolean).map(n => typeof n === 'string' ? [n, {}] : [n.name, n]));
    this.parts = [];
    this.angle = 0;
    this.tilt = 0;
    this.missing = [];
    this.turn = new C.Matrix3();
    this.hinge = new C.Matrix3();
    this.orientation = new C.Matrix3();
  }

  get attached() {return this.parts.length > 0;}
  // How many of the parts move each way, which is what a test can check without
  // reaching into the matrices.
  get counts() {
    return {spinning: this.parts.filter(part => part.turn !== 0).length,
      tilting: this.parts.filter(part => part.tilts).length, total: this.parts.length};
  }

  // Find the moving parts in a loaded model and keep, for each, the place and
  // the orientation the model authored it with. Movement is composed from those
  // every frame rather than accumulated onto the last frame's matrix.
  attach(model) {
    const C = this.C;
    this.parts = [];
    this.missing = [];
    if (!model || typeof model.getNode !== 'function') return 0;
    const wanted = new Map();
    for (const node of this.spinning) wanted.set(node.name, Number(node.turn) < 0 ? -1 : 1);
    for (const name of this.tilting.keys()) if (!wanted.has(name)) wanted.set(name, 0);
    for (const [name, turn] of wanted) {
      const node = model.getNode(name);
      if (!node) {this.missing.push(name); continue;}
      const authored = C.Matrix4.clone(node.originalMatrix ?? node.matrix, new C.Matrix4());
      const spec = this.tilting.get(name);
      const spinSpec = this.spinning.find(s => s.name === name);
      this.parts.push({node, turn, tilts: this.tilting.has(name),
        spinAxis: rotationFor(spinSpec?.axis) ?? this.spinAxis,
        stopTilt: Number.isFinite(spinSpec?.stop_at_tilt_deg)
          ? spinSpec.stop_at_tilt_deg * Math.PI / 180 : Infinity,
        startTilt: Number.isFinite(spinSpec?.start_at_tilt_deg)
          ? spinSpec.start_at_tilt_deg * Math.PI / 180 : -Infinity,
        angle: this.angle,
        tiltAxis: rotationFor(spec?.axis) ?? this.tiltAxis,
        tiltSign: spec?.sign == null ? this.tiltSign : (Number(spec.sign) < 0 ? -1 : 1),
        tiltOffset: Number(spec?.offset_deg || 0) * Math.PI / 180,
        // Split once: where it sits, and how it is turned where it sits.
        origin: C.Matrix4.getTranslation(authored, new C.Cartesian3()),
        basis: C.Matrix4.getMatrix3(authored, new C.Matrix3()),
        rotation: new C.Matrix3(), out: new C.Matrix4()});
    }
    if (this.parts.length) this.write();
    return this.parts.length;
  }

  detach() {this.parts = []; this.angle = 0; this.tilt = 0;}

  // Advance the blades by however much real time has passed, and put the ducts
  // where the aircraft's tilt actuators have them. Returns true when something
  // moved, so the caller can ask for a frame only when it did.
  advance(seconds, radiansPerSecond, tiltRadians = this.tilt, flying = false) {
    if (!this.parts.length) return false;
    const step = Number(seconds);
    const rate = visibleRate(radiansPerSecond, flying);
    const tilt = Number.isFinite(tiltRadians) ? tiltRadians : this.tilt;
    const turned = Number.isFinite(step) && step > 0 && rate > 0;
    const tilted = Math.abs(tilt - this.tilt) > 1e-6;
    if (!turned && !tilted) return false;
    if (turned) {
      // Held inside one turn: an angle that only ever grows loses its precision
      // on a long flight, and a blade at 4,000 radians is a blade that judders.
      const delta = rate * Math.min(step, MAX_STEP_S);
      this.angle = (this.angle + delta) % (Math.PI * 2);
      // Model-specific display policy only: keep the stopped blade phase, so
      // returning to lift never snaps it to the front propellers' phase.
      for (const part of this.parts) {
        if (part.turn && tilt < part.stopTilt && tilt >= part.startTilt)
          part.angle = (part.angle + delta) % (Math.PI * 2);
      }
    }
    this.tilt = tilt;
    return this.write();
  }

  write() {
    const C = this.C;let changed=false;
    for (const part of this.parts) {
      const angle = this.tilt * part.tiltSign + part.tiltOffset;
      const phase=part.turn===0?0:(Number.isFinite(part.stopTilt)||Number.isFinite(part.startTilt)?part.angle:this.angle)*part.turn;
      const hingeAngle=part.tilts && part.tiltAxis?angle:0;
      // Cesium marks the whole model's node hierarchy dirty on a matrix write.
      // A stationary duct or a stopped lift prop has no new transform to upload.
      if(part.lastPhase===phase && part.lastHinge===hingeAngle)continue;
      part.lastPhase=phase;part.lastHinge=hingeAngle;changed=true;
      const hinged = part.tilts && part.tiltAxis && Math.abs(angle) > 1e-9;
      if (hinged) C.Matrix3[part.tiltAxis](angle, this.hinge);
      // The duct's hinge first, outside the part's own orientation, because the
      // vehicle model gives that axis in the airframe's coordinates.
      const oriented = part.tilts && hinged
        ? C.Matrix3.multiply(this.hinge, part.basis, this.orientation)
        : part.basis;
      // Then the propeller's own turn, inside, about the shaft the duct is now
      // holding.
      if (part.turn !== 0) {
        C.Matrix3[part.spinAxis](phase, this.turn);
        C.Matrix3.multiply(oriented, this.turn, part.rotation);
      } else {
        C.Matrix3.clone(oriented, part.rotation);
      }
      part.node.matrix = C.Matrix4.fromRotationTranslation(part.rotation, part.origin, part.out);
    }
    return changed;
  }
}
