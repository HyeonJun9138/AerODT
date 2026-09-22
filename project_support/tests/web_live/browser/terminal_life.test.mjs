import test from 'node:test';
import assert from 'node:assert/strict';
import {BOARD_W, BOARD_H, CROWD_LIMIT, gateSigns, paintBoard, peopleOn}
  from '../../../../digital_twin/visualization/web/terminal_board.js';

// The schedule on the wall and the people it puts in the room come from one
// answer, so the thing worth testing is that they agree: the rows that say
// "탑승 · G3" are the rows that seat four people in G3's lounge, and a gate
// nobody has been called to is empty.

// Just enough 2D context to record what was drawn.
function canvas() {
  const drawn = [], fills = [];
  const ink = {
    set fillStyle(value) {fills.push(value); this._fill = value;},
    get fillStyle() {return this._fill;},
    set font(value) {this._font = value;}, get font() {return this._font;},
    set textAlign(value) {this._align = value;}, get textAlign() {return this._align;},
    set textBaseline(value) {this._base = value;}, get textBaseline() {return this._base;},
    fillRect: (x, y, w, h) => drawn.push({rect: [x, y, w, h], colour: ink._fill}),
    fillText: (text, x, y) => drawn.push({text, x, y, colour: ink._fill}),
  };
  return {width: 0, height: 0, getContext: () => ink, drawn, fills,
    texts: () => drawn.filter(item => item.text != null).map(item => item.text)};
}

const row = (changes = {}) => ({flight_id: 'F0031', direction: 'departure', time: '07:42',
  time_s: 27720, counterpart: 'VP2', counterpart_name: '잠실', gate: 'G3', passengers: 4, seats: 6,
  status: 'boarding', status_text: '탑승', late_s: 0, ...changes});

const BOARD = {vertiport_id: 'VP1', clock: '07:30', time_s: 27000,
  departures: [row(), row({flight_id: 'F0044', time: '07:55', time_s: 28500, gate: 'G1',
    status: 'scheduled', status_text: '예정', passengers: 3})],
  arrivals: [row({flight_id: 'F0028', direction: 'arrival', time: '07:35', time_s: 27300,
    counterpart_name: '광화문', gate: 'G2', status: 'approach', status_text: '접근'})],
  waiting: {G3: 4}};

test('the board is painted at a fixed size, whatever the panel measures', () => {
  const sheet = canvas();
  paintBoard(sheet, BOARD, {title: '여의도', now: '07:30'});
  assert.equal(sheet.width, BOARD_W);
  assert.equal(sheet.height, BOARD_H);
});

test('every row is on it, soonest first, with its own words', () => {
  const sheet = canvas();
  const drawn = paintBoard(sheet, BOARD, {title: '여의도', now: '07:30'});
  assert.equal(drawn, 3);
  const texts = sheet.texts();
  assert.ok(texts.includes('여의도') && texts.includes('07:30'), '머리글과 시계');
  // 07:35 arrival sits between the two departures, because a board is a clock.
  const order = ['07:42', '07:35', '07:55'].map(time => texts.indexOf(time));
  assert.ok(order[1] < order[0] && order[0] < order[2], texts.join('|'));
  assert.ok(texts.includes('탑승') && texts.includes('접근') && texts.includes('예정'));
  // Which way a flight is going is read at a glance, not from a word.
  assert.ok(texts.includes('→ 잠실') && texts.includes('← 광화문'));
  assert.ok(texts.includes('G3') && texts.includes('G1'));
});

test('a status has its own colour, so a delay is seen before it is read', () => {
  const sheet = canvas();
  paintBoard(sheet, {...BOARD, departures: [row({status: 'late', status_text: '지연'})],
    arrivals: [], waiting: {}}, {});
  const late = sheet.drawn.find(item => item.text === '지연');
  const plain = sheet.drawn.find(item => item.text === '07:42');
  assert.ok(late && plain && late.colour !== plain.colour);
});

test('an empty board says so, and one with no answer yet says that instead', () => {
  const nothing = canvas();
  assert.equal(paintBoard(nothing, {departures: [], arrivals: []}, {}), 0);
  assert.ok(nothing.texts().some(text => /예정된 운항이 없습니다/.test(text)));
  const waiting = canvas();
  assert.equal(paintBoard(waiting, null, {}), 0);
  assert.ok(waiting.texts().some(text => /불러오는 중/.test(text)));
  assert.equal(paintBoard(null, BOARD, {}), 0, '캔버스가 없으면 아무 일도 없다');
});

