// What one deck actually looks like right now, from the day being flown.
//
// The vertiport screens already draw a deck's resources, but they colour them
// from a rehearsal projection - a plausible day invented for a deck with no
// flights on it. When a day *is* being flown, inventing one is worse than
// useless: the operator is looking at the real thing and being shown a story.
// This turns the server's answer for one deck into the same shape the drawing
// wants, so the picture is the day.
//
// It also works out the landing queue. The list of who is waiting is on the
// screen already; what is not is the *order*, and the order is the whole point
// of a queue. Given as numbers it has to be reassembled in the head every time.
import {observedStandState,taxiRuns} from './vertiport_operations.js';

// How soon a booking counts as coming up rather than merely later. A pad the
// next arrival has in three minutes is not free in any sense an operator cares
// about; one it has in half an hour is.
export const SOON_S = 300;

const ids = rows => rows.map(row => row.flight_id ?? row.aircraft_id).filter(Boolean);
// Airborne, or holding - which is airborne too. An older answer without the
// flag is taken at face value rather than silently emptying the queue.
const inFlight = row => !['parked','gate_out','gate_in','charge'].includes(row.phase)&&row.airborne !== false;

// Bound here but still on the ground somewhere else. Worth a number on the
// screen, because it says whether the queue is about to grow, and worth keeping
// out of the queue itself, because it has no place in one yet.
export function expectedAt(deck) {
  return (deck?.inbound ?? []).filter(row => !inFlight(row)).length;
}

// Every resource on the deck, keyed the way the drawing keys them, with the
// state the day puts it in and who is on it.
export function resourceStates(deck, resources = []) {
  const states = new Map();
  if (!deck) return states;
  const now = Number(deck.time_s);
  const standing = deck.standing ?? [];
  const inbound = [...(deck.inbound ?? []), ...(deck.holding ?? [])];
  const movements = deck.movements ?? [];
  const splitStands=Object.hasOwn(deck,'stand_reservations');

  for (const resource of resources) {
    if (resource.kind === 'gate') {
      if(splitStands){
        states.set(resource.key,observedStandState(resource.id,deck.stands,deck.stand_reservations));
        continue;
      }
      // A stand can be taken by an aircraft standing on it or spoken for by one
      // still in the air. The two are not the same thing and an operator
      // deciding where to put an arrival has to be able to tell them apart.
      const here = standing.filter(row => row.stand === resource.id);
      const coming = inbound.filter(row => row.stand === resource.id);
      const held = (deck.stands ?? {})[resource.id];
      states.set(resource.key, here.length
        ? {state: 'occupied', occupants: ids(here)}
        : coming.length || held
          ? {state: 'reserved', occupants: coming.length ? ids(coming) : [held]}
          : {state: 'free', occupants: []});
    } else if (resource.kind === 'fato') {
      const slots = (deck.pads ?? {})[resource.id] ?? [];
      const busy = slots.filter(slot => slot.from_s <= now && now < slot.to_s);
      const next = slots.filter(slot => slot.from_s > now).sort((a, b) => a.from_s - b.from_s)[0];
      states.set(resource.key, busy.length
        ? {state: busy.length > 1 ? 'conflict' : 'occupied', occupants: ids(busy)}
        : next && next.from_s - now <= SOON_S
          ? {state: 'reserved', occupants: ids([next])}
          : {state: 'free', occupants: []});
    } else if (resource.kind === 'charger') {
      // A charger belongs to a stand, and it is in use when the aircraft on
      // that stand is charging rather than merely parked on it.
      const parked = standing.filter(row => row.stand === resource.gate
        &&(!splitStands||deck.stands?.[resource.gate]===row.aircraft_id));
      const on = parked.filter(row => row.phase === 'charge');
      states.set(resource.key, on.length ? {state: 'occupied', occupants: ids(on)}
        : parked.length ? {state: 'reserved', occupants: ids(parked)}
        : {state: 'free', occupants: []});
    }
  }

  // A taxiway is in use by whatever is running along it. The deck's own
  // topology decides which edges a run crosses, so this follows the layout
  // rather than colouring every taxiway whenever anything is moving.
  for (const movement of movements) {
    if (!movement.on_ground || !movement.from || !movement.to) continue;
    for (const edge of taxiRuns(resources, movement.from, movement.to)) {
      const already = states.get(edge.key);
      states.set(edge.key, {state: already?.state === 'occupied' ? 'conflict' : 'occupied',
        occupants: [...(already?.occupants ?? []), movement.flight_id ?? movement.aircraft_id]});
    }
  }
  for (const resource of resources)
    if (resource.kind === 'taxiway' && !states.has(resource.key))
      states.set(resource.key, {state: 'free', occupants: []});
  return states;
}

