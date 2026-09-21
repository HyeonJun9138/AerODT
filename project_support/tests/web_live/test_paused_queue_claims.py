"""Stopped returners protect their stop, not an unflown common merge leg."""
from copy import deepcopy
from types import SimpleNamespace

import pytest

from digital_twin.simulation.holding_queue import HoldingQueue, relative


def magok_pair():
    # Observed VP015 geometry at 06:55:54; no operational log dependency.
    rejoin = (37.5872491, 126.8041048, 375.768)
    points = {'A': (37.589223, 126.800974, 495.822),
              'B': (37.586679, 126.804354, 496.436)}
    bays = {'A': (37.589980, 126.799894, 495.768),
            'B': (37.582561, 126.806166, 495.768)}
    q = HoldingQueue()
    for owner, point in points.items():
        q.reservations[owner] = dict(owner=owner, state='returning', target=bays[owner],
            rejoin=rejoin, movement_target=rejoin, return_hold=point)
    observations = [dict(owner=k, position=v, velocity=(0, 0, 0)) for k, v in points.items()]
    return q, observations, rejoin


@pytest.mark.parametrize('reverse', [False, True])
def test_two_paused_returns_at_common_entry_do_not_mutually_lock(reverse):
    q, observations, rejoin = magok_pair()
    before = deepcopy(q.reservations)
    if reverse:
        observations.reverse()
    clear = {o['owner']: q.transfer_clear(o['owner'], o['position'], rejoin,
        observations, 120, 45, 35) for o in observations}
    assert clear == {'A': False, 'B': True}
    assert q.reservations == before, 'preview must not grant or move an aircraft'
    # The physically nearer return has priority, not whichever is iterated first.
    q.reservations['B'].pop('return_hold')
    a = next(o for o in observations if o['owner']=='A')
    assert not q.transfer_clear('A', a['position'], rejoin, observations, 120, 45, 35)


def test_a_paused_returner_still_protects_its_observed_body_and_stop_target():
    q, observations, rejoin = magok_pair()
    b = observations[1]
    start = (b['position'][0] - .003, b['position'][1], b['position'][2])
    end = (b['position'][0] + .003, b['position'][1], b['position'][2])
    assert not q.transfer_clear('follower', start, end, observations, 120, 45, 35)
    # An overshooting aircraft must also reserve its commanded stopping point.
    b['position'] = (b['position'][0], b['position'][1] + .004, b['position'][2])
    assert not q.transfer_clear('follower', start, end, observations, 120, 45, 35)


def test_pause_does_not_hide_residual_velocity_before_the_aircraft_stops():
    q, observations, rejoin = magok_pair()
    a, b = observations
    delta = relative(a['position'], rejoin)
    a['velocity'] = tuple(v / 25 for v in delta)
    assert not q.transfer_clear('B', b['position'], rejoin, observations, 120, 45, 35)


def test_unpaused_return_keeps_its_moving_path_even_when_observed_speed_is_zero():
    q, observations, rejoin = magok_pair()
    q.reservations['A'].pop('return_hold')
    b = observations[1]
    assert not q.transfer_clear('B', b['position'], rejoin, observations, 120, 45, 35)


def test_unknown_traffic_and_reserved_bays_are_not_ignored():
    q, observations, rejoin = magok_pair()
    b = observations[1]
    observations.append(dict(owner='external', position=rejoin, velocity=(0, 0, 0)))
    assert not q.transfer_clear('B', b['position'], rejoin, observations, 120, 45, 35)
    observations.pop()
    q.reservations['occupied'] = dict(state='holding', target=rejoin)
    assert not q.transfer_clear('B', b['position'], rejoin, observations, 120, 45, 35)


@pytest.mark.parametrize('order', ['AB', 'BA'])
def test_engine_keeps_nearer_return_priority_in_both_iteration_orders(order):
    from test_scenario_engine import engine_of, row
    e = engine_of(row('A', 'A', 'VP1', 'VP2', '06:30:00'),
                  row('B', 'B', 'VP1', 'VP2', '06:30:00', stand='G3', arrival_stand='G4'))
    q, observations, rejoin = magok_pair()
    e.psu.waiting = q
    try:
        for o in observations:
            a = e.aircraft[o['owner']]
            a.flight = e.flights[o['owner']]
            a.route = e.route(a.flight)
            a.index, a.phase = a.route.descent_index, 'hold'
            a.latitude, a.longitude, a.altitude = o['position']
            a.speed_mps = a.climb_mps = 0
            a.telemetry = {'north_mps': 0, 'east_mps': 0}
            a.clearance = SimpleNamespace(approach_started_s=e.time_s-60,
                                          sequence=1, holding_assignment=None)
            q.reservations[o['owner']].update(slot=o['owner'], move_start=o['position'],
                                              assigned_s=e.time_s-120, port='VP2')
        for key in order:
            a = e.aircraft[key]
            clear = e._queue_return_clear(a)
            assert clear == (key=='B')
            target = rejoin if clear else (a.latitude, a.longitude, a.altitude)
            assert e._queue_instruction(a, not clear, e.time_s, .2, pause_return=not clear) == (True, target)
            assert q.reservations[key]['movement_target'] == target
        assert 'return_hold' not in q.reservations['B']
        assert not e._queue_return_clear(e.aircraft['A'])
        assert e._queue_return_clear(e.aircraft['B']), 'priority must survive the next tick'
    finally:
        e.close()


def test_new_uncommitted_arrival_cannot_take_a_paused_returners_merge():
    q, observations, rejoin = magok_pair()
    q.reservations['B']['state'] = 'holding'
    b = observations[1]
    assert not q.transfer_clear('B', b['position'], rejoin, observations, 120, 45, 35)


def test_hypothetical_detour_origin_cannot_reverse_observed_merge_priority():
    q, observations, rejoin = magok_pair()
    from digital_twin.simulation.holding_queue import paused_return_yields
    a, b = observations
    assert not paused_return_yields(q.reservations['A'], a, q.reservations['B'], b, 120, 45)
    assert not q.transfer_clear('A', rejoin, rejoin, observations, 120, 45, 35)


def test_braking_or_unsettled_return_keeps_future_merge_until_observed_stopped():
    q, observations, rejoin = magok_pair()
    from digital_twin.simulation.holding_queue import paused_return_yields
    a, b = observations
    assert paused_return_yields(q.reservations['B'], b, q.reservations['A'], a, 120, 45)
    a['velocity'] = (2, 0, 0)
    assert not paused_return_yields(q.reservations['B'], b, q.reservations['A'], a, 120, 45)
    a['velocity'] = (0, 0, 0)
    q.reservations['A']['return_hold'] = rejoin
    assert not paused_return_yields(q.reservations['B'], b, q.reservations['A'], a, 120, 45)
