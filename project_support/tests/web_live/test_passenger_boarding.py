import copy
import pytest
from digital_twin.model_library import flight_plan as fp, passenger_boarding as boarding
from digital_twin.model_library.ground_motion import at
from digital_twin.model_library.vertiport_layout import PATTERNS, generate_layout, validate_definition
from project_support.tests.web_live.test_flight_plan import plan


@pytest.mark.parametrize('count',[0,1,3,4])
def test_manifest_count_and_all_boarded_before_taxi(count):
    p=plan(passengers=count)
    if count==0:
        assert 'boarding' not in p
        assert 'alighting' not in p
        return
    b=p['boarding'];leg=p['legs'][0]
    assert b['count']==count and len(b['release_s'])==count
    assert b['facility'] and b['gate']==p['departure']['gate']
    end=b['release_s'][-1]+b['walk_s']+b['enter_s']
    assert leg['ground_motion']['times_s'][0]>=end+1.9
    assert at(leg['ground_motion'],end)==(0,0)
    assert b['path'][0]!=b['path'][-1]
    assert leg['end_s']==p['legs'][1]['start_s']
    arrival=p['alighting'];charge=p['legs'][-1]
    assert arrival['count']==count and arrival['gate']==p['arrival']['gate']
    assert arrival['start_stage']=='charge'
    assert charge['duration_s']>=arrival['duration_s']


@pytest.mark.parametrize('pattern',list(PATTERNS))
@pytest.mark.parametrize('heading',[0,37,90])
def test_all_layouts_and_gate_facilities_can_board(pattern,heading):
    d=validate_definition({'name':'test','latitude':37.5,'longitude':127,'heading_deg':heading,
        'gates':3,'platform_height_m':20,'pattern':pattern,
        'fatos':[{'role':'takeoff'},{'role':'landing'}]})
    layout=generate_layout(d)
    for gate in layout['gates']:
        taxi=fp.taxi_path(layout,gate['id'],layout['fatos'][0]['id'])
        leg=fp._ground_leg('gate_out','test',taxi,'deck:VP',fp.AIRCRAFT)
        b=boarding.prepare(layout,gate['id'],4,leg)
        assert b['gate']==gate['id']
        assert b['walk_s']>0 and b['duration_s']<180
        incoming=fp.taxi_path(layout,layout['fatos'][1]['id'],gate['id'])
        arrival_leg=fp._ground_leg('gate_in','test',incoming,'deck:VP',fp.AIRCRAFT)
        before=copy.deepcopy(arrival_leg)
        arrival=boarding.prepare(layout,gate['id'],4,arrival_leg,alighting=True)
        assert arrival_leg==before, 'Alighting must not change the incoming taxi motion'
        assert arrival['facility']==b['facility'] and arrival['datum']=='deck:VP'
        assert arrival['start_stage']=='charge' and arrival['walk_s']>0


def test_short_charge_keeps_time_for_alighting_even_after_native_retime():
    from digital_twin.simulation.native_flight_engine import retime
    p=plan(passengers=4,charge_target_pct=1)
    b=p['alighting'];charge=p['legs'][-1]
    assert charge['charge_kwh']==0
    assert charge['duration_s']>=b['duration_s']
    updated=retime(p,{1:90},charge_target_pct=1)
    assert updated['legs'][-1]['duration_s']>=b['duration_s']
    assert updated['alighting']==b, 'Schedule is charge-relative, never a stale absolute timestamp'


def test_obstacle_detour_and_blocked_path_do_not_walk_through_facility():
    box=(2,-1,4,1)
    points=boarding.route((0,0),(6,0),[box],(-10,-10,10,10))
    assert len(points)>2
    assert all(not boarding.crosses(a,b,box) for a,b in zip(points,points[1:]))
    with pytest.raises(ValueError):
        boarding.route((0,0),(6,0),[(2,-11,4,11)],(-10,-10,10,10))


def test_old_layouts_do_not_invent_facilities():
    p=plan()
    leg=copy.deepcopy(p['legs'][0]);before=copy.deepcopy(leg)
    assert boarding.prepare({},'G1',3,leg) is None
    assert leg==before
