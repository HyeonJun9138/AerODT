import test from 'node:test';
import assert from 'node:assert/strict';
import {entitySoundProfile} from '../../../../digital_twin/visualization/web/entity_sound_profile.js';
import {SelectedEntityAudio} from '../../../../digital_twin/visualization/web/selected_entity_audio.js';
import {sceneSoundSample} from '../../../../user_application/web/domains/uam/audio/entity_sound_controls.js';

// Two things an aircraft does that made no sound at all. Taxiing across a deck
// was silent because `running` is false at zero rpm and the rotor level is the
// only thing that ever opened a voice. Driving the nacelles over was silent
// because a tilt angle is a position, and nothing was listening to it moving.

const rolling = {entity_id: 'u1', kind: 'uam', rotor_radps: 0, grounded: true,
  flight_phase: 'gate_out', speed_mps: 4, tilt_deg: 0};
const flying = {entity_id: 'u1', kind: 'uam', rotor_radps: 300, flight_phase: 'climb',
  tilt_deg: 45, velocity_ecef_mps: [40, 0, 0]};

test('an aircraft rolling across a deck with its rotors stopped is no longer silent', () => {
  const profile = entitySoundProfile(rolling, 10);
  assert.equal(profile.level, 0, '회전익은 실제로 멈춰 있다');
  assert.ok(profile.roll > .5, `구르는 소리가 난다 (${profile.roll.toFixed(2)})`);
});

test('standing still on the deck is silent, which is what makes rolling read as rolling', () => {
  assert.equal(entitySoundProfile({...rolling, speed_mps: 0}, 10).roll, 0);
  // A creep below walking pace is the aircraft being nudged, not taxiing.
  assert.equal(entitySoundProfile({...rolling, speed_mps: .2}, 10).roll, 0);
  assert.ok(entitySoundProfile({...rolling, speed_mps: 1.5}, 10).roll > 0);
});

test('rolling grows with ground speed and fades with distance', () => {
  const slow = entitySoundProfile({...rolling, speed_mps: 1.5}, 10).roll;
  const taxi = entitySoundProfile(rolling, 10).roll;
  assert.ok(taxi > slow, '빠를수록 커진다');
  assert.ok(entitySoundProfile(rolling, 2000).roll < taxi / 3, '멀면 작아진다');
  assert.equal(entitySoundProfile(rolling, 100000).roll, 0);
});

test('nothing rolls in the air', () => {
  assert.equal(entitySoundProfile({...rolling, grounded: false, flight_phase: 'cruise',
    speed_mps: 60, rotor_radps: 300}, 10).roll, 0);
  // `airborne` is what the manual sample says; `grounded` is what the day says.
  assert.equal(entitySoundProfile({...rolling, grounded: undefined, flight_phase: 'cruise',
    airborne: true, speed_mps: 60}, 10).roll, 0);
});

test('a nacelle held at an angle is silent; one being driven is not', () => {
  // This is the whole reason the rate is measured rather than read off `mode`,
  // which says 'transition' for any intermediate angle, held or swinging.
  assert.equal(entitySoundProfile(flying, 10, {tiltRate: 0}).servo, 0);
  assert.ok(entitySoundProfile(flying, 10, {tiltRate: 5}).servo > .5);
  assert.equal(entitySoundProfile(flying, 10).servo, 0, '측정값이 없으면 소리도 없다');
  // A held angle arrives rounded, so a little jitter must not whine forever.
  assert.equal(entitySoundProfile(flying, 10, {tiltRate: .1}).servo, 0);
});

test('both transition regimes are audible, an order of magnitude apart', () => {
  // A scheduled flight tilts 0->90 across the whole climb stage -- minutes, so
  // well under a degree a second. A pilot changing mode by hand has it blended
  // through in seconds. If the scale only suits one of them, the other is
  // either inaudible or pinned flat, and the day is full of the first kind.
  const scheduled = entitySoundProfile(flying, 10, {tiltRate: .6});
  const byHand = entitySoundProfile(flying, 10, {tiltRate: 20});
  assert.ok(scheduled.servo > .2, `예정 비행의 전환도 들린다 (${scheduled.servo.toFixed(2)})`);
  assert.ok(byHand.servo > scheduled.servo * 1.8, '손으로 넘기면 확실히 더 크다');
  assert.ok(byHand.servo < 1, '위쪽이 한 값에 붙어버리지 않는다');
});

