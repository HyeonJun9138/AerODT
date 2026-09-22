import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../../../../user_application/web/domains/uam/cockpit/deck_walk.js',import.meta.url),'utf8');
assert.match(source,/from '\/visualization\/walk_camera\.js'/,'browser imports use the served mount, not the repository path');
const walkUrl=new URL('../../../../digital_twin/visualization/web/walk_camera.js',import.meta.url).href;
const {DeckWalk}=await import('data:text/javascript;base64,'+Buffer.from(
  source.replace("'/visualization/walk_camera.js'",JSON.stringify(walkUrl))).toString('base64'));

// The server owns whether the pilot is out of the aircraft. This makes the view
// agree with that answer rather than keeping a second one -- which matters most
// in the case nobody presses a button for: an aircraft that strays ends its
// ground procedure, the flag drops, and the operator has to come back into a
// seat they never asked to return to.

const M = 111320, E = M * Math.cos(37.5 * Math.PI / 180);
const DECK = {id: 'VP1', height_m: 100, outline: [
  [127 - 50 / E, 37.5 - 50 / M], [127 + 50 / E, 37.5 - 50 / M],
  [127 + 50 / E, 37.5 + 50 / M], [127 - 50 / E, 37.5 + 50 / M]]};
const SAMPLE = {position: {longitude: 127, latitude: 37.5, altitude_m: 100}, heading_deg: 0};

function harness({decks = [DECK]} = {}) {
  const listeners = new Map(), views = [], notices = [], boarded = [], interiors = [], lives = [];
  const asked = [];
  let answer = {board: {clock: '07:30', departures: [], arrivals: [], waiting: {G1: 4}}};
  const view = {addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name)};
  const inputs = {enableRotate: true, enableTranslate: true, enableZoom: true, enableTilt: true, enableLook: true};
  const C = {Cartesian3: {clone: v => ({...v}), fromDegrees: (lon, lat, h) => ({lon, lat, h})},
    Matrix4: {IDENTITY: 'I', clone: m => m}, Math: {toRadians: d => d * Math.PI / 180}};
  const exits = [];
  const globe = {C, viewer: {camera: {positionWC: {x: 9}, directionWC: {}, upWC: {}, transform: 'T',
      setView: v => views.push(v)}, scene: {screenSpaceCameraController: inputs}},
    cockpit: {exit: (...args) => exits.push(args)}};
  let ground = {};
  const walk = new DeckWalk({globe, window: view, readGround: () => ground,
    readSample: () => SAMPLE, readDecks: () => decks,
    onBoard: () => boarded.push(1), notify: m => notices.push(m),
    showTerminal: (id, on) => {interiors.push([id, on]); return true;},
    readLife: id => {asked.push(id); return Promise.resolve(answer);},
    showLife: (...args) => {lives.push(args); return args[2] ? 4 : 0;}});
  return {walk, set: next => {ground = next;}, listeners, views, notices, boarded, inputs, exits,
    interiors, lives, asked, reply: next => {answer = next;}};
}

const OUT = {crew_outside: true, crew_door_m: {forward_m: .3, right_m: 1.1}};
// The refresh answers through a then/catch/finally chain, so the flag that
// stops a second request only clears a few microtasks after the answer.
const settle = async () => {for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();};

test('nothing happens until the service says the pilot is out', () => {
  const h = harness();
  h.set({phase: 'charging', crew_can_leave: true});
  assert.equal(h.walk.sync(0), false);
  assert.equal(h.walk.walking, false);
  assert.equal(h.exits.length, 0, '조종석을 함부로 비우지 않는다');
});

test('when it does, the cockpit lets go and the operator is stood beside the door', () => {
  const h = harness();
  h.set(OUT);
  assert.equal(h.walk.sync(0), true);
  assert.equal(h.walk.walking, true);
  assert.deepEqual(h.exits.at(-1), [false, true], '조종석이 먼저 카메라를 놓는다');
  assert.equal(h.views.at(-1).destination.h > 100, true, '데크 위 눈높이');
  assert.match(h.notices.at(-1), /W A S D/);
});

