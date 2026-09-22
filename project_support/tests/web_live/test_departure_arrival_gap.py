"""Future approach reservations must leave provably usable departure gaps."""
from types import SimpleNamespace
import pytest
from digital_twin.simulation.scenario_engine import ScenarioEngine, Phase, Route
from test_psu_sequencing import sequencer
from test_predictive_ground import entry_fixture


def test_arrival_first_can_reserve_prefix_without_owning_departure_volume():
    e,a,d=entry_fixture()
    try:
        e._terminal.assume_mixed_separated=False
        e._terminal.release('D','departure')
        prefix=e._arrival_entry_route(a,300)
        assert prefix is not None
        assert not e._terminal.acquire(a.flight,prefix,'arrival')
        assert not e._terminal.blockers(d.flight,d.route,'departure')
        assert not e._terminal.acquire(d.flight,d.route,'departure')
        # Arrival cannot expand into final until the actual departure releases.
        assert e._terminal.blockers(a.flight,a.route,'arrival')
    finally:e.close()


@pytest.mark.parametrize('remaining,fits',[(500,True),(167,False),(100,False)])
def test_gap_includes_taxi_takeoff_climb_and_safety_margin(remaining,fits):
    route=Route('out',[Phase(s,s,[(0,0,0),(0,0,0)],t,1)
        for s,t in [('gate_out',60),('takeoff',40),('climb',10)]],{}, {})
    arrival=SimpleNamespace(flight={'flight_id':'A'},clearance=SimpleNamespace(approach_mode='initial'),
        external=None,failed=False,airborne=True,speed_mps=10)
    e=SimpleNamespace(_terminal=SimpleNamespace(claims={('A','arrival'):{'route':'prefix'}}),
        aircraft={'D':SimpleNamespace(external=None)},pilots=True,time_s=100,
        _remaining_native=lambda a:remaining,_native_leg_seconds=lambda *args:0,
        policy={'psu':{'final_guard_s':45,'prediction_buffer_s':12}},
        psu=SimpleNamespace(tuning=SimpleNamespace(mixed_separation_s=45)))
    result=ScenarioEngine._departure_arrival_window(e,{'aircraft_id':'D'},route,arrival)
    assert result['fits'] is fits
    assert result['departure_clear_s']==210
    assert result['arrival_guard_s']==100+remaining-57
    arrival.external={"manual":True}
    assert not ScenarioEngine._departure_arrival_window(e,{'aircraft_id':'D'},route,arrival)['fits']


def test_valid_gap_never_erases_actual_pad_or_terminal_occupancy():
    psu=sequencer()
    def blockers(fits,**kwargs):
        return psu.departure_blockers(flight_id='D',origin='V',fato='F1',now_s=100,
            arrival_conflicts=[{'flight_id':'A','departure_window':{
                'fits':fits,'reason':'arrival_window_too_short'}}],**kwargs)
    assert blockers(True)==[]
    assert blockers(False)[0]['reason']=='arrival_window_too_short'
    assert '완료 시간 부족' in psu.assess_departure(flight_id='D',blockers=blockers(False)).reason
    assert blockers(True,pad_occupants=[(('V','F1'),'X')],adjacent_fatos=['F1'])[0]['reason']=='pad_occupied'
    assert blockers(True,terminal_conflicts=[{'flight_id':'X','reason':'terminal_paths_overlap'}])[0]['reason']=='terminal_paths_overlap'
