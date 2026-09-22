import test from 'node:test';
import assert from 'node:assert/strict';
import {WalkCamera, blockedAt, deckUnder, doorStep, insideRing, stepPose,
  EYE_M, WALK_MPS, RUN_MPS} from '../../../../digital_twin/visualization/web/walk_camera.js';

// Getting out and standing on the deck. The rule the whole thing rests on is
// that a person can only be where the floor is -- and the floor is the same
// polygon the aircraft lands on, so there is no second definition to drift.

// A 100 m square deck at 37.5N, 100 m up, and the metres-per-degree it implies.
const M = 111320, E = M * Math.cos(37.5 * Math.PI / 180);
const half = 50;
const DECK = {id: 'VP1', height_m: 100, outline: [
  [127 - half / E, 37.5 - half / M], [127 + half / E, 37.5 - half / M],
  [127 + half / E, 37.5 + half / M], [127 - half / E, 37.5 + half / M]]};
const DECKS = [DECK];
const middle = () => ({longitude: 127, latitude: 37.5, height: 100, heading: 0, pitch: 0});
// One second of walking is twenty frames of it. A single step() of a whole
// second is refused on purpose -- see the hidden-tab test below -- so asking
// for a second's travel has to ask the way the page does.
function walk(pose, seconds, input, decks = DECKS) {
  let at = pose;
  for (let left = seconds; left > 0; left -= .05) at = stepPose(at, Math.min(.05, left), input, decks);
  return at;
}

test('the floor is the polygon the aircraft lands on, and nothing outside it is', () => {
  assert.equal(deckUnder(DECKS, 127, 37.5)?.id, 'VP1');
  assert.equal(deckUnder(DECKS, 127 + 60 / E, 37.5), null, '데크 밖은 바닥이 없다');
  assert.equal(deckUnder([], 127, 37.5), null);
  assert.equal(insideRing(DECK.outline, 127, 37.5), true);
  assert.equal(insideRing(DECK.outline, 127, 37.5 + 60 / M), false);
});

test('walking forward covers a walking pace, and running covers a running one', () => {
  const walked = walk(middle(), 1, {forward: 1});
  assert.ok(Math.abs((walked.latitude - 37.5) * M - WALK_MPS) < .05, '북쪽으로 보행 속도만큼');
  const ran = walk(middle(), 1, {forward: 1, run: true});
  assert.ok(Math.abs((ran.latitude - 37.5) * M - RUN_MPS) < .05);
  // Backing up is a shuffle whatever the button says.
  const back = walk(middle(), 1, {forward: -1, run: true});
  assert.ok(Math.abs((back.latitude - 37.5) * M + WALK_MPS) < .05);
});

test('heading decides which way forward is, and strafing is square to it', () => {
  const east = walk({...middle(), heading: 90}, 1, {forward: 1});
  assert.ok((east.longitude - 127) * E > WALK_MPS - .05, '기수 90도면 동쪽으로');
  assert.ok(Math.abs((east.latitude - 37.5) * M) < .05);
  const right = walk(middle(), 1, {strafe: 1});
  assert.ok((right.longitude - 127) * E > WALK_MPS - .05, '옆걸음은 오른쪽으로');
});

test('the edge is a wall, not a cliff', () => {
  // A pace from the edge, walking at it: the step is refused whole rather than
  // leaving someone standing on air 100 m up.
  const atEdge = {...middle(), latitude: 37.5 + (half - .02) / M};
  const after = stepPose(atEdge, .05, {forward: 1}, DECKS);
  assert.equal(after.latitude, atEdge.latitude, '가장자리에서 더 나아가지 않는다');
  assert.equal(after.longitude, atEdge.longitude);
  // Turning and looking still work while stood against it.
  const turned = stepPose(atEdge, .05, {forward: 1, turn: 1, pitch: -1}, DECKS);
  assert.notEqual(turned.heading, atEdge.heading);
  assert.ok(turned.pitch < 0);
});

test('looking up and down stops before the neck does', () => {
  let pose = middle();
  for (let i = 0; i < 40; i++) pose = stepPose(pose, .5, {pitch: 1}, DECKS);
  assert.ok(pose.pitch <= 72 && pose.pitch >= 71, `위쪽 한계 (${pose.pitch})`);
  for (let i = 0; i < 80; i++) pose = stepPose(pose, .5, {pitch: -1}, DECKS);
  assert.ok(pose.pitch >= -72 && pose.pitch <= -71);
});

