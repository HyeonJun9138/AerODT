// The detector's boxes become places: a ray from the camera pose through the
// box centre, a range from the box's size against what such a thing measures,
// an error that says the range is the weak part. The tracks join the snapshot
// as perception and are reported to the server for the risk model.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {perceivedPosition, geodeticOf, PerceptionTracks, CLASSES, FRAME, TRACK_TTL_MS, REPORT_INTERVAL_MS} from '../../../../user_application/web/camera_perception.js';
import {ecefOf} from '../../../../user_application/web/intruder_injection.js';

// A camera at 300 m over Seoul looking due north, level.
const lat = 37.55, lon = 127.0, alt = 300;
const position = ecefOf(lat, lon, alt);
const up = (() => { const l = lat * Math.PI / 180, o = lon * Math.PI / 180; return [Math.cos(l) * Math.cos(o), Math.cos(l) * Math.sin(o), Math.sin(l)]; })();
const north = (() => { const l = lat * Math.PI / 180, o = lon * Math.PI / 180; return [-Math.sin(l) * Math.cos(o), -Math.sin(l) * Math.sin(o), Math.cos(l)]; })();
const pose = {position, direction: north, up};
const focal = (FRAME.width / 2) / Math.tan(FRAME.fov_deg * Math.PI / 360);
const centred = (size_px) => [FRAME.width / 2 - size_px / 2, FRAME.height / 2 - size_px / 2, FRAME.width / 2 + size_px / 2, FRAME.height / 2 + size_px / 2];

test('a centred box is placed straight ahead, at the range its size implies', () => {
  // A 1.4 m drone that is 20 px tall sits at 1.4 * focal / 20 metres ahead.
  const placed = perceivedPosition({class_name: 'Drone', box: centred(20)}, pose);
  const expected = 1.4 * focal / 20;
  assert.ok(Math.abs(placed.range_m - expected) < 1e-6, `${placed.range_m} vs ${expected}`);
  assert.equal(placed.kind, 'drone');
  // Straight ahead is due north of the camera at the same height.
  assert.ok(Math.abs(placed.altitude_m - alt) < .5, `altitude ${placed.altitude_m}`);
  assert.ok(placed.latitude_deg > lat && Math.abs(placed.longitude_deg - lon) < 1e-5);
  const metres = (placed.latitude_deg - lat) * 111320;
  assert.ok(Math.abs(metres - expected) < expected * .01, `${metres} m north vs ${expected}`);
  // The error is a fraction of the range, never below the floor.
  assert.ok(Math.abs(placed.sigma_m - Math.max(5, expected * .25)) < 1e-9);
});

test('a box to the right of centre lies east of the line of sight; a box high in the image is higher', () => {
  const right = perceivedPosition({class_name: 'Bird', box: [FRAME.width / 2 + 100, FRAME.height / 2 - 10, FRAME.width / 2 + 120, FRAME.height / 2 + 10]}, pose);
  assert.ok(right.longitude_deg > lon, 'east of north');
  const high = perceivedPosition({class_name: 'Bird', box: [FRAME.width / 2 - 10, 20, FRAME.width / 2 + 10, 40]}, pose);
  // A 20 px bird is about 14 m away; 124 px above centre on a 264 px focal is about 6 m up.
  assert.ok(high.altitude_m > alt + 3, `higher: ${high.altitude_m}`);
});

test('a speck or an unsure detection is not placed', () => {
  assert.equal(perceivedPosition({class_name: 'Drone', box: centred(6)}, pose), null, 'too small to read a range from');
  const tracks = new PerceptionTracks({now: () => 0});
  assert.equal(tracks.observe({detections: [{track_id: 1, class_name: 'Drone', confidence: .3, box: centred(20)}]}, pose, 'A', 0).length, 0);
});

