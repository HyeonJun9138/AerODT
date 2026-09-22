"""Model Library: a day of demand turned into a day of flights.

`flight_schedule` reads what a day *is*. This writes one. Given the passengers
who want to travel in each hour, the aircraft standing on the decks and a way to
ask how long a flight takes, it says which aircraft carries which load, from
which stand, at what time — the same file the twin reads back.

**It is not an optimiser, and it is not a simulation.** It is a greedy,
event-ordered dispatcher: whichever aircraft is free earliest takes the biggest
load it can fill from where it is standing, and the day is built one departure
at a time. Nothing is searched, nothing is improved, and no attempt is made to
prove the result is the best day available. What it produces is a *plausible
intent* — and intent is exactly what the rehearsal engine needs, because the
whole question a rehearsal answers is which of these flights cannot be flown as
written. Solving that here would settle it before anybody watched.

Three rules it holds to, each of which is a decision rather than a detail:

* **A flight that could not be given an arrival stand is carried, not dropped.**
  It holds, first come first served, for the next stand a departure frees; after
  an hour it is written out as `arrival_unresolved`, which is a fact about the
  day, and its aircraft flies no more of it.
* **Demand belongs to its hour.** What an hour could not carry is counted as
  unserved rather than pushed into the next one, so a fleet that is too small
  shows up as unserved passengers instead of a day that slides later and later.
  Within the hour an aircraft that lands and turns around is ready again at
  once, so a short leg is flown as often as the hour allows.
* **It never invents a flight time.** How long a leg takes is asked of the
  caller, which is where the route network and the operating profile live. A
  pair the caller cannot join is left unserved and named.

Pure: no files, no clock, no network. Seconds are from the scenario date's
midnight, past midnight included, the same as everywhere else in the schedule.
"""
import csv
import heapq
import io
import math
import random

from . import flight_schedule, schedule_planning

SCHEMA_VERSION = 1

# How many destinations are tried for one aircraft before it is left standing.
# A deck with nothing reachable should not be walked through every pair in the
# network on every departure.
MAX_DESTINATION_ATTEMPTS = 8
# An aircraft that arrives to a full deck holds, and the first to arrive is the
# first to be given the next stand that frees. The wait is real and is written
# out as the arrival resource wait. Beyond an hour the deck is not busy, it is
# full, and the flight is called unresolved.
MAX_HOLD_S = 3600.0

# The columns written, in the order the twin's own example file has them. Every
# one of them is a column `flight_schedule` knows; the two tuples are imported
# rather than retyped so the writer and the reader cannot drift apart.
COLUMNS = (
    "scenario_id", "scenario_date", "flight_plan_id", "aircraft_id", "aircraft_type_id",
    "seat_capacity", "passenger_count", "passenger_load_factor",
    "origin_vertiport_id", "origin_vertiport_name",
    "destination_vertiport_id", "destination_vertiport_name", "demand_hour",
    "departure_stand_id", "departure_fato_id", "arrival_stand_id", "arrival_fato_id",
    "off_block_time", "lift_off_time", "departure_handoff_time", "touchdown_time",
    "in_block_time", "turnaround_complete_time",
    "off_block_to_departure_handoff_sec", "departure_handoff_to_touchdown_sec",
    "touchdown_to_in_block_sec", "block_time_sec", "airborne_time_sec",
    "departure_resource_wait_sec", "arrival_resource_wait_sec",
    "flight_status", "route_waypoint_count", "route_path",
)

MINUTES_PER_DAY = 24 * 60


class _Aircraft:
    __slots__ = ("identifier", "seats", "at", "stand", "available_at", "flights")

    def __init__(self, identifier, seats, at, stand, available_at):
        self.identifier, self.seats = identifier, int(seats)
        self.at, self.stand = at, stand
        self.available_at, self.flights = float(available_at), 0


def _window(start_minutes, end_minutes):
    """The hours of the operating day, each with the seconds it runs between."""
    from .demand_profile import window_hours
    start_s = int(start_minutes) * 60
    span = (int(end_minutes) - int(start_minutes)) % MINUTES_PER_DAY or MINUTES_PER_DAY
    end_s = start_s + span * 60
    first = int(start_minutes) // 60
    hours = []
    for offset, (hour, _fraction) in enumerate(window_hours(start_minutes, end_minutes)):
        absolute = first + offset
        hours.append((hour, max(absolute * 3600, start_s), min((absolute + 1) * 3600, end_s)))
    return start_s, end_s, hours