test('the actuator follows how fast it is driven, not where it has got to', () => {
  const slow = entitySoundProfile(flying, 10, {tiltRate: 1});
  const fast = entitySoundProfile(flying, 10, {tiltRate: 5});
  assert.ok(fast.servo > slow.servo);
  assert.ok(fast.servoRate > slow.servoRate, '음높이도 속도를 따라간다');
  // Driving back the other way is the same machinery doing the same work.
  assert.equal(entitySoundProfile(flying, 10, {tiltRate: -5}).servo, fast.servo);
  // The angle itself must not move it.
  assert.equal(entitySoundProfile({...flying, tilt_deg: 5}, 10, {tiltRate: 5}).servo, fast.servo);
});

test('a neighbour taxiing is shortlisted; a parked one and a silent flyer are not', () => {
  // The shortlist is six places and it is what the voices are drawn from, so
  // what gets in matters. A stopped-rotor aircraft that is merely airborne is
  // silent whatever happens next and must not take a place from something that
  // can be heard -- which is why this admits ground movement rather than any.
  const at = (id, entity) => [`x${id}`,
    {entity: {entity_id: `x${id}`, kind: 'uam', ...entity}, position: {x: 10 + id, y: 0, z: 0}}];
  const items = new Map([
    at(1, {flight_phase: 'gate_out', grounded: true, rotor_radps: 0, speed_mps: 4}),
    at(2, {flight_phase: 'parked', grounded: true, rotor_radps: 0, speed_mps: 0}),
    at(3, {flight_phase: 'climb', rotor_radps: 0, velocity_ecef_mps: [40, 0, 0]}),
  ]);
  const globe = {items, viewer: {camera: {positionWC: {x: 0, y: 0, z: 0}, rightWC: {x: 1, y: 0, z: 0},
    positionCartographic: {height: 100}}},
    entityScene: {layers: {uam: {visible: true}}, samples: {renderTime: () => 1, telemetryAt: () => ({})}}};
  assert.deepEqual(sceneSoundSample(globe, 0).nearby.map(s => s.entity.entity_id), ['x1']);
});

class Param {
  value = 0; events = [];
  setTargetAtTime(value, time, tau) {this.value = value; this.events.push({value, time, tau});}
  setValueAtTime(value) {this.value = value;}
  cancelScheduledValues() {}
}
class Node {
  constructor() {for (const key of ['gain', 'frequency', 'detune', 'Q', 'threshold', 'knee',
    'ratio', 'attack', 'release', 'pan']) this[key] = new Param();}
  connect() {return this;} disconnect() {} start() {this.started = true;} stop() {this.stopped = true;}
  setPeriodicWave() {}
}
class Context {
  currentTime = 0; sampleRate = 8000; state = 'suspended'; nodes = []; destination = new Node();
  node() {const n = new Node(); this.nodes.push(n); return n;}
  createGain() {return this.node();} createOscillator() {return this.node();}
  createBufferSource() {return this.node();} createBiquadFilter() {return this.node();}
  createDynamicsCompressor() {return this.node();} createStereoPanner() {return this.node();}
  createPeriodicWave() {return {};}
  createBuffer(channels, length) {return {getChannelData: () => new Float32Array(length)};}
  async resume() {this.state = 'running';} async suspend() {this.state = 'suspended';}
  async close() {this.state = 'closed';}
}

async function engine() {
  const context = new Context();
  const audio = new SelectedEntityAudio({createContext: () => context});
  await audio.enable();
  return {audio, context, voice: () => audio.voices[audio.active]};
}

