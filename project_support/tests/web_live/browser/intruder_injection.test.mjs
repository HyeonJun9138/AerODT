// An obstacle put in front of the camera on purpose has to be one object, not
// three: the map, the camera's own scene and the risk panel all read the live
// snapshot, so joining it there is what keeps them looking at the same thing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {INTRUDERS, INTRUDER_KINDS, LINGER_S, intruderAt, intruderEntity, ecefOf,
        IntruderInjector} from '../../../../user_application/web/intruder_injection.js';

const own = {entity_id: 'scenario:UAM0001', kind: 'uam', latitude_deg: 37.52,
             longitude_deg: 126.92, altitude_m: 300, heading_deg: 0};
const metres = (a, b) => {
  const north = (b.latitude_deg - a.latitude_deg) * 111320;
  const east = (b.longitude_deg - a.longitude_deg) * 111320 * Math.cos(a.latitude_deg * Math.PI / 180);
  return {north, east, dist: Math.hypot(north, east)};
};

test('it crosses the view rather than flying at the camera', () => {
  // Something approaching head-on barely moves in the image; the whole point is
  // to give the detector and the operator something that plainly moves.
  const spec = INTRUDERS.drone;
  const span = 2 * spec.lateral_m / spec.speed_mps;
  const start = intruderAt(spec, own, 0);
  const middle = intruderAt(spec, own, span / 2);
  const end = intruderAt(spec, own, span);
  for (const point of [start, middle, end])
    assert.ok(Math.abs(metres(own, point).north - spec.ahead_m) < 1,
      'it stays the same distance ahead all the way across');
  const across = [start, middle, end].map(p => metres(own, p).east);
  assert.ok(across[0] > spec.lateral_m - 1 && across[2] < 1 - spec.lateral_m, `swept ${across[0]} to ${across[2]}`);
  assert.ok(Math.abs(across[1]) < 1, 'and passes straight through the middle');
  // Pointed where it is going, not at the camera.
  assert.equal(Math.round(middle.heading_deg), 90);
});

test('the crossing follows the aircraft it was launched around', () => {
  // Launched off a heading of 90, "ahead" is east and "across" is north-south.
  const turned = {...own, heading_deg: 90};
  const point = intruderAt(INTRUDERS.drone, turned, 0);
  const {north, east} = metres(turned, point);
  assert.ok(Math.abs(east - INTRUDERS.drone.ahead_m) < 1, `ahead is east: ${east}`);
  assert.ok(Math.abs(north + INTRUDERS.drone.lateral_m) < 1, `across is north: ${north}`);
});

test('a bird wanders in height and a drone holds its level', () => {
  const spec = INTRUDERS.bird, span = 2 * spec.lateral_m / spec.speed_mps;
  const heights = Array.from({length: 9}, (_, i) => intruderAt(spec, own, span * i / 8).altitude_m);
  const swing = Math.max(...heights) - Math.min(...heights);
  assert.ok(swing > 1, `a bird does not fly a straight line: ${swing} m`);
  assert.ok(swing <= spec.bob_m * 2 + 0.001);
  const drone = Array.from({length: 5}, (_, i) =>
    intruderAt(INTRUDERS.drone, own, i).altitude_m);
  assert.ok(drone.every(h => h === own.altitude_m), 'a transiting drone holds its level');
});

test('a crossing ends, and does not come back', () => {
  const spec = INTRUDERS.drone, span = 2 * spec.lateral_m / spec.speed_mps;
  assert.equal(intruderAt(spec, own, -1), null, 'nothing before it is launched');
  assert.ok(intruderAt(spec, own, span + LINGER_S / 2), 'it lingers briefly past the far side');
  assert.equal(intruderAt(spec, own, span + LINGER_S + 0.1), null);
  assert.equal(intruderAt(spec, own, Number.NaN), null);
  assert.equal(intruderAt(null, own, 1), null);
  assert.equal(intruderAt(spec, null, 1), null);
});