test('the keys move the person, and only while they are a person', () => {
  const h = harness();
  h.set(OUT); h.sync = t => h.walk.sync(t);
  h.walk.sync(0);
  const before = {...h.walk.camera.pose};
  h.listeners.get('keydown')({code: 'KeyW', preventDefault() {}});
  for (let t = 50; t <= 1000; t += 50) h.walk.sync(t);
  const after = h.walk.camera.pose;
  // Stepping out leaves you facing the aircraft, so forward is whichever
  // way that is -- what matters is that a pace was taken, not its compass.
  const moved = Math.hypot((after.latitude - before.latitude) * M,
    (after.longitude - before.longitude) * E);
  assert.ok(moved > 1, `앞으로 걷는다 (${moved.toFixed(2)} m)`);
  h.listeners.get('keyup')({code: 'KeyW', preventDefault() {}});
  const held = {...h.walk.camera.pose};
  for (let t = 1050; t <= 1500; t += 50) h.walk.sync(t);
  assert.equal(h.walk.camera.pose.latitude, held.latitude, '떼면 선다');
});

test('E boards beside the door, but Escape is not a boarding shortcut', () => {
  const h = harness();
  h.set(OUT); h.walk.sync(0);
  h.listeners.get('keydown')({code: 'KeyE', preventDefault() {}});
  h.listeners.get('keydown')({code: 'Escape', preventDefault() {}});
  assert.equal(h.boarded.length, 1);
  assert.equal(h.walk.walking, true, '탑승은 서버가 정한다 — 키가 바로 앉히지 않는다');
});

test('E away from the aircraft tells the distance and does not board', () => {
  const h = harness();
  h.set(OUT); h.walk.sync(0);
  h.walk.camera.pose.longitude += 8 / E;
  h.listeners.get('keydown')({code: 'KeyE', preventDefault() {}});
  assert.equal(h.boarded.length, 0);
  assert.match(h.notices.at(-1), /출입문까지 8\.0 m/);
});

test('boarding is refused from the terminal floor even below the door', () => {
  const h = harness();
  h.set(OUT); h.walk.sync(0);
  h.walk.camera.pose.level = -1;
  h.listeners.get('keydown')({code: 'KeyE', preventDefault() {}});
  assert.equal(h.boarded.length, 0);
  assert.match(h.notices.at(-1), /데크로 올라가/);
});

test('the flag dropping puts the operator back, whoever dropped it', () => {
  // Pressing 기체로 돌아가기 and an aircraft that strayed out of its procedure
  // reach this the same way, which is the point of reading one flag.
  const h = harness();
  h.set(OUT); h.walk.sync(0);
  assert.equal(h.inputs.enableRotate, false);
  h.set({phase: 'idle'});
  assert.equal(h.walk.sync(100), false);
  assert.equal(h.walk.walking, false);
  assert.equal(h.inputs.enableRotate, true, '조작을 돌려준다');
  assert.equal(h.views.at(-1).destination.x, 9, '보던 자리로 돌아간다');
});

test('a deck the page has not received is said, not walked on', () => {
  const h = harness({decks: []});
  h.set(OUT);
  assert.equal(h.walk.sync(0), false);
  assert.equal(h.walk.walking, false);
  assert.match(h.notices.at(-1), /데크를 찾지 못했습니다/);
});

test('keys pressed before stepping out cannot carry into the first frame', () => {
  const h = harness();
  h.set({phase: 'charging'});
  h.walk.sync(0);
  h.listeners.get('keydown')({code: 'KeyW', preventDefault() {}});   // ignored: not walking
  h.set(OUT); h.walk.sync(50);
  const start = {...h.walk.camera.pose};
  h.walk.sync(100);
  assert.equal(h.walk.camera.pose.latitude, start.latitude, '내리자마자 걷고 있지는 않다');
});

test('the storey under the deck is stood up while somebody is on it, and taken down after', () => {
  // It is hidden under its own deck, so distance cannot decide this: the one
  // moment worth paying for the geometry is the one the operator is standing
  // still in, before they walk through the door rather than as they do.
  const h = harness();
  h.set(OUT); h.walk.sync(0);
  assert.deepEqual(h.interiors.at(-1), ['VP1', true], '내린 데크의 실내');
  h.set({phase: 'idle'}); h.walk.sync(100);
  assert.deepEqual(h.interiors.at(-1), ['VP1', false], '앉으면 치운다');
  assert.equal(h.interiors.length, 2, '한 번씩만');
});

