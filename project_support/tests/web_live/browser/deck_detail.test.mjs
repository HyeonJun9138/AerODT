import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {FakeElement, fakeDocument} from './fake_dom.mjs';
import {resourceStates, landingQueue, padWindows, deckSummary, expectedAt, SOON_S}
  from '../../../../user_application/web/deck_state.js';
import {DeckDetail} from '../../../../user_application/web/domains/uam/operations/deck_detail.js';
import {resourcesOf} from '../../../../user_application/web/vertiport_operations.js';

// A small deck: two stands, two pads, a charger on each stand and a taxiway
// joining G1 to F1.
const RECORD = {
  id: 'VP001', name: '여의도',
  layout: {
    frame: {heading_deg: 0, latitude: 37.52, longitude: 126.92},
    platform: {corners_m: [[-50, -40], [50, -40], [50, 40], [-50, 40]]},
    fatos: [{id: 'F1', center_m: [30, 0], role: 'both'}, {id: 'F2', center_m: [-30, 0], role: 'both'}],
    gates: [{id: 'G1', center_m: [0, 20]}, {id: 'G2', center_m: [0, -20]}],
    chargers: [{id: 'C1', center_m: [12, 20], gate: 'G1'}, {id: 'C2', center_m: [12, -20], gate: 'G2'}],
    edges: [{id: 'E1', from: 'G1', to: 'F1', points_m: [[0, 20], [30, 0]]},
            {id: 'E2', from: 'G2', to: 'F2', points_m: [[0, -20], [-30, 0]]}],
  },
};
const RESOURCES = resourcesOf(RECORD);

const deckOf = (over = {}) => ({
  vertiport_id: 'VP001', clock: '07:10:00', time_s: 25800,
  standing: [{aircraft_id: 'UAM0001', flight_id: 'FPL1', stand: 'G1', phase: 'charge'}],
  inbound: [{aircraft_id: 'UAM0002', flight_id: 'FPL2', stand: 'G2', phase: 'cruise',
             sequence: 4, holding: false, hold_seconds: 0, airborne: true},
            // Bound here, but still taxiing at its own origin: it has not asked
            // for a slot yet, so it has no landing number and no stand.
            {aircraft_id: 'UAM0007', flight_id: 'FPL7', stand: null, phase: 'gate_out',
             sequence: null, holding: false, hold_seconds: 0, airborne: false}],
  holding: [{aircraft_id: 'UAM0003', flight_id: 'FPL3', stand: null, phase: 'hold',
             sequence: 2, holding: true, hold_seconds: 300},
            {aircraft_id: 'UAM0004', flight_id: 'FPL4', stand: null, phase: 'hold',
             sequence: 3, holding: true, hold_seconds: 150}],
  outbound: [],
  movements: [{aircraft_id: 'UAM0005', flight_id: 'FPL5', phase: 'gate_in',
               from: 'F1', to: 'G1', on_ground: true}],
  pads: {F1: [{from_s: 25790, to_s: 25880, flight_id: 'FPL9', kind: 'arrival'}],
         F2: [{from_s: 26400, to_s: 26490, flight_id: 'FPL8', kind: 'departure'}]},
  stands: {G1: 'FPL1', G2: 'FPL2'},
  ...over,
});

// ---- what the deck is doing ------------------------------------------------
test('a stand somebody is standing on and one somebody is only coming to read differently', () => {
  // An operator deciding where to put an arrival has to be able to tell the two
  // apart; both would otherwise show as simply taken.
  const states = resourceStates(deckOf(), RESOURCES);
  assert.deepEqual(states.get('gate:G1'), {state: 'occupied', occupants: ['FPL1']});
  assert.deepEqual(states.get('gate:G2'), {state: 'reserved', occupants: ['FPL2']});
  const empty = resourceStates(deckOf({standing: [], inbound: [], holding: [], stands: {}}), RESOURCES);
  assert.equal(empty.get('gate:G1').state, 'free');
  assert.equal(empty.get('gate:G2').state, 'free');
});

