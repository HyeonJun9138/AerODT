"""Ground-authority safety contracts, using independent motion sampling."""
from dataclasses import FrozenInstanceError, replace
import math
import sys

import pytest

from digital_twin.contracts.ground_operations import GroundObservation, GroundRequest
from user_application.uam_mission.ground_control import VertiportGroundControl


def request(name, path=((0., 0.), (100., 0.)), **changes):
    values = dict(aircraft_id=name, flight_id='F'+name, vertiport_id='V', route_id='R'+name,
                  path_m=tuple(path), distance_m=0., speed_mps=0., max_speed_mps=4.,
                  radius_m=7., requested_s=0.)
    values.update(changes)
    return GroundRequest(**values)


def point_at(req, distance=None):
    """Independent test interpolation; does not import production geometry."""
    remaining = req.distance_m if distance is None else distance
    for a, b in zip(req.path_m, req.path_m[1:]):
        length = math.dist(a, b)
        if remaining <= length and length:
            return tuple(a[k]+(b[k]-a[k])*remaining/length for k in (0, 1))
        remaining -= length
    return req.path_m[-1]


def observations(requests):
    return [GroundObservation(r.aircraft_id, r.vertiport_id, point_at(r), r.radius_m) for r in requests]


def test_parked_aircraft_keeps_the_crossing_closed_without_expiration():
    control = VertiportGroundControl()
    a = request('A')
    parked = GroundObservation('B', 'V', (50., 0.))
    for now in (0., 600., 1e9):
        grant = control.authorize([a], [parked], now)['A']
        assert 0 <= grant.stop_distance_m < 36
        assert grant.blocked_by == ('B',)
        assert grant.reason
    assert control.authorize([a], [], 1e9+1)['A'].stop_distance_m == 100


@pytest.mark.parametrize('paths', [
    (((-50., 0.), (0., 0.), (50., 0.)), ((0., -50.), (0., 0.), (0., 50.))),
    (((-50., 0.), (50., 0.)), ((0., -50.), (0., 50.))),
])
def test_geometric_and_shared_node_crossings_wait_outside_winner_entire_route(paths):
    requests = [request('A', paths[0]), request('B', paths[1])]
    result = VertiportGroundControl().authorize(requests, observations(requests), 0)
    assert result['A'].stop_distance_m == 100
    assert 0 < result['B'].stop_distance_m < 36
    assert result['B'].blocked_by == ('A',)
    wait = point_at(requests[1], result['B'].stop_distance_m)
    assert math.dist(wait, (0., 0.)) > 14


def test_opposing_path_does_not_manufacture_egress_or_move_into_deadlock():
    requests = [request('A'), request('B', ((100., 0.), (0., 0.)))]
    result = VertiportGroundControl().authorize(requests, observations(requests), 0)
    assert all(r.stop_distance_m == 0 for r in result.values())
    assert all(r.reason for r in result.values())


def test_blocked_exit_keeps_winner_before_crossing_instead_of_stopping_inside():
    a = request('A', ((-50., 0.), (50., 0.)))
    b = request('B', ((0., -50.), (0., 50.)))
    parked = GroundObservation('P', 'V', (20., 0.))
    result = VertiportGroundControl().authorize([a, b], observations([a, b])+[parked], 0)
    assert result['A'].stop_distance_m < 36
    assert result['B'].stop_distance_m == 100


def test_claim_is_released_only_after_observed_progress_not_elapsed_time():
    control = VertiportGroundControl()
    a = request('A', ((-50., 0.), (50., 0.)))
    b = request('B', ((0., -50.), (0., 50.)))
    first = control.authorize([a, b], observations([a, b]), 0)
    stopped_b = replace(b, distance_m=first['B'].stop_distance_m)
    a = replace(a, distance_m=10.)  # The owner has actually used its claim.
    waiting = control.authorize([a, stopped_b], observations([a, stopped_b]), 10000)
    assert waiting['B'].stop_distance_m == pytest.approx(stopped_b.distance_m)
    passed_a = replace(a, distance_m=80.)
    released = control.authorize([passed_a, stopped_b], observations([passed_a, stopped_b]), 10001)
    assert released['B'].stop_distance_m == 100


