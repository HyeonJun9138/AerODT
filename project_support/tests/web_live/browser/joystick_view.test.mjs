// Looking around while flying by hand.
//
// The head switch must not move the aircraft, and must not fight the follow
// camera either: `followFlight` re-anchors every frame and keeps whatever
// offset the operator is standing at, so an orbit made here survives the
// aircraft moving underneath it. Inside the cockpit the same switch is the
// pilot's head instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveGlobe} from '../../../../digital_twin/visualization/web/globe.js';

function harness({cockpit = null, anchor = {}, identity = false, position = {x: 0, y: 0, z: 100, magnitude: 200}} = {}) {
  const calls = [];
  const C = {
    Matrix4: {IDENTITY: 'identity', equals: (a, b) => a === b, clone: v => v},
    Cartesian3: Object.assign(class {}, {magnitude: p => p.magnitude ?? Math.hypot(p.x, p.y, p.z), clone: v => v}),
  };
  const camera = {
    transform: identity ? 'identity' : 'frame',
    position,
    rotateRight: angle => calls.push(['right', angle]),
    rotateUp: angle => calls.push(['up', angle]),
    lookAtTransform: value => calls.push(['transform', value]),
  };
  const globe = Object.create(LiveGlobe.prototype);
  Object.assign(globe, {C, cockpit, flightAnchor: anchor, viewer: {camera, scene: {requestRender() {}}}});
  return {globe, calls, camera};
}

test('outside the cockpit the head switch orbits the aircraft, and stops short of overhead', () => {
  const {globe, calls} = harness();
  assert.equal(globe.lookAround(1, 0, 1 / 60), true);
  assert.deepEqual(calls.map(c => c[0]), ['right']);
  assert.ok(calls[0][1] > 0, '오른쪽을 밀면 오른쪽으로 돈다');

  // Twice as long pressed is twice as far, so the speed is in degrees per
  // second rather than per frame -- a slow frame must not slow the view down.
  const slow = harness();
  slow.globe.lookAround(1, 0, 2 / 60);
  assert.ok(Math.abs(slow.calls[0][1] - calls[0][1] * 2) < 1e-9);

  // A wild dt from a background tab is clamped rather than swinging the view.
  const stalled = harness();
  stalled.globe.lookAround(1, 0, 30);
  assert.ok(stalled.calls[0][1] <= 0.11);

  // Nearly overhead, the tilt is taken back: past it the horizon inverts and a
  // four-way switch is a poor way to recover.
  const top = harness({position: {x: 0, y: 0, z: 199, magnitude: 200}});
  top.globe.lookAround(0, 1, 1 / 60);
  assert.deepEqual(top.calls.map(c => c[0]), ['up', 'up']);
  assert.ok(Math.abs(top.calls[0][1] + top.calls[1][1]) < 1e-12, 'the step is undone exactly');
  // Well below it, the tilt stands.
  const level = harness({position: {x: 0, y: 0, z: 10, magnitude: 200}});
  level.globe.lookAround(0, 1, 1 / 60);
  assert.deepEqual(level.calls.map(c => c[0]), ['up']);
});

test('with no frame around anything, the switch does nothing at all', () => {
  // `camera.position` is a place on the globe when no lookAt frame is set.
  // Rotating about it would throw the view across the world.
  const free = harness({identity: true});
  assert.equal(free.globe.lookAround(1, 1, 1 / 60), false);
  assert.deepEqual(free.calls, []);
  const untracked = harness({anchor: null});
  untracked.globe.tracking = false;
  assert.equal(untracked.globe.lookAround(1, 1, 1 / 60), false);
  assert.deepEqual(untracked.calls, []);
  // A centred switch is not an instruction either, and neither is nonsense.
  const still = harness();
  assert.equal(still.globe.lookAround(0, 0, 1 / 60), false);
  assert.equal(still.globe.lookAround(NaN, 1, 1 / 60), false);
  assert.deepEqual(still.calls, []);
});

