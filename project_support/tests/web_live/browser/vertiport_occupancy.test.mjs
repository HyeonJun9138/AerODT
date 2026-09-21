import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {boardFrom, clockSeconds, describeMovement, occupancyCounts, occupancyFrom, summarise}
  from '../../../../user_application/web/vertiport_occupancy.js';
import {resourcesOf} from '../../../../user_application/web/vertiport_operations.js';

const web = new URL('../../../../user_application/web/', import.meta.url);
const app = readFileSync(new URL('app.js', web), 'utf8');
const panel = readFileSync(new URL('vertiport_panel.js', web), 'utf8');

// A small deck: two pads, four stands, one charger on G1, one taxiway.
const RECORD = {id: 'VP001', name: '여의도', layout: {
  fatos: [{id: 'F1', role: 'both'}, {id: 'F2', role: 'both'}],
  gates: [{id: 'G1'}, {id: 'G2'}, {id: 'G3'}, {id: 'G4'}],
  chargers: [{id: 'C1', gate: 'G1'}],
  edges: [{id: 'E1', from: 'G1', to: 'F1'}]}};
const RESOURCES = resourcesOf(RECORD);
const at = (clock, extra = {}) => ({vertiport_id: 'VP001', clock, standing: [], inbound: [], outbound: [],
  holding: [], pads: {}, stands: {}, ...extra});
const aircraft = (id, over = {}) => ({aircraft_id: id, flight_id: null, stand: null, origin: null,
  destination: null, holding: false, airborne: false, hold_seconds: 0, passengers: 0, seats: 4, ...over});
const stateOf = (occupancy, kind, id) => occupancy.get(`${kind}:${id}`)?.state;

test('the day clock and the pad windows are read on the same scale', () => {
  assert.equal(clockSeconds('06:36:08'), 23768);
  assert.equal(clockSeconds('06:36'), 23760);
  assert.equal(clockSeconds('00:00:00'), 0);
  // A day that runs past midnight is still one day's worth of seconds.
  assert.equal(clockSeconds('25:00:00'), 90000);
  assert.equal(clockSeconds(''), null);
  assert.equal(clockSeconds('6:5'), null);
  assert.equal(clockSeconds('06:70:00'), null);
  // Nothing can be said without a clock, so nothing is.
  assert.equal(occupancyFrom(at('nonsense'), RESOURCES).size, 0);
});

test('a stand is taken by what is parked on it and held for what is coming to it', () => {
  const occupancy = occupancyFrom(at('06:36:08', {
    standing: [aircraft('UAM0021', {stand: 'G4'})],
    inbound: [aircraft('UAM0058', {stand: 'G3', destination: 'VP001', airborne: true})],
    stands: {G2: 'FPL000045'}}), RESOURCES);
  assert.equal(stateOf(occupancy, 'gate', 'G4'), 'occupied');
  assert.deepEqual(occupancy.get('gate:G4').occupants, ['UAM0021']);
  assert.equal(stateOf(occupancy, 'gate', 'G3'), 'reserved', '오고 있는 기체가 배정된 스탠드');
  assert.equal(stateOf(occupancy, 'gate', 'G2'), 'reserved', 'PSU가 잡아 둔 스탠드');
  assert.equal(stateOf(occupancy, 'gate', 'G1'), 'free');
  // Two aircraft on one stand is the engine telling us something is wrong.
  const clash = occupancyFrom(at('06:36:08', {standing: [aircraft('A', {stand: 'G1'}), aircraft('B', {stand: 'G1'})]}), RESOURCES);
  assert.equal(stateOf(clash, 'gate', 'G1'), 'conflict');
});

test('separate stand ledgers show actual aircraft occupancy and flight reservations without merging plans',()=>{
  const state=at('06:36:08',{stands:{G1:'UAM0019'},stand_reservations:{G1:'FPL-LATER',G2:'FPL-ARR'},
    standing:[aircraft('OLD',{stand:'G3'})],inbound:[aircraft('ARR',{stand:'G4',flight_id:'FPL-OLD'})],
    outbound:[aircraft('UAM0019',{phase:'gate_out',stand:'G1'})]});
  const before=structuredClone(state),occupancy=occupancyFrom(state,RESOURCES);
  assert.deepEqual(occupancy.get('gate:G1').occupants,['UAM0019']);
  assert.equal(occupancy.get('gate:G1').state,'occupied','departing aircraft still physically blocks its stand');
  assert.equal(occupancy.get('gate:G2').state,'reserved');
  assert.deepEqual(occupancy.get('gate:G2').occupants,['FPL-ARR']);
  assert.equal(occupancy.get('gate:G3').state,'free','a standing row cannot override the observed stand ledger');
  assert.equal(occupancy.get('gate:G4').state,'free','old planned gate is not a reservation');
  assert.deepEqual(occupancyCounts(occupancy,RESOURCES).gate,{busy:1,total:4,known:4});
  assert.deepEqual(state,before);
});