def test_missing_claim_owner_does_not_imply_vacant_corridor():
    control = VertiportGroundControl()
    a = request('A', ((-50., 0.), (50., 0.)))
    b = request('B', ((0., -50.), (0., 50.)))
    control.authorize([a, b], observations([a, b]), 0)
    result = control.authorize([b], observations([b]), 100000)
    assert result['B'].stop_distance_m < 36
    control.reset()
    assert control.authorize([b], observations([b]), 100001)['B'].stop_distance_m == 100


def test_unrelated_routes_and_ports_are_parallel():
    requests = [request('A'), request('B', ((0., 40.), (100., 40.))),
                request('C', vertiport_id='OTHER')]
    result = VertiportGroundControl().authorize(requests, observations(requests), 0)
    assert all(r.stop_distance_m == 100 for r in result.values())


def test_arrival_priority_aging_and_order_invariance():
    a = request('A', ((-50., 0.), (50., 0.)))
    b = request('B', ((0., -50.), (0., 50.)), arrival=True)
    for batch in ([a, b], [b, a]):
        result = VertiportGroundControl().authorize(batch, list(reversed(observations(batch))), 0)
        assert result['B'].stop_distance_m == 100
        assert result['A'].stop_distance_m < 36
    old = replace(a, requested_s=-600.)
    result = VertiportGroundControl().authorize([b, old], observations([b, old]), 0)
    assert result['A'].stop_distance_m == 100
    assert result['B'].stop_distance_m < 36


def test_entered_winner_keeps_priority_over_new_arrival():
    control = VertiportGroundControl()
    a = request('Z', ((-50., 0.), (50., 0.)))
    control.authorize([a], observations([a]), 0)
    a = replace(a, distance_m=10.)
    b = request('A', ((0., -50.), (0., 50.)), arrival=True, requested_s=1.)
    result = control.authorize([b, a], observations([b, a]), 1)
    assert result['Z'].stop_distance_m == 100
    assert result['A'].stop_distance_m < 36


def test_overlapping_initial_placement_is_reported_without_motion():
    requests = [request('A'), request('B', ((10., 0.), (10., 100.)))]
    result = VertiportGroundControl().authorize(requests, observations(requests), 0)
    assert all(r.stop_distance_m == 0 and r.speed_limit_mps == 0 for r in result.values())
    assert all(r.reason for r in result.values())


def test_same_direction_follower_makes_progress_after_leader_clears():
    control = VertiportGroundControl()
    leader = request('A', distance_m=30.)
    follower = request('B')
    result = control.authorize([leader, follower], observations([leader, follower]), 0)
    assert result['A'].stop_distance_m == 100
    assert 0 < result['B'].stop_distance_m < 16
    leader = replace(leader, distance_m=60.)
    result = control.authorize([leader, follower], observations([leader, follower]), 1)
    assert 30 < result['B'].stop_distance_m < 46


def test_independently_sampled_stepped_crossing_has_no_swept_overlap_and_completes():
    control = VertiportGroundControl()
    requests = [request('A', ((-50., 0.), (50., 0.))),
                request('B', ((0., -50.), (0., 50.)))]
    for tick in range(150):
        batch = requests if tick % 2 else list(reversed(requests))
        result = control.authorize(batch, observations(batch), tick*.5)
        next_requests = [replace(r, distance_m=min(r.distance_m+2, result[r.aircraft_id].stop_distance_m))
                         for r in requests]
        for i in range(21):
            points = [point_at(r, r.distance_m+(n.distance_m-r.distance_m)*i/20)
                      for r, n in zip(requests, next_requests)]
            assert math.dist(*points) >= 14, (tick, points)
        assert all(n.distance_m >= r.distance_m for r, n in zip(requests, next_requests))
        requests = next_requests
    assert [r.distance_m for r in requests] == [100., 100.]


@pytest.mark.parametrize('changes', [dict(radius_m=0.), dict(radius_m=float('nan')),
    dict(distance_m=-1.), dict(distance_m=101.), dict(speed_mps=-1.),
    dict(max_speed_mps=float('inf')), dict(requested_s=float('nan')),
    dict(path_m=()), dict(path_m=((0., 0.), (float('nan'), 1.)))])
def test_invalid_request_cannot_create_authority(changes):
    with pytest.raises(ValueError):
        r = request('A', **changes)
        VertiportGroundControl().authorize([r], [], 0)


