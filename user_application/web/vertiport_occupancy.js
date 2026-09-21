// User/Application: what a deck's resources are actually doing, read from the
// day being flown rather than from the example schedule.
//
// The scenario engine already knows this: which aircraft is parked on which
// stand, and which flight the PSU has given which pad and when. This turns that
// into the same vocabulary the rehearsal view already speaks, so one panel can
// show either without knowing which it is looking at.
//
// It states nothing it was not told. The engine does not route along the ground
// - it says an aircraft is going from this stand to that pad - so which taxiway
// runs lie between the two comes from the layout's own topology, and a run with
// nothing crossing it is empty rather than cleared. Occupancy read here is a
// picture of a rehearsal; it is not a clearance and grants nothing.
import {MINUTE, observedStandState, taxiRuns} from './vertiport_operations.js';
import {describePilotDecision} from './pilot_decision.js';

// How far ahead a booking counts as "coming", matching the example view.
export const SOON_MS = 5 * MINUTE;
export const SOON_S = SOON_MS / 1000;

// "06:36:08" -> 23768. The pad windows are seconds of the scheduled day and the
// clock is the same day, so the two are compared without leaving the payload.
export function clockSeconds(text) {
  const parts = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(text ?? '').trim());
  if (!parts) return null;
  const [hours, minutes, seconds] = [Number(parts[1]), Number(parts[2]), Number(parts[3] ?? 0)];
  if (hours > 47 || minutes > 59 || seconds > 59) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

const listOf = (value) => (Array.isArray(value) ? value : []);
const onGround=row=>['parked','gate_out','gate_in','charge'].includes(row.phase);
const hasGroundDecision=row=>onGround(row)&&(row.ground_waiting===true||['ground_wait','ground_taxi'].includes(row.instruction?.action));
const PAD_KIND = {arrival: '착륙', departure: '이륙'};
// What each vertiport stage is, said the way the deck's operator would say it.
export const PHASE_NAMES = {gate_out: '지상 이동 (게이트 → FATO)', takeoff: '이륙',
  landing: '착륙', gate_in: '지상 이동 (FATO → 게이트)', charge: '충전'};

export function movementsOf(state = {}) {return listOf(state.movements);}

// One movement in a line: who, and from where to where on this surface.
export function describeMovement(movement = {}) {
  const who = movement.flight_id ?? movement.aircraft_id;
  const decision=hasGroundDecision(movement)?describePilotDecision({state:movement}):null;
  const name = decision?[decision.title,decision.reason,
    ...decision.fields.filter(field=>['blocked_by','planned_stand','assigned_stand','gate_reason'].includes(field.key))
      .map(field=>`${field.label}: ${field.value}`)].join(' · '):PHASE_NAMES[movement.phase] ?? movement.phase;
  if (movement.from && movement.to && movement.from !== movement.to) return `${who} · ${movement.from} → ${movement.to} · ${name}`;
  return `${who} · ${movement.to ?? movement.from ?? '—'} · ${name}`;
}

// Every aircraft the deck is dealing with, whichever list it arrived in.
export function trafficOf(state = {}) {
  return {standing: listOf(state.standing), inbound: listOf(state.inbound),
    outbound: listOf(state.outbound), holding: listOf(state.holding)};
}

// One resource's state, from the day. `now` is seconds of the scheduled day.
function padState(fato, pads, now) {
  const slots = listOf(pads?.[fato.id]);
  const busy = slots.filter(slot => slot.from_s <= now && slot.to_s > now);
  if (busy.length) {
    return {state: busy.length > 1 ? 'conflict' : 'occupied',
      occupants: busy.map(slot => `${slot.flight_id ?? '비행'} ${PAD_KIND[slot.kind] ?? ''}`.trim())};
  }
  const soon = slots.filter(slot => slot.from_s > now && slot.from_s <= now + SOON_S);
  if (soon.length) return {state: 'reserved', occupants: soon.map(slot => slot.flight_id ?? '비행')};
  return {state: 'free', occupants: []};
}

function standState(gate, traffic, stands) {
  const parked = traffic.standing.filter(item => item.stand === gate.id);
  if (parked.length) {
    return {state: parked.length > 1 ? 'conflict' : 'occupied',
      occupants: parked.map(item => item.aircraft_id)};
  }
  // Held for a flight on its way in, whether by the PSU's stand book or by an
  // inbound aircraft already told which stand it is going to.
  const booked = stands?.[gate.id];
  const coming = traffic.inbound.filter(item => item.stand === gate.id);
  if (booked || coming.length) {
    return {state: 'reserved', occupants: coming.map(item => item.aircraft_id).concat(booked ? [String(booked)] : [])};
  }
  return {state: 'free', occupants: []};
}

// A charger stands beside one gate; the engine does not schedule charging, so
// the honest reading is that a charger is in use when something is parked on
// the gate it serves.
function chargerState(charger, gateStates) {
  const gate = gateStates.get(charger.gate);
  if (!gate) return {state: 'unknown', occupants: []};
  return gate.state === 'occupied' || gate.state === 'conflict'
    ? {state: 'occupied', occupants: gate.occupants} : {state: 'free', occupants: []};
}

