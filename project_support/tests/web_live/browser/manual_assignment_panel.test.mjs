// The one aircraft of the running day that a person asked to fly.
//
// There is nothing to press. The choosing was done with the plan, in its own
// wizard step, and once the day is running the flight that was asked for either
// has come round or has not. So the console carries nothing for this -- it
// watches, and when a matching flight is standing there ready it takes it and
// puts the operator in the cockpit.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ManualAssignmentPanel} from '../../../../user_application/web/domains/uam/cockpit/manual_assignment_panel.js';

const FLIGHTS = [
  {flight_id: 'F1', aircraft_id: 'A1', seats: 4, origin: 'VP1', destination: 'VP2', off_block_s: 23400, due_in_s: 120},
  {flight_id: 'F2', aircraft_id: 'A2', seats: 4, origin: 'VP2', destination: 'VP1', off_block_s: 23700, due_in_s: 420},
  {flight_id: 'F3', aircraft_id: 'A3', seats: 6, origin: 'VP2', destination: 'VP1', off_block_s: 24000, due_in_s: 720},
];
const ASSIGNED = {aircraft_id: 'A1', seats: 4, stand: 'G1', latitude: 37.5, longitude: 127, altitude_m: 20,
                  flight: {flight_id: 'F1', origin: 'VP1', destination: 'VP2', off_block_s: 23400}};
const RUNNING = {loaded: true, control_open: true};