def _choose(available, seats, blocked, origin, rng):
    """Which deck this aircraft flies to next.

    A cabin that can be filled is worth more than one that cannot, so the decks
    with a full load waiting are drawn between by how many people are waiting.
    When none of them can fill the cabin the fullest one is taken outright,
    which is what stops a four-seater shuttling one passenger at a time.
    """
    live = [(destination, count) for destination, count in available.items()
            if count > 0 and (origin, destination) not in blocked]
    if not live:
        return None
    full = sorted(((destination, count) for destination, count in live if count >= seats))
    if full:
        total = sum(count for _, count in full)
        pick, running = rng.uniform(0, total), 0.0
        for destination, count in full:
            running += count
            if pick <= running:
                return destination
        return full[-1][0]
    # The fullest; and between decks with the same few waiting, one drawn by
    # the seed rather than the first by name, or every deck in the network
    # would send its whole fleet to the same alphabetical neighbour at once.
    most = max(count for _, count in live)
    fullest = sorted(destination for destination, count in live if count == most)
    return fullest[0] if len(fullest) == 1 else rng.choice(fullest)


def _pick_stand(ledger, when):
    """The stand that is free earliest at a deck, and when it is free.

    A stand an aircraft is parked on is held with no release time until that
    aircraft is dispatched, so a deck of idle aircraft correctly reads as full.
    """
    if not ledger:
        return None, math.inf
    stand = min(sorted(ledger), key=lambda key: ledger[key])
    return stand, ledger[stand]


def _fato_picker():
    """Spread the day across the pads a deck actually has.

    This used to answer the first pad with the right role and nothing else,
    which meant every departure in the day left from the same one. Measured on
    a generated 60-flight day: **60 of 60 departures planned onto F1**, and 51
    of 60 arrivals onto F2. A deck laid out F1/F3 takeoff and F2/F4 landing
    therefore had half its pads planned for and the other half never used, and
    the engine spent the day re-selecting pads at runtime and re-spacing the
    queue behind them -- which is what a pilot sees as their departure time
    sliding away from them while they sit at the gate.

    Round robin rather than anything cleverer. The schedule is built before any
    of it is flown, so there is no observed load to balance against, and a
    rotation is deterministic: the same demand builds the same day, which is
    what the seed is there to guarantee.
    """
    counters = {}

    def pick(deck, layout_fatos, role):
        usable = [name for name in
                  (str(item.get("id") or "") for item in layout_fatos or ()
                   if item.get("role") in (role, "both")) if name]
        if not usable:
            return ""
        index = counters.get((deck, role), 0)
        counters[(deck, role)] = index + 1
        return usable[index % len(usable)]

    return pick