def test_invalid_observation_and_duplicate_request_are_rejected():
    with pytest.raises(ValueError):
        GroundObservation('A', 'V', (0., float('inf')))
    r = request('A')
    with pytest.raises(ValueError):
        VertiportGroundControl().authorize([r, r], [], 0)
    with pytest.raises(ValueError):
        VertiportGroundControl().authorize([r], [], float('nan'))


def test_inputs_are_immutable_and_authority_is_route_bound():
    path = [[0., 0.], [100., 0.]]
    r = request('A', path)
    path[0][0] = 99.
    assert r.path_m[0] == (0., 0.)
    with pytest.raises(FrozenInstanceError):
        r.distance_m = 10.
    grant = VertiportGroundControl().authorize([r], [], 0)['A']
    assert grant.route_id == r.route_id and grant.speed_limit_mps == 4.


def test_larger_request_footprint_cannot_be_hidden_by_smaller_observation():
    a = request('A')
    b = request('B', ((50., 0.), (50., 100.)), radius_m=12.)
    result = VertiportGroundControl().authorize([a, b], [
        GroundObservation('A', 'V', (0., 0.), 7.),
        GroundObservation('B', 'V', (50., 0.), 7.),
    ], 0)
    assert result['A'].stop_distance_m < 31.


def test_unused_claim_can_yield_to_arrival_without_forgetting_actual_obstacle():
    control = VertiportGroundControl()
    a = request('A', ((-50., 0.), (50., 0.)))
    control.authorize([a], observations([a]), 0)
    b = request('B', ((0., -50.), (0., 50.)), arrival=True, requested_s=1.)
    result = control.authorize([a, b], observations([a, b]), 1)
    assert result['B'].stop_distance_m == 100.
    assert result['A'].stop_distance_m < 36.


def test_release_is_route_scoped_and_never_removes_observed_obstacle():
    control = VertiportGroundControl()
    a = request('A', ((-50., 0.), (50., 0.)))
    b = request('B', ((0., -50.), (0., 50.)))
    control.authorize([a], observations([a]), 0)
    control.release('A', 'different_route')
    assert control.authorize([b], observations([b]), 1)['B'].stop_distance_m < 36
    control.release('A', a.route_id)
    parked = GroundObservation('A', 'V', (0., 0.))
    assert control.authorize([b], observations([b])+[parked], 2)['B'].stop_distance_m < 36
    assert control.authorize([b], observations([b]), 3)['B'].stop_distance_m == 100


def test_route_replacement_requires_explicit_release_and_new_route_binding():
    control = VertiportGroundControl()
    a = request('A')
    control.authorize([a], observations([a]), 0)
    replacement = replace(a, route_id='v2', path_m=((0., 0.), (0., 100.)))
    with pytest.raises(ValueError):
        control.authorize([replacement], observations([replacement]), 1)
    control.release('A', a.route_id)
    result = control.authorize([replacement], observations([replacement]), 1)['A']
    assert result.route_id == 'v2' and result.stop_distance_m == 100.


def test_paused_same_time_and_bad_batch_cannot_change_decision():
    control = VertiportGroundControl()
    requests = [request('A', ((-50., 0.), (50., 0.))),
                request('B', ((0., -50.), (0., 50.)))]
    first = control.authorize(requests, observations(requests), 0)
    bad = [GroundObservation('A', 'V', (1000., 1000.))]
    with pytest.raises(ValueError):
        control.authorize(requests, bad, 0)
    assert control.authorize(reversed(requests), observations(requests), 0) == first


def test_reversed_progress_cannot_discard_already_occupied_claim_space():
    control = VertiportGroundControl()
    a = request('A', distance_m=20.)
    control.authorize([a], observations([a]), 0)
    earlier = replace(a, distance_m=10.)
    with pytest.raises(ValueError):
        control.authorize([earlier], observations([earlier]), 1)