test('an empty explicit reservation ledger clears old inbound gate claims',()=>{
  const occupancy=occupancyFrom(at('06:36:08',{stands:{},stand_reservations:{},
    inbound:[aircraft('ARR',{flight_id:'FPL-ARR',stand:'G2'})]}),RESOURCES);
  assert.deepEqual(occupancy.get('gate:G2'),{state:'free',occupants:[]});
});

test('a pad is busy for the window the PSU gave it, and held just before', () => {
  const now = clockSeconds('06:36:08');
  const pads = {F1: [{from_s: now - 30, to_s: now + 30, flight_id: 'FPL000004', kind: 'departure'}],
    F2: [{from_s: now + 120, to_s: now + 180, flight_id: 'FPL000009', kind: 'arrival'}]};
  const occupancy = occupancyFrom(at('06:36:08', {pads}), RESOURCES);
  assert.equal(stateOf(occupancy, 'fato', 'F1'), 'occupied');
  assert.deepEqual(occupancy.get('fato:F1').occupants, ['FPL000004 이륙']);
  assert.equal(stateOf(occupancy, 'fato', 'F2'), 'reserved', '5분 안에 오는 예약');
  // A window that has passed, and one too far off to matter, are both free.
  const later = occupancyFrom(at('06:36:08', {pads: {F1: [{from_s: now - 300, to_s: now - 60, flight_id: 'X', kind: 'arrival'}],
    F2: [{from_s: now + 3600, to_s: now + 3660, flight_id: 'Y', kind: 'arrival'}]}}), RESOURCES);
  assert.equal(stateOf(later, 'fato', 'F1'), 'free');
  assert.equal(stateOf(later, 'fato', 'F2'), 'free');
});

test('a taxiway is busy when something is crossing it, and empty otherwise', () => {
  // The engine does not route along the ground; it says an aircraft is taxiing
  // from G1 to F1, and the deck's own topology says E1 lies between them.
  const moving = occupancyFrom(at('06:36:08', {
    movements: [{aircraft_id: 'UAM0019', flight_id: 'FPL000002', phase: 'gate_out',
      direction: 'departure', stand: 'G1', fato: 'F1', from: 'G1', to: 'F1', on_ground: true}]}), RESOURCES);
  assert.equal(stateOf(moving, 'taxiway', 'E1'), 'occupied');
  assert.deepEqual(moving.get('taxiway:E1').occupants, ['UAM0019']);
  // Nothing crossing is "nothing on it", which is not the same as cleared - the
  // panel grants nothing either way.
  const still = occupancyFrom(at('06:36:08', {standing: [aircraft('UAM0021', {stand: 'G1'})]}), RESOURCES);
  assert.equal(stateOf(still, 'taxiway', 'E1'), 'free');
  // A charger is the one inference: something is parked on the gate it serves.
  assert.equal(stateOf(still, 'charger', 'C1'), 'occupied');
  assert.equal(stateOf(occupancyFrom(at('06:36:08'), RESOURCES), 'charger', 'C1'), 'free');
  const counts = occupancyCounts(moving, RESOURCES);
  assert.deepEqual(counts.taxiway, {busy: 1, total: 1, known: 1});
  assert.deepEqual(counts.gate, {busy: 0, total: 4, known: 4});
});

test('an aircraft standing on a pad outranks whatever the pad was booked for', () => {
  const now = clockSeconds('06:36:08');
  const state = at('06:36:08', {
    pads: {F1: [{from_s: now + 600, to_s: now + 660, flight_id: 'FPL000099', kind: 'arrival'}]},
    movements: [{aircraft_id: 'UAM0021', flight_id: 'FPL000004', phase: 'takeoff',
      direction: 'departure', stand: 'G4', fato: 'F1', from: 'F1', to: null, on_ground: false}]});
  const occupancy = occupancyFrom(state, RESOURCES);
  // The booking is a plan; this is an aircraft.
  assert.equal(stateOf(occupancy, 'fato', 'F1'), 'occupied');
  assert.deepEqual(occupancy.get('fato:F1').occupants, ['UAM0021']);
  // A vertical is not on a taxiway.
  assert.equal(stateOf(occupancy, 'taxiway', 'E1'), 'free');
  assert.match(describeMovement(state.movements[0]), /^FPL000004 · F1 · 이륙$/);
  assert.match(describeMovement({aircraft_id: 'A', phase: 'gate_in', from: 'F2', to: 'G1'}),
    /^A · F2 → G1 · 지상 이동 \(FATO → 게이트\)$/);
  assert.equal(summarise(state, RESOURCES).moving, 1);
});