def schedule(*, demand, fleet, stands, timing, start_minutes, end_minutes, seed=1,
             names=None, fatos=None, scenario_date="", scenario_id="", on_progress=None,
             planning=None, manual_preference=None):
    """Build the day.

    `demand` is `{hour, from, to, passengers}` rows; `fleet` is
    `{aircraft_id, vertiport, stand, seats}`; `stands` is the stand ids each deck
    has; `fatos` is optionally each deck's FATO records so a flight can name the
    pad it uses. `timing(origin, destination, from_gate, to_gate)` answers the
    seconds a flight takes — `gate_out_s`, `takeoff_s`, `air_s`, `landing_s`,
    `gate_in_s`, `turnaround_s`, and optionally `from_fato`, `to_fato` and
    `route_path` — or raises `ValueError` naming why that pair cannot be flown.

    `planning`, when given, applies timetable FATO spacing and planned
    turnaround recovery. Air-route occupancy and runtime separation remain
    authoritative PSU concerns rather than timetable constraints.

    `on_progress(done, total)` is called as the day is built, because a run this
    long has to be able to say how far along it is.
    """
    rng = random.Random(int(seed) if seed is not None else 1)
    names = dict(names or {})
    fatos = dict(fatos or {})
    planning_values = schedule_planning.validate(planning) if planning is not None else None
    slots = schedule_planning.PlanningSlotBook() if planning_values is not None else None
    start_s, end_s, hours = _window(start_minutes, end_minutes)

    aircraft, free_at, notes = {}, {}, []
    for deck, ids in (stands or {}).items():
        free_at[str(deck)] = {str(stand): -math.inf for stand in ids or ()}
    for record in fleet or ():
        identifier = str(record.get("aircraft_id") or "")
        deck = str(record.get("vertiport") or "")
        ledger = free_at.setdefault(deck, {})
        stand = str(record.get("stand") or "")
        if stand not in ledger or ledger[stand] == math.inf:
            spare = [key for key in sorted(ledger) if ledger[key] != math.inf]
            if not spare:
                notes.append(f"{deck}: 주기장이 모자라 {identifier}을(를) 배치하지 못했습니다")
                continue
            stand = spare[0]
        ledger[stand] = math.inf
        aircraft[identifier] = _Aircraft(identifier, record.get("seats") or 0, deck, stand, start_s)

    by_hour = {}
    for row in demand or ():
        origins = by_hour.setdefault(int(row["hour"]), {})
        destinations = origins.setdefault(str(row["from"]), {})
        key = str(row["to"])
        destinations[key] = destinations.get(key, 0) + int(row["passengers"])

    flights, arrivals, blocked = [], [], set()
    # Only the first matching generated flight gets preference. Time and
    # physical resource checks remain authoritative; no existing day is edited.
    manual_pending = bool(manual_preference)
    def preferred(carrier):
        return (manual_pending and carrier.flights == 0
                and (not manual_preference.get("seats") or carrier.seats == manual_preference["seats"])
                and (not manual_preference.get("vertiport") or carrier.at == manual_preference["vertiport"]))
    # One rotation for the whole day, so the pads are shared across it rather
    # than each hour starting again from the first one.
    pick_fato = _fato_picker()
    counter, sequence = 0, 0
    unserved, unresolved = 0, 0
    capacity_wait_total = capacity_wait_max = 0.0
    capacity_delayed_flights = capacity_spill_events = 0
    capacity_wait_started = {}
    total_steps = len(hours) + 1
    if on_progress:
        on_progress(0, total_steps)
    # The hour being built: the aircraft ready to leave in it, in the order
    # they become free. An aircraft that lands and turns around inside the hour
    # goes straight back in, so a short leg can be flown several times an hour
    # rather than once; the heap is rebuilt at the top of every hour.
    hour_state = {"ready": [], "order": 0, "start": start_s, "end": start_s}

    def make_ready(carrier):
        if carrier.available_at < hour_state["end"]:
            heapq.heappush(hour_state["ready"], (max(carrier.available_at, hour_state["start"]), hour_state["order"], carrier.identifier))
            hour_state["order"] += 1

    # Flights circling over a full deck, in the order they arrived. A stand
    # freed by a departure goes to the one that has waited longest, not to
    # whichever happened to ask again first.
    holding = {}
    pending = {}

    def park(flight, stand, when):
        """The flight is on the deck at `when`, on `stand`."""
        deck = flight["destination_vertiport_id"]
        free_at[deck][stand] = math.inf
        flight["arrival_stand_id"] = stand
        flight["arrival_resource_wait_s"] = when - flight["_arrived_s"]
        flight["touchdown_s"] = when + flight["_landing_s"]
        flight["in_block_s"] = flight["touchdown_s"] + flight["_gate_in_s"]
        flight["turnaround_complete_s"] = flight["in_block_s"] + flight["_turnaround_s"]
        flight["flight_status"] = flight_schedule.READY_STATUS
        carrier = aircraft[flight["aircraft_id"]]
        carrier.at, carrier.stand = deck, stand
        carrier.available_at = flight["turnaround_complete_s"]
        pending.pop(flight["flight_plan_id"], None)
        make_ready(carrier)

    def give_up(flight):
        """The deck is not busy, it is full. The day says so and the aircraft
        stops flying rather than circling for the rest of it."""
        nonlocal unresolved
        flight["flight_status"] = flight_schedule.UNRESOLVED_STATUS
        flight["arrival_stand_id"] = ""
        flight["arrival_resource_wait_s"] = MAX_HOLD_S
        flight["touchdown_s"] = None
        flight["in_block_s"] = None
        flight["turnaround_complete_s"] = None
        unresolved += 1
        aircraft[flight["aircraft_id"]].available_at = math.inf
        pending.pop(flight["flight_plan_id"], None)

    def land(flight, when):
        """Give an arriving flight a stand, or put it in the hold queue."""
        deck = flight["destination_vertiport_id"]
        ledger = free_at.setdefault(deck, {})
        stand, ready = _pick_stand(ledger, when)
        flight["_arrived_s"] = when
        if stand is not None and ready <= when and not holding.get(deck):
            park(flight, stand, when)
            return
        holding.setdefault(deck, []).append(flight["flight_plan_id"])
        push_arrival(when + MAX_HOLD_S, flight, "deadline")

    def release(deck, when):
        """A stand at `deck` is free from `when`: the longest-held flight lands."""
        queue = holding.get(deck)
        ledger = free_at.get(deck) or {}
        while queue:
            stand, ready = _pick_stand(ledger, when)
            if stand is None or ready > when:
                break
            flight = pending.get(queue.pop(0))
            if flight is None or flight["flight_status"] != flight_schedule.UNRESOLVED_STATUS:
                continue
            park(flight, stand, max(when, flight["_arrived_s"]))

    def push_arrival(when, flight, kind="arrive"):
        nonlocal sequence
        sequence += 1
        heapq.heappush(arrivals, (when, sequence, flight["flight_plan_id"], kind))

    def settle(limit):
        """Land everything that wants to land before `limit`, in time order."""
        while arrivals and arrivals[0][0] < limit:
            when, _, identifier, kind = heapq.heappop(arrivals)
            flight = pending.get(identifier)
            if flight is None:
                continue  # it landed from the hold queue in the meantime
            if kind == "deadline":
                queue = holding.get(flight["destination_vertiport_id"]) or []
                if identifier in queue:
                    queue.remove(identifier)
                give_up(flight)
            else:
                land(flight, when)

    for index, (hour, hour_start, hour_end) in enumerate(hours):
        remaining = {origin: dict(destinations)
                     for origin, destinations in (by_hour.get(hour) or {}).items()}
        hour_state.update(ready=[], order=0, start=hour_start, end=hour_end)
        ready = hour_state["ready"]
        for carrier in sorted(aircraft.values(), key=lambda a: not preferred(a)):
            make_ready(carrier)
        while True:
            # Everything that lands before the next departure is landed first,
            # in time order, so a stand freed by a departure is seen by the
            # arrival that comes after it and not asked for before it.
            settle(ready[0][0] if ready else hour_end)
            if not ready:
                break
            when, _, identifier = heapq.heappop(ready)
            if when >= hour_end:
                break
            carrier = aircraft[identifier]
            if carrier.available_at >= hour_end:
                continue
            at = max(when, carrier.available_at, hour_start)
            if at >= hour_end:
                continue
            available = remaining.get(carrier.at) or {}
            if not any(available.values()):
                continue
            local = set(blocked)
            built = None
            for _attempt in range(MAX_DESTINATION_ATTEMPTS):
                destination = _choose(available, carrier.seats, local, carrier.at, rng)
                if destination is None:
                    break
                try:
                    choices = timing(carrier.at, destination, carrier.stand, None)
                except (ValueError, KeyError) as error:
                    local.add((carrier.at, destination))
                    blocked.add((carrier.at, destination))
                    notes.append(f"{carrier.at} → {destination}: {error}")
                    continue
                if isinstance(choices, dict):
                    choices = [choices]
                choices = [dict(item) for item in choices or () if isinstance(item, dict)]
                if not choices:
                    local.add((carrier.at, destination))
                    blocked.add((carrier.at, destination))
                    continue
                built = (destination, choices)
                break
            if built is None:
                continue
            destination, choices = built
            load = min(int(available[destination]), carrier.seats)
            if load <= 0:
                continue
            cabin = flight_schedule.seat_class(carrier.seats)
            off_block = at
            slot_specs = []
            if slots is not None:
                candidates = []
                for option in choices:
                    specs = schedule_planning.event_specs(carrier.at, destination, option, planning_values)
                    candidates.append((slots.earliest_start(off_block, specs),
                                       str(option.get("from_fato") or ""),
                                       str(option.get("to_fato") or ""), option, specs))
                slotted, _from_fato, _to_fato, legs, slot_specs = min(candidates,
                    key=lambda item: (item[0], item[1], item[2]))
                if slotted > off_block + 1e-7:
                    capacity_wait_started.setdefault(identifier, off_block)
                    if slotted >= hour_end:
                        capacity_wait_started.pop(identifier, None)
                        capacity_spill_events += 1
                        continue
                    heapq.heappush(ready, (slotted, hour_state["order"], identifier))
                    hour_state["order"] += 1
                    continue
                capacity_wait = off_block - capacity_wait_started.pop(identifier, off_block)
            else:
                legs = choices[0]
                capacity_wait = 0.0
            counter += 1
            if preferred(carrier):
                manual_pending = False
                # Restore ordinary tie order for the remaining initial fleet.
                ranks = {key: i for i, key in enumerate(aircraft)}
                ready[:] = [(t, ranks[key], key) for t, _, key in ready]
                heapq.heapify(ready)
            if slots is not None:
                slots.reserve(off_block, slot_specs)
                if capacity_wait > 0:
                    capacity_delayed_flights += 1
                    capacity_wait_total += capacity_wait
                    capacity_wait_max = max(capacity_wait_max, capacity_wait)
            lift_off = off_block + float(legs["gate_out_s"])
            handoff = lift_off + float(legs["takeoff_s"])
            arrival_ready = handoff + float(legs["air_s"])
            turnaround = float(legs["turnaround_s"])
            if planning_values is not None:
                turnaround = max(turnaround, float(cabin["turnaround_seconds"]))
                turnaround += float(planning_values["turnaround_recovery_s"])
            flight = {
                "flight_plan_id": f"FPL{counter:06d}", "aircraft_id": identifier,
                "aircraft_type_id": cabin["type_id"], "seat_capacity": carrier.seats,
                "passenger_count": load,
                "origin_vertiport_id": carrier.at, "destination_vertiport_id": destination,
                "origin_vertiport_name": names.get(carrier.at, ""),
                "destination_vertiport_name": names.get(destination, ""),
                "demand_hour": hour,
                "departure_stand_id": carrier.stand,
                "departure_fato_id": legs.get("from_fato") or pick_fato(carrier.at, fatos.get(carrier.at), "takeoff"),
                "arrival_stand_id": "",
                "arrival_fato_id": legs.get("to_fato") or pick_fato(destination, fatos.get(destination), "landing"),
                "off_block_s": off_block, "lift_off_s": lift_off, "departure_handoff_s": handoff,
                "touchdown_s": None, "in_block_s": None, "turnaround_complete_s": None,
                "departure_resource_wait_s": capacity_wait, "arrival_resource_wait_s": 0.0,
                "route_path": list(legs.get("route_path") or ()),
                "flight_status": flight_schedule.UNRESOLVED_STATUS,
                "_landing_s": float(legs["landing_s"]), "_gate_in_s": float(legs["gate_in_s"]),
                "_turnaround_s": turnaround,
            }
            flights.append(flight)
            pending[flight["flight_plan_id"]] = flight
            # The stand is the deck's again the moment the aircraft rolls off it,
            # and a flight holding over the deck may have it.
            free_at.setdefault(carrier.at, {})[carrier.stand] = off_block
            carrier.available_at = math.inf  # airborne until it is given a stand
            carrier.flights += 1
            push_arrival(arrival_ready, flight)
            available[destination] -= load
            release(carrier.at, off_block)
        # A tentative facility wait belongs to this hour's demand. Another
        # aircraft may carry the remaining passengers before the delayed one
        # is reconsidered; do not charge that abandoned wait to a different
        # destination or to the next hour's passengers.
        capacity_wait_started.clear()
        settle(hour_end)
        unserved += sum(sum(destinations.values()) for destinations in remaining.values())
        if on_progress:
            on_progress(index + 1, total_steps)

    # Whatever is still in the air when the day closes still has to be given a
    # stand or called unresolved: a flight with no ending is not an answer.
    settle(math.inf)
    if on_progress:
        on_progress(total_steps, total_steps)

    for flight in flights:
        for key in ("_landing_s", "_gate_in_s", "_turnaround_s", "_arrived_s"):
            flight.pop(key, None)
    carried = sum(flight["passenger_count"] for flight in flights
                   if flight["flight_status"] == flight_schedule.READY_STATUS)
    rotations = [carrier.flights for carrier in aircraft.values()]
    if manual_pending:
        notes.append("수동 우선 배치 조건에 맞는 편을 만들지 못했습니다. 인승·출발지·수요·항로를 확인하세요.")
    return {
        "schema_version": SCHEMA_VERSION,
        "scenario_id": str(scenario_id or ""), "scenario_date": str(scenario_date or ""),
        "flights": flights, "notes": sorted(set(notes)),
        "summary": {
            "flights": len(flights),
            "ready_flights": sum(1 for flight in flights
                                 if flight["flight_status"] == flight_schedule.READY_STATUS),
            "unresolved_flights": unresolved,
            "aircraft": len(aircraft),
            "used_aircraft": sum(1 for carrier in aircraft.values() if carrier.flights),
            "carried_passengers": carried,
            "unserved_passengers": unserved,
            "demand_passengers": sum(int(row["passengers"]) for row in demand or ()),
            "start_seconds": start_s, "end_seconds": end_s,
            "capacity_delayed_flights": capacity_delayed_flights,
            "capacity_delay_seconds_total": round(capacity_wait_total, 1),
            "capacity_delay_seconds_max": round(capacity_wait_max, 1),
            "capacity_spill_events": capacity_spill_events,
            "fato_slot_reservations": slots.reservations["fato"] if slots else 0,
            "turnaround_recovery_seconds": (planning_values["turnaround_recovery_s"]
                                             if planning_values else 0.0),
            "rotation_flights_min": min(rotations) if rotations else 0,
            "rotation_flights_max": max(rotations) if rotations else 0,
            "rotation_flights_mean": round(sum(rotations) / len(rotations), 2) if rotations else 0.0,
        },
    }