@pytest.mark.parametrize('paths', [
    (((-80., 0.), (0., 0.), (80., 0.)), ((0., -80.), (0., 0.), (80., 0.))),
    (((-60., -30.), (-20., 10.), (20., 10.), (60., -30.)), ((0., -80.), (0., 80.))),
    (((-80., 0.), (80., 0.)), ((80., 50.), (0., 50.), (0., -50.), (-80., -50.))),
])
def test_independent_polyline_motion_sampling_checks_merge_and_curved_sweeps(paths):
    control = VertiportGroundControl()
    requests = [request('A', paths[0]), request('B', paths[1])]
    lengths = [sum(math.dist(a, b) for a, b in zip(path, path[1:])) for path in paths]
    for tick in range(350):
        # Completed aircraft leave only at the test's explicit lifecycle boundary.
        active = [r for r, length in zip(requests, lengths) if r.distance_m < length-1e-7]
        result = control.authorize(active, observations(active), tick*.5)
        moved = []
        for r, length in zip(requests, lengths):
            distance = min(r.distance_m+2., result[r.aircraft_id].stop_distance_m) if r in active else length
            moved.append(replace(r, distance_m=distance))
        for i in range(41):
            pts = [point_at(r, r.distance_m+(n.distance_m-r.distance_m)*i/40)
                   for r, n in zip(requests, moved) if r in active]
            if len(pts) > 1:
                assert math.dist(*pts) >= 14., (tick, pts)
        for r, n, length in zip(requests, moved, lengths):
            if r.distance_m < length-1e-7 <= n.distance_m:
                control.release(n.aircraft_id, n.route_id)
        requests = moved
    assert [r.distance_m for r in requests] == pytest.approx(lengths)


def test_denied_request_owner_missing_later_does_not_vacate_its_hold_point():
    control = VertiportGroundControl()
    a = request('A')
    overlapping = GroundObservation('P', 'V', (10., 0.))
    assert control.authorize([a], observations([a])+[overlapping], 0)['A'].stop_distance_m == 0
    crossing = request('C', ((0., -50.), (0., 50.)))
    result = control.authorize([crossing], observations([crossing]), 600)['C']
    assert result.stop_distance_m < 36.
    assert result.blocked_by == ('A',)


def test_four_crossing_routes_remain_separated_through_independent_substeps():
    control = VertiportGroundControl()
    requests = []
    for i, angle in enumerate((0., math.pi/4, math.pi/2, 3*math.pi/4)):
        start = (-80*math.cos(angle), -80*math.sin(angle))
        end = (80*math.cos(angle), 80*math.sin(angle))
        requests.append(request(chr(65+i), (start, end)))
    for tick in range(240):
        result = control.authorize(requests[tick%4:]+requests[:tick%4], observations(requests), tick*.5)
        moved = [replace(r, distance_m=min(r.distance_m+2., result[r.aircraft_id].stop_distance_m))
                 for r in requests]
        for substep in range(11):
            points = [point_at(r, r.distance_m+(n.distance_m-r.distance_m)*substep/10)
                      for r, n in zip(requests, moved)]
            for i, a in enumerate(points):
                assert all(math.dist(a, b) >= 14. for b in points[i+1:])
        requests = moved
    assert [r.distance_m for r in requests] == pytest.approx([160.]*4)


def test_cached_capsule_geometry_clips_route_progress_with_upper_clearance():
    from digital_twin.model_library.ground_routes import route_geometry
    horizontal = route_geometry(((-20., 0.), (20., 0.)))
    vertical = route_geometry(((0., -20.), (0., 0.), (0., 20.)))
    assert horizontal.occupied_intervals(vertical, 5., other_start_m=16.)[0] == pytest.approx((14.999, 25.001))
    assert horizontal.occupied_intervals(vertical, 5., other_start_m=30.) == ()
    assert horizontal.occupied_intervals(vertical, 5., other_end_m=15.)[0] == pytest.approx((20.-math.sqrt(5.001**2-25.), 20.+math.sqrt(5.001**2-25.)))
    assert horizontal.occupied_intervals(vertical, 5., other_start_m=20., other_end_m=20.)[0] == pytest.approx((14.999, 25.001))
    result = horizontal.occupied_intervals(vertical, 10., other_start_m=27.)
    assert result[0] == pytest.approx((20.-math.sqrt(10.001**2-49.), 20.+math.sqrt(10.001**2-49.)))