test('a frame the page never delivered cannot teleport anybody', () => {
  // A hidden tab hands back one enormous delta when it wakes.
  const far = stepPose(middle(), 90, {forward: 1, run: true}, DECKS);
  assert.ok(Math.hypot((far.latitude - 37.5) * M, (far.longitude - 127) * E) <= RUN_MPS * .25 + .01);
  assert.deepEqual(stepPose(middle(), NaN, {forward: 1}, DECKS).latitude, 37.5);
});

test('stepping out of the door puts you beside the aircraft, facing it', () => {
  const sample = {position: {longitude: 127, latitude: 37.5, altitude_m: 100}, heading_deg: 0};
  const at = doorStep(sample, {forward_m: .3, right_m: 1.1}, DECKS);
  assert.equal(at.deck, 'VP1');
  assert.equal(at.height, 100, '높이는 데크가 정한다');
  assert.ok((at.longitude - 127) * E > 1.5, '문이 있는 오른쪽으로 내려선다');
  assert.equal(at.heading, 270, '내려서면 기체를 본다');
  // Nowhere to stand is answered as nowhere, not as a guess.
  assert.equal(doorStep(sample, {forward_m: 0, right_m: 0}, []), null);
  assert.equal(doorStep(null, {}, DECKS), null);
});

test('the camera refuses to stand somewhere there is no deck, and gives the view back', () => {
  const inputs = {enableRotate: true, enableTranslate: true, enableZoom: true, enableTilt: true, enableLook: true};
  const views = [];
  const C = {Cartesian3: {clone: v => ({...v}), fromDegrees: (lon, lat, h) => ({lon, lat, h})},
    Matrix4: {IDENTITY: 'I', clone: m => m}, Math: {toRadians: d => d * Math.PI / 180}};
  const camera = {positionWC: {x: 1}, directionWC: {y: 1}, upWC: {z: 1}, transform: 'T',
    setView: view => views.push(view)};
  const walk = new WalkCamera({viewer: {camera, scene: {screenSpaceCameraController: inputs}}, C});
  assert.equal(walk.enter({longitude: 127, latitude: 37.6}, DECKS), false, '바닥이 없으면 서지 않는다');
  assert.equal(walk.active, false);
  assert.equal(inputs.enableRotate, true, '거절했으면 조작도 그대로다');

  assert.equal(walk.enter({longitude: 127, latitude: 37.5, height: 100, heading: 20}, DECKS), true);
  assert.equal(walk.active, true);
  assert.equal(inputs.enableRotate, false, '마우스는 둘러보기에 쓴다');
  assert.equal(views.at(-1).destination.h, 100 + EYE_M, '눈높이로 선다');

  walk.step(1, {forward: 1});
  assert.ok(views.length > 1);
  assert.equal(walk.exit(), true);
  assert.equal(walk.active, false);
  assert.equal(inputs.enableRotate, true, '나가면 조작을 돌려준다');
  assert.equal(views.at(-1).destination.x, 1, '보던 자리로 돌아간다');
  assert.equal(walk.exit(), false, '두 번 나가는 일은 없다');
});

// --- the storey below ---------------------------------------------------
// The terminal floor is directly under the deck, so a longitude and latitude
// is inside both. Which one you are on is a fact about the person, and the
// stair cores are the only places it changes.
const FLOOR = {id: 'VP1:terminal', level: -1, height_m: 95.4, outline: DECK.outline};
const CORE = [[127 - 2 / E, 37.5 + 18 / M], [127 + 2 / E, 37.5 + 18 / M],
  [127 + 2 / E, 37.5 + 22 / M], [127 - 2 / E, 37.5 + 22 / M]];
const WORLD = {surfaces: [{...DECK, level: 0}, FLOOR], links: [
  {id: 'down', from: 0, to: -1, outline: CORE, exit: {longitude: 127, latitude: 37.5 + 26 / M}},
  {id: 'up', from: -1, to: 0, outline: CORE, exit: {longitude: 127, latitude: 37.5 + 14 / M}}]};

test('two floors share a point, and the level says which one you are on', () => {
  assert.equal(deckUnder(WORLD.surfaces, 127, 37.5, 0)?.id, 'VP1');
  assert.equal(deckUnder(WORLD.surfaces, 127, 37.5, -1)?.id, 'VP1:terminal');
  // Walking downstairs never changes where you are, only which floor.
  const below = stepPose({longitude: 127, latitude: 37.5, height: 100, heading: 0, pitch: 0, level: -1},
    .05, {forward: 1}, WORLD);
  assert.equal(below.level, -1);
  assert.equal(below.height, 95.4, '아래층 높이로 선다');
});