test('the entity says out loud that somebody put it there', () => {
  // Once it is in the snapshot it is indistinguishable from traffic somebody is
  // flying, and the only thing keeping it honest is saying so on the entity.
  const track = {id: 'intruder:bird:1', kind: 'bird', own_id: own.entity_id, started_at: 1000, side: 1};
  const entity = intruderEntity(track, 3000, own);
  assert.equal(entity.provenance, 'injected');
  assert.equal(entity.derivation, 'injected');
  assert.equal(entity.source, 'intruder');
  assert.match(entity.name, /주입/);
  assert.equal(entity.kind, 'bird');
  // And carries what the detector is expected to call it, so the risk side and
  // the camera are asking about the same object.
  assert.deepEqual(
    {expect: entity.intruder.expect, injected: entity.intruder.injected, size: entity.intruder.size_m},
    {expect: 'Bird', injected: true, size: INTRUDERS.bird.size_m});
});

test('injecting adds to the snapshot without editing the one it was handed', () => {
  // Half a dozen panels get this object after the injector does; one of them
  // holding a reference to a list that later grew is a ghost on someone's
  // screen a week later.
  const injector = new IntruderInjector({now: () => 1000});
  injector.launch('drone', own.entity_id);
  const received = {sequence: 7, entities: [own]};
  const frozen = structuredClone(received);
  const out = injector.inject(received);
  assert.deepEqual(received, frozen, 'the snapshot handed in is untouched');
  assert.notEqual(out, received);
  assert.equal(out.entities.length, 2);
  assert.equal(out.sequence, 7, 'and everything else about it survives');
  assert.equal(out.entities[1].intruder.kind, 'drone');
});

test('nothing is added when there is nothing to cross in front of', () => {
  const injector = new IntruderInjector({now: () => 1000});
  assert.equal(injector.launch('drone', null), null, 'no aircraft, no crossing');
  assert.equal(injector.launch('pterodactyl', own.entity_id), null, 'only the kinds that exist');
  assert.equal(injector.active, 0);
  const snapshot = {entities: [own]};
  assert.equal(injector.inject(snapshot), snapshot, 'an idle injector hands it straight back');
  assert.equal(injector.inject(null), null);
  // Launched, then its aircraft leaves the snapshot: the reason for it has gone.
  injector.launch('drone', own.entity_id);
  assert.equal(injector.active, 1);
  injector.inject({entities: []});
  assert.equal(injector.active, 0, 'and the track goes with it');
});

test('a finished crossing drops itself, and clearing drops the rest', () => {
  let at = 1000;
  const injector = new IntruderInjector({now: () => at});
  injector.launch('drone', own.entity_id);
  const span = 2 * INTRUDERS.drone.lateral_m / INTRUDERS.drone.speed_mps;
  at = 1000 + (span + LINGER_S + 1) * 1000;
  assert.equal(injector.inject({entities: [own]}).entities.length, 1, 'it has gone past');
  assert.equal(injector.active, 0);
  injector.launch('bird', own.entity_id);
  injector.launch('bird', own.entity_id);
  assert.equal(injector.active, 2);
  assert.equal(injector.clear(), true);
  assert.equal(injector.clear(), false, 'clearing nothing is not a change');
});

test('two launched together do not fly the same line through the frame', () => {
  const injector = new IntruderInjector({now: () => 1000});
  const first = injector.launch('bird', own.entity_id);
  const second = injector.launch('bird', own.entity_id);
  assert.notEqual(first.side, second.side);
  assert.notEqual(first.id, second.id);
});