test('a deck the page has not received leaves no interior standing', () => {
  const h = harness({decks: []});
  h.set(OUT); h.walk.sync(0);
  assert.deepEqual(h.interiors, []);
});

test('changing floor is said, because the stairs are the one thing with no button', () => {
  const M2 = 111320, E2 = M2 * Math.cos(37.5 * Math.PI / 180);
  const at = (e, n) => [127 + e / E2, 37.5 + n / M2];
  const square = (e, n, half) => [at(e - half, n - half), at(e + half, n - half),
    at(e + half, n + half), at(e - half, n + half)];
  // The door step lands at the middle of the deck; the stair is a pace away.
  const world = {surfaces: [
      {id: 'VP1', level: 0, height_m: 100, outline: square(0, 0, 50)},
      {id: 'VP1:terminal', level: -1, height_m: 95.4, outline: square(0, 0, 47)}],
    links: [{id: 'VP1:T1:down', from: 0, to: -1, gate: 'G1', outline: square(1.1, 0, 2.2),
      exit: {longitude: at(6, 0)[0], latitude: at(6, 0)[1]}}]};
  const h = harness({decks: world});
  h.set(OUT); h.walk.sync(0);
  assert.equal(h.walk.level, 0);
  h.listeners.get('keydown')({code: 'KeyW', preventDefault() {}});
  for (let t = 50; t <= 1500 && h.walk.level === 0; t += 50) h.walk.sync(t);
  assert.equal(h.walk.level, -1, '계단으로 내려간다');
  assert.match(h.notices.at(-1), /터미널 층/);
  assert.equal(h.walk.camera.pose.height, 95.4, '아래층 바닥 높이');
});

test('the terminal asks the day what it is doing, and not on every frame', async () => {
  const h = harness();
  h.set(OUT); h.walk.sync(0);
  await settle();
  assert.deepEqual(h.asked, ['VP1'], '내리자마자 한 번');
  for (let t = 50; t <= 2000; t += 50) h.walk.sync(t);
  assert.equal(h.asked.length, 1, '2.5초 안에는 다시 묻지 않는다');
  h.walk.sync(2600);
  await settle();
  assert.equal(h.asked.length, 2);
  // The wall and the room come from the one answer.
  assert.deepEqual(h.lives.at(-1)[2], {G1: 4});
  assert.equal(h.lives.at(-1)[1].clock, '07:30');
});

test('a slow answer does not queue a second request behind it', async () => {
  const h = harness();
  let release;
  h.walk.readLife = () => {h.asked.push('VP1'); return new Promise(resolve => {release = resolve;});};
  h.set(OUT); h.walk.sync(0);
  for (let t = 3000; t <= 40000; t += 2600) h.walk.sync(t);
  assert.equal(h.asked.length, 1, '답이 올 때까지 한 건만');
  release({board: {departures: [], arrivals: [], waiting: {}}});
  await settle();
  h.walk.sync(60000);
  await settle();
  assert.equal(h.asked.length, 2);
});

test('an answer that arrives after boarding is not painted onto a floor nobody is on', async () => {
  const h = harness();
  let release;
  h.walk.readLife = () => new Promise(resolve => {release = resolve;});
  h.set(OUT); h.walk.sync(0);
  h.set({phase: 'idle'}); h.walk.sync(100);
  assert.equal(h.walk.walking, false);
  release({board: {departures: [], arrivals: [], waiting: {G1: 4}}});
  await settle();
  assert.equal(h.lives.length, 0, '이미 기체로 돌아갔다');
});

test('a deck with no day loaded still gets its interior, just an empty board', async () => {
  const h = harness();
  h.walk.readLife = () => Promise.resolve(null);
  h.set(OUT); h.walk.sync(0);
  await settle();
  assert.equal(h.walk.walking, true);
  assert.deepEqual(h.lives.at(-1), ['VP1', null, {}]);
});