test('PSU resource projection uses actual aircraft IDs and separate flight reservations',()=>{
  const deck=deckOf({standing:[],inbound:[],holding:[],stands:{G1:'UAM0019'},stand_reservations:{G2:'FPL-ARR'}});
  const before=structuredClone(deck),states=resourceStates(deck,RESOURCES);
  assert.deepEqual(states.get('gate:G1'),{state:'occupied',occupants:['UAM0019']});
  assert.deepEqual(states.get('gate:G2'),{state:'reserved',occupants:['FPL-ARR']});
  assert.deepEqual(deck,before);
  const cleared=resourceStates(deckOf({stands:{},stand_reservations:{}}),RESOURCES);
  assert.deepEqual(cleared.get('gate:G1'),{state:'free',occupants:[]});
  assert.deepEqual(cleared.get('gate:G2'),{state:'free',occupants:[]});
  assert.equal(cleared.get('charger:C1').state,'free','a cleared stand cannot retain a stale charging occupant');
});

test('a pad is busy while a booking is running and spoken for only when one is close', () => {
  const states = resourceStates(deckOf(), RESOURCES);
  assert.deepEqual(states.get('fato:F1'), {state: 'occupied', occupants: ['FPL9']});
  // F2's booking is ten minutes off, which is not a pad an operator would call
  // taken.
  assert.equal(states.get('fato:F2').state, 'free');
  const soon = deckOf({pads: {F1: [], F2: [{from_s: 25800 + SOON_S - 10, to_s: 26000,
    flight_id: 'FPL8', kind: 'departure'}]}});
  assert.deepEqual(resourceStates(soon, RESOURCES).get('fato:F2'),
    {state: 'reserved', occupants: ['FPL8']});
  // Two bookings over the same moment is the service contradicting itself.
  const clash = deckOf({pads: {F1: [{from_s: 25790, to_s: 25880, flight_id: 'A', kind: 'arrival'},
                                    {from_s: 25795, to_s: 25885, flight_id: 'B', kind: 'arrival'}]}});
  assert.equal(resourceStates(clash, RESOURCES).get('fato:F1').state, 'conflict');
});

test('a charger is in use when the aircraft on its stand is charging, not merely parked', () => {
  const states = resourceStates(deckOf(), RESOURCES);
  assert.deepEqual(states.get('charger:C1'), {state: 'occupied', occupants: ['FPL1']});
  assert.equal(states.get('charger:C2').state, 'free');
  const parked = deckOf({standing: [{aircraft_id: 'UAM0001', flight_id: 'FPL1',
    stand: 'G1', phase: 'parked'}]});
  assert.equal(resourceStates(parked, RESOURCES).get('charger:C1').state, 'reserved');
});

test('only the taxiways a ground run actually crosses are marked, by the deck topology', () => {
  const states = resourceStates(deckOf(), RESOURCES);
  assert.deepEqual(states.get('taxiway:E1'), {state: 'occupied', occupants: ['FPL5']});
  assert.equal(states.get('taxiway:E2').state, 'free', 'an unrelated taxiway is not coloured');
  // An aircraft in the air is not on the ground, whatever its phase says.
  const flying = deckOf({movements: [{aircraft_id: 'X', flight_id: 'F', phase: 'landing',
    from: null, to: 'F1', on_ground: false}]});
  assert.equal(resourceStates(flying, RESOURCES).get('taxiway:E1').state, 'free');
});

test('nothing is invented when there is no day', () => {
  assert.equal(resourceStates(null, RESOURCES).size, 0);
  assert.equal(deckSummary(null), null);
  assert.deepEqual(landingQueue(null), []);
  assert.deepEqual(padWindows(null), []);
});

// ---- the queue -------------------------------------------------------------
test('the queue is in the order the service gave, with those still to ask at the back', () => {
  const rows = landingQueue(deckOf());
  assert.deepEqual(rows.map(row => row.aircraft_id), ['UAM0003', 'UAM0004', 'UAM0002']);
  assert.deepEqual(rows.map(row => row.place), [1, 2, 3]);
  assert.deepEqual(rows.map(row => row.sequence), [2, 3, 4]);
  // Everything coming here is in it, waiting or not: a queue that shows only
  // the ones already holding cannot say whether the next one is about to join.
  assert.deepEqual(rows.map(row => row.holding), [true, true, false]);
  // An aircraft that has not asked yet is not ahead of anybody, whatever its
  // distance says.
  const unasked = landingQueue(deckOf({inbound: [{aircraft_id: 'UAM0009', sequence: null,
    hold_seconds: 0, phase: 'cruise', airborne: true}]}));
  assert.equal(unasked.at(-1).aircraft_id, 'UAM0009');
  assert.equal(unasked.at(-1).sequence, null);
});

