"""What a scheduled flight reports about itself while it is being flown.

Which mode it is in, how far through it is against the plan it was given, where
it has been, and who is getting on and off. These are the answers the panel puts
on screen when somebody clicks an aircraft, so they are held here rather than in
the panel: the panel must not be the thing that decides a cruise is flown on the
wing.
"""
import math

import pytest

from digital_twin.model_library import flight_mode, flight_plan, scheduled_route
from digital_twin.simulation.scenario_engine import HOLD_PHASES, PHASE_PARKED
from digital_twin.model_library.route_network import network as build_network
from project_support.tests.web_live.test_scenario_engine import (LINKS, NODES, VERTIPORTS,
                                                                 engine_of, row, run_to, state_of)


def fly(engine, aircraft_id, until_phase, limit_s=3600.0):
    """Run until the aircraft is in a phase, answering its state there."""
    end = engine.time_s + limit_s
    while engine.time_s < end:
        engine.advance(engine.time_s + 1)
        state = state_of(engine, aircraft_id)
        if state["phase"] == until_phase:
            return state
    raise AssertionError(f"{aircraft_id} never reached {until_phase}")


def test_the_mode_follows_the_rotors_through_the_whole_flight():
    """Rotors off the pad, transition on the way up, wing in the cruise, and
    back through the transition before the approach."""
    engine = engine_of(row("F1", "A1", "VP1", "VP2", "06:31:00"))
    seen, last, order = {}, None, []
    end = engine.time_s + 3600
    while engine.time_s < end:
        engine.advance(engine.time_s + 1)
        state = state_of(engine, "A1")
        seen.setdefault(state["phase"], set()).add(state["flight_mode"])
        if state["flight_mode"] != last:
            order.append(state["flight_mode"])
            last = state["flight_mode"]
        if state["phase"] == PHASE_PARKED and "gate_in" in seen:
            break
    assert seen["gate_out"] == {flight_mode.GROUND}
    assert seen["takeoff"] == {flight_mode.ROTOR}, "the lift off the pad is all rotor"
    assert flight_mode.TRANSITION in seen["climb"], "on the way up it turns over"
    assert seen["cruise"] == {flight_mode.WING}, "the cruise is flown on the wing, all of it"
    assert flight_mode.TRANSITION in seen["descent"], "and it turns back before the approach"
    assert seen["landing"] == {flight_mode.ROTOR}
    assert seen["gate_in"] == {flight_mode.GROUND}
    # The order it happens in, once each: ground, rotors, over, wing, back, rotors, ground.
    assert order == [flight_mode.GROUND, flight_mode.ROTOR, flight_mode.TRANSITION,
                     flight_mode.WING, flight_mode.TRANSITION, flight_mode.ROTOR,
                     flight_mode.GROUND]
    # The tilt on screen and the mode in words are the same number read twice.
    state = fly(engine_of(row("F1", "A1", "VP1", "VP2", "06:31:00")), "A1", "cruise")
    assert state["tilt_deg"] == pytest.approx(90.0, abs=0.1)
    assert state["flight_mode_label"] == "고정익"


def test_the_transition_is_finished_before_the_hold_and_the_hold_is_on_the_rotors():
    """A pilot told to wait has already come back off the wing: the hold is flown
    as a multirotor, out of the corridor."""
    engine = engine_of(row("F1", "A1", "VP1", "VP2", "06:31:00"),
                       row("F2", "A2", "VP1", "VP2", "06:31:20", stand="G2", arrival_stand="G3"))
    modes, stopped = [], False
    end = engine.time_s + 5400
    while engine.time_s < end:
        engine.advance(engine.time_s + 1)
        state = state_of(engine, "A2")
        if state["phase"] in HOLD_PHASES:
            modes.append(state["flight_mode"])
            stopped = stopped or state["phase"] == "hold"
        elif modes:
            break
    assert stopped, "one of the two had to wait"
    # Out of the corridor, stopped, and back onto the approach — all of it on
    # the rotors, because the reverse transition happened before the wait.
    assert set(modes) == {flight_mode.ROTOR}