test('a voice whose rotors are stopped still sounds when it rolls, and its rotor path stays silent', async () => {
  const {audio, voice} = await engine();
  audio.update({entity: rolling, distance: 10});
  const v = voice();
  assert.ok(v.output.gain.value > 0, '목소리가 열린다');
  assert.ok(v.rollGain.gain.value > 0, '구르는 소리가 난다');
  assert.equal(v.rotor.gain.value, 0, '멈춘 회전익은 소리를 내지 않는다');
  assert.equal(v.airGain.gain.value, 0, '엔진 기류도 나지 않는다');
  await audio.destroy();
});

test('an aircraft in the air is mixed exactly as it was before any of this', async () => {
  // The share arithmetic has to be an identity when there is nothing else
  // happening, or every flight in the fleet quietly changes tone.
  const {audio, context, voice} = await engine();
  audio.update({entity: flying, distance: 100});
  const v = voice(), profile = entitySoundProfile(flying, 100, {tiltRate: 0});
  assert.ok(profile.level > 0);
  assert.equal(v.output.gain.value, profile.level, '출력은 예전 그대로 level 이다');
  assert.equal(v.rotor.gain.value, .065 * (1 - .3 * profile.cruise), '회전익 경로도 그대로다');
  assert.equal(v.rollGain.gain.value, 0);
  assert.equal(v.servoGain.gain.value, 0);
  assert.equal(context.nodes.filter(n => n.started).length > 0, true);
  await audio.destroy();
});

test('the tilt rate is measured between observations, and a long gap is not one movement', async () => {
  const {audio, context, voice} = await engine();
  // Held still: nothing is being driven.
  audio.update({entity: {...flying, tilt_deg: 20}, distance: 10});
  context.currentTime = .05;
  audio.update({entity: {...flying, tilt_deg: 20}, distance: 10});
  assert.equal(voice().servoGain.gain.value, 0, '각도가 그대로면 조용하다');
  // Driven over: several degrees a second, sampled at the usual 20 Hz.
  for (let step = 1; step <= 6; step++) {
    context.currentTime = .05 + step * .05;
    audio.update({entity: {...flying, tilt_deg: 20 + step * .4}, distance: 10});
  }
  const driven = voice().servoGain.gain.value;
  assert.ok(driven > 0, `구동 중에는 기계 소리가 난다 (${driven.toFixed(3)})`);
  // A gap the aircraft could have done anything in says nothing about a servo,
  // so the whole change must not be reported as one sweep.
  context.currentTime = 12;
  audio.update({entity: {...flying, tilt_deg: 90}, distance: 10});
  assert.equal(voice().servoGain.gain.value, 0, '오래 끊겼다 오면 한 번의 움직임이 아니다');
  await audio.destroy();
});

test('a slow scheduled transition holds a steady actuator rather than pulsing', async () => {
  // The rate is a difference between two rounded angles 50 ms apart, and at
  // 0.6 deg/s that difference is three hundredths of a degree. Without the
  // smoothing it lands as a spike and a gap and the actuator stutters, which
  // sounds like a fault rather than a machine.
  const {audio, context, voice} = await engine();
  let tilt = 10; const seen = [];
  for (let step = 0; step < 40; step++) {
    context.currentTime = step * .05;
    audio.update({entity: {...flying, tilt_deg: tilt}, distance: 10});
    tilt += .03;
    if (step >= 20) seen.push(voice().servoGain.gain.value);
  }
  assert.ok(Math.min(...seen) > 0, '내내 들린다');
  assert.ok(Math.max(...seen) - Math.min(...seen) < .05,
    `맥동하지 않는다 (${Math.min(...seen).toFixed(3)}~${Math.max(...seen).toFixed(3)})`);
  await audio.destroy();
});

test('measuring the rate of many aircraft does not grow without bound', async () => {
  const {audio, context} = await engine();
  for (let i = 0; i < 300; i++) {
    context.currentTime = i * .05;
    audio.update({entity: {...flying, entity_id: `u${i}`, tilt_deg: i % 90}, distance: 10});
  }
  assert.ok(audio.motion.size <= 24, `기억이 무한정 늘지 않는다 (${audio.motion.size})`);
  await audio.destroy();
});
