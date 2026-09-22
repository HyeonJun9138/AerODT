"""The departures and arrivals board for one deck.

A pure reading of the day. It takes the flights as written, whatever the engine
currently says each one is doing, and the clock, and answers the rows a board
would show -- which is also what says how many people are waiting at which gate,
because a row carries its own passenger count.

Kept out of the engine and out of the observation on purpose. The board is the
one part of the terminal a person reads for a fact, so the rule that turns a
phase and a clock into a word on a screen has to be testable without standing up
a scenario. Nothing here decides anything about the flight; a status is a
reading of state that already exists.
"""
from . import flight_schedule

# How far either side of now a board is worth showing. A flight three hours out
# is not information, and one that left half an hour ago is not either -- but a
# departure stays up a while after it goes, because the first thing somebody
# does on reaching a board is look for the flight they think they missed.
AHEAD_S = 3 * 3600
BEHIND_S = 20 * 60
ROWS = 10
# Boarding is called this far before off-block, and a flight is late this far
# after it. Both are display thresholds; neither moves an aircraft.
BOARDING_OPENS_S = 12 * 60
LATE_S = 3 * 60

DEPARTURE = {"scheduled": "예정", "boarding": "탑승", "taxi": "이동",
             "airborne": "출발", "late": "지연"}
ARRIVAL = {"scheduled": "예정", "approach": "접근", "holding": "대기",
           "landing": "착륙", "arrived": "도착", "late": "지연"}

_MOVING = ("gate_out", "takeoff", "climb", "cruise", "descent", "landing", "gate_in")


def _seconds(flight, *keys):
    """The first of these times the schedule actually carries."""
    for key in keys:
        value = flight.get(key)
        if isinstance(value, (int, float)):
            return float(value)
    return None


def _departure_status(flight, state, due_s, now_s):
    phase = (state or {}).get("phase")
    if phase == "gate_out":
        return "taxi"
    if state and (state.get("airborne") or phase in ("takeoff", "climb", "cruise")):
        return "airborne"
    # Standing on its stand. Whether that reads as boarding or as late is the
    # clock's business, not the aircraft's.
    if now_s >= due_s + LATE_S:
        return "late"
    if now_s >= due_s - BOARDING_OPENS_S:
        return "boarding"
    return "scheduled"


def _arrival_status(flight, state, due_s, now_s):
    phase = (state or {}).get("phase")
    if phase in ("gate_in", "charge") or (state and phase == "parked"):
        return "arrived"
    if state and state.get("holding"):
        return "holding"
    if phase == "landing":
        return "landing"
    if state and (state.get("airborne") or phase in ("descent", "cruise", "climb", "takeoff")):
        return "approach"
    if now_s >= due_s + LATE_S:
        return "late"
    return "scheduled"


def _row(flight, state, due_s, now_s, departing):
    status = (_departure_status if departing else _arrival_status)(flight, state, due_s, now_s)
    words = DEPARTURE if departing else ARRIVAL
    counterpart = flight["destination"] if departing else flight["origin"]
    name = flight.get("destination_name" if departing else "origin_name") or counterpart
    return {"flight_id": flight["flight_id"],
            "aircraft_id": (state or {}).get("aircraft_id") or flight.get("aircraft_id"),
            "direction": "departure" if departing else "arrival",
            "time_s": round(due_s, 1), "time": flight_schedule.clock_text(due_s),
            "counterpart": counterpart, "counterpart_name": name,
            # The stand is what a gate lounge is named for, so it is what the
            # people waiting are counted against.
            "gate": flight.get("departure_stand" if departing else "arrival_stand") or None,
            "fato": flight.get("departure_fato" if departing else "arrival_fato") or None,
            "passengers": int(flight.get("passengers") or 0),
            "seats": int(flight.get("seats") or 0),
            "status": status, "status_text": words[status],
            "late_s": round(max(0.0, now_s - due_s), 1) if status == "late" else 0.0}


def board(flights, live, vertiport_id, now_s, rows=ROWS, ahead_s=AHEAD_S, behind_s=BEHIND_S):
    """The rows one deck's board shows now.

    `flights` is the day as written, keyed or listed; `live` is whatever the
    engine says each flight is doing right now, keyed by flight id, and may be
    empty -- a day that is loaded but not running still has a board.
    """
    listed = list(flights.values()) if hasattr(flights, "values") else list(flights or [])
    live = live or {}
    departures, arrivals = [], []
    for flight in listed:
        if not isinstance(flight, dict) or not flight.get("flight_id"):
            continue
        for departing, place, times, into in (
                (True, flight.get("origin"), ("off_block_s", "lift_off_s"), departures),
                (False, flight.get("destination"), ("in_block_s", "touchdown_s"), arrivals)):
            if place != vertiport_id:
                continue
            due = _seconds(flight, *times)
            if due is None or not (-behind_s <= due - now_s <= ahead_s):
                continue
            into.append(_row(flight, live.get(flight["flight_id"]), due, now_s, departing))
    # Soonest first, and a tie broken by flight id so two clients never disagree
    # about which of two 07:30 departures is the upper line.
    order = lambda row: (row["time_s"], row["flight_id"])
    shown = sorted(departures, key=order)[:rows]
    return {"vertiport_id": vertiport_id, "time_s": round(float(now_s), 1),
            "clock": flight_schedule.clock_text(now_s),
            "departures": shown,
            "arrivals": sorted(arrivals, key=order)[:rows],
            # Who is standing at which gate, from the rows above. It travels
            # with them so the room and the wall cannot disagree about it, and
            # so the browser does not need a second copy of this rule.
            "waiting": waiting_by_gate(shown)}


def waiting_by_gate(rows):
    """How many passengers are waiting at each gate, from the board's own rows.

    Only the flights that have actually been called: a gate whose flight is two
    hours out has nobody at it, and putting the whole day's passengers in the
    lounges at once would fill a terminal that is empty in real life.
    """
    waiting = {}
    for row in rows or []:
        if row.get("direction") != "departure" or row.get("status") not in ("boarding", "late"):
            continue
        gate = row.get("gate")
        if not gate:
            continue
        waiting[gate] = waiting.get(gate, 0) + int(row.get("passengers") or 0)
    return waiting
