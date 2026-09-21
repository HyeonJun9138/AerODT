"""A whole scheduled day, flown as the clock reaches it.

The engine is the only thing that moves an aircraft, so these tests are about
movement: that a flight leaves when the schedule says, passes through its phases
in order and ends up parked at the far end; that a second aircraft wanting the
same pad leaves the corridor and waits clear of it; and that disconnected decks
do not cause an invented straight-line flight.
"""
import math

from digital_twin.model_library import flight_schedule
from digital_twin.model_library.route_network import network as build_network
from digital_twin.model_library.vertiport_layout import generate_layout, validate_definition
from digital_twin.simulation import psu_sequencing
from digital_twin.simulation.scenario_engine import (HOLD, HOLD_MIN_RADIUS_M, HOLD_PHASES,
                                                     HOLD_RADIUS_M, PHASE_PARKED, ScenarioEngine,
                                                     _bearing)


def vertiport(identifier, name, latitude, longitude, **changes):
    definition = validate_definition({"name": name, "latitude": latitude, "longitude": longitude,
                                      "heading_deg": 0, "gates": 4, "platform_height_m": 20,
                                      "fatos": [{"role": "takeoff"}, {"role": "landing"}], **changes})
    return {**definition, "id": identifier, "layout": generate_layout(definition)}


VERTIPORTS = [vertiport("VP1", "여의도", 37.525, 126.920),
              vertiport("VP2", "봉천", 37.478, 126.941),
              vertiport("VP3", "상암", 37.578, 126.892)]
NODES = [{"id": "WP1", "name": "영등포", "latitude": 37.515, "longitude": 126.925, "altitude_m": 304.8,
          "altitude_reference": "agl"},
         {"id": "WP2", "name": "신림동", "latitude": 37.490, "longitude": 126.933, "altitude_m": 304.8,
          "altitude_reference": "agl"}]
LINKS = [{"id": "L1", "from": "fato:VP1:F1", "to": "WP1", "segment": "C", "width_m": None, "name": "출발"},
         {"id": "L2", "from": "WP1", "to": "WP2", "segment": "F", "width_m": 300.0, "name": "순항"},
         {"id": "L3", "from": "WP2", "to": "fato:VP2:F2", "segment": "G", "width_m": None, "name": "도착"}]
NETWORK = build_network(NODES, LINKS, VERTIPORTS)

HEADER = ("flight_plan_id,aircraft_id,seat_capacity,passenger_count,origin_vertiport_id,"
          "destination_vertiport_id,departure_stand_id,departure_fato_id,arrival_stand_id,"
          "arrival_fato_id,off_block_time,touchdown_time,flight_status,scenario_date")


def row(flight, aircraft, origin, destination, off, *, stand="G1", arrival_stand="G2", seats=4,
        passengers=2, touchdown="07:00:00"):
    return (f"{flight},{aircraft},{seats},{passengers},{origin},{destination},{stand},F1,"
            f"{arrival_stand},F2,{off},{touchdown},ready,2026-10-10")


def schedule_of(*rows, vertiports=VERTIPORTS):
    text = "\n".join([HEADER, *rows]) + "\n"
    return flight_schedule.read_schedule(text, vertiports=vertiports)


def engine_of(*rows, vertiports=VERTIPORTS, network=NETWORK, elevation=None):
    return ScenarioEngine(schedule_of(*rows, vertiports=vertiports),
                          vertiports=vertiports, network=network, elevation=elevation)


def run_to(engine, until, step=2.0):
    while engine.time_s < until:
        engine.advance(min(until, engine.time_s + step))
    return engine


def state_of(engine, aircraft_id):
    return next(item for item in engine.states() if item["aircraft_id"] == aircraft_id)


def test_the_day_opens_with_every_aircraft_on_the_stand_it_starts_from():
    engine = engine_of(row("F1", "A1", "VP1", "VP2", "06:30:00", stand="G1"),
                       row("F2", "A2", "VP1", "VP2", "06:40:00", stand="G2"),
                       row("F3", "A3", "VP2", "VP1", "06:35:00", stand="G1"))
    assert engine.time_s == 6 * 3600 + 30 * 60
    states = {item["aircraft_id"]: item for item in engine.states()}
    assert len(states) == 3 and all(item["phase"] == PHASE_PARKED for item in states.values())
    assert states["A1"]["vertiport"] == "VP1" and states["A1"]["stand"] == "G1"
    assert states["A3"]["vertiport"] == "VP2"
    # A parked aircraft stands on its deck, not on the ground under it.
    deck = VERTIPORTS[0]["layout"]["platform"]["height_m"]
    assert states["A1"]["altitude_m"] == deck
    assert states["A1"]["flight_id"] is None and states["A1"]["airborne"] is False
    # And the stand it is on is held, so nothing else is cleared onto it.
    assert engine.psu._stands.occupant("VP1", "G1") == "A1"


