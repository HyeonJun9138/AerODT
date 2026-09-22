"""수동 기체는 아직 서 있는 예약들 뒤로 계속 밀리지 않는다.

`_preview_arrival_entry` never displaces anybody: whatever is in its `others`
pushes the aircraft being previewed later. That set includes the entry
reservations of aircraft **still standing on their own stands**, which are
forecasts rather than traffic — so a hand-flown aircraft waiting at the gate was
pushed further back every time the meter was recomputed, and the pilot watched
their departure time slide away while sitting still.

The rule here is the arrival sequencer's: first among those still waiting, never
in front of anything actually flying.
"""
from digital_twin.simulation.scenario_engine import ScenarioEngine
from project_support.tests.web_live.test_scenario_engine import schedule_of, row, VERTIPORTS, NETWORK


def engine(policy=None):
    result=ScenarioEngine(schedule_of(row('F', 'A', 'VP1', 'VP2', '06:30:00'),
                                      row('G', 'B', 'VP1', 'VP2', '06:30:00',
                                          stand='G3', arrival_stand='G4')),
                          vertiports=VERTIPORTS, network=NETWORK,
                          elevation=lambda lon, lat: 0, policy=policy)
    result.psu.tuning.manual_arrival_priority=True
    return result


def pair(e):
    (a, b), (f, g) = list(e.aircraft.values()), list(e.flights.values())
    return a, b, f, g, e.route(f), e.route(g)


def test_a_waiting_reservation_pushes_an_ordinary_aircraft_back():
    # The behaviour the hand-flown case is measured against: B is previewed
    # after A has booked, so B is spaced behind A even though neither has moved.
    e = engine()
    try:
        a, b, f, g, first, second = pair(e)
        assert e._meter_arrival_entry(a, f, first, e.time_s)
        alone = e._preview_arrival_entry(b, g, second, e.time_s)['entry_s']
        e._meter_arrival_entry(b, g, second, e.time_s)
        assert e._entry_forecasts['G']['entry_s'] >= alone, '앞선 예약 뒤로 간다'
    finally:
        e.close()


def test_the_hand_flown_aircraft_keeps_its_place_against_reservations_still_on_the_ground():
    e = engine()
    try:
        a, b, f, g, first, second = pair(e)
        assert e._meter_arrival_entry(a, f, first, e.time_s)
        ordinary = e._preview_arrival_entry(b, g, second, e.time_s)['entry_s']
        # The same aircraft, now the one a person is flying.
        b.external = {'since_s': e.time_s, 'flight_id': g['flight_id'],
                      'departed': False, 'violations': []}
        flown = e._preview_arrival_entry(b, g, second, e.time_s)['entry_s']
        assert flown < ordinary, f'서 있는 예약 뒤로 밀리지 않는다 ({flown:.0f} < {ordinary:.0f})'
    finally:
        e.close()


def test_it_does_not_slide_further_each_time_the_meter_is_recomputed():
    # The complaint itself: the number moved every time it was worked out again.
    e = engine()
    try:
        a, b, f, g, first, second = pair(e)
        e._meter_arrival_entry(a, f, first, e.time_s)
        b.external = {'since_s': e.time_s, 'flight_id': g['flight_id'],
                      'departed': False, 'violations': []}
        seen = [e._preview_arrival_entry(b, g, second, e.time_s)['entry_s'] for _ in range(5)]
        assert max(seen) - min(seen) < 1e-6, f'같은 시각에 다시 물으면 같은 답이다 ({seen})'
    finally:
        e.close()


def test_what_the_priority_skips_is_a_reservation_and_never_traffic():
    """Three readings of the same pair, so the change is described exactly.

    The priority skips the entry *reservations* of aircraft still standing on
    their stands. It does not touch the loop below that reads aircraft actually
    under way, so the hand-flown aircraft still gives ground to one -- it is
    simply spaced against where that aircraft really is, rather than against the
    more conservative booking it made before it left.
    """
    def entry(*, book=False, flying=False, manual=True):
        e = engine()
        try:
            a, b, f, g, first, second = pair(e)
            if book:
                e._meter_arrival_entry(a, f, first, e.time_s)
            if flying:
                # What that loop reads is the phase and the index, not the
                # observed airborne flag: an aircraft past its stand is traffic.
                a.route, a.index, a.phase = first, first.landing_index - 1, 'descent'
            if manual:
                b.external = {'since_s': e.time_s, 'flight_id': g['flight_id'],
                              'departed': False, 'violations': []}
            return e._preview_arrival_entry(b, g, second, e.time_s)['entry_s']
        finally:
            e.close()

    alone = entry()
    assert entry(book=True) == alone, '서 있는 기체의 예약은 건너뛴다'
    # And the ordinary aircraft is held to that booking as it always was, which
    # is exactly what the hand-flown one is being let out of.
    assert entry(book=True, manual=False) > alone
    # These two decks are far enough apart that the flying aircraft's own ETA
    # never conflicts with this one's, so the fixture cannot show the yield --
    # it can only be shown where the guard is written. It is one condition on
    # the loop that reads *reservations*; the loop that reads aircraft under way
    # has none, which is what makes 'never in front of traffic' true.
    from pathlib import Path
    source = Path('digital_twin/simulation/scenario_engine.py').read_text(encoding='utf-8')
    body = source.partition('def _preview_arrival_entry')[2].partition('\n    def ')[0]
    forecasts, _, traffic = body.partition('for other in self.aircraft.values():')
    assert 'waiting_only' in forecasts, '예약 루프에 조건이 있다'
    assert 'waiting_only' not in traffic, '교통 루프에는 조건이 없다'


def test_later_ground_departures_cannot_reverse_a_mature_manual_entry_booking():
    """A taxiing follower keeps its later slot; it is not an earlier arrival."""
    e = engine()
    try:
        a, b, f, g, first, second = pair(e)
        a.external = {'since_s': e.time_s, 'flight_id': f['flight_id'],
                      'departed': False, 'violations': [], 'departure_pending': True}
        assert e._meter_arrival_entry(a, f, first, e.time_s)
        own = dict(e._entry_forecasts[f['flight_id']])
        assert not e._meter_arrival_entry(b, g, second, e.time_s)
        later = e._entry_forecasts[g['flight_id']]
        assert later['entry_s'] > own['entry_s']

        # It has started its metered ground leg at another origin, but has not
        # taken off and does not gain permission to displace the first slot.
        b.flight, b.route, b.phase, b.index = g, second, 'gate_out', 0
        assert e._meter_arrival_entry(a, f, first, own['departure_s'] + .1)
        assert e._entry_forecasts[f['flight_id']] == own

        # Once physically airborne, observation is authoritative and the
        # existing traffic branch may delay the still-grounded manual flight.
        b.phase = 'cruise'
        e._meter_arrival_entry(a, f, first, own['departure_s'] + .2)
    finally:
        e.close()


def test_turning_the_priority_off_puts_the_pilot_back_in_the_queue():
    e = engine()
    try:
        a, b, f, g, first, second = pair(e)
        e.psu.tuning.manual_arrival_priority = False
        e._meter_arrival_entry(a, f, first, e.time_s)
        ordinary = e._preview_arrival_entry(b, g, second, e.time_s)['entry_s']
        b.external = {'since_s': e.time_s, 'flight_id': g['flight_id'],
                      'departed': False, 'violations': []}
        assert e._preview_arrival_entry(b, g, second, e.time_s)['entry_s'] == ordinary
    finally:
        e.close()