function watcher({flights = FLIGHTS, assign} = {}) {
  const calls = [], said = [];
  const made = new ManualAssignmentPanel({
    api: {
      offers: async () => {calls.push(['offers']); return {models: [], flights: typeof flights === 'function' ? flights() : flights};},
      assign: async body => {calls.push(['assign', body]); return assign ? assign(body) : ASSIGNED;},
      release: async body => {calls.push(['release', body]); return {released: true};},
    },
    notify: (status, message) => said.push([status, message]),
    onAssigned: value => calls.push(['assigned', value.aircraft_id]),
    onReleased: value => calls.push(['released', value.aircraft_id])});
  return {made, calls, said};
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('a day nobody asked to fly is never asked about', async () => {
  const {made, calls} = watcher();
  made.setRequest({want: false});
  made.tick(RUNNING, 1000);
  await settle();
  assert.deepEqual(calls, [], '요청이 없으면 하루에 묻지도 않는다');
  made.setRequest(null);
  made.tick(RUNNING, 9000);
  await settle();
  assert.deepEqual(calls, []);
});

test('a matching flight standing ready is taken without anything to press', async () => {
  const {made, calls, said} = watcher();
  made.setRequest({want: true, seats: 4, vertiport: 'VP1'});
  made.tick(RUNNING, 1000);
  await settle();

  assert.deepEqual(calls[0], ['offers']);
  assert.deepEqual(calls[1], ['assign', {seats: 4, vertiport: 'VP1', flight_id: 'F1'}]);
  assert.deepEqual(calls[2], ['assigned', 'A1'], '그리고 조종석으로 넘긴다');
  assert.equal(made.assignment.aircraft_id, 'A1');
  assert.match(said.at(-1)[1], /수동 비행 배정 · A1 · VP1 → VP2/);
});

test('waiting is the ordinary state, and it is not asked about twice a second', async () => {
  // The plan asked for something that has not come round yet. That is not a
  // failure, and it is not worth a request per poll either.
  let flights = FLIGHTS.filter(row => row.seats === 6 && row.origin === 'VP1');
  const {made, calls, said} = watcher({flights: () => flights});
  made.setRequest({want: true, seats: 6, vertiport: 'VP1'});

  made.tick({loaded: false, control_open: false}, 0);
  await settle();
  assert.deepEqual(calls, [], '하루가 없으면 묻지 않는다');

  made.tick(RUNNING, 1000);
  await settle();
  assert.equal(calls.length, 1, '열리면 바로 한 번');
  assert.equal(made.assignment, null);
  assert.equal(said.length, 1, '배정되지 않은 이유를 한 번 알린다');
  assert.match(said[0][1], /수동 배정 대기/);

  made.tick(RUNNING, 4000);
  await settle();
  assert.equal(calls.length, 1, '매 폴링마다는 아니다');

  // The flight comes round; the next beat takes it.
  flights = FLIGHTS.map(row => ({...row, seats: 6, origin: 'VP1'}));
  made.tick(RUNNING, 7000);
  await settle();
  assert.ok(made.assignment, '조건에 맞는 편이 오면 그때 잡는다');
});

test('a refusal is said once, not once a beat', async () => {
  const {made, calls, said} = watcher({assign: () => {throw new Error('조건에 맞는 출발 예정편이 없습니다.');}});
  made.setRequest({want: true});
  for (const at of [1000, 7000, 13000]) {made.tick(RUNNING, at); await settle();}
  assert.ok(calls.filter(([kind]) => kind === 'assign').length >= 2, '계속 다시 시도한다');
  assert.equal(said.filter(([status]) => status === 'warning').length, 1, '말은 한 번만');
  assert.match(said[0][1], /배정 실패 · 조건에 맞는/);
  assert.equal(made.assignment, null);
});

test('the day is the truth about who is flying what', async () => {
  const {made, calls} = watcher();
  made.setRequest({want: true});
  made.tick(RUNNING, 1000);
  await settle();
  assert.ok(made.assignment);

  // Already holding one, it stops asking.
  const before = calls.length;
  made.tick({...RUNNING, manual_aircraft: 'A1'}, 20000);
  await settle();
  assert.equal(calls.length, before);

  // Handed back elsewhere -- or the console closed -- and it lets go.
  made.tick({...RUNNING, manual_aircraft: null}, 30000);
  assert.equal(made.assignment, null);
  made.setRequest({want: true});
  made.tick(RUNNING, 40000);
  await settle();
  assert.ok(made.assignment);
  made.tick({loaded: false, control_open: false}, 50000);
  assert.equal(made.assignment, null);
});

test('releasing hands the airframe back to the day', async () => {
  const {made, calls} = watcher();
  made.setRequest({want: true});
  made.tick(RUNNING, 1000);
  await settle();
  await made.release();
  assert.equal(made.assignment, null);
  assert.ok(calls.some(([kind, body]) => kind === 'release' && body.aircraft_id === 'A1'));
  assert.ok(calls.some(([kind]) => kind === 'released'));
});

test('the choice lives in the plan, the console shows nothing, and the cockpit is the day’s own', () => {
  const demand = readFileSync(new URL('../../../../user_application/web/domains/uam/planning/demand_panel.js', import.meta.url), 'utf8');
  assert.match(demand, /\['manual', '수동 비행'\]/, '계획 마법사의 한 단계다');
  assert.match(demand, /this\.onControlPanel\(this\.plan, this\.manualRequest\(\)\)/);

  // Nothing of this is drawn on the day console any more.
  const control = readFileSync(new URL('../../../../user_application/web/domains/uam/operations/scenario_control.js', import.meta.url), 'utf8');
  assert.match(control, /this\.manualPanel\?\.tick\(this\.status\)/, '폴링만 넘겨준다');
  assert.doesNotMatch(control, /manualPanel\.root/, '콘솔에는 아무것도 붙지 않는다');
  const module = readFileSync(new URL('../../../../user_application/web/domains/uam/cockpit/manual_assignment_panel.js', import.meta.url), 'utf8');
  assert.doesNotMatch(module, /buildElement|document/, '누를 것이 없으므로 그릴 것도 없다');

  // An airframe of the day is an ordinary scenario entity: entering its cockpit
  // is the same path as any other, and the single-flight preview would draw a
  // second aircraft in the same place.
  const app = readFileSync(new URL('../../../../user_application/web/app.js', import.meta.url), 'utf8');
  assert.match(app, /await arriveAtManualAircraft\(\{aircraftId,getGlobe:/);
  assert.match(app, /isCurrent:\(\)=>manualFlight\.running/);
  assert.match(app, /if\(manualFlight\.twin\)\{[^}]*setManualSample[\s\S]*?return;\}liveGlobe\?\.moveFlight/, '미리보기를 겹쳐 그리지 않는다');
});