def test_a_flight_leaves_when_the_schedule_says_and_goes_through_its_phases():
    engine = engine_of(row("F1", "A1", "VP1", "VP2", "06:31:00"))
    run_to(engine, 6 * 3600 + 30 * 60 + 50)
    assert state_of(engine, "A1")["phase"] == PHASE_PARKED, "not yet"
    seen = [state_of(engine, "A1")["phase"]]
    while engine.time_s < 7 * 3600 + 30 * 60:
        engine.advance(engine.time_s + 2)
        phase = state_of(engine, "A1")["phase"]
        if seen[-1] != phase:
            seen.append(phase)
        if len(seen) > 2 and phase == PHASE_PARKED:
            break
    assert seen[0] == PHASE_PARKED
    flown = [phase for phase in seen if phase != PHASE_PARKED]
    assert flown == ["gate_out", "takeoff", "climb", "cruise", "descent", "landing", "gate_in"]
    ended = state_of(engine, "A1")
    assert ended["vertiport"] == "VP2", "it is parked where it flew to"
    assert ended["flight_id"] is None
    # The wheels are stopped and the people are still getting off: they walk to
    # the shelter rather than vanishing with the flight.
    assert ended["passengers"] == 2 and ended["passenger_flow"]["phase"] == "alighting"
    run_to(engine, engine.time_s + ended["passenger_flow"]["duration_s"] + 1)
    away = state_of(engine, "A1")
    assert away["passengers"] == 0 and away["passenger_flow"] is None
    assert engine.summary()["flights_completed"] == 1
    assert engine.psu._stands.occupant("VP2", ended["stand"]) == "A1"
    # The flight left the stand it started on.
    assert engine.psu._stands.occupant("VP1", "G1") is None


def test_it_is_airborne_between_the_lift_and_the_landing_and_moves_while_it_is():
    engine = engine_of(row("F1", "A1", "VP1", "VP2", "06:31:00"))
    run_to(engine, 6 * 3600 + 33 * 60)
    first = state_of(engine, "A1")
    assert first["airborne"] and first["altitude_m"] > VERTIPORTS[0]["layout"]["platform"]["height_m"] + 50
    assert first["heading_deg"] is not None and first["speed_mps"] > 0
    engine.advance(engine.time_s + 20)
    later = state_of(engine, "A1")
    moved = math.dist((first["latitude_deg"], first["longitude_deg"]),
                      (later["latitude_deg"], later["longitude_deg"]))
    assert moved > 0, "twenty seconds of cruise is not the same place"


def test_the_second_aircraft_wanting_one_pad_leaves_the_corridor_and_waits_clear_of_it():
    """The hold is entered where the approach would have started, not on the
    approach: an aircraft told to wait must not be waiting in the way of the one
    it is waiting for."""
    engine = engine_of(row("F1", "A1", "VP1", "VP2", "06:31:00"),
                       row("F2", "A2", "VP1", "VP2", "06:31:20", stand="G2", arrival_stand="G3"))
    held, positions = None, []
    while engine.time_s < 7 * 3600 + 30 * 60:
        engine.advance(engine.time_s + 2)
        state = state_of(engine, "A2")
        if state["holding"]:
            held = state
            positions.append(state)
        if state["phase"] == PHASE_PARKED and engine.summary()["flights_completed"] == 2:
            break
    assert held is not None, "one of the two had to wait"
    assert {item["phase"] for item in positions} <= set(HOLD_PHASES)
    assert any(item["phase"] == HOLD for item in positions), "it actually stops and waits"
    assert held["sequence"] == 2, "and it was told which number it is"
    # The place it waits is off the deck and above the approach.
    deck = next(item for item in VERTIPORTS if item["id"] == "VP2")
    waiting = next(item for item in positions if item["phase"] == HOLD)
    metres = math.dist((waiting["latitude_deg"] * 111320, waiting["longitude_deg"] * 88000),
                       (deck["latitude"] * 111320, deck["longitude"] * 88000))
    # Far enough out to be clear of the deck, and no further than the wait pays
    # for: a short wait is spent stopped, not commuting.
    assert HOLD_MIN_RADIUS_M - 20 <= metres <= HOLD_RADIUS_M + 200
    assert waiting["altitude_m"] > deck["platform_height_m"] + 200
    # Both still land, and the wait is on the record.
    assert engine.summary()["flights_completed"] == 2
    assert engine.psu.statistics()["held_arrivals"] >= 1
    assert engine.psu.clearance("F2").hold_s > 0