test('the entity carries the Earth-fixed position the map actually places it by', () => {
  // The map builds a position from position_ecef_m and silently drops an entity
  // without one. A crossing that only knew its latitude and longitude was never
  // drawn - which is how this was found.
  const track = {id: 'intruder:drone:1', kind: 'drone', own_id: own.entity_id, started_at: 1000, side: 1};
  const entity = intruderEntity(track, 1000, own);
  assert.ok(Array.isArray(entity.position_ecef_m) && entity.position_ecef_m.length === 3);
  assert.ok(entity.position_ecef_m.every(Number.isFinite));
  // On the Earth, three hundred metres up: the vector is as long as the planet
  // is wide, not a lat/lon pair that happened to get three slots.
  const radius = Math.hypot(...entity.position_ecef_m);
  assert.ok(radius > 6.35e6 && radius < 6.40e6, `radius ${radius}`);
  // And it is a real transform, not a scaled copy of the degrees: the drone at
  // launch sits `ahead_m` ahead and `lateral_m` across, so its Earth-fixed point
  // must be the hypotenuse of the two from the aircraft's own.
  const ownEcef = ecefOf(own.latitude_deg, own.longitude_deg, own.altitude_m);
  const apart = Math.hypot(...entity.position_ecef_m.map((v, i) => v - ownEcef[i]));
  const planned = Math.hypot(INTRUDERS.drone.ahead_m, INTRUDERS.drone.lateral_m);
  assert.ok(Math.abs(apart - planned) < 0.5, `${apart} m apart, planned ${planned}`);
});

test("an injected entity carries the day's clock, not the wall's", () => {
  // Every neighbour in the snapshot is stamped with the day's state_time, and
  // that is the clock the display's sample ring orders by. An object stamped
  // with wall time would sit in a ring of day-time neighbours with a time
  // nothing else agrees on.
  const injector = new IntruderInjector({now: () => 5_000_000});
  injector.launch('drone', own.entity_id);
  const out = injector.inject({sequence: 1, state_time: 12345.5, entities: [own]});
  const added = out.entities.find(e => e.entity_id.startsWith('intruder:'));
  assert.equal(added.state_time, 12345.5);
  assert.equal(added.observation_time, 12345.5);
  assert.equal(added.received_time, 12345.5);
  // While the crossing itself is still paced in wall seconds.
  const later = new IntruderInjector({now: () => 5_000_000});
  later.launch('drone', own.entity_id);
  const a = later.inject({state_time: 1, entities: [own]}).entities.at(-1);
  later.now = () => 5_002_000;
  const b = later.inject({state_time: 1, entities: [own]}).entities.at(-1);
  assert.notEqual(a.longitude_deg, b.longitude_deg, 'two wall-seconds later it has moved');
  // With no clock in the snapshot it falls back rather than stamping NaN.
  const bare = new IntruderInjector({now: () => 7_000_000});
  bare.launch('bird', own.entity_id);
  assert.equal(bare.inject({entities: [own]}).entities.at(-1).state_time, 7000);
});

test('the scene draws the two kinds in the uam category, in their own colours', () => {
  // An unknown kind is silently skipped at replace() - which is how an injected
  // obstacle went undrawn. A drone or a bird is a small, low thing over a city,
  // which is what the uam layer already is, so they share it.
  const scene = readFileSync('digital_twin/visualization/web/entity_scene.js', 'utf-8');
  assert.match(scene, /this\.layers\.drone=this\.layers\.uam;this\.layers\.bird=this\.layers\.uam;/);
  assert.match(scene, /drone:C\.Color\.fromCssColorString\('#ff8a94'\),bird:C\.Color\.fromCssColorString\('#ffb35c'\)/);
  assert.match(scene, /drone:'#ff8a94',bird:'#ffb35c'/, 'the glyph colours too');
  assert.match(scene, /drone:categoryRange\('uam',height\),bird:categoryRange\('uam',height\)/);
  assert.match(scene, /drone:drawsSymbol\('uam',height\),bird:drawsSymbol\('uam',height\)/);
  // One screen cell, one mark, whichever low-flying kind got there first.
  assert.match(scene, /uam,drone:uam,bird:uam/);
  const policy = readFileSync('digital_twin/visualization/web/render_policy.js', 'utf-8');
  assert.match(policy, /drone: 400000, bird: 400000/);
  assert.match(policy, /aircraft:\['aircraft','uam','drone','bird'\]/, 'and they get labels in the near band');
});

// ---- the wiring that makes it one object ------------------------------------
test('the crossing joins the snapshot before it fans out to the panels', () => {
  const app = readFileSync('user_application/web/app.js', 'utf-8');
  const inject = app.indexOf('intruders.inject(received)');
  assert.ok(inject > 0, 'the shell injects on the way past');
  for (const consumer of ['riskRadar.observe(snapshot)', 'globe.replace(snapshot)'])
    assert.ok(app.indexOf(consumer) > inject, `${consumer} must read the injected snapshot`);
});