test('a flight that has not left its own deck yet is counted, not queued', () => {
  // Putting it in the queue with the taxi phase it is in at its origin reads as
  // nonsense on this deck's screen - and it is not in a line, it has not joined
  // one. Whether it is coming is still worth knowing.
  const rows = landingQueue(deckOf());
  assert.ok(!rows.some(row => row.aircraft_id === 'UAM0007'));
  assert.equal(expectedAt(deckOf()), 1);
  assert.equal(expectedAt(deckOf({inbound: []})), 0);
  // An answer from before the flag existed is taken at face value rather than
  // silently emptying the queue.
  const older = deckOf({inbound: [{aircraft_id: 'UAM0002', sequence: 4, hold_seconds: 0, phase: 'cruise'}]});
  assert.equal(landingQueue(older).length, 3);
  assert.equal(expectedAt(older), 0);
});

test('a stopped ground wait cannot enter the airborne landing queue through a stale holding flag',()=>{
  const row={aircraft_id:'G',phase:'gate_out',airborne:false,holding:true,ground_waiting:true,
    instruction:{action:'ground_wait'}};
  const deck=deckOf({holding:[],inbound:[row]});
  assert.deepEqual(landingQueue(deck),[]);assert.equal(expectedAt(deck),1);
});

test('the bar each one gets is its wait against the longest wait on the deck', () => {
  const rows = landingQueue(deckOf());
  assert.equal(rows[0].share, 1, 'the longest wait fills its bar');
  assert.equal(rows[1].share, 0.5, 'half the wait is half the bar');
  assert.equal(rows[2].share, 0);
  // With nobody waiting the bars are empty rather than all full.
  const calm = landingQueue(deckOf({holding: [], inbound: [{aircraft_id: 'A', sequence: 1,
    hold_seconds: 0, phase: 'cruise', airborne: true}]}));
  assert.equal(calm[0].share, 0);
});

// ---- the pads --------------------------------------------------------------
test('a pad shows what is coming on a shared window, and nothing that is over', () => {
  const rows = padWindows(deckOf(), {span_s: 900});
  assert.deepEqual(rows.map(row => row.pad), ['F1', 'F2']);
  const [f1] = rows;
  assert.equal(f1.slots.length, 1);
  assert.equal(f1.slots[0].running, true, 'a booking over now is running');
  assert.equal(f1.slots[0].from, 0, 'and the part of it already past is clipped off');
  assert.ok(f1.slots[0].to > 0 && f1.slots[0].to <= 1);
  // F2's booking is at +600 s of a 900 s window.
  assert.equal(Math.round(rows[1].slots[0].from * 900), 600);
  // A booking that finished is the record's business, not the operator's.
  const past = padWindows(deckOf({pads: {F1: [{from_s: 100, to_s: 200,
    flight_id: 'OLD', kind: 'arrival'}]}}), {span_s: 900});
  assert.deepEqual(past[0].slots, []);
});

// ---- the view --------------------------------------------------------------
function mount({record = RECORD, deck = deckOf(), fail = false} = {}) {
  const document = {...fakeDocument, body: new FakeElement('body'), hidden: false};
  const host = new FakeElement('div');
  const asked = [];
  const view = new DeckDetail({document, poll: 1e9, api: {
    vertiport: async id => {asked.push(id); if (fail) throw new Error('HTTP 500'); return record;},
    occupancy: async id => {asked.push(id); return deck;}}});
  view.render(host);
  return {view, host, asked};
}