def test_a_holding_aircraft_is_not_put_where_the_corridors_are():
    """The corridor into and out of a deck is the one bearing a waiting aircraft
    may not sit on."""
    engine = engine_of(row("F1", "A1", "VP1", "VP2", "06:31:00"))
    corridors = engine._corridors.get("VP2")
    assert corridors, "the network reaches this deck, so it has corridor bearings"
    deck = next(item for item in VERTIPORTS if item["id"] == "VP2")
    (latitude, longitude, _), slot = engine._holding_fix("VP2", (deck["latitude"], deck["longitude"], 0))
    bearing = _bearing((deck["latitude"], deck["longitude"]), (latitude, longitude))
    for corridor in corridors:
        gap = abs((bearing - corridor + 180) % 360 - 180)
        assert gap >= 30, f"the fix sits {gap:.0f}° from a corridor"
    # A second aircraft waiting for the same deck is sent somewhere else again.
    engine._holds.setdefault("VP2", {})["A1"] = {"slot": slot}
    _, other = engine._holding_fix("VP2", (deck["latitude"], deck["longitude"], 0))
    assert other != slot, "two aircraft do not wait in the same place"


def test_decks_the_network_does_not_join_are_not_flown_direct():
    """Even an older CSV without route_path must follow an existing corridor."""
    engine = engine_of(row("F1", "A1", "VP1", "VP3", "06:31:00"))
    run_to(engine, 7 * 3600 + 30 * 60, step=5)
    assert engine.summary()["flights_completed"] == 0
    assert engine.summary()["direct_flights"] == 0
    assert engine.summary()["cancelled"] == 1
    assert engine.summary()["flights_started"] == 0
    assert state_of(engine, "A1")["vertiport"] == "VP1"
    assert any(event["kind"] == "cancelled" for event in engine.events)
    # A drawn route is not marked as made up.
    joined = engine_of(row("F2", "A2", "VP1", "VP2", "06:31:00"))
    assert joined.route(joined.flights["F2"]).direct is False


def test_a_pair_that_cannot_be_flown_at_all_is_reported_and_the_aircraft_moves_on():
    # One pad has to do both, so a deck that cannot be landed on is one with two
    # pads that both only launch.
    no_landing = vertiport("VP4", "무착륙", 37.55, 126.99,
                           fatos=[{"role": "takeoff"}, {"role": "takeoff"}])
    places = [*VERTIPORTS, no_landing]
    engine = engine_of(row("F1", "A1", "VP1", "VP4", "06:31:00"),
                       row("F2", "A1", "VP1", "VP2", "06:50:00"),
                       vertiports=places, network=build_network(NODES, LINKS, places))
    run_to(engine, 7 * 3600 + 30 * 60, step=5)
    assert any("F1" in problem for problem in engine.problems)
    assert engine.summary()["cancelled"] == 1
    # The aircraft is not stranded by the flight it could not make.
    assert engine.summary()["flights_completed"] == 1
    assert state_of(engine, "A1")["vertiport"] == "VP2"


def test_a_bigger_cabin_is_a_different_airframe_on_the_same_line():
    """Every cabin flies the reference aircraft's performance down the same
    corridor. What a bigger one costs the day is on the ground: it is a
    different airframe on the map and it takes longer to turn round."""
    engine = engine_of(row("F1", "A1", "VP1", "VP2", "06:31:00", seats=2),
                       row("F2", "A2", "VP1", "VP2", "06:31:00", seats=8, stand="G2", arrival_stand="G3"))
    small = engine.route(engine.flights["F1"])
    large = engine.route(engine.flights["F2"])
    cruise = lambda route: next(phase for phase in route.phases if phase.stage == "cruise")
    assert cruise(small).distance_m == cruise(large).distance_m, "the same corridor"
    assert cruise(small).duration_s == cruise(large).duration_s, "flown at the same speed"
    # The two are told apart on the map, and in what they cost the deck.
    assert state_of(engine, "A1")["asset_id"] != state_of(engine, "A2")["asset_id"]
    assert (flight_schedule.seat_class(2)["turnaround_seconds"]
            < flight_schedule.seat_class(8)["turnaround_seconds"])


