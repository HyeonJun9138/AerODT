"""Admission must see the observed queue, not just an expired departure forecast."""
from types import SimpleNamespace

import pytest

from digital_twin.simulation.scenario_engine import Phase, Route
from test_scenario_engine import engine_of, row


def priority_fixture():
    e = engine_of(row('A', 'A', 'VP1', 'VP2', '06:30:00'),
                  row('D', 'D', 'VP2', 'VP1', '09:00:00', stand='G4'))
    a = e.aircraft['A']
    e._maybe_depart(a, e.time_s)
    a.index, a.phase, a.hold_seconds = a.route.descent_index, 'hold', 120
    a.clearance = e.psu.request_arrival(flight_id='A', vertiport='VP2', fato='F2',
        stand='G2', earliest_s=e.time_s + 100, now_s=e.time_s - 120)
    a.clearance.approach_s = e.time_s
    end = a.route.phases[a.route.landing_index].points[-1]
    route = Route('crossing', [Phase('takeoff', 'lift',
        [end, (end[0], end[1], end[2] + 30)], 30, 1)], {}, {})
    e._terminal.assume_mixed_separated = False
    e._terminal.assume_distinct_fatos_separated = False
    return e, e.flights['D'], route


@pytest.mark.parametrize('switch', ['disabled', 'distinct'])
def test_waiting_arrival_priority_respects_terminal_policy(switch):
    e, flight, route = priority_fixture()
    try:
        assert e._departure_blockers(flight, route)
        if switch == 'disabled':
            e._terminal.enabled = False
        else:
            e._terminal.assume_distinct_fatos_separated = True
        assert not e._departure_blockers(flight, route)
        e._active_pads[('VP2', 'F1')] = 'occupied'
        assert any(b['reason'] == 'pad_occupied' for b in e._departure_blockers(flight, route))
    finally:
        e.close()


def admission_fixture(count=2):
    e = engine_of(*(row(f'F{i}', f'A{i}', 'VP1', 'VP2', '06:30:00', stand=f'G{i}')
                    for i in range(1, count + 1)))
    p = (37.5, 127., 30.)
    route = Route('admission', [Phase('takeoff', 'up', [p, p], 0, 1),
        Phase('cruise', 'cruise', [p, p], 100, 20),
        Phase('descent', 'approach', [p, p], 50, 10),
        Phase('landing', 'land', [p, p], 50, 1)], {'fato': 'F2'}, {})
    e.pilots = SimpleNamespace(estimate_to_entry=lambda *a: 100.,
                              cached_entry_estimate=lambda *a: 100., close=lambda: None)
    e.policy['psu']['entry_spacing_s'] = 60.
    e.policy['psu']['approach_headway_s'] = 15.
    return e, route


def held(e, route, index, remaining=200.):
    a = e.aircraft[f'A{index}']
    a.flight, a.route = e.flights[f'F{index}'], route
    a.phase, a.index = 'hold', route.descent_index
    e._entry_forecasts[a.flight['flight_id']] = {
        'key': ('VP2', 'F2'), 'entry_s': e.time_s - 300, 'departure_s': e.time_s - 400}
    e.psu.waiting.reservations[a.flight['flight_id']] = {'state': 'holding'}
    e._remaining_native = lambda aircraft: remaining
    return a


def test_expired_forecast_of_a_holding_aircraft_still_meters_new_departure():
    e, route = admission_fixture()
    try:
        held(e, route, 1)
        b, flight = e.aircraft['A2'], e.flights['F2']
        pose = (b.latitude, b.longitude, b.altitude)
        assert not e._meter_arrival_entry(b, flight, route, e.time_s)
        assert e._entry_forecasts['F2']['departure_s'] == pytest.approx(e.time_s + 90)
        assert b.phase == 'parked' and pose == (b.latitude, b.longitude, b.altitude)
        assert e.psu._stands.occupant('VP1', 'G2') == 'A2'
    finally:
        e.close()