// Resource key -> {state, occupants}, for every resource the layout has.
// `closures` are the operator's own practice closures and still win: a closed
// resource with something on it is a conflict, exactly as in the example view.
export function occupancyFrom(state, resources = [], closures = {}) {
  const now = clockSeconds(state?.clock);
  const traffic = trafficOf(state);
  const answer = new Map();
  if (now === null) return answer;
  const gateStates = new Map();
  for (const resource of resources) {
    if (resource.kind !== 'gate') continue;
    const found = Object.hasOwn(state,'stand_reservations')
      ?observedStandState(resource.id,state.stands,state.stand_reservations):standState(resource, traffic, state?.stands);
    gateStates.set(resource.id, found);
    answer.set(resource.key, found);
  }
  const movements = movementsOf(state);
  // Which taxiway runs are being crossed right now, and by whom. The engine
  // does not route along the ground - it says where an aircraft is going, from
  // which stand to which pad - so the layout's own topology says which runs lie
  // between the two. That is the same path the example schedule uses.
  const crossing = new Map();
  for (const movement of movements) {
    if (!movement.on_ground) continue;
    for (const run of taxiRuns(resources, movement.from, movement.to)) {
      crossing.set(run.key, [...(crossing.get(run.key) ?? []), movement.aircraft_id]);
    }
  }
  // A pad with an aircraft on it now is busy whatever its booking says: the
  // booking is a plan and this is an aircraft.
  const onPad = new Map();
  for (const movement of movements) {
    if (movement.on_ground || !movement.fato) continue;
    onPad.set(movement.fato, [...(onPad.get(movement.fato) ?? []), movement.aircraft_id]);
  }
  for (const resource of resources) {
    if (resource.kind === 'gate') continue;
    if (resource.kind === 'fato') {
      const here = onPad.get(resource.id);
      answer.set(resource.key, here
        ? {state: here.length > 1 ? 'conflict' : 'occupied', occupants: here}
        : padState(resource, state?.pads, now));
      continue;
    }
    if (resource.kind === 'taxiway') {
      const here = crossing.get(resource.key);
      // Nothing is crossing it. That is "nothing is on it", not "it is cleared":
      // this view never grants anything.
      answer.set(resource.key, here
        ? {state: here.length > 1 ? 'conflict' : 'occupied', occupants: here}
        : {state: 'free', occupants: []});
      continue;
    }
    answer.set(resource.key, resource.kind === 'charger' ? chargerState(resource, gateStates)
      : {state: 'unknown', occupants: []});
  }
  for (const [key, closure] of Object.entries(closures ?? {})) {
    const found = answer.get(key);
    if (!found) continue;
    answer.set(key, {state: found.occupants.length ? 'conflict' : 'closed',
      occupants: found.occupants, reason: closure?.reason});
  }
  return answer;
}

// How many of each kind are in use, for the row of counters.
export function occupancyCounts(occupancy, resources = []) {
  const counts = {};
  for (const resource of resources) {
    const row = counts[resource.kind] ??= {busy: 0, total: 0, known: 0};
    row.total += 1;
    const state = occupancy.get(resource.key)?.state;
    if (state && state !== 'unknown') row.known += 1;
    if (state === 'occupied' || state === 'conflict') row.busy += 1;
  }
  return counts;
}

// The deck's own arrivals and departures, newest first by the time they matter.
// Only what the day says: no example rows are invented here.
export function boardFrom(state = {}, {limit = 24} = {}) {
  const traffic = trafficOf(state);
  const rows = [
    ...traffic.holding.map(item => ({...item, direction: 'arrival', status: 'PSU 대기'})),
    ...traffic.inbound.map(item => ({...item, direction: 'arrival',
      status: item.airborne ? '접근 중' : '출발지 지상'})),
    ...traffic.outbound.map(item => ({...item, direction: 'departure', status: '출발'})),
  ];
  return rows.map(item => {
    const decision=hasGroundDecision(item)?describePilotDecision({state:item}):null;
    const assignment=item.gate_assignment??{planned_stand:item.planned_stand,assigned_stand:item.stand,
      revision:item.gate_revision,reason:item.gate_reason};
    return {
    id: item.flight_id ?? item.aircraft_id,
    callsign: item.flight_id ?? item.aircraft_id,
    aircraft: item.aircraft_id,
    direction: item.direction,
    counterpart: item.direction === 'arrival' ? item.origin : item.destination,
    stand: assignment.assigned_stand ?? null,
    planned_stand: assignment.planned_stand ?? null,
    gate_revision: assignment.revision ?? null,
    gate_reason: assignment.reason ?? '',
    status: decision?.title??item.status,
    reason: decision?.reason??'',
    blocked_by: decision?.fields.find(field=>field.key==='blocked_by')?.value??'',
    ground_waiting: onGround(item)&&item.ground_waiting===true,
    holding: !onGround(item)&&Boolean(item.holding),
    hold_seconds: Number(item.hold_seconds) || 0,
    passengers: Number(item.passengers) || 0,
    seats: Number(item.seats) || 0,
  };}).slice(0, limit);
}

// One line for a facility in a list of them, for whoever is watching the whole
// network rather than one deck.
export function summarise(state, resources = [], closures = {}) {
  const occupancy = occupancyFrom(state, resources, closures);
  const counts = occupancyCounts(occupancy, resources);
  const traffic = trafficOf(state);
  return {
    clock: state?.clock ?? null,
    gates: counts.gate ?? {busy: 0, total: 0, known: 0},
    pads: counts.fato ?? {busy: 0, total: 0, known: 0},
    standing: traffic.standing.length,
    inbound: traffic.inbound.length,
    outbound: traffic.outbound.length,
    holding: traffic.holding.length,
    moving: movementsOf(state).length,
  };
}