test('the camera draws an obstacle it has no model for, at the right size', () => {
  // A bird has no glTF in the library. Left out of the camera scene, the
  // detector would be asked about an empty sky.
  const camera = readFileSync('digital_twin/visualization/web/airframe_camera.js', 'utf-8');
  // Whenever the glTF is missing - no asset, or an asset the page loaded its
  // catalogue before - the body stands in, at the object's size.
  assert.match(camera, /body:i\.entity\.intruder\?\.injected\?i\.entity\.intruder\.size_m:0/);
  assert.match(camera, /if\(!uri&&target\.body\)/);
  assert.equal(typeof INTRUDERS.bird.asset, 'string', 'the bird has a model now; the body is the fallback for any asset that fails');
  assert.equal(INTRUDERS.drone.asset, 'amvlab_drone', 'the drone has a real one');
});

test('the camera scene mirrors every kind an intruder can be, and puts it first', () => {
  // Found live: the mirror filter listed the kinds it had always seen, and
  // `bird` was not one of them, so the bird reached the map and the risk
  // panel and never the camera image the whole exercise is about.
  const camera = readFileSync('digital_twin/visualization/web/airframe_camera.js', 'utf-8');
  const kinds = /\[('[a-z]+'(?:,'[a-z]+')*)\]\.includes\(i\.entity\.kind\)/.exec(camera);
  assert.ok(kinds, 'the mirror filter must be a plain list of kinds');
  const listed = kinds[1].split(',').map(k => k.replace(/'/g, ''));
  for (const spec of Object.values(INTRUDERS))
    assert.ok(listed.includes(spec.kind), `${spec.kind} must reach the camera scene`);
  // On a deck the parked neighbours are nearer and the loader takes two at a
  // time; the crossing lasts seconds, so it cannot wait its turn by distance.
  assert.match(camera, /\.sort\(\(a,b\)=>\(Number\(Boolean\(b\.i\.entity\.intruder\?\.injected\)\)-Number\(Boolean\(a\.i\.entity\.intruder\?\.injected\)\)\)\|\|a\.d-b\.d\)/);
});

test('the buttons offer exactly the kinds that exist, and let go with the camera', () => {
  const panel = readFileSync('user_application/web/aircraft_camera_panel.js', 'utf-8');
  assert.match(panel, /for\(const \[kind,spec\] of Object\.entries\(INTRUDERS\)\)/);
  assert.match(panel, /onclick:\(\)=>this\.launchIntruder\(kind\)/);
  // Closing the camera, or watching a different aircraft, must not leave an
  // injected object on the map and in the risk panel with nobody watching it.
  assert.match(panel, /this\.releaseIntruders\(\);this\.releasePerception\(\);this\.mode='front'/);
  const close = panel.slice(panel.indexOf(' close(){'));
  assert.match(close.slice(0, 800), /this\.releaseIntruders\(\)/);
  assert.deepEqual(INTRUDER_KINDS, ['bird', 'drone', 'uam']);
});

test('a crossing is close enough to see through a 95-degree lens and still starts outside it', () => {
  // 576 px across at 95 degrees is about 264 px of focal length. Anything under
  // ten pixels is a speck the operator cannot find and the detector cannot name.
  const focal = 288 / Math.tan((95 / 2) * Math.PI / 180);
  const halfWidth = ahead => ahead * Math.tan((95 / 2) * Math.PI / 180);
  for (const [kind, spec] of Object.entries(INTRUDERS)) {
    const pixels = focal * spec.size_m / spec.ahead_m;
    assert.ok(pixels >= 12, `${kind} is ${pixels.toFixed(1)} px at ${spec.ahead_m} m`);
    assert.ok(spec.lateral_m > halfWidth(spec.ahead_m), `${kind} starts inside the frame`);
    // And it is a crossing somebody can follow, not a flash: a few seconds.
    const span = 2 * spec.lateral_m / spec.speed_mps;
    assert.ok(span >= 3 && span <= 8, `${kind} crosses in ${span.toFixed(1)} s`);
  }
});