def test_overlapping_observed_etas_are_queued_not_counted_as_one_slot():
    e, route = admission_fixture(3)
    try:
        held(e, route, 1)
        held(e, route, 2)
        assert not e._meter_arrival_entry(e.aircraft['A3'], e.flights['F3'], route, e.time_s)
        assert e._entry_forecasts['F3']['departure_s'] == pytest.approx(e.time_s + 180)
    finally:
        e.close()


def test_late_ground_release_rechecks_observed_traffic_without_losing_queue_order():
    e, route = admission_fixture()
    try:
        b, flight = e.aircraft['A2'], e.flights['F2']
        assert e._meter_arrival_entry(b, flight, route, e.time_s)
        held(e, route, 1)
        order = list(e._entry_forecasts)
        assert not e._meter_arrival_entry(b, flight, route, e.time_s + 300)
        assert list(e._entry_forecasts) == order
        assert b.ready_s == e.opens_s, 'turnaround readiness is not an admission reservation'
        e.aircraft['A1'].phase = 'gate_in'
        e.aircraft['A1'].index = route.landing_index + 1
        due = e._entry_forecasts['F2']['departure_s']
        assert e._meter_arrival_entry(b, flight, route, due)
    finally:
        e.close()


def test_entry_rate_cannot_exceed_configured_landing_service_rate():
    e, route = admission_fixture()
    try:
        assert e._meter_arrival_entry(e.aircraft['A1'], e.flights['F1'], route, e.time_s)
        assert not e._meter_arrival_entry(e.aircraft['A2'], e.flights['F2'], route, e.time_s)
        assert e._entry_forecasts['F2']['entry_s'] - e._entry_forecasts['F1']['entry_s'] >= 90
    finally:
        e.close()


def test_observed_backlog_on_another_pad_does_not_close_this_pad():
    e, route = admission_fixture()
    try:
        held(e, route, 1)
        other = Route('other', route.phases, {'fato': 'F4'}, {})
        assert e._meter_arrival_entry(e.aircraft['A2'], e.flights['F2'], other, e.time_s)
    finally:
        e.close()


def test_later_unstarted_booking_cannot_push_a_mature_booking_to_the_tail():
    e, route = admission_fixture()
    try:
        a, b = e.aircraft.values()
        f, g = e.flights.values()
        assert e._meter_arrival_entry(a, f, route, e.time_s)
        assert not e._meter_arrival_entry(b, g, route, e.time_s)
        # The first departure was delayed on the ground until the second's
        # projected arrival. It still precedes that unstarted reservation.
        due = e._entry_forecasts['F2']['departure_s']
        assert e._meter_arrival_entry(a, f, route, due)
    finally:
        e.close()


def test_different_approach_lengths_do_not_hide_a_touchdown_conflict():
    e, route = admission_fixture()
    try:
        a, b = e.aircraft.values()
        f, g = e.flights.values()
        assert e._meter_arrival_entry(a, f, route, e.time_s)
        # A actually departed; otherwise a parked reservation must be moved
        # forward to protect its earliest current arrival after a ground delay.
        a.flight, a.route, a.phase, a.index = f, route, 'cruise', 1
        e._remaining_native = lambda aircraft: 110.
        # B reaches the entry 90 seconds later but has a 90-second shorter
        # approach. Entry spacing alone would send both to the pad together.
        shorter = Route('short', [*route.phases[:2],
            Phase('descent', 'approach', route.phases[2].points, 5, 10),
            Phase('landing', 'land', route.phases[3].points, 5, 1)], {'fato': 'F2'}, {})
        assert not e._meter_arrival_entry(b, g, shorter, e.time_s + 90)
        assert e._entry_forecasts['F2']['departure_s'] == pytest.approx(e.time_s + 180)
    finally:
        e.close()