// Who is in line to land, in the order the service put them in.
//
// Everything already flying towards this deck is in it, waiting or not: a queue
// that only shows the ones holding cannot say whether the one behind them is
// about to join. What is left out is anything still on the ground somewhere
// else - a flight bound here that has not taken off is coming, but it is not in
// a queue, and putting it in one with the taxi phase it is in at its own origin
// reads as nonsense on this deck's screen. `expectedAt` counts those instead.
export function landingQueue(deck) {
  if (!deck) return [];
  const now = Number(deck.time_s);
  const rows = [...(deck.holding ?? []), ...(deck.inbound ?? [])].filter(inFlight).map(row => ({
    aircraft_id: row.aircraft_id, flight_id: row.flight_id, phase: row.phase,
    sequence: Number.isFinite(row.sequence) ? row.sequence : null,
    holding: Boolean(row.holding), stand: row.stand ?? null,
    origin: row.origin ?? null,
    wait_s: Math.max(0, Number(row.hold_seconds) || 0),
  }));
  // By landing number, because that is the order the service actually gave. An
  // aircraft with no number yet has not asked, so it goes to the back - it is
  // not ahead of anybody, whatever its distance says.
  rows.sort((a, b) => (a.sequence ?? Infinity) - (b.sequence ?? Infinity)
    || (b.wait_s - a.wait_s)
    || String(a.aircraft_id).localeCompare(String(b.aircraft_id)));
  const longest = Math.max(1, ...rows.map(row => row.wait_s));
  return rows.map((row, index) => ({...row, place: index + 1,
    // How long this one has waited against the longest wait on the deck: the
    // bar the drawing gives it, so a queue reads as a queue at a glance.
    share: row.wait_s / longest, now}));
}

// What each pad has coming, as a window the drawing can lay out end to end.
// Slots already finished are dropped: a pad's past is in the record, not on the
// operator's screen.
export function padWindows(deck, {span_s = 900} = {}) {
  if (!deck) return [];
  const now = Number(deck.time_s);
  return Object.entries(deck.pads ?? {}).map(([pad, slots]) => ({
    pad,
    slots: (slots ?? [])
      .filter(slot => slot.to_s > now && slot.from_s < now + span_s)
      .sort((a, b) => a.from_s - b.from_s)
      .map(slot => ({...slot,
        // Where it sits in the window, clamped so a booking that started before
        // now still shows the part of it that is left.
        from: Math.max(0, (slot.from_s - now) / span_s),
        to: Math.min(1, (slot.to_s - now) / span_s),
        running: slot.from_s <= now && now < slot.to_s})),
  })).sort((a, b) => a.pad.localeCompare(b.pad, undefined, {numeric: true}));
}

// One line saying what the deck is doing, for the header.
export function deckSummary(deck) {
  if (!deck) return null;
  const stands = Object.keys(deck.stands ?? {}).length;
  return {standing: (deck.standing ?? []).length, inbound: (deck.inbound ?? []).length,
    holding: (deck.holding ?? []).length, outbound: (deck.outbound ?? []).length,
    moving: (deck.movements ?? []).length, stands_taken: stands, clock: deck.clock ?? ''};
}
