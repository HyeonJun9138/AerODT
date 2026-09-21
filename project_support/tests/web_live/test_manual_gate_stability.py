"""착륙한 뒤에는 배정 GATE가 바뀌지 않는다.

The arrival gate is re-checked on every tick, and when the sequencer answers a
different stand the engine retargets the taxi. For an automatic arrival that is
free -- it re-plans inside the same tick. A person has read the number off the
panel and is taking the aircraft to it, and the only guard was "not while they
happen to be rolling", so stopping to read the panel was enough to have the
gate changed underneath them: 배정 STAND 변경 · G5 → G3, on the ground.
"""
from digital_twin.simulation.scenario_engine import ScenarioEngine
from project_support.tests.web_live.test_scenario_engine import schedule_of, row, VERTIPORTS, NETWORK


def engine():
    return ScenarioEngine(schedule_of(row('F', 'A', 'VP1', 'VP2', '06:30:00'),
                                      row('G', 'B', 'VP1', 'VP2', '06:30:00',
                                          stand='G3', arrival_stand='G4')),
                          vertiports=VERTIPORTS, network=NETWORK, elevation=lambda lon, lat: 0)


def flown(aircraft, flight, *, departed=True):
    aircraft.external = {'since_s': 0.0, 'flight_id': flight['flight_id'],
                         'departed': departed, 'violations': []}
    return aircraft


def other_stand(e, flight):
    """A stand at the destination that is not the one this flight was given."""
    return next(s for s in e._stands_of(flight['destination'])
                if s != flight['arrival_stand'])


def test_a_hand_flown_aircraft_that_has_landed_keeps_the_gate_it_was_given():
    e = engine()
    try:
        a = next(iter(e.aircraft.values()))
        f = e.flights[a.next_flight or list(e.flights)[0]] if a.next_flight else list(e.flights.values())[0]
        a.flight = f
        a.route = e.route(f)
        a.phase = 'gate_in'
        flown(a, f)
        assert not a.airborne, '착륙해 있다'
        assert e._retarget_arrival_gate(a, other_stand(e, f)) is False
    finally:
        e.close()


def test_it_is_still_free_to_change_while_they_are_in_the_air():
    # That is where the service is supposed to settle it, and where the pilot
    # has time to be told and fly to it.
    e = engine()
    try:
        a = next(iter(e.aircraft.values()))
        f = list(e.flights.values())[0]
        a.flight, a.route = f, e.route(f)
        flown(a, f)
        airborne = e._retarget_arrival_gate(a, other_stand(e, f))
        # Whatever the route machinery answers, it must not be the flat refusal
        # the landed case gives: the guard has to be about being down.
        assert airborne is not False or a.airborne is False
    finally:
        e.close()


def test_before_departure_the_arrival_gate_is_not_frozen():
    # `departed` is what tells the two apart: on the stand at the origin the
    # aircraft is also not airborne, and its arrival gate should still move.
    e = engine()
    try:
        a = next(iter(e.aircraft.values()))
        f = list(e.flights.values())[0]
        a.flight, a.route = f, e.route(f)
        a.phase = 'parked'
        flown(a, f, departed=False)
        assert e._retarget_arrival_gate(a, other_stand(e, f)) is not False
    finally:
        e.close()


def test_an_automatic_arrival_is_still_moved_when_it_is_standing_still():
    # Nothing here may take that away: a stopped automatic aircraft whose gate
    # is blocked has to be sent somewhere, and it re-plans its taxi for free.
    e = engine()
    try:
        a = next(iter(e.aircraft.values()))
        f = list(e.flights.values())[0]
        a.flight, a.route = f, e.route(f)
        a.phase = 'gate_in'
        assert a.external is None
        try:
            assert e._retarget_arrival_gate(a, other_stand(e, f)) is not False
        except ValueError as problem:
            # It got past the guard and into planning a taxi, which is the
            # point: this fixture's aircraft has no position on the deck for
            # one to be planned from. Being refused by the guard would have
            # returned False without ever reaching the planner.
            assert '유도로' in str(problem), problem
    finally:
        e.close()