def test_the_clock_only_goes_forwards_and_resetting_is_how_it_goes_back():
    engine = engine_of(row("F1", "A1", "VP1", "VP2", "06:31:00"))
    run_to(engine, 6 * 3600 + 40 * 60)
    moment = engine.time_s
    engine.advance(moment - 300)
    assert engine.time_s == moment, "a clock that could be wound back would un-give a landing number"
    engine.reset()
    assert engine.time_s == engine.opens_s
    assert state_of(engine, "A1")["phase"] == PHASE_PARKED
    assert engine.summary()["flights_completed"] == 0
    assert engine.psu.statistics()["requests"] == 0


def test_the_summary_counts_what_the_console_reads_out():
    two_way = build_network(NODES, [*LINKS,
        {"id": "R1", "from": "fato:VP2:F1", "to": "WP2", "segment": "C"},
        {"id": "R3", "from": "WP1", "to": "fato:VP1:F2", "segment": "G"}], VERTIPORTS)
    engine = engine_of(row("F1", "A1", "VP1", "VP2", "06:31:00"),
                       row("F2", "A2", "VP2", "VP1", "06:31:00", arrival_stand="G3"), network=two_way)
    opened = engine.summary()
    assert opened["aircraft"] == 2 and opened["parked"] == 2 and opened["active"] == 0
    assert opened["flights"] == 2 and opened["flights_remaining"] == 2
    assert opened["progress"] == 0.0
    run_to(engine, 6 * 3600 + 34 * 60)
    flying = engine.summary()
    assert flying["active"] == 2 and flying["flights_started"] == 2
    assert flying["passengers_carried"] == 4 if flying["airborne"] == 2 else True
    assert 0 < flying["progress"] <= 1


def test_a_flight_can_be_asked_about_by_name():
    engine = engine_of(row("F1", "A1", "VP1", "VP2", "06:31:00"))
    run_to(engine, 6 * 3600 + 33 * 60)
    flying = engine.flight_detail("F1")
    assert flying["flight"]["flight_id"] == "F1"
    assert flying["state"]["aircraft_id"] == "A1"
    operations = [event for event in flying['events'] if event['kind'] in ('taxi_requested','off_block')]
    assert [event['kind'] for event in operations] == ['taxi_requested','off_block']
    assert operations[1]['time_s'] > operations[0]['time_s']
    assert any(event.get("node") == "allocate" for event in flying["events"])
    # After it has landed the flight is still answerable; only nothing is flying it.
    run_to(engine, 6 * 3600 + 45 * 60)
    landed = engine.flight_detail("F1")
    assert landed["flight"]["flight_id"] == "F1" and landed["state"] is None
    assert "in_block" in [event["kind"] for event in landed["events"]]
    assert engine.flight_detail("nope") is None


def test_an_aircraft_with_nothing_left_to_fly_is_parked_rather_than_gone():
    """A deck that empties itself as the day ends would be the model showing
    through: the airframes are standing on it until somebody moves them."""
    engine = engine_of(row("F1", "A1", "VP1", "VP2", "06:31:00"))
    run_to(engine, 6 * 3600 + 45 * 60)
    ended = state_of(engine, "A1")
    assert ended["phase"] == PHASE_PARKED and ended["vertiport"] == "VP2"
    summary = engine.summary()
    assert summary["parked"] == 1 and summary["finished"] == 1
    assert summary["flights_completed"] == 1 and summary["flights_remaining"] == 0


def test_heights_come_from_the_elevation_source_when_there_is_one():
    """A corridor a thousand feet over the ground has to know where the ground
    is. The source answers either a number or a (height, coverage) pair, and no
    coverage falls back rather than putting the corridor at sea level."""
    flat = engine_of(row("F1", "A1", "VP1", "VP2", "06:31:00"), elevation=lambda lon, lat: (300.0, 1.0))
    high = engine_of(row("F1", "A1", "VP1", "VP2", "06:31:00"), elevation=lambda lon, lat: (900.0, 1.0))
    cruise = lambda engine: next(phase for phase in engine.route(engine.flights["F1"]).phases
                                 if phase.stage == "cruise")
    assert cruise(high).points[0][2] - cruise(flat).points[0][2] == 600.0
    # No coverage, a bad answer and a source that raises all fall back instead.
    for source in (lambda lon, lat: (500.0, 0.0), lambda lon, lat: None,
                   lambda lon, lat: (_ for _ in ()).throw(RuntimeError("no tiles"))):
        engine = engine_of(row("F1", "A1", "VP1", "VP2", "06:31:00"), elevation=source)
        assert math.isfinite(cruise(engine).points[0][2])