test('every detector class maps to a map kind with a size, and unknown ones are not placed', () => {
  for (const spec of Object.values(CLASSES)) assert.ok(['bird', 'drone', 'uam'].includes(spec.kind) && spec.size_m > 0);
  assert.equal(perceivedPosition({class_name: 'Background', box: centred(10)}, pose), null);
  assert.equal(perceivedPosition({class_name: 'Drone', box: [1, 2, 3]}, pose), null);
  assert.equal(perceivedPosition({class_name: 'Drone', box: centred(10)}, null), null);
  // Case is the detector's business, not ours.
  assert.equal(perceivedPosition({class_name: 'HELICOPTER', box: centred(30)}, pose).kind, 'uam');
});

test('geodetic conversion inverts the Earth-fixed one to well under a metre', () => {
  for (const [la, lo, h] of [[37.55, 127.0, 300], [0, 0, 0], [-45, 170, 5000], [80, -120, 100]]) {
    const g = geodeticOf(ecefOf(la, lo, h));
    assert.ok(Math.abs(g.latitude_deg - la) < 1e-7 && Math.abs(g.longitude_deg - lo) < 1e-7 && Math.abs(g.altitude_m - h) < .01, JSON.stringify(g));
  }
});

test('tracks keep identity across sightings and gain a velocity and heading from motion', () => {
  let now = 1000;
  const tracks = new PerceptionTracks({now: () => now});
  const first = tracks.observe({detections: [{track_id: 7, class_name: 'Drone', confidence: .8, box: centred(20)}]}, pose, 'scenario:UAM0001', now);
  assert.equal(first.length, 1);
  assert.equal(first[0].id, 'perceived:scenario:UAM0001:7');
  assert.equal(first[0].velocity_ecef_mps, null);
  // Half a second later the same box has moved 40 px to the right: eastward.
  now += 500;
  const [second] = tracks.observe({detections: [{track_id: 7, class_name: 'Drone', confidence: .8, box: centred(20).map((v, i) => i % 2 ? v : v + 40)}]}, pose, 'scenario:UAM0001', now);
  assert.equal(tracks.active, 1, 'the same track, not a second one');
  assert.ok(second.velocity_ecef_mps && Math.hypot(...second.velocity_ecef_mps) > 1);
  assert.ok(second.heading_deg > 45 && second.heading_deg < 135, `eastward, got ${second.heading_deg}`);
  assert.equal(second.sightings, 2);
});

test('a track not seen again is dropped, and everything goes when the aircraft changes', () => {
  let now = 0;
  const tracks = new PerceptionTracks({now: () => now});
  tracks.observe({detections: [{track_id: 1, class_name: 'Bird', confidence: .5, box: centred(12)}]}, pose, 'A', now);
  now += TRACK_TTL_MS + 1;
  assert.equal(tracks.expire(now), true);
  assert.equal(tracks.active, 0);
  tracks.observe({detections: [{track_id: 1, class_name: 'Bird', confidence: .5, box: centred(12)}]}, pose, 'A', now);
  tracks.observe({detections: [{track_id: 1, class_name: 'Bird', confidence: .5, box: centred(12)}]}, pose, 'B', now);
  assert.deepEqual([...tracks.tracks.keys()], ['perceived:B:1']);
});