def test_progress_counts_the_wait_and_the_plan_says_whether_it_is_late():
    engine = engine_of(row("F1", "A1", "VP1", "VP2", "06:31:00", touchdown="06:40:00"))
    flying = fly(engine, "A1", "cruise")
    adherence = flying["adherence"]
    assert 0.0 < adherence["progress"] < 1.0
    assert adherence["remaining_s"] > 0
    assert adherence["planned_block_s"] > 0
    assert adherence["elapsed_s"] >= 0
    # Late is positive, and it is measured against the touchdown the plan asked
    # for rather than against how long the flight has taken.
    assert adherence["planned_touchdown_s"] == 6 * 3600 + 40 * 60
    assert adherence["delay_s"] == pytest.approx(
        adherence["expected_touchdown_s"] - adherence["planned_touchdown_s"], abs=0.1)
    later = fly(engine, "A1", "landing")
    assert later["adherence"]["progress"] > adherence["progress"], "it only goes forwards"
    assert later["adherence"]["remaining_s"] <= adherence["remaining_s"]
    # A parked aircraft is not flying a plan, so it reports none.
    run_to(engine, engine.time_s + 900)
    assert state_of(engine, "A1")["adherence"] is None


def test_an_aircraft_carries_the_track_of_the_flight_it_is_flying():
    engine = engine_of(row("F1", "A1", "VP1", "VP2", "06:31:00"))
    assert engine.track("A1")["points"] == [], "nothing flown yet"
    fly(engine, "A1", "cruise")
    track = engine.track("A1")
    assert track["flight_id"] == "F1" and track["origin"] == "VP1"
    assert len(track["points"]) > 3
    requested=next(e['time_s'] for e in engine.events if e['kind']=='taxi_requested' and e['flight_id']=='F1')
    departed=next(e['time_s'] for e in engine.events if e['kind']=='off_block' and e['flight_id']=='F1')
    assert track['departed_s']==departed and departed>requested
    # Longitude, latitude, altitude, time — the order a path is drawn from.
    # Boarding belongs to the mission track, but actual off-block is motion start.
    for longitude, latitude, altitude, moment in track["points"]:
        assert 126.0 < longitude < 128.0 and 37.0 < latitude < 38.0
        assert altitude >= 0.0 and moment >= requested
    times = [point[3] for point in track["points"]]
    assert times == sorted(times), "oldest first"
    assert len(track["points"]) <= 900, "bounded"
    assert state_of(engine, "A1")["track_points"] == len(track["points"])
    # The track belongs to the flight, not to the airframe: the next one starts
    # its own.
    # Parked at the far end it still carries the track of the flight it just
    # flew, named by that flight: clicking an aircraft that has landed shows
    # where it came from rather than nothing.
    run_to(engine, engine.time_s + 3600)
    landed = engine.track("A1")
    assert landed["flight_id"] == "F1" and landed["flying"] is False
    assert len(landed["points"]) > 3
    assert engine.track("nobody") is None


def test_people_walk_on_before_it_taxis_and_off_after_it_parks():
    engine = engine_of(row("F1", "A1", "VP1", "VP2", "06:31:00", passengers=3))
    boarding = fly(engine, "A1", "gate_out")
    flow = boarding["passenger_flow"]
    assert flow["phase"] == "boarding" and flow["count"] == 3
    assert 0.0 <= flow["share"] <= 1.0 and flow["duration_s"] > 0
    assert flow["vertiport"] == "VP1" and flow["stand"] == "G1"
    assert boarding["on_board"] <= 3
    # Airborne, everybody is aboard.
    airborne = fly(engine, "A1", "cruise")
    assert airborne["passenger_flow"]["phase"] == "aboard"
    assert airborne["on_board"] == 3
    # Parked at the far end, they get off before the airframe is free again.
    end = engine.time_s + 3600
    while engine.time_s < end:
        engine.advance(engine.time_s + 1)
        state = state_of(engine, "A1")
        if state["phase"] == PHASE_PARKED and state["flight_id"] is None:
            break
    off = state_of(engine, "A1")
    assert off["passenger_flow"]["phase"] == "alighting"
    assert off["passenger_flow"]["count"] == 3
    assert off["passenger_flow"]["vertiport"] == "VP2"
    assert off["on_board"] <= 3
    run_to(engine, engine.time_s + off["passenger_flow"]["duration_s"] + 2)
    assert state_of(engine, "A1")["on_board"] == 0