@pytest.mark.parametrize('winner_progress', [49.5, 49.66, 49.9])
def test_clearance_margin_does_not_creep_forward_before_winner_crosses(winner_progress):
    control = VertiportGroundControl()
    a = request('A', tuple((float(i), 0.) for i in range(-50, 51, 2)))
    b = request('B', tuple((0., float(i)) for i in range(-50, 51, 2)))
    first = control.authorize([a,b], observations([a,b]), 0)
    a = replace(a, distance_m=winner_progress)
    b = replace(b, distance_m=first['B'].stop_distance_m)
    next_authority = control.authorize([a,b], observations([a,b]), 10)['B']
    assert next_authority.stop_distance_m == pytest.approx(first['B'].stop_distance_m, abs=1e-7)



def test_old_boarding_request_cannot_preempt_aircraft_already_using_crossing():
    from digital_twin.model_library.ground_motion import advance
    control = VertiportGroundControl()
    profile = {'distances_m': [0., 100.], 'speeds_mps': [4., 4.]}
    a = request('A', ((-50., 0.), (50., 0.)), max_speed_mps=0.)
    b = request('B', ((0., -50.), (0., 50.)), requested_s=1., arrival=True)
    control.authorize([a], observations([a]), 0.)
    saw_ready_departure_while_arrival_moving = False
    for tick in range(1, 1001):
        if b.distance_m > 30.:
            a = replace(a, max_speed_mps=4.)
        requests = [a, b]
        result = control.authorize(requests, observations(requests), tick*.1)
        if a.distance_m > 0. and 30. < b.distance_m < 64.:
            saw_ready_departure_while_arrival_moving = True
            assert result['B'].stop_distance_m == 100., 'unused request age must not steal an entered crossing'
        moved = []
        for r in requests:
            grant = result[r.aircraft_id]
            assert grant.stop_distance_m-r.distance_m >= r.speed_mps*r.speed_mps/1.2-1e-6
            distance, speed = advance(profile, r.distance_m, r.speed_mps,
                                      grant.stop_distance_m, grant.speed_limit_mps, .1)
            moved.append(replace(r, distance_m=distance, speed_mps=speed))
        for substep in range(21):
            points = [point_at(r, r.distance_m+(n.distance_m-r.distance_m)*substep/20)
                      for r, n in zip(requests, moved)]
            assert math.dist(*points) >= 14.
        a, b = moved
        if a.distance_m == b.distance_m == 100.:
            break
    assert saw_ready_departure_while_arrival_moving
    assert a.distance_m == b.distance_m == 100.


@pytest.mark.parametrize('registered_radius', [7., 12.])
@pytest.mark.parametrize('observed_offset', [0., -.2])
def test_registered_crossing_keeps_exit_space_for_a_later_request(registered_radius, observed_offset):
    from digital_twin.model_library.ground_motion import advance
    control = VertiportGroundControl()
    a = request('A', ((-50., 0.), (50., 0.)))
    b = request('B', ((0., -50.), (0., 50.)), radius_m=registered_radius)
    parked = GroundObservation('P', 'V', (20., 0.))
    control.configure_routes('V', (a.path_m, b.path_m), radius_m=registered_radius)
    profile = {'distances_m': [0., 100.], 'speeds_mps': [4., 4.]}
    for tick in range(200):
        grant = control.authorize([a], observations([a])+[parked], tick*.1)['A']
        assert grant.stop_distance_m < 36.
        d, v = advance(profile, a.distance_m, a.speed_mps, grant.stop_distance_m, grant.speed_limit_mps, .1)
        a = replace(a, distance_m=d, speed_mps=v)
    # Upper-only static cache padding can move this perpendicular stop at most 2 mm earlier.
    assert 42.738-registered_radius <= a.distance_m <= 42.74-registered_radius
    assert a.speed_mps == 0.
    for tick in range(400):
        requests = [a,b]
        observed = observations([a])+[GroundObservation('B', 'V',
                    (point_at(b)[0]+observed_offset, point_at(b)[1]), registered_radius), parked]
        grants = control.authorize(requests, observed, 20+tick*.1)
        assert grants['B'].stop_distance_m == 100.
        moved = []
        for r in requests:
            grant = grants[r.aircraft_id]
            assert grant.stop_distance_m-r.distance_m >= r.speed_mps*r.speed_mps/1.2-1e-6
            d, v = advance(profile, r.distance_m, r.speed_mps,
                           grant.stop_distance_m, grant.speed_limit_mps, .1)
            moved.append(replace(r, distance_m=d, speed_mps=v))
        for substep in range(21):
            positions = [point_at(r, r.distance_m+(n.distance_m-r.distance_m)*substep/20)
                         for r, n in zip(requests, moved)]
            positions[1] = (positions[1][0]+observed_offset, positions[1][1])
            assert math.dist(*positions) >= 7.+registered_radius
        a, b = moved
        if b.distance_m == 100.:
            break
    assert b.distance_m == 100.