test('in the cockpit the same switch turns the pilot, not the camera arm', () => {
  const looked = [];
  const {globe, calls} = harness({cockpit: {active: true, look: (dx, dy) => looked.push([dx, dy]),
    zoom: (d, m) => looked.push(['zoom', d, m]), resetLook: () => looked.push(['reset'])}});
  assert.equal(globe.lookAround(1, 0, 1 / 60), true);
  assert.deepEqual(calls, [], 'the camera arm is not touched');
  assert.equal(looked.length, 1);
  assert.ok(looked[0][0] > 0);
  // A second of full deflection is a reasonable head turn, not a spin.
  const turn = looked[0][0] * 60 * 0.003 * 180 / Math.PI;
  assert.ok(turn > 45 && turn < 120, `초당 ${turn.toFixed(0)}도`);

  assert.equal(globe.lookZoom(-1), true);
  assert.equal(looked.at(-1)[0], 'zoom');
  assert.equal(globe.resetLook(), true);
  assert.deepEqual(looked.at(-1), ['reset']);
});

test('시야 초기화 outside the cockpit lets go of the frame first, or it would keep the orbit', () => {
  // `followFlight` deliberately keeps the operator's offset while a frame is
  // standing. Resetting has to drop the frame, or the reset resets nothing.
  const {globe, calls} = harness();
  const followed = [];
  globe.followFlight = (sample, options) => followed.push([sample, options]);
  assert.equal(globe.resetLook(), false, 'nothing being followed, nothing to reset');
  assert.deepEqual(followed, []);

  globe.followedFlightSample = {position: {latitude: 37.5, longitude: 127, altitude_m: 120}};
  assert.equal(globe.resetLook(), true);
  assert.deepEqual(calls.at(-1), ['transform', 'identity'], 'the frame goes first');
  assert.equal(followed.length, 1);
  assert.equal(followed[0][0], globe.followedFlightSample);
  assert.equal(followed[0][1].reset, true);
});

// The switch is held, so what it produces is an intent. Turning the view is a
// separate job, done wherever the frames are -- which is the whole point of
// the split: it used to be done on the flight command's tick, twenty times a
// second, against a screen drawing sixty.
const FRAME = 1000 / 60;

// One second of a held switch, driven the way the application drives it: the
// stick is polled on the 50 ms command tick, the view is stepped every frame.
function replay(globe, {seconds = 1, release = Infinity, x = 1, y = 0, speed = 1} = {}) {
  const frames = [], calls = globe.__calls;
  let polled = -Infinity;
  for (let frame = 0; frame * FRAME < seconds * 1000; frame += 1) {
    const now = frame * FRAME, before = calls.length;
    if (now - polled >= 50) {polled = now; globe.setLook(now / 1000 < release ? x : 0, now / 1000 < release ? y : 0, speed);}
    globe.stepLook(now);
    frames.push(calls.slice(before));
  }
  return frames;
}

function bench(options) {
  const {globe, calls} = harness(options);
  globe.__calls = calls;
  return globe;
}

// How far the view turned, on one axis: a diagonal pushes both, so adding them
// together would measure the push rather than the speed along it.
const sum = (rows, axis = 'right') =>
  rows.flat().filter(([name]) => name === axis).reduce((total, [, angle]) => total + angle, 0);

test('every drawn frame moves the view, and by the same amount once it is up to speed', () => {
  // The defect: the stick was read on the command tick and the camera turned
  // there and only there, so two frames in three were identical and the third
  // jumped about three degrees. Measured before the fix: 68% of frames still.
  const frames = replay(bench());
  assert.equal(frames.filter(f => !f.length).length, 0, '가만히 있는 프레임이 없다');

  const steps = frames.slice(30).map(f => f[0][1]);
  const spread = Math.max(...steps) / Math.min(...steps);
  assert.ok(spread < 1.02, `정상 속도에서 프레임마다 같은 각도 (${spread.toFixed(3)}배)`);

  // And a slow frame is not a slow view: the step is per second, so a second of
  // full deflection covers the same ground however the frames fall.
  const half = bench(), halved = [];
  let polled = -Infinity;
  for (let frame = 0; frame * FRAME * 2 < 1000; frame += 1) {
    const now = frame * FRAME * 2;
    if (now - polled >= 50) {polled = now; half.setLook(1, 0, 1);}
    half.stepLook(now);
    halved.push(now);
  }
  assert.ok(Math.abs(sum([half.__calls]) / sum(frames)) - 1 < 0.05, '30 Hz에서도 초당 같은 각도');
});