test('walking into a core takes you to the other end of it', () => {
  let pose = {longitude: 127, latitude: 37.5 + 14 / M, height: 100, heading: 0, pitch: 0, level: 0};
  for (let i = 0; i < 200 && pose.level === 0; i++) pose = stepPose(pose, .05, {forward: 1}, WORLD);
  assert.equal(pose.level, -1, '계단으로 걸어 들어가면 아래층이다');
  assert.equal(pose.height, 95.4);
  assert.equal(pose.through, 'down');
  // And the landing is clear of the core, so the next step does not send you
  // straight back up again.
  const next = stepPose(pose, .05, {}, WORLD);
  assert.equal(next.level, -1, '층계참에서 곧바로 되돌아가지 않는다');
});

test('a stair with nowhere to arrive leaves you where you were', () => {
  const broken = {surfaces: [{...DECK, level: 0}], links: WORLD.links};
  let pose = {longitude: 127, latitude: 37.5 + 14 / M, height: 100, heading: 0, pitch: 0, level: 0};
  for (let i = 0; i < 200; i++) pose = stepPose(pose, .05, {forward: 1}, broken);
  assert.equal(pose.level, 0, '아래층이 없으면 내려가지 않는다');
  assert.equal(pose.height, 100);
});

test('a plain list of decks still works, as the deck-only case', () => {
  const pose = stepPose(middle(), .05, {forward: 1}, DECKS);
  assert.equal(pose.level, 0);
  assert.equal(pose.height, 100);
});

// The fit-out of the terminal floor is solid where it stands. It is refused
// the same way the edge of the deck is -- the move is not taken at all -- so
// there is one rule about where a person may be and not two that disagree.
const SHOP = [[127 - 6 / E, 37.5 + 6 / M], [127 + 6 / E, 37.5 + 6 / M],
  [127 + 6 / E, 37.5 + 14 / M], [127 - 6 / E, 37.5 + 14 / M]];
const FITTED = {...WORLD, blocks: [{id: 'shop', level: -1, outline: SHOP}]};

test('a shop is walked into and not through', () => {
  const start = {longitude: 127, latitude: 37.5, height: 95.4, deck: 'VP1:terminal',
    level: -1, heading: 0, pitch: 0};
  const after = walk(start, 8, {forward: 1}, FITTED);
  const north = (after.latitude - start.latitude) * M;
  assert.ok(north > 2 && north < 6.1, `가게 앞에서 선다 (${north.toFixed(2)} m)`);
  assert.equal(blockedAt(FITTED.blocks, 127, 37.5 + 10 / M, -1)?.id, 'shop');
});

test('what is solid on one floor is not solid on the other', () => {
  // Both floors are the same longitude and latitude. A bench downstairs that
  // also stopped somebody on the deck would be a bench in mid-air.
  assert.equal(blockedAt(FITTED.blocks, 127, 37.5 + 10 / M, 0), null);
  const onDeck = walk({longitude: 127, latitude: 37.5, height: 100, deck: 'VP1',
    level: 0, heading: 0, pitch: 0}, 8, {forward: 1}, FITTED);
  assert.ok((onDeck.latitude - 37.5) * M > 10, '데크에서는 지나간다');
});

test('a stair is still a stair even with something solid drawn over it', () => {
  // The way between floors is the one thing on the floor that has to be
  // reachable, so it is walked into on purpose rather than refused.
  const over = {...WORLD, blocks: [{id: 'over-core', level: 0, outline: CORE}]};
  const pose = walk({...middle(), level: 0, deck: 'VP1'}, 20, {forward: 1}, over);
  assert.equal(pose.level, -1, '계단은 막히지 않는다');
});

test('a world with no blocks behaves exactly as it did before there were any', () => {
  const plain = walk({...middle(), level: 0, deck: 'VP1'}, 2, {forward: 1}, WORLD);
  const empty = walk({...middle(), level: 0, deck: 'VP1'}, 2, {forward: 1}, {...WORLD, blocks: []});
  assert.deepEqual(plain, empty);
  assert.equal(blockedAt(undefined, 127, 37.5, 0), null);
});