def test_registered_identical_and_reversed_route_do_not_create_self_conflict():
    control = VertiportGroundControl()
    a = request('A', ((-50., 0.), (50., 0.)))
    control.configure_routes('V', (a.path_m, tuple(reversed(a.path_m)), a.path_m))
    result = control.authorize([a], [GroundObservation('P', 'V', (20., 0.))], 0)['A']
    assert result.stop_distance_m == pytest.approx(55.99)
    assert result.blocked_by == ('P',)


def test_registered_shared_corridors_do_not_lock_a_clear_route_or_other_port():
    control = VertiportGroundControl()
    a = request('A', ((-50., 0.), (50., 0.)))
    branches = (a.path_m, ((-50., -50.), (-50., 0.), (50., 0.)),
                ((-50., 50.), (-50., 0.), (50., 0.)), ((0., -50.), (0., 50.)))
    control.configure_routes('V', branches)
    assert control.authorize([a], observations([a]), 0)['A'].stop_distance_m == 100.
    control.reset()
    elsewhere = replace(a, vertiport_id='OTHER')
    control.configure_routes('V', branches)
    assert control.authorize([elsewhere], [GroundObservation('P', 'OTHER', (20., 0.))], 0)['A'].stop_distance_m == pytest.approx(55.99)


def test_registered_layout_is_immutable_validated_and_reset_scoped():
    control = VertiportGroundControl()
    a = request('A', ((-50., 0.), (50., 0.)))
    crossing = [[0., -50.], [0., 50.]]
    control.configure_routes('V', (crossing,))
    crossing[0][0] = 999.
    parked = GroundObservation('P', 'V', (20., 0.))
    assert control.authorize([a], [parked], 0)['A'].stop_distance_m < 36.
    with pytest.raises(ValueError):
        control.configure_routes('V', (a.path_m,))
    control.reset()
    assert control.authorize([a], [parked], 0)['A'].stop_distance_m == pytest.approx(55.99)
    control.reset()
    with pytest.raises(ValueError):
        control.configure_routes('V', (((float('nan'), 0.), (50., 0.)),))


def test_registered_same_centerline_with_different_sampling_is_not_self_conflict():
    control = VertiportGroundControl()
    path = tuple((float(i), 0.) for i in range(-50, 51, 2))
    a = request('A', path)
    control.configure_routes('V', (((50., 0.), (-50., 0.)),))
    result = control.authorize([a], [GroundObservation('P', 'V', (20., 0.))], 0)['A']
    assert result.stop_distance_m == pytest.approx(55.99)


@pytest.mark.parametrize('radius', [0., -1., float('nan'), float('inf')])
def test_registered_maximum_footprint_must_be_finite_and_positive(radius):
    with pytest.raises(ValueError):
        VertiportGroundControl().configure_routes('V', (((0., 0.), (100., 0.)),), radius_m=radius)


def test_request_exceeding_registered_footprint_is_rejected_but_obstacle_is_not_ignored():
    control = VertiportGroundControl()
    a = request('A')
    control.configure_routes('V', (a.path_m,), radius_m=7.)
    with pytest.raises(ValueError):
        control.authorize([replace(a, radius_m=12.)], [], 0.)
    parked = GroundObservation('P', 'V', (50., 0.), 12.)
    assert control.authorize([a], [parked], 0.)['A'].stop_distance_m == pytest.approx(30.99)
    with pytest.raises(ValueError):
        control.configure_routes('V', (a.path_m,), radius_m=12.)
    control.reset()
    control.configure_routes('V', (a.path_m,), radius_m=12.)
    assert control.authorize([replace(a, radius_m=12.)], [], 0.)['A'].stop_distance_m == 100.