test('perceived objects join the snapshot labelled as perception, without mutating it', () => {
  const tracks = new PerceptionTracks({now: () => 5000});
  tracks.observe({detections: [{track_id: 3, class_name: 'Airplane', confidence: .7, box: centred(60)}]}, pose, 'scenario:UAM0001', 5000);
  // One sighting is a flicker; the object appears once it has been seen twice.
  assert.equal(tracks.inject({state_time: 1234, entities: [{entity_id: 'scenario:UAM0001', kind: 'uam'}]}).entities.length, 1);
  tracks.observe({detections: [{track_id: 3, class_name: 'Airplane', confidence: .7, box: centred(60)}]}, pose, 'scenario:UAM0001', 5300);
  const snapshot = {state_time: 1234.5, entities: [{entity_id: 'scenario:UAM0001', kind: 'uam'}]};
  const injected = tracks.inject(snapshot);
  assert.notEqual(injected, snapshot);
  assert.equal(snapshot.entities.length, 1);
  const added = injected.entities[1];
  assert.equal(added.entity_id, 'perceived:scenario:UAM0001:3');
  assert.equal(added.kind, 'uam');
  assert.equal(added.provenance, 'camera_ai');
  assert.equal(added.source, 'perception');
  assert.match(added.name, /인식 #3 · \d+ m · 70%/);
  assert.equal(added.state_time, 1234.5);
  assert.equal(added.position_ecef_m.length, 3);
  assert.equal(added.perceived.class_name, 'Airplane');
  // The camera's aircraft is gone from the snapshot: so is what it saw.
  assert.equal(tracks.inject({state_time: 1235, entities: []}).entities.length, 0);
  assert.equal(tracks.active, 0);
});

test('reports go to the server a few times a second at most, only while there is something to report', async () => {
  let now = 0;
  const calls = [];
  const fetch = async (url, options) => { calls.push([url, JSON.parse(options.body)]); return {ok: true}; };
  const tracks = new PerceptionTracks({now: () => now});
  assert.equal(await tracks.publish(fetch, 100, now), false, 'nothing to say');
  tracks.observe({detections: [{track_id: 9, class_name: 'Drone', confidence: .9, box: centred(20)}]}, pose, 'scenario:UAM0002', now);
  assert.equal(await tracks.publish(fetch, 100.4, now), false, 'seen once: not yet');
  tracks.observe({detections: [{track_id: 9, class_name: 'Drone', confidence: .9, box: centred(20)}]}, pose, 'scenario:UAM0002', now);
  assert.equal(await tracks.publish(fetch, 100.5, now), true);
  assert.equal(await tracks.publish(fetch, 100.6, now + REPORT_INTERVAL_MS - 1), false, 'too soon');
  assert.equal(await tracks.publish(fetch, 100.8, now + REPORT_INTERVAL_MS), true);
  assert.equal(calls.length, 2);
  const [url, body] = calls[0];
  assert.equal(url, '/api/perception/observations');
  assert.equal(body.ownship_id, 'scenario:UAM0002');
  assert.equal(body.state_time, 100.5);
  assert.equal(body.objects.length, 1);
  assert.equal(body.objects[0].track_id, '9');
  assert.equal(body.objects[0].kind, 'drone');
  assert.ok(body.objects[0].sigma_m >= 5);
});

test('the page and the panel are wired: pose travels with the frame, perceptions join the snapshot, the camera never sees its own', () => {
  const panel = readFileSync('user_application/web/aircraft_camera_panel.js', 'utf-8');
  const app = readFileSync('user_application/web/app.js', 'utf-8');
  const camera = readFileSync('digital_twin/visualization/web/airframe_camera.js', 'utf-8');
  const session = readFileSync('user_application/web/camera_detection_session.js', 'utf-8');
  // The pose the image was rendered from is taken when the frame is encoded
  // and handed back with the detector's answer for that frame.
  assert.match(panel, /const pose=this\.camera\.lastPose;/);
  assert.match(panel, /this\.session\.submit\(\{width:576,height:288,image_base64,pose\}\)/);
  assert.match(session, /this\.onResult\(result,frame\)/);
  assert.match(panel, /onResult:\(result,frame\)=>\{this\.result=\{result\};this\.paint\(\);this\.perceive\(result,frame\);\}/);
  assert.match(camera, /this\.lastPose=\{frame:this\.frameNumber\+1,mode,position:pose\.position,direction:pose\.direction,up:pose\.up,at:now\}/);
  // Into the snapshot beside the injected intruders, before it fans out.
  assert.match(app, /scopeSnapshot\(activeDomain==='uam'\?perception\.inject\(intruders\.inject\(received\)\):received,activeDomain\)/);
  // And the camera scene skips them, or the detector would see its own answer.
  assert.match(camera, /i\.entity\.provenance!=='camera_ai'\)/);
  // AI off, aircraft changed, camera closed: the perceptions go too.
  assert.match(panel, /if\(!enabled\)this\.releasePerception\(\)/);
  assert.match(panel, /this\.releaseIntruders\(\);this\.releasePerception\(\);/);
});