test("the operator's own practice closure still wins over the day", () => {
  const closures = {'gate:G4': {reason: '시설 점검'}, 'fato:F2': {reason: '지상 작업'}};
  const occupancy = occupancyFrom(at('06:36:08', {standing: [aircraft('UAM0021', {stand: 'G4'})]}), RESOURCES, closures);
  // Closing something with an aircraft on it does not remove the aircraft.
  assert.equal(stateOf(occupancy, 'gate', 'G4'), 'conflict');
  assert.deepEqual(occupancy.get('gate:G4').occupants, ['UAM0021']);
  assert.equal(occupancy.get('gate:G4').reason, '시설 점검');
  assert.equal(stateOf(occupancy, 'fato', 'F2'), 'closed');
});

test('the board is only what the day says, and says which way each one is going', () => {
  const rows = boardFrom(at('06:36:08', {
    holding: [aircraft('UAM0090', {flight_id: 'FPL000100', destination: 'VP001', origin: 'VP007',
      holding: true, airborne: true, hold_seconds: 42})],
    inbound: [aircraft('UAM0058', {flight_id: 'FPL000045', destination: 'VP001', origin: 'VP011', airborne: true, stand: 'G3'})],
    outbound: [aircraft('UAM0019', {flight_id: 'FPL000002', origin: 'VP001', destination: 'VP005', airborne: true})]}));
  assert.deepEqual(rows.map(row => [row.callsign, row.direction, row.counterpart, row.status]), [
    ['FPL000100', 'arrival', 'VP007', 'PSU 대기'],
    ['FPL000045', 'arrival', 'VP011', '접근 중'],
    ['FPL000002', 'departure', 'VP005', '출발'],
  ]);
  assert.equal(rows[0].holding, true);
  assert.equal(rows[0].hold_seconds, 42);
  assert.deepEqual(boardFrom(at('06:36:08')), [], '없는 편을 지어내지 않습니다');
});

test('ground movement and board show the received stop reason and preserve the original gate plan',()=>{
  const movement={aircraft_id:'UAM0070',flight_id:'FPL70',phase:'gate_in',from:'F1',to:'G2',airborne:false,
    ground_waiting:true,holding:true,instruction:{action:'ground_wait',reason:'교차 유도로 통과 대기',blocked_by:['UAM0080'],wait_seconds:9},
    gate_assignment:{planned_stand:'G1',assigned_stand:'G2',revision:1,reason:'G1 실제 점유'}};
  assert.match(describeMovement(movement),/지상 대기/);assert.match(describeMovement(movement),/교차 유도로 통과 대기/);
  assert.match(describeMovement(movement),/UAM0080/);assert.doesNotMatch(describeMovement(movement),/체공/);
  const row=boardFrom(at('06:36:08',{inbound:[movement]}))[0];
  assert.equal(row.status,'지상 대기');assert.equal(row.holding,false);
  assert.equal(row.planned_stand,'G1');assert.equal(row.stand,'G2');
  assert.equal(row.reason,'교차 유도로 통과 대기');
  const braking=boardFrom(at('06:36:08',{inbound:[{...movement,ground_waiting:false,speed_mps:0}]}))[0];
  assert.equal(braking.status,'지상 이동 · 감속');assert.equal(braking.holding,false);
});

test('a deck summarises to one line for whoever is watching all of them', () => {
  const found = summarise(at('06:36:08', {
    standing: [aircraft('A', {stand: 'G1'}), aircraft('B', {stand: 'G2'})],
    inbound: [aircraft('C', {destination: 'VP001'})],
    holding: [aircraft('D', {destination: 'VP001', holding: true})],
    pads: {F1: [{from_s: clockSeconds('06:36:08') - 5, to_s: clockSeconds('06:36:08') + 55, flight_id: 'F', kind: 'arrival'}]}}),
    RESOURCES);
  assert.equal(found.clock, '06:36:08');
  assert.deepEqual(found.gates, {busy: 2, total: 4, known: 4});
  assert.deepEqual(found.pads, {busy: 1, total: 2, known: 2});
  assert.equal(found.standing, 2);
  assert.equal(found.holding, 1);
});

test('the panels read the occupancy from the server, so every screen sees one answer', () => {
  // The vertiport operator reads their own deck; the PSU reads all of them. Both
  // come from the running scenario rather than from anything held in a browser.
  assert.match(app, /scenarioVertiport:id=>getJSON\(`\/api\/simulation\/scenario\/vertiports\/\$\{encodeURIComponent\(id\)\}`\)/);
  assert.match(app, /scenarioVertiports:\(\)=>getJSON\('\/api\/simulation\/scenario\/vertiports'\)/);
  assert.match(panel, /occupancyFrom\(this\.live,resourcesOf\(this\.record\),this\.draft\.closures\)/);
  // While a day is being flown the example projection is not also on screen.
  assert.match(panel, /if\(this\.live\)\{this\.fillLiveBoard\(host\);return;\}/);
  assert.match(panel, /재생 중인 비행계획/);
});
