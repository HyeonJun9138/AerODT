// Standing on the deck, on foot.
//
// The cockpit camera is bolted to a model matrix and the orbit camera looks at
// the world from outside it. This one is neither: it is a person, at eye height
// above a surface, who can only be where that surface is. Everything about it
// follows from that last clause -- there is no flying, no clipping through the
// edge, and no height of its own to get wrong, because the deck says what the
// height is.
//
// The walkable surface is the one the aircraft already lands on:
// `VertiportLayer.contactDecks()` answers `{id, height_m, outline}` per deck,
// the same polygons the manual flight uses for touchdown contact. Using them
// here means a pilot cannot walk somewhere their aircraft could not have
// stood, and there is no second definition of the deck to drift out of step.
//
// The geometry is kept apart from the camera on purpose: the rules about where
// a person may be are worth testing without standing up a globe, and they are
// the part that is easy to get wrong.

export const EYE_M = 1.62;        // eye height of a standing adult, not the top of the head
export const WALK_MPS = 1.4;      // an unhurried walk
export const RUN_MPS = 3.1;
export const TURN_DPS = 110;      // degrees a second at full deflection
export const PITCH_LIMIT_DEG = 72;
const METRES_PER_DEGREE = 111320;

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const finite = Number.isFinite;

/** Metres per degree of longitude at this latitude. */
export function eastScale(latitude) {
  return METRES_PER_DEGREE * Math.cos(latitude * Math.PI / 180);
}