test('letting go settles the view instead of stopping it dead, but does not let it drift', () => {
  const frames = replay(bench(), {seconds: 2, release: 1});
  const after = frames.slice(Math.ceil(1000 / FRAME));
  const coast = sum(after) * 180 / Math.PI;
  assert.ok(coast > 0.5, '뚝 끊기지 않고 잦아든다');
  assert.ok(coast < 4, `놓은 뒤 더 도는 각도는 조금 (${coast.toFixed(1)}도)`);

  // And it does come to rest: an exponential only approaches zero, so the last
  // sliver is cut rather than crept through.
  const stopped = after.findIndex(f => !f.length);
  assert.ok(stopped > 0 && stopped * FRAME < 300, `${(stopped * FRAME).toFixed(0)} ms 안에 멈춘다`);
  assert.deepEqual(after.slice(stopped).flat(), [], '멈춘 뒤로는 아무것도 하지 않는다');
});

test('a diagonal push is a direction, not a bonus, and the tuned speed still scales it', () => {
  const straight = sum(replay(bench()));
  const both = replay(bench(), {x: 1, y: 1});
  assert.ok(Math.abs(sum(both) / straight - Math.SQRT1_2) < 0.01,
    '두 방향을 같이 밀어도 옆으로 41% 빨라지지 않는다');
  assert.ok(Math.abs(sum(both, 'up') / straight - Math.SQRT1_2) < 0.01, '위아래도 같은 몫');

  const faster = sum(replay(bench(), {speed: 2}));
  assert.ok(Math.abs(faster / straight - 2) < 0.02, '설정한 속도는 그대로 곱해진다');
  // Whatever a hand-edited profile says, within the range the window offers.
  assert.equal(bench().setLook(1, 0, 99).speed, 4);
  assert.equal(bench().setLook(1, 0, 0).speed, 0.1);
});

test('nothing held is nothing done, and nonsense is not an instruction', () => {
  const idle = bench();
  assert.equal(idle.stepLook(0), false, '아직 아무것도 받지 않았으면 할 일이 없다');
  idle.setLook(0, 0, 1);
  assert.equal(idle.stepLook(FRAME), false);
  assert.deepEqual(idle.__calls, []);

  const nonsense = bench();
  assert.deepEqual([nonsense.setLook(NaN, 1).x, nonsense.setLook(NaN, 1).y], [0, 1]);
  assert.equal(nonsense.setLook(5, -5).x, 1, '범위를 벗어난 값은 잘린다');
  assert.equal(nonsense.setLook(5, -5).y, -1);
});

test('the render loop is what drives it, because that is where the frames are', async () => {
  const {readFileSync} = await import('node:fs');
  const source = readFileSync(new URL('../../../../digital_twin/visualization/web/globe.js', import.meta.url), 'utf8');
  const lines = source.split(/\r?\n/), start = lines.findIndex(line => line.startsWith('  frame() {'));
  assert.ok(start > 0, 'frame()');
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('  }')) break;
    body.push(line);
  }
  assert.match(body.join('\n'), /this\.stepLook\(now\)/, '시야는 렌더 프레임마다 나아간다');
  // Before the cockpit is posed, or a turn of the head would wait a frame.
  assert.ok(body.findIndex(l => l.includes('stepLook')) < body.findIndex(l => l.includes('cockpit?.update')));
  // And the command tick no longer turns anything itself.
  const app = readFileSync(new URL('../../../../user_application/web/app.js', import.meta.url), 'utf8');
  assert.match(app, /onLook:\(x,y,speed,zoom\)=>liveGlobe\?\.setLook\(x,y,speed,zoom\)/);
  assert.doesNotMatch(app, /lookAround/);
});
