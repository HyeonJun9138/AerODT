// Arriving at an aircraft to fly it by hand.
//
// `flyToFlight` re-aims the camera with `lookAt`, which is a teleport: measured
// from 14 km out, the camera was 9.3 km away by the first sampled frame -- five
// kilometres gone before anything was drawn -- and inside 400 m within a second.
// That is what reads as being pulled into the aircraft. The glide covers the
// same ground as a flight, from a standstill, over a couple of seconds.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {LiveGlobe} from '../../../../digital_twin/visualization/web/globe.js';

const SAMPLE = {position: {latitude: 37.52, longitude: 127.02, altitude_m: 120}, heading_deg: 40};

// Only what the approach touches; the globe itself is never constructed here.
function harness({distance = 14264} = {}) {
  const flights = [];
  const C = {
    Cartesian3: Object.assign(class {}, {
      fromDegrees: (longitude, latitude, height) => ({longitude, latitude, height}),
      distance: () => distance,
    }),
    BoundingSphere: class {constructor(centre, radius) {Object.assign(this, {centre, radius});}},
    HeadingPitchRange: class {constructor(heading, pitch, range) {Object.assign(this, {heading, pitch, range});}},
    EasingFunction: {QUADRATIC_IN_OUT: 'ease'},
    Math: {toRadians: degrees => degrees * Math.PI / 180},
  };
  const camera = {positionWC: {}, cancelFlight() {}, flyToBoundingSphere: (sphere, options) => flights.push({sphere, options})};
  const globe = Object.create(LiveGlobe.prototype);
  Object.assign(globe, {C, viewer: {camera, scene: {requestRender() {}}},
    motion: {cancel() {}}, cameraSpring: {reset() {}}, destinationPreparation: {cancel() {}}});
  return {globe, flights};
}

test('the approach is flown, not jumped: one eased flight and nothing before it',async()=>{
  const {globe, flights} = harness();
  const arrival = globe.flyToFlightSmoothly(SAMPLE);
  assert.equal(flights.length, 1, 'one camera flight');
  const {sphere, options} = flights[0];
  assert.equal(options.easingFunction, 'ease');
  assert.equal(sphere.centre.latitude, 37.52);
  // It ends where flyToFlight would have framed it, so the settle that follows
  // has no distance left to travel and nothing to jump.
  assert.equal(Math.round(options.offset.range), 180);
  assert.equal(Math.round(options.offset.heading * 180 / Math.PI), 40);
  assert.equal(Math.round(options.offset.pitch * 180 / Math.PI), -28);
  // It resolves only on arrival, so the cockpit cannot cut across the glide.
  let settled = false;
  arrival.then(() => {settled = true;});
  await Promise.resolve();
  assert.equal(settled, false);
  options.complete();
  assert.equal(await arrival, true);
});

test('a longer way to come takes longer, within bounds anyone would sit through',()=>{
  const take = distance => {const {globe, flights} = harness({distance});
    globe.flyToFlightSmoothly(SAMPLE); return flights[0].options.duration;};
  assert.ok(take(600) >= 1.4, 'never snappier than a glide');
  assert.ok(take(14264) > take(600), 'further is slower');
  assert.ok(take(400000) <= 3.4, 'and never a journey');
  // Measured: the old path was inside 400 m in about a second from 14 km out.
  assert.ok(take(14264) >= 2, 'the 14 km case is seconds, not one');
});

test('already alongside, there is nothing to glide through',async()=>{
  const {globe, flights} = harness({distance: 200});
  assert.equal(await globe.flyToFlightSmoothly(SAMPLE), false);
  assert.equal(flights.length, 0, 'no flight, no pause staring at nothing');
  // No sample is not an approach either.
  const empty = harness();
  assert.equal(await empty.globe.flyToFlightSmoothly(null), false);
  assert.equal(empty.flights.length, 0);
});

test('manual start waits for the approach before entering the cockpit',()=>{
  const app = readFileSync(new URL('../../../../user_application/web/app.js', import.meta.url), 'utf8');
  assert.match(app, /await liveGlobe\?\.flyToFlightSmoothly\(manualFlight\.sample\)/,
    'the glide is awaited, not fired and forgotten');
  const glide = app.indexOf('flyToFlightSmoothly');
  const enter = app.indexOf('cockpit.enterSingle()');
  assert.ok(glide > 0 && enter > glide, 'and it happens before the cockpit');
});
