"""Diagnostic wording must not replace a PSU cause with only a bay location."""
from types import SimpleNamespace
import pytest
from digital_twin.simulation.scenario_engine import ScenarioEngine
from project_support.tests.web_live.test_scenario_engine import schedule_of, row, VERTIPORTS, NETWORK


@pytest.fixture
def engine():
    e = ScenarioEngine(schedule_of(row('F', 'A', 'VP1', 'VP2', '06:30:00')),
        vertiports=VERTIPORTS, network=NETWORK, elevation=lambda lon, lat: 0)
    yield e
    e.close()


def test_terminal_reason_names_observed_blocker_without_guessing_aircraft_id(engine):
    engine.flights['OTHER'] = {'aircraft_id': 'UAM0003'}
    blockers = [dict(flight_id='OTHER', operation='departure', vertiport='VP2', fato='F1')]
    assert engine._terminal_wait_reason(blockers) == 'UAM0003 (VP2 F1) 이륙 경로와 접근 경로 분리 대기'
    blockers[0].update(flight_id='UNKNOWN', operation='arrival')
    reason = engine._terminal_wait_reason(blockers)
    assert 'UNKNOWN' in reason and '착륙' in reason
    assert 'UAM' not in reason  # Flight IDs cannot be converted to invented aircraft IDs.


def test_bay_keeps_current_cause_and_removes_it_when_returning(engine):
    a = engine.aircraft['A']; a.flight = engine.flights['F']; a.route = engine.route(a.flight)
    assert engine._prepare_waiting_route(a, engine.time_s)
    r = engine.psu.waiting.reservations['F']; r['state'] = 'holding'
    a.index = a.route.descent_index
    a.latitude, a.longitude, a.altitude = r['target']
    a.speed_mps = a.climb_mps = 0
    a.clearance = SimpleNamespace(sequence=1, approach_started_s=None, holding_assignment=None)
    cause = 'UAM0003 (VP2 F1) 이륙 경로와 접근 경로 분리 대기'
    queued, target = engine._queue_instruction(a, True, engine.time_s, .1, hold_reason=cause)
    assert queued and target == r['target']
    assert a.instruction['clearance_reason'].startswith(cause)
    assert '지정 위치 대기' in a.instruction['clearance_reason']
    engine._queue_instruction(a, True, engine.time_s, .1, hold_reason='주기장 확보 대기')
    assert '주기장 확보 대기' in a.instruction['clearance_reason']
    assert 'UAM0003' not in a.instruction['clearance_reason']
    engine._queue_transfer_clear = lambda *args, **kwargs: True
    # Released at the bay the approach was planned through, the aircraft is
    # handed back to its pilot there: the approach starts where it is, with
    # no return to the entry it left the corridor at.
    queued, target = engine._queue_instruction(a, False, engine.time_s, .1, hold_reason=cause)
    assert not queued and target is None
    assert 'F' not in engine.psu.waiting.reservations and a.hold is None
    assert [e['kind'] for e in engine.events if e['kind'] in ('hold_released', 'holding_rejoin_complete')] == ['hold_released', 'holding_rejoin_complete']
    assert 'UAM0003' not in a.instruction['clearance_reason']


def test_captured_bay_keeps_a_fixed_nearby_hold_point_instead_of_chasing_exact_wp(engine):
    a=engine.aircraft['A'];a.flight=engine.flights['F'];a.route=engine.route(a.flight)
    engine._prepare_waiting_route(a,engine.time_s)
    r=engine.psu.waiting.reservations['F'];r['state']='moving'
    a.index=a.route.descent_index
    a.latitude,a.longitude,a.altitude=r['target']
    a.latitude+=10/111320
    a.speed_mps=.5;a.climb_mps=0
    a.clearance=SimpleNamespace(sequence=1,approach_started_s=None,holding_assignment=None)
    position=(a.latitude,a.longitude,a.altitude)
    queued,target=engine._queue_instruction(a,True,engine.time_s,.1)
    assert queued and target==position
    assert r['state']=='holding'
    a.latitude+=2/111320
    assert engine._queue_instruction(a,True,engine.time_s+1,.1)[1]==position
    assert r['target']!=position, 'reservation geometry stays unchanged'
    engine._queue_transfer_clear=lambda *args,**kwargs:True
    engine._queue_instruction(a,False,engine.time_s+2,.1)
    assert 'settled_target' not in r