def test_preview_is_read_only_and_does_not_rehearse_native_flight():
    e, route = admission_fixture()
    try:
        from copy import deepcopy
        held(e, route, 1)
        before = deepcopy(e._entry_forecasts)
        e.pilots.estimate_to_entry = lambda *a: pytest.fail('synchronous native rehearsal')
        e._preview_arrival_entry(e.aircraft['A2'], e.flights['F2'], route, e.time_s, cached_only=True)
        assert e._entry_forecasts == before
    finally:
        e.close()


@pytest.mark.parametrize('committed', [False, True])
def test_uncommitted_arrival_with_blocked_bay_return_cannot_strand_ready_follower(committed):
    e = engine_of(row('F1', 'A1', 'VP1', 'VP2', '06:30:00'),
                  row('F2', 'A2', 'VP1', 'VP2', '06:30:00', stand='G3', arrival_stand='G4'))
    try:
        for a in e.aircraft.values():
            e._maybe_depart(a, e.time_s)
            a.index, a.phase = a.route.descent_index, 'hold'
            a.place(*a.route.phases[a.index].at(0))
            a.clearance = e.psu.request_arrival(flight_id=a.flight['flight_id'], vertiport='VP2',
                fato='F2', stand=a.flight['arrival_stand'], earliest_s=e.time_s + 100, now_s=e.time_s)
            e.psu.waiting.reservations[a.flight['flight_id']] = {'state': 'holding'}
        e._remaining_native = lambda a: 100.
        e._queue_return_clear = lambda a: a.aircraft_id == 'A2'
        if committed:
            e.aircraft['A1'].clearance.approach_started_s = e.time_s - 60
        e._refresh_predictions(e.time_s)
        if committed:
            assert e.psu.begin_approach('F1', e.time_s)
            assert not e.psu.begin_approach('F2', e.time_s, capacity=1)
        else:
            assert not e.psu.begin_approach('F1', e.time_s)
            assert e.psu.begin_approach('F2', e.time_s)
            assert '복귀 경로' in e.aircraft['A1'].clearance.reason
        assert e.aircraft['A1'].clearance.sequence < e.aircraft['A2'].clearance.sequence
        # Once the observed return is clear, its original number participates
        # again. No teleport, forced landing or erasure of the waiting flight.
        e._queue_return_clear = lambda a: True
        e._refresh_predictions(e.time_s + 30)
        assert e.aircraft['A1'].clearance.approach_s is not None
    finally:
        e.close()


def test_native_congested_arrivals_complete_without_bypassing_ground_authority():
    from communication.python.native_pilot import NativePilotLibrary
    from digital_twin.simulation.scenario_engine import ScenarioEngine
    from user_application.uam_mission.scenario_pilots import ScenarioPilots
    from user_application.uam_mission.ground_control import VertiportGroundControl
    from test_scenario_engine import schedule_of, VERTIPORTS, NETWORK
    try:
        library = NativePilotLibrary()
    except (OSError, RuntimeError):
        pytest.skip('native pilot library unavailable')
    schedule = schedule_of(*(row(f'F{i}', f'A{i}', 'VP1', 'VP2', '06:30:00',
        stand=f'G{i}', arrival_stand=f'G{i}') for i in range(1, 5)))
    e = ScenarioEngine(schedule, vertiports=VERTIPORTS, network=NETWORK,
        pilots=ScenarioPilots(library, workers=1), ground_control=VertiportGroundControl(),
        policy={'psu': {'entry_spacing_s': 60, 'approach_headway_s': 15, 'terminal_separation': False}})
    try:
        for _ in range(2200):
            e.advance(e.time_s + 1)
            if e.problems or all(a.completed for a in e.aircraft.values()):
                break
        assert not e.problems
        assert all(a.completed == 1 and not a.airborne for a in e.aircraft.values())
        assert len({a.stand for a in e.aircraft.values()}) == 4
        assert not e._entry_forecasts, 'completed traffic must not retain admission reservations'
        assert sum(event['kind'] == 'touchdown' for event in e.events) == 4
    finally:
        e.close()