test('opening a deck draws its layout, its counts, its queue and its pads', async () => {
  const {view, host} = mount();
  assert.equal(view.root.hidden, true, 'nothing is shown until a deck is chosen');
  await view.open('VP001');
  assert.equal(view.root.hidden, false);
  assert.match(host.textContent, /여의도/);
  assert.match(host.textContent, /07:10:00/);
  // The counts.
  assert.equal(host.querySelectorAll('.deck-figure').length, 5);
  // The layout, drawn from the saved geometry and coloured by the day.
  const shapes = host.querySelectorAll('.vp-resource');
  assert.ok(shapes.length >= 8, `drew ${shapes.length} resources`);
  assert.equal(shapes.filter(node => node.getAttribute('data-state') === 'occupied').length >= 3, true);
  // The queue, in order, with a bar each.
  const queue = host.querySelectorAll('.deck-queue-row');
  assert.equal(queue.length, 3);
  assert.match(queue[0].textContent, /UAM0003/);
  assert.equal(queue[0].getAttribute('data-hold'), 'true');
  assert.equal(host.querySelectorAll('.deck-bar-fill').length, 3);
  // The pads, on their shared window.
  assert.equal(host.querySelectorAll('.deck-pad-track').length, 2);
  assert.equal(host.querySelectorAll('.deck-pad-slot').length, 2);
});

test('the legend counts what the drawing shows, so the question from across the room is answered', async () => {
  const {view, host} = mount();
  await view.open('VP001');
  const legend = host.querySelector('.deck-legend').children.map(row => row.textContent);
  assert.equal(legend.length, 3, 'stands, pads and chargers');
  assert.match(legend[0], /Gate.*점유 1.*예정 1.*가용 0/);
  assert.match(legend[1], /FATO.*점유 1.*예정 0.*가용 1/);
});

test('choosing a resource says what it is and who is on it, and choosing it again lets go', async () => {
  const {view, host} = mount();
  await view.open('VP001');
  assert.match(host.querySelector('.deck-picked').textContent, /도형을 누르면/);
  view.selected = 'gate:G1';
  view.paint();
  assert.match(host.querySelector('.deck-picked').textContent, /Gate G1 · 점유 · FPL1/);
  const shape = host.querySelectorAll('.vp-resource').find(node => node.getAttribute('data-selected') === 'true');
  assert.ok(shape, 'and the drawing marks the one that is chosen');
});

test('a deck with no day says so instead of drawing an empty one', async () => {
  const {view, host} = mount({deck: null});
  await view.open('VP001');
  assert.match(host.textContent, /재생 정보가 없습니다/);
  assert.equal(host.querySelectorAll('.deck-queue-row').length, 0);
});

test('a layout that cannot be read is said out loud, not drawn as an empty deck', async () => {
  const {view, host} = mount({fail: true});
  await view.open('VP001');
  assert.match(host.textContent, /HTTP 500/);
  const {view: bare, host: bareHost} = mount({record: {id: 'VP001', name: '여의도'}});
  await bare.open('VP001');
  assert.match(bareHost.textContent, /저장된 지상 레이아웃이 없습니다/);
  assert.ok(bareHost.querySelectorAll('.deck-queue-row').length > 0, 'the queue is still shown');
});

test('closing puts the polling down and the panel back to the list', async () => {
  const {view} = mount();
  let closed = 0;
  view.onClose = () => {closed += 1;};
  await view.open('VP001');
  view.start();
  assert.ok(view.timer);
  view.close();
  assert.equal(view.timer, null, 'nothing polls for a deck nobody is looking at');
  assert.equal(view.id, null);
  assert.equal(view.root.hidden, true);
  assert.equal(closed, 1);
});

test('the PSU list opens the deck it names, and the same row closes it again', () => {
  const psu = readFileSync('user_application/web/domains/uam/operations/psu_panel.js', 'utf-8');
  assert.match(psu, /onclick:\(\)=>this\.openDeck\(row\.vertiport_id\)/);
  assert.match(psu, /const next=this\.deckId===id\?null:id/, 'pressing the same row lets go');
  assert.match(psu, /'aria-pressed':String\(this\.deckId===row\.vertiport_id\)/);
  const app = readFileSync('user_application/web/app.js', 'utf-8');
  assert.match(app, /createPanel\(DeckDetail,\{document,/);
  assert.match(app, /occupancy:operatingApi\.vertiport/);
});
