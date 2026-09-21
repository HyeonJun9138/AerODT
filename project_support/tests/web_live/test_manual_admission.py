"""Regression: submitted manual departures must not depend on click timing."""
import pytest
from digital_twin.simulation import manual_takeover as manual, manual_procedure
from test_holding_backpressure import admission_fixture
from test_manual_procedure import assigned, place


@pytest.mark.parametrize('late', [90, 600, 3600])
def test_later_departure_cannot_use_overdue_older_reservation(late):
    e, route = admission_fixture()
    try:
        a, b = e.aircraft.values()
        f, g = e.flights.values()
        manual.hand_over(e, a.aircraft_id)
        assert e._meter_arrival_entry(a, f, route, e.time_s)
        original_order = list(e._entry_forecasts)
        now = e.time_s + late
        # Old reservation is no longer a plausible arrival for the parked owner.
        assert not e._meter_arrival_entry(b, g, route, now)
        assert e._entry_forecasts[g['flight_id']]['departure_s'] >= now + 90
        assert list(e._entry_forecasts)[:1] == original_order
        assert e._meter_arrival_entry(a, f, route, now)
    finally:
        e.close()


def test_single_request_is_rechecked_and_granted_without_moving_aircraft():
    e, a = assigned()
    try:
        original = e._departure_blockers
        e._departure_blockers = lambda *args: [{'flight_id':'TRAFFIC'}]
        pose = (a.latitude, a.longitude, a.altitude)
        for _ in range(4):
            assert manual.request(e, a.aircraft_id, 'departure')['state'] == 'hold'
        first = a.external['departure_requested_s']
        assert 'TRAFFIC' in manual.advisory(e,a.aircraft_id)['procedure']['reason']
        assert not manual.advisory(e,a.aircraft_id)['procedure']['next']['enabled']
        e._departure_blockers = original
        # Exercise the real engine tick, not an advisory GET or another click.
        e.advance(e.time_s + 1)
        assert a.external['departed']
        assert a.external['departure_requested_s'] == first
        assert pose == (a.latitude, a.longitude, a.altitude)
        assert not a.airborne
        assert manual.advisory(e,a.aircraft_id)['procedure']['stage']=='지상 이동 허가'
        assert len([x for x in e.events if x['kind']=='pilot_request']) == 4
        assert any(x['kind']=='psu_response' and x['outcome']=='granted' for x in e.events)
    finally:
        e.close()


def test_stale_pose_does_not_grant_and_cancel_removes_pending_request():
    e, a = assigned()
    try:
        a.ready_s=e.time_s+1
        manual.request(e,a.aircraft_id,'departure')
        a.external['pose_received']-=10
        e.advance(e.time_s+2)
        assert not a.external['departed']
        assert '위치 수신' in manual.advisory(e,a.aircraft_id)['procedure']['reason']
        assert manual.request(e,a.aircraft_id,'hold')['state']=='accepted'
        place(e,a,(a.latitude,a.longitude,a.altitude))
        e.advance(e.time_s+2)
        assert not a.external['departed'] and not a.external.get('departure_pending')
    finally:
        e.close()


def test_blocked_pad_is_never_overridden_by_repeated_requests_or_elapsed_time():
    e, a = assigned()
    try:
        e._departure_blockers=lambda *args:[{'flight_id':'OCCUPIED'}]
        manual.request(e,a.aircraft_id,'departure')
        for delay in [1, 10, 100, 1000]:
            place(e,a,(a.latitude,a.longitude,a.altitude))
            manual.advance_request(e,a,e.time_s+delay)
            assert not a.external['departed'] and a.flight is None
        assert 'OCCUPIED' in manual.advisory(e,a.aircraft_id)['procedure']['reason']
    finally:
        e.close()


def test_advisory_uses_selected_pad_before_departure_is_granted():
    e, a = assigned()
    try:
        f=e.flights['F1'];r=e.route(f)
        selected=dict(f,departure_fato='F3')
        e._assigned_plans['F1']=(selected,r)
        assert manual.advisory(e,a.aircraft_id)['procedure']['departure_fato']=='F3'
        assert e.flights['F1']['departure_fato']!= 'F3'
    finally:
        e.close()