/** Whether a point is inside one ring, by the crossing count of a ray east. */
export function insideRing(ring, longitude, latitude) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > latitude) === (yj > latitude)) continue;
    if (longitude < (xj - xi) * (latitude - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The floor a point stands on at this level, or null where there is none.
 *
 * The level matters because the terminal storey is directly beneath the deck:
 * a longitude and latitude is inside both of them, and which one you are on is
 * a fact about the person rather than about the point.
 */
export function deckUnder(decks, longitude, latitude, level = null) {
  for (const deck of decks ?? []) {
    const ring = deck?.outline;
    if (!Array.isArray(ring) || ring.length < 3) continue;
    if (level != null && (deck.level ?? 0) !== level) continue;
    if (insideRing(ring, longitude, latitude)) return deck;
  }
  return null;
}

/** Whatever was passed as the world, as the world. */
function worldOf(given) {
  if (Array.isArray(given)) return {surfaces: given, links: [], blocks: []};
  return {surfaces: given?.surfaces ?? [], links: given?.links ?? [], blocks: given?.blocks ?? []};
}

/** Whether something solid stands at this point on this level.
 *
 * A shop, a bench, a screening wall. They are refused the same way the edge of
 * the deck is -- the move is not taken at all -- so there is one rule about
 * where a person may be and not two that can disagree.
 */
export function blockedAt(blocks, longitude, latitude, level) {
  for (const block of blocks ?? []) {
    if ((block?.level ?? 0) !== level) continue;
    const ring = block?.outline;
    if (Array.isArray(ring) && ring.length > 2 && insideRing(ring, longitude, latitude)) return block;
  }
  return null;
}

/** The way off this level a point is standing in, if any. */
export function linkAt(links, longitude, latitude, level) {
  for (const link of links ?? []) {
    if ((link?.from ?? 0) !== level) continue;
    const ring = link?.outline;
    if (Array.isArray(ring) && ring.length > 2 && insideRing(ring, longitude, latitude)) return link;
  }
  return null;
}

/** One step of walking. Returns the pose to be in, never a pose off the deck.
 *
 * The horizontal move is accepted or refused whole. Sliding along an edge would
 * be kinder to walk against, but it is also how a person ends up somewhere the
 * floor merely appears to reach -- and the first thing anyone does on a deck
 * 120 m above the ground is walk at the edge to look over it.
 */
export function stepPose(pose, seconds, input = {}, given = []) {
  const {surfaces: decks, links, blocks} = worldOf(given);
  const level = pose.level ?? 0;
  const dt = clamp(finite(seconds) ? seconds : 0, 0, .25);
  const turn = clamp(input.turn ?? 0, -1, 1);
  const heading = (pose.heading + turn * TURN_DPS * dt + 360) % 360;
  const pitch = clamp((pose.pitch ?? 0) + (input.pitch ?? 0) * TURN_DPS * dt,
    -PITCH_LIMIT_DEG, PITCH_LIMIT_DEG);
  const forward = clamp(input.forward ?? 0, -1, 1), strafe = clamp(input.strafe ?? 0, -1, 1);
  const travel = Math.hypot(forward, strafe);
  const next = {...pose, heading, pitch};
  if (travel < 1e-3) return next;
  // Walking backwards is a shuffle, not a run, whatever the button says.
  const speed = (input.run && forward > 0 ? RUN_MPS : WALK_MPS) * Math.min(1, travel);
  const radians = heading * Math.PI / 180;
  const north = (forward * Math.cos(radians) - strafe * Math.sin(radians)) * speed * dt;
  const east = (forward * Math.sin(radians) + strafe * Math.cos(radians)) * speed * dt;
  const latitude = pose.latitude + north / METRES_PER_DEGREE;
  const longitude = pose.longitude + east / eastScale(pose.latitude);
  const deck = deckUnder(decks, longitude, latitude, level);
  if (!deck) return next;
  // A stair is walked into on purpose; anything else solid is walked into by
  // accident, and stops you where you are.
  if (blockedAt(blocks, longitude, latitude, level) && !linkAt(links, longitude, latitude, level)) return next;
  const moved = {...next, longitude, latitude, height: deck.height_m, deck: deck.id, level};
  // Walking into a stair takes you to the other end of it. The landing is put
  // clear of the core's own footprint by the layout, so nobody arrives standing
  // in the way they came and is carried straight back.
  const stair = linkAt(links, longitude, latitude, level);
  if (!stair) return moved;
  const floor = deckUnder(decks, stair.exit?.longitude ?? longitude, stair.exit?.latitude ?? latitude, stair.to);
  if (!floor) return moved;
  return {...moved, level: stair.to, deck: floor.id, height: floor.height_m,
    longitude: stair.exit?.longitude ?? longitude, latitude: stair.exit?.latitude ?? latitude,
    through: stair.id};
}

/** Where a person standing at an aircraft's door is, in world terms. */
export function doorStep(sample, door = {}, decks = []) {
  const at = sample?.position;
  if (!at || !finite(at.latitude) || !finite(at.longitude)) return null;
  // The door offsets are the airframe's own: forward along the nose, right off
  // the starboard side. A step out is those plus a pace clear of the skin.
  const heading = (finite(sample.heading_deg) ? sample.heading_deg : 0) * Math.PI / 180;
  const ahead = (door.forward_m ?? 0), side = (door.right_m ?? 0) + 1.1;
  const north = ahead * Math.cos(heading) - side * Math.sin(heading);
  const east = ahead * Math.sin(heading) + side * Math.cos(heading);
  const latitude = at.latitude + north / METRES_PER_DEGREE;
  const longitude = at.longitude + east / eastScale(at.latitude);
  const {surfaces} = worldOf(decks);
  const deck = deckUnder(surfaces, longitude, latitude, 0) ?? deckUnder(surfaces, at.longitude, at.latitude, 0);
  if (!deck) return null;
  // Facing the aircraft, which is what you are looking at when you step down.
  return {longitude, latitude, height: deck.height_m, deck: deck.id, level: 0,
    heading: ((finite(sample.heading_deg) ? sample.heading_deg : 0) + 270) % 360, pitch: -6};
}

export class WalkCamera {
  constructor({viewer, C} = {}) {
    Object.assign(this, {viewer, C});
    this.active = false; this.pose = null; this.decks = []; this.world = {surfaces: [], links: []};
    this.saved = null;
  }

  setDecks(world) {this.world = worldOf(world); this.decks = this.world.surfaces;}

  /** Stand up at a pose. Answers false when there is nothing to stand on. */
  enter(pose, world = this.world) {
    const camera = this.viewer?.camera, C = this.C;
    if (!camera || !C || !pose || !finite(pose.longitude) || !finite(pose.latitude)) return false;
    this.setDecks(world);
    if (!deckUnder(this.decks, pose.longitude, pose.latitude, pose.level ?? 0)) return false;
    if (this.active) this.exit();
    const inputs = this.viewer.scene?.screenSpaceCameraController;
    this.saved = {
      destination: C.Cartesian3.clone(camera.positionWC),
      orientation: {direction: C.Cartesian3.clone(camera.directionWC), up: C.Cartesian3.clone(camera.upWC)},
      inputs: inputs ? {enableRotate: inputs.enableRotate, enableTranslate: inputs.enableTranslate,
        enableZoom: inputs.enableZoom, enableTilt: inputs.enableTilt, enableLook: inputs.enableLook} : null,
      transform: C.Matrix4 ? C.Matrix4.clone(camera.transform) : null,
    };
    // The mouse belongs to looking around, not to orbiting a globe that is now
    // under the operator's feet.
    if (inputs) for (const key of Object.keys(this.saved.inputs)) inputs[key] = false;
    this.pose = {heading: 0, pitch: 0, level: 0, ...pose};
    this.active = true;
    this.apply();
    return true;
  }

  /** One frame. `seconds` is real time, because a person walks in real time
   *  whatever the day's clock is doing. */
  step(seconds, input) {
    if (!this.active || !this.pose) return null;
    this.pose = stepPose(this.pose, seconds, input, this.world);
    this.apply();
    return this.pose;
  }

  apply() {
    const camera = this.viewer?.camera, C = this.C, pose = this.pose;
    if (!camera || !C || !pose) return;
    camera.setView({
      destination: C.Cartesian3.fromDegrees(pose.longitude, pose.latitude, pose.height + EYE_M),
      orientation: {heading: C.Math.toRadians(pose.heading), pitch: C.Math.toRadians(pose.pitch), roll: 0},
      endTransform: C.Matrix4?.IDENTITY,
    });
  }

  exit() {
    if (!this.active) return false;
    this.active = false;
    const camera = this.viewer?.camera, saved = this.saved;
    this.saved = null; this.pose = null;
    const inputs = this.viewer?.scene?.screenSpaceCameraController;
    if (inputs && saved?.inputs) for (const [key, value] of Object.entries(saved.inputs)) inputs[key] = value;
    if (camera && saved) camera.setView({destination: saved.destination, orientation: saved.orientation,
      endTransform: this.C?.Matrix4?.IDENTITY});
    return true;
  }
}