// ---------------------------------------------------------------------------

const seats = (cx, cy) => ({outline_m: [[cx - 1.5, cy], [cx + 1.5, cy], [cx + 1.5, cy + .6], [cx - 1.5, cy + .6]],
  seats_m: [[cx - 1, cy], [cx, cy], [cx + 1, cy]], facing_m: [0, 1]});
const PLAN = {
  entry: {center_m: [0, -40], facing_m: [0, 1]},
  security: {lanes: [{id: 'S1', center_m: [0, -34]}]},
  lounges: [{id: 'L1', gate: 'G1', core: 'T1', center_m: [-20, 0], rows: [seats(-20, 0), seats(-20, 2)]},
    {id: 'L3', gate: 'G3', core: 'T3', center_m: [20, 0], rows: [seats(20, 0), seats(20, 2)]}],
  rest: [], units: [{id: 'U1', kind: 'shop', center_m: [-40, 20], size_m: [9, 10], facing_m: [1, 0]},
    {id: 'U2', kind: 'toilet', center_m: [40, 20], size_m: [9, 10], facing_m: [-1, 0]}],
  board: null};

test('only the gate that has been called has anybody at it', () => {
  const people = peopleOn(PLAN, {waiting: {G3: 4}});
  const passengers = people.filter(person => person.kind === 'passenger');
  assert.equal(passengers.length, 4);
  // All of them at G3's lounge, none at G1's.
  assert.ok(passengers.every(person => person.at[0] > 10), JSON.stringify(passengers));
  assert.equal(peopleOn(PLAN, {waiting: {}}).filter(p => p.kind === 'passenger').length, 0);
});

test('a lounge fills its seats first and stands the rest behind them', () => {
  const people = peopleOn(PLAN, {waiting: {G1: 8}, staff: false});
  assert.equal(people.length, 8);
  const seated = people.filter(person => person.seated);
  assert.equal(seated.length, 6, '두 줄 세 자리');
  // The six seated are on the seats the plan gives, to the centimetre.
  const places = new Set([...PLAN.lounges[0].rows].flatMap(r => r.seats_m).map(p => p.join()));
  assert.ok(seated.every(person => places.has(person.at.join())), '자리에 앉는다');
  // Nobody is standing on somebody else.
  const standing = people.filter(person => !person.seated);
  assert.equal(standing.length, 2);
  assert.notDeepEqual(standing[0].at, standing[1].at);
});

test('the shops and the screening are staffed whether or not a flight is boarding', () => {
  const people = peopleOn(PLAN, {waiting: {}});
  assert.equal(people.filter(person => person.kind === 'officer').length, 1);
  // A shop has somebody in it; a toilet does not.
  assert.equal(people.filter(person => person.kind === 'staff').length, 1);
  assert.equal(peopleOn(PLAN, {waiting: {}, staff: false}).length, 0);
});

test('a crowd is capped, because a floor is not a frame budget', () => {
  const people = peopleOn(PLAN, {waiting: {G1: 500, G3: 500}});
  assert.ok(people.length <= CROWD_LIMIT, people.length);
  assert.equal(peopleOn(PLAN, {waiting: {G1: 4}, crowd: 2}).length, 2);
});

test('nobody is placed on a floor that has no plan', () => {
  assert.deepEqual(peopleOn(null, {waiting: {G1: 4}}), []);
  assert.deepEqual(peopleOn({}, {waiting: {G1: 4}}), []);
});

test('everybody faces something: a heading is a compass bearing, not a vector', () => {
  for (const person of peopleOn(PLAN, {waiting: {G3: 6}})) {
    assert.ok(Number.isFinite(person.heading) && person.heading >= 0 && person.heading < 360,
      `${person.kind} ${person.heading}`);
  }
});

test('a gate says which flight it is boarding, not just its own number', () => {
  const signs = gateSigns(BOARD);
  assert.equal(signs.get('G3'), 'G3 · 07:42 잠실 · 탑승');
  assert.equal(signs.get('G1'), 'G1 · 07:55 잠실 · 예정');
  // Arrivals are not boarding anybody, so G2 keeps its plain sign.
  assert.equal(signs.has('G2'), false);
  assert.equal(gateSigns(null).size, 0);
});

test('a gate with two departures shows the one leaving first', () => {
  const later = {...BOARD.departures[0], time: '09:10', time_s: 33000, status_text: '예정'};
  const signs = gateSigns({departures: [BOARD.departures[0], {...later, gate: 'G3'}]});
  assert.match(signs.get('G3'), /07:42/);
});