def test_active_observation_cannot_bypass_registered_maximum_footprint():
    control = VertiportGroundControl()
    a = request('A')
    control.configure_routes('V', (a.path_m,), radius_m=7.)
    with pytest.raises(ValueError, match='registered'):
        control.authorize([a], [GroundObservation('A', 'V', (0., 0.), 12.)], 0.)
    parked = GroundObservation('P', 'V', (50., 0.), 12.)
    assert control.authorize([a], [parked], 0.)['A'].stop_distance_m == pytest.approx(30.99)


def test_registered_exit_accounts_for_allowed_future_observation_projection_error():
    control = VertiportGroundControl()
    a = request('A', ((-50., 0.), (50., 0.)))
    b = request('B', ((0., -50.), (0., 50.)))
    control.configure_routes('V', (a.path_m, b.path_m), radius_m=7.)
    parked = GroundObservation('P', 'V', (20., 0.))
    stop = control.authorize([a], observations([a])+[parked], 0.)['A'].stop_distance_m
    a = replace(a, distance_m=stop)
    observed = observations([a])+[GroundObservation('B', 'V', (-.2, -50.)), parked]
    result = control.authorize([a,b], observed, 30.)
    assert result['B'].stop_distance_m == 100.
    # Actual displaced centreline, independent of the authority's geometry.
    assert abs(point_at(a)[0]-(-.2)) >= 14.


def test_static_route_cache_reuses_valid_nanometre_projection_jitter():
    from digital_twin.model_library import ground_routes as geometry
    a = geometry.route_geometry(((-50., 0.), (0., 0.), (50., 0.)))
    b = geometry.route_geometry(((0., -50.), (0., 50.)))
    geometry._conflict_cells.cache_clear()
    geometry._static_intervals.cache_clear()
    a.occupied_intervals(b, 14.25)
    misses = geometry._conflict_cells.cache_info().misses
    for offset in (1e-9, 2e-9, 3e-9, 4e-9, 5e-9):
        a.occupied_intervals(b, 14.25+offset)
    assert geometry._conflict_cells.cache_info().misses == misses


def test_static_route_cache_reuses_real_curved_phase_progress_projection():
    from digital_twin.model_library import ground_routes as geometry, ground_motion
    from digital_twin.simulation.scenario_engine import Phase
    points, profile, _, duration = ground_motion.prepare([(37.,127.), (37.0003,127.), (37.0003,127.0004)],4.,0.)
    scale = math.pi*6371000./180
    def xy(point):
        return ((point[0]-37.)*scale,(point[1]-127.)*scale*math.cos(math.radians(37.)))
    phase = Phase('gate_in','test',[(p[0],p[1],30.) for p in points],duration,4.,{'ground_motion':profile})
    route = geometry.route_geometry(tuple(xy(p) for p in points))
    crossing = geometry.route_geometry(((-20.,10.), (60.,10.)))
    geometry._conflict_cells.cache_clear()
    geometry._static_intervals.cache_clear()
    errors = []
    for i in range(101):
        fraction = i/100.
        error = math.dist(xy(phase.at_fraction(fraction)[:2]), route.point_at(route.length_m*fraction))
        errors.append(error)
        route.occupied_intervals(crossing,14.25+error)
    assert max(errors) > 1e-6  # Real projection, not only artificial sub-nanometre noise.
    assert geometry._conflict_cells.cache_info().misses == 1


@pytest.mark.parametrize('radius', [0., 1e-300, 1e-12, 1e-6, .001, .5, 1., 7., 14.25,
    math.nextafter(14.25,0.), math.nextafter(14.25,math.inf), 14.250500001, 1e15, 1e100, sys.float_info.max])
def test_cached_route_clearance_is_finite_and_never_smaller(radius):
    from digital_twin.model_library import ground_routes as geometry
    upper = geometry._route_cache_clearance(radius)
    assert math.isfinite(upper) and upper >= radius
    assert upper-radius <= 2*geometry._CACHE_CLEARANCE_QUANTUM_M+2*math.ulp(radius)


@pytest.mark.parametrize('radius', [-1., float('nan'), float('inf')])
def test_cached_route_clearance_rejects_invalid_values(radius):
    from digital_twin.model_library import ground_routes as geometry
    with pytest.raises(ValueError):
        geometry._route_cache_clearance(radius)


