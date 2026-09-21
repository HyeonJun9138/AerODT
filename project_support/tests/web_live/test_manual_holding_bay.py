"""Where a hand-flown aircraft waits, when the service tells it to wait.

An automatic arrival that has to wait is sent to a named bay off the approach
entry, and that bay is reserved so nobody else is sent to it. A pilot flying by
hand used to get a number and nothing else -- "hold 4475 seconds" over open sky,
with no place to be. The bays are laid out around the arrival's approach entry,
which a hand-flown aircraft has in its own plan, so there is one to give.
"""
import pytest

from digital_twin.simulation import manual_procedure, manual_takeover, psu_sequencing
from project_support.tests.web_live.test_scenario_engine import engine_of, row


def flying(engine, aircraft_id='A1'):
    """Hand the aircraft over, get it away and put it in the air."""
    manual_takeover.hand_over(engine, aircraft_id)
    manual_takeover.request(engine, aircraft_id, 'departure')
    manual_takeover.request(engine, aircraft_id, 'takeoff')
    aircraft = engine.aircraft[aircraft_id]
    manual_takeover.place(engine, aircraft_id, latitude=37.53, longitude=126.93,
                          altitude=240.0, heading=180.0, step=1.0, airborne=True, speed_mps=42.0)
    # The service does not talk about landing until it has been told this one
    # got off the ground.
    manual_takeover.request(engine, aircraft_id, 'report_airborne')
    return aircraft


def busy_pad(engine, aircraft, minutes=20):
    """Book the arrival pad, so this aircraft is held.

    Under the policy's maximum hold: past it the service refuses instead, which
    is a different answer and not the one being tested here.
    """
    flight = aircraft.flight
    pad = engine.psu.pad(flight['destination'], flight['arrival_fato'])
    for step in range(int(minutes * 60 / 90)):
        pad.hold(engine.time_s + step * 90, 90.0, f'OTHER{step}', psu_sequencing.ARRIVAL)


def test_a_pilot_told_to_wait_is_told_where():
    engine = engine_of(row('F1', 'A1', 'VP1', 'VP2', '06:30:00'))
    aircraft = flying(engine)
    busy_pad(engine, aircraft)

    answer = manual_takeover.request_hold(engine, 'A1')
    assert answer['state'] == 'holding'
    assert answer['reason'].startswith('지정 대기점 배정')
    bay = answer['hold']
    assert bay and bay['slot'], '순번만이 아니라 자리가 나와야 한다'
    # A place is coordinates, not a name: the pilot has to fly to it.
    latitude, longitude, altitude = bay['fix']
    assert -90 <= latitude <= 90 and -180 <= longitude <= 180 and altitude > 0
    # And where to go back to once the slot comes round.
    assert len(bay['rejoin']) == 3
    assert bay['manual'] is True


def test_the_bay_is_reserved_so_nobody_else_is_sent_to_it():
    engine = engine_of(row('F1', 'A1', 'VP1', 'VP2', '06:30:00'))
    aircraft = flying(engine)
    busy_pad(engine, aircraft)
    manual_takeover.request_hold(engine, 'A1')
    mine = engine.aircraft['A1'].hold
    assert mine and mine['slot']

    # The reservation is the service's, held under this flight's name, and it
    # is the same list the automatic arrivals draw from.
    owner = aircraft.flight['flight_id']
    assert engine.psu.waiting.reservations[owner]['slot'] == mine['slot']

    # Anyone else asking the queue for a place gets a different one, because
    # this one is taken -- which is the whole point of reserving it.
    policy = engine.policy['pilot']
    theirs = engine.psu.waiting.reserve(
        'SOMEONE-ELSE', aircraft.flight['destination'], engine._queue_candidates(aircraft),
        mine['rejoin'], engine.time_s, policy['traffic_horizontal_m'],
        policy['traffic_vertical_m'], lambda point: True)
    assert theirs is None or theirs['slot'] != mine['slot'], '같은 자리에 두 대를 보내지 않는다'
    assert theirs is None or theirs['target'] != mine['fix']


def test_the_place_arrives_without_anyone_pressing_for_it():
    engine = engine_of(row('F1', 'A1', 'VP1', 'VP2', '06:30:00'))
    aircraft = flying(engine)
    busy_pad(engine, aircraft)
    # Being held is the moment the place is needed, so reading the advisory --
    # which is what the cockpit does every second -- is enough to have one.
    manual_takeover.request(engine, 'A1', 'arrival')
    advice = manual_takeover.advisory(engine, 'A1')
    assert advice['hold'] and advice['hold']['slot'], '누르지 않아도 자리가 나온다'
    assert advice['arrival']['state'] == psu_sequencing.HOLDING


def test_the_cockpit_line_says_the_place_not_only_the_wait():
    engine = engine_of(row('F1', 'A1', 'VP1', 'VP2', '06:30:00'))
    aircraft = flying(engine)
    busy_pad(engine, aircraft)
    manual_takeover.request(engine, 'A1', 'arrival')
    manual_takeover.advisory(engine, 'A1')
    guidance = manual_procedure.guidance(engine, aircraft, aircraft.flight, engine.time_s)
    assert '대기점에서 대기' in guidance['text'], guidance['text']
    assert guidance['reason'] and '착륙 슬롯까지' not in guidance['reason']
    assert guidance['next']['kind']=='approach' and not guidance['next']['enabled']


def test_an_aircraft_still_on_the_ground_is_not_given_a_bay_in_the_sky():
    engine = engine_of(row('F1', 'A1', 'VP1', 'VP2', '06:30:00'))
    manual_takeover.hand_over(engine, 'A1')
    manual_takeover.request(engine, 'A1', 'departure')
    aircraft = engine.aircraft['A1']
    assert aircraft.airborne is False
    advice = manual_takeover.advisory(engine, 'A1')
    assert advice['hold'] is None, '지상에 있는 기체에게 체공 대기점을 주지 않는다'


@pytest.mark.parametrize('twice', [1, 2])
def test_asking_again_keeps_the_same_place(twice):
    engine = engine_of(row('F1', 'A1', 'VP1', 'VP2', '06:30:00'))
    aircraft = flying(engine)
    busy_pad(engine, aircraft)
    slots = set()
    for _ in range(twice + 1):
        manual_takeover.request_hold(engine, 'A1')
        slots.add(engine.aircraft['A1'].hold['slot'])
    assert len(slots) == 1, '물어볼 때마다 자리가 바뀌지 않는다'