def _row(flight, scenario_id, scenario_date):
    clock = flight_schedule.clock_text
    seats = int(flight["seat_capacity"]) or 1
    off_block, handoff = flight["off_block_s"], flight["departure_handoff_s"]
    touchdown, in_block = flight["touchdown_s"], flight["in_block_s"]
    def gap(start, end):
        return "" if start is None or end is None else round(float(end) - float(start), 2)
    route = flight.get("route_path") or []
    import json
    return {
        "scenario_id": scenario_id, "scenario_date": scenario_date,
        "flight_plan_id": flight["flight_plan_id"], "aircraft_id": flight["aircraft_id"],
        "aircraft_type_id": flight["aircraft_type_id"], "seat_capacity": seats,
        "passenger_count": flight["passenger_count"],
        "passenger_load_factor": round(flight["passenger_count"] / seats, 4),
        "origin_vertiport_id": flight["origin_vertiport_id"],
        "origin_vertiport_name": flight["origin_vertiport_name"],
        "destination_vertiport_id": flight["destination_vertiport_id"],
        "destination_vertiport_name": flight["destination_vertiport_name"],
        "demand_hour": flight["demand_hour"],
        "departure_stand_id": flight["departure_stand_id"],
        "departure_fato_id": flight["departure_fato_id"],
        "arrival_stand_id": flight["arrival_stand_id"],
        "arrival_fato_id": flight["arrival_fato_id"],
        "off_block_time": clock(off_block), "lift_off_time": clock(flight["lift_off_s"]),
        "departure_handoff_time": clock(handoff), "touchdown_time": clock(touchdown),
        "in_block_time": clock(in_block), "turnaround_complete_time": clock(flight["turnaround_complete_s"]),
        "off_block_to_departure_handoff_sec": gap(off_block, handoff),
        "departure_handoff_to_touchdown_sec": gap(handoff, touchdown),
        "touchdown_to_in_block_sec": gap(touchdown, in_block),
        "block_time_sec": gap(off_block, in_block),
        "airborne_time_sec": gap(flight["lift_off_s"], touchdown),
        "departure_resource_wait_sec": round(float(flight["departure_resource_wait_s"]), 2),
        "arrival_resource_wait_sec": round(float(flight["arrival_resource_wait_s"]), 2),
        "flight_status": flight["flight_status"],
        "route_waypoint_count": len(route) if route else "",
        "route_path": json.dumps(route, ensure_ascii=False) if route else "",
    }


def to_csv(answer):
    """The day as the file the twin reads back.

    A day with no flights still gets its columns: an empty schedule is an answer,
    and a file with no header is a broken one.
    """
    out = io.StringIO(newline="")
    writer = csv.DictWriter(out, fieldnames=list(COLUMNS), lineterminator="\n")
    writer.writeheader()
    scenario_id = str(answer.get("scenario_id") or "")
    scenario_date = str(answer.get("scenario_date") or "")
    for flight in answer.get("flights") or ():
        writer.writerow(_row(flight, scenario_id, scenario_date))
    return out.getvalue()