def test_exact_capsule_and_dynamic_point_footprint_do_not_use_cache_padding():
    from digital_twin.model_library import ground_routes as geometry
    assert geometry.capsule_interval((-20.,0.),(20.,0.),(0.,-20.),(0.,20.),5.) == (.375,.625)
    route = geometry.route_geometry(((-20.,0.),(20.,0.)))
    point = geometry.route_geometry(((0.,0.),))
    assert route.occupied_intervals(point,5.) == ((15.,25.),)


def test_cold_conflict_cells_do_not_compute_unused_reverse_projection(monkeypatch):
    from digital_twin.model_library import ground_routes as geometry
    a = geometry.route_geometry(((-20., 0.), (20., 0.)))
    b = geometry.route_geometry(((0., -20.), (0., 20.)))
    geometry._conflict_cells.cache_clear()
    calls = []
    original = geometry.capsule_interval
    def counted(*args):
        calls.append(args)
        return original(*args)
    monkeypatch.setattr(geometry, 'capsule_interval', counted)
    cells = geometry._conflict_cells(a, b, 5.)
    assert tuple(cell[:4] for cell in cells) == ((0, 0, 15., 25.),)
    assert len(calls) == 1  # No consumer needs the reverse arc interval.


def test_static_segment_bounds_are_reused_across_route_pairs(monkeypatch):
    from digital_twin.model_library import ground_routes as geometry
    a = geometry.route_geometry(((-20., 0.), (0., 0.), (20., 0.)))
    b = geometry.route_geometry(((0., -20.), (0., 20.)))
    c = geometry.route_geometry(((5., -20.), (5., 20.)))
    bounds = geometry._bounded_segments(a)
    assert bounds is geometry._bounded_segments(a)
    assert len(bounds) == 2
    geometry._conflict_cells.cache_clear()
    def forbidden(*args):
        raise AssertionError('cold pair must use precomputed segment bounds')
    monkeypatch.setattr(geometry, '_boxes_apart', forbidden)
    assert geometry._conflict_cells(a, b, 5.)
    assert geometry._conflict_cells(a, c, 5.)


def test_cold_geometry_matches_original_pair_scan_exactly():
    import random
    from digital_twin.model_library import ground_routes as geometry
    rng = random.Random(91643)
    for _ in range(100):
        a = geometry.route_geometry(tuple((rng.uniform(-30, 30), rng.uniform(-30, 30)) for _ in range(5)))
        b = geometry.route_geometry(tuple((rng.uniform(-30, 30), rng.uniform(-30, 30)) for _ in range(6)))
        radius = rng.uniform(.001, 20.)
        expected = []
        for i, p, q, origin, span in geometry._segments(a):
            for j, r, s, _, _ in geometry._segments(b):
                if geometry._boxes_apart(p, q, r, s, radius):
                    continue
                interval = geometry.capsule_interval(p, q, r, s, radius)
                if interval is not None:
                    expected.append((i, j, origin+span*interval[0], origin+span*interval[1]))
        assert tuple(cell[:4] for cell in geometry._conflict_cells(a, b, radius)) == tuple(expected)

def test_intersection_egress_retreat_never_revokes_moving_braking_corridor():
    from digital_twin.model_library import ground_motion
    control=VertiportGroundControl()
    path=((0.,0.),(100.,0.))
    control.configure_routes('V',[path,((20.,-50.),(20.,50.))],radius_m=7)
    # A new physical obstacle gives a valid 26 m stop, but the intersection
    # courtesy rule formerly retreated it to the current 15 m position.
    moving=request('A',path=path,distance_m=15.,speed_mps=2.)
    obstacle=GroundObservation('manual','V',(40.,0.),7.)
    authority=control.authorize([moving],[obstacle],1)['A']
    assert 15.+2.**2/(2*ground_motion.ACCEL_MPS2) <= authority.stop_distance_m < 26.
    profile={'distances_m':[0.,100.],'speeds_mps':[4.,0.]}
    distance,speed=15.,2.
    for _ in range(100):
        distance,speed=ground_motion.advance(profile,distance,speed,authority.stop_distance_m,4.,.1)
    assert speed < .001
    assert distance <= authority.stop_distance_m
    assert 40.-distance > 14.