def _flat(origin, point):
    cos = math.cos(math.radians(origin[0]))
    return ((point[1] - origin[1]) * 111320 * cos, (point[0] - origin[0]) * 111320)


def _side_of(centre, point):
    """(metres from the corridor centreline, -1 right of travel / +1 left)."""
    origin = centre[0]
    line = [_flat(origin, item) for item in centre]
    x, y = _flat(origin, point)
    best = None
    for (ax, ay), (bx, by) in zip(line, line[1:]):
        dx, dy = bx - ax, by - ay
        length = math.hypot(dx, dy)
        if length < 1e-6:
            continue
        share = max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / (length * length)))
        gap = math.hypot(x - (ax + dx * share), y - (ay + dy * share))
        cross = dx * (y - ay) - dy * (x - ax)
        if best is None or gap < best[0]:
            best = (gap, -1 if cross < 0 else 1)
    return best


TWO_WAY = build_network(
    NODES,
    [*LINKS,
     # The same corridor drawn the other way, so one pair of decks is joined in
     # both directions and the two flights share a centreline.
     {"id": "R1", "from": "fato:VP2:F1", "to": "WP2", "segment": "C", "width_m": None, "name": "출발"},
     {"id": "R2", "from": "WP2", "to": "WP1", "segment": "F", "width_m": 300.0, "name": "순항"},
     {"id": "R3", "from": "WP1", "to": "fato:VP1:F2", "segment": "G", "width_m": None, "name": "도착"}],
    VERTIPORTS)


def test_the_cruise_is_flown_on_the_right_of_the_corridor_both_ways():
    """Right-hand traffic, measured on the geometry the engine actually flies —
    not on the helper that computes it."""
    engine = engine_of(row("F1", "A1", "VP1", "VP2", "06:31:00"),
                       row("F2", "A2", "VP2", "VP1", "06:31:00", stand="G1", arrival_stand="G3"),
                       network=TWO_WAY)
    out = engine.route(dict(engine.flights["F1"], departure_stand="G1"))
    back = engine.route(dict(engine.flights["F2"], departure_stand="G1"))
    outbound = next(phase for phase in out.phases if phase.stage == "cruise")
    inbound = next(phase for phase in back.phases if phase.stage == "cruise")
    assert outbound.detail["right_offset_m"] > 0, "the corridor has a lane to keep to"

    # The corridor's own centreline, as the network drew it: WP1 to WP2.
    centre = [(37.515, 126.925), (37.490, 126.933)]
    for phase, line, name in ((outbound, centre, "outbound"),
                              # Right is measured against the way each is going,
                              # so the corridor is read the other way round for
                              # the flight coming back down it.
                              (inbound, list(reversed(centre)), "inbound")):
        # The lane is entered and left over 200 m, so the ends sit on the middle.
        middle = phase.points[len(phase.points) // 2]
        gap, side = _side_of(line, middle)
        assert side == -1, f"{name} keeps right"
        assert 1.0 < gap <= scheduled_route.RIGHT_OFFSET_M + 1.0, f"{name} is {gap:.1f} m out"

    # Which means the two never share a place: opposing traffic is separated
    # where both are fully in their lane.
    nearest = min(flight_plan.haversine_m((a[0], a[1]), (b[0], b[1]))
                  for a in phase_middle(outbound) for b in phase_middle(inbound))
    assert nearest > scheduled_route.RIGHT_OFFSET_M, f"they pass {nearest:.1f} m apart"


def phase_middle(phase, edge=0.25):
    """The stretch of a phase that is fully in its lane, ends excluded."""
    points = phase.points
    first, last = int(len(points) * edge), max(1, int(len(points) * (1 - edge)))
    return points[first:last] or points[len(points) // 2:len(points) // 2 + 1]


def test_the_turnaround_waits_for_the_last_passenger_off():
    engine = engine_of(row("F1", "A1", "VP1", "VP2", "06:31:00", passengers=4))
    end = engine.time_s + 3600
    while engine.time_s < end:
        engine.advance(engine.time_s + 1)
        aircraft = engine.aircraft["A1"]
        if aircraft.unloading:
            assert aircraft.ready_s >= aircraft.unloading["from_s"] + aircraft.unloading["duration_s"]
            return
    raise AssertionError("the flight never arrived")
