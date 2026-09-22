"""A deferred departure must not indefinitely exclude an empty landing pad."""
from types import SimpleNamespace

from test_scenario_engine import engine_of, row
from test_psu_sequencing import sequencer


def test_entry_meter_time_is_part_of_departure_protection_horizon():
    e=engine_of(row('D','D','VP1','VP2','06:30:00'))
    try:
        now=e.time_s
        assert 'D' in e._pending_departure_ids('VP1',now)
        e._entry_forecasts['D']={'departure_s':now+600}
        assert 'D' not in e._pending_departure_ids('VP1',now)
        e._entry_forecasts['D']['departure_s']=now+30
        assert 'D' in e._pending_departure_ids('VP1',now)
        e.aircraft['D'].failed=True
        assert 'D' not in e._pending_departure_ids('VP1',now)
    finally:e.close()


def test_a_future_leg_elsewhere_is_not_a_ready_departure_at_this_port():
    e=engine_of(row('D','D','VP1','VP2','06:30:00'))
    try:
        e.aircraft['D'].vertiport='VP2'
        assert 'D' not in e._pending_departure_ids('VP1',e.time_s)
    finally:e.close()


def test_compact_four_fato_empty_deck_uses_serial_operations_instead_of_deadlock():
    psu=sequencer()
    facts=dict(takeoff_fatos=('F1','F3'),candidate_blocked_fatos=('F1','F3'),
               pending_departures=('D',),reserve_ratio=.5,simultaneous_departure_capacity=0)
    answer=psu.protect_departure_capacity(**facts)
    assert answer.granted and answer.required==0
    # This is not permission to overlap two landings in the coupled group.
    answer=psu.protect_departure_capacity(**facts,currently_blocked_fatos=('F1','F3'))
    assert not answer.granted and '순차 이착륙' in answer.reason


def test_real_vp002_close_fatos_remain_independent_resources():
    e=engine_of(row('D','D','VP1','VP2','06:30:00'))
    try:
        from copy import deepcopy
        e._vertiports['VP1']=deepcopy(e._vertiports['VP1'])
        # Live VP002 pad centres are close, but different IDs remain different
        # resources. Route overlap is checked separately.
        e._layout('VP1')['fatos']=[dict(id=id,role=role,center_m=xy) for id,role,xy in [
            ('F1','takeoff',[-17.869,7.585]),('F2','landing',[-5.095,-24.032]),
            ('F3','takeoff',[26.522,-11.258]),('F4','landing',[13.748,20.359])]]
        assert not e._same_fato('VP1','F1','F2')
        for pad in ('F2','F4'):
            result=e._arrival_departure_capacity('VP1',pad,'arrival',e.time_s)
            assert result.granted and result.required==0
    finally:e.close()


def test_dedicated_landing_is_not_subject_to_neighbouring_shared_pool_quota():
    e=engine_of(row('D','D','VP1','VP2','06:30:00'))
    try:
        from copy import deepcopy
        e._vertiports['VP1']=deepcopy(e._vertiports['VP1'])
        e._layout('VP1')['fatos']=[
            {'id':'F1','role':'both','center_m':[0,0]},
            {'id':'F2','role':'landing','center_m':[20,0]}]
        result=e._arrival_departure_capacity('VP1','F2','arrival',e.time_s)
        assert result.granted and result.required==0
        assert result.reason=='겸용 FATO 보호 대상 없음'
    finally:e.close()


def test_full_destination_holding_queue_keeps_departure_at_gate_not_on_fato():
    """Destination admission is a pre-taxi condition, not a takeoff condition."""
    e=engine_of(row('D','D','VP1','VP2','06:30:00'))
    try:
        aircraft=e.aircraft['D'];flight=e.flights['D'];route=e.route(flight)
        start=(aircraft.latitude,aircraft.longitude,aircraft.altitude,aircraft.phase)
        e.pilots=SimpleNamespace(close=lambda:None)
        e._select_fatos=lambda candidate,now:(flight,route)
        e._meter_arrival_entry=lambda *args,**kwargs:True
        e._departure_blockers=lambda *args,**kwargs:[]
        # An empty candidate set is the exact result after every safe
        # destination bay has been rejected by separation checks.
        e._queue_candidates=lambda *args,**kwargs:iter(())

        e._maybe_depart(aircraft,e.time_s)

        assert aircraft.flight is None and aircraft.route is None
        assert (aircraft.latitude,aircraft.longitude,aircraft.altitude,aircraft.phase)==start
        assert aircraft.next_flight==0
        assert not e._active_pads
        assert e.psu.clearance('D','departure') is None
        assert aircraft.instruction=={
            'action':'departure_wait',
            'reason':'PSU 접근 대기점 여유 확보 대기 (GATE 유지)',
        }
    finally:e.close()
