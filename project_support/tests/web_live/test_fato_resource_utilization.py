"""Free pads must stay usable without dropping physical separation or route ownership."""
from copy import deepcopy
from types import SimpleNamespace

import pytest

from digital_twin.simulation import psu_sequencing as psu
from project_support.tests.web_live.test_fato_assignment import multi_engine


@pytest.fixture
def engine():
    e, _ = multi_engine()
    yield e
    e.pilots = None
    e.close()


def book_departure(e):
    e.pilots = SimpleNamespace()
    original = e.flights['F1']
    flight, route = e._select_fatos(original, e.time_s)
    assert e._meter_arrival_entry(e.aircraft['A1'], flight, route, e.time_s)
    # Another movement claims this pad while our aircraft is still on stand.
    e._active_pads[('VP1', flight['departure_fato'])] = 'other'
    return original, flight, route


def test_unstarted_booking_can_use_another_free_departure_pad_without_losing_arrival_order(engine):
    original, before, route = book_departure(engine)
    snapshot = deepcopy(engine._entry_forecasts)
    pose = (engine.aircraft['A1'].latitude, engine.aircraft['A1'].longitude)
    selected, alternate = engine._select_fatos(original, engine.time_s + 1)
    assert selected['departure_fato'] != before['departure_fato']
    assert selected['arrival_fato'] == before['arrival_fato']
    assert not engine._departure_blockers(selected, alternate)
    assert engine._entry_forecasts == snapshot
    assert engine.flights['F1'] == original
    assert pose == (engine.aircraft['A1'].latitude, engine.aircraft['A1'].longitude)
    assert engine.aircraft['A1'].flight is None
    assert engine._assigned_plans['F1'] == (selected, alternate)


def test_departure_clearance_freezes_the_pad_even_if_another_pad_is_empty(engine):
    original, before, route = book_departure(engine)
    engine.psu.request_departure(flight_id='F1', vertiport='VP1', fato=before['departure_fato'],
        earliest_s=engine.time_s, now_s=engine.time_s)
    assert engine._select_fatos(original, engine.time_s + 1) == (before, route)


def test_all_blocked_pads_do_not_churn_the_booking(engine):
    original, before, route = book_departure(engine)
    for i in range(1, 5):
        engine._active_pads[('VP1', f'F{i}')] = 'other'
    assert engine._select_fatos(original, engine.time_s + 1) == (before, route)


def test_empty_alternate_pad_cannot_bypass_a_shared_departure_merge(engine):
    original, before, route = book_departure(engine)
    engine._terminal.assume_distinct_fatos_separated = True
    engine._terminal.enabled = False
    engine._terminal.acquire(dict(before, flight_id='other'), route, 'departure')
    assert engine._select_fatos(original, engine.time_s + 1) == (before, route)
    engine._terminal.release('other', 'departure')
    assert engine._select_fatos(original, engine.time_s + 2)[0]['departure_fato'] != before['departure_fato']


def returning(e):
    a = e.aircraft['A1']; a.flight = e.flights['F1']; a.route = e.route(a.flight)
    assert e._prepare_waiting_route(a, e.time_s)
    r = e.psu.waiting.reservations['F1']
    r.update(state='returning', movement_target=r['rejoin'])
    a.index = a.route.descent_index
    a.latitude, a.longitude, a.altitude = tuple((x+y)/2 for x,y in zip(r['target'], r['rejoin']))
    a.phase = 'hold'; a.speed_mps = 8; a.climb_mps = 0
    a.clearance = SimpleNamespace(sequence=1, approach_started_s=e.time_s-30, holding_assignment=None)
    return a, r


def test_transient_crossing_pauses_return_instead_of_sending_aircraft_back_to_bay(engine):
    a, r = returning(engine)
    position = (a.latitude, a.longitude, a.altitude)
    engine._queue_transfer_clear = lambda *args, **kwargs: False
    queued, target = engine._queue_instruction(a, True, engine.time_s, .1,
        hold_reason='주변 교통 분리 대기', pause_return=True)
    assert queued and target == position
    assert r['state'] == 'returning'
    assert r['movement_target'] == position, 'protect the commanded stop, not an unflown merge'
    assert a.clearance.approach_started_s is not None
    a.latitude += 1/111320
    assert engine._queue_instruction(a, True, engine.time_s+1, .1, pause_return=True)[1] == position
    engine._queue_transfer_clear = lambda *args, **kwargs: True
    # Released, the approach starts where the aircraft is: no return to the
    # entry, and no return to the bay it has already left.
    assert engine._queue_instruction(a, False, engine.time_s+2, .1)[1] == (a.latitude, a.longitude, a.altitude)
    assert 'return_hold' not in r


def test_paused_return_still_blocks_a_crossing_follower(engine):
    a, r = returning(engine)
    position = (a.latitude, a.longitude, a.altitude)
    engine._queue_instruction(a, True, engine.time_s, .1, pause_return=True)
    start = (position[0]-.003, position[1], position[2])
    end = (position[0]+.003, position[1], position[2])
    assert not engine.psu.waiting.transfer_clear('follower', start, end,
        [dict(owner='F1', position=position, velocity=(0,0,0))], 120, 45, 35)


def test_resource_loss_can_still_return_to_the_reserved_bay(engine):
    a, r = returning(engine)
    engine._queue_transfer_clear = lambda *args, **kwargs: True
    queued, target = engine._queue_instruction(a, True, engine.time_s, .1, hold_reason='주기장 확보 대기')
    assert queued and target == r['target'] and r['state'] == 'moving'


# Handed back where it is: a little above the leg is the pilot's to fly, a
# winged speed is not (it is slowed first), and a final-gate bay still returns.
@pytest.mark.parametrize('final_gate,speed,altitude,released', [
    (False,8,0,True), (False,20,0,False), (False,8,10,True), (True,8,0,False)])
def test_intermediate_rejoin_hands_back_to_native_guidance_without_precision_stop(engine, final_gate, speed, altitude, released):
    a, r = returning(engine)
    r['final_gate'] = final_gate
    a.latitude, a.longitude, a.altitude = r['rejoin']
    a.latitude += 12/111320; a.altitude += altitude; a.speed_mps = speed
    a.telemetry = {'tilt_deg': 0}
    pose = (a.latitude, a.longitude, a.altitude)
    route = a.route; index = a.index
    queued, target = engine._queue_instruction(a, False, engine.time_s, .1)
    assert (not queued) == released
    assert (a.latitude, a.longitude, a.altitude) == pose
    assert a.route is route and a.index == index, 'only native guidance may advance the waypoint'
    assert ('F1' not in engine.psu.waiting.reservations) == released
