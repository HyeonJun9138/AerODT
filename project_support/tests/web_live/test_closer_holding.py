import math
from digital_twin.simulation.scenario_engine import _offset, _bearing
from digital_twin.model_library.flight_plan import haversine_m
from test_scenario_engine import engine_of, row

def setup():
    e=engine_of(row('F','A','VP1','VP2','06:30:00'))
    port=e._vertiports['VP2'];centre=(port['latitude'],port['longitude'])
    e._corridors['VP2']={0.0}
    entry=(*_offset(centre,0,800),e._deck_height('VP2')+300)
    return e,centre,entry

def test_default_wait_is_near_the_port_and_avoids_the_arrival_corridor():
    e,centre,entry=setup()
    point,slot=e._holding_fix('VP2',entry)
    assert 399<=haversine_m(centre,point[:2])<=601
    assert haversine_m(entry[:2],point[:2])<800
    assert abs((_bearing(centre,point[:2])+180)%360-180)>=35

def test_operator_radius_is_used_by_native_default_call_and_explicit_budget_is_respected():
    e,centre,entry=setup()
    e.policy['psu'].update(hold_min_radius_m=800.,hold_radius_m=1000.)
    point,_=e._holding_fix('VP2',entry)
    assert 799<=haversine_m(centre,point[:2])<=1001
    point,_=e._holding_fix('VP2',entry,900)
    assert 799<=haversine_m(centre,point[:2])<=901

def test_slot_identity_does_not_hide_an_already_reserved_position():
    e,centre,entry=setup()
    first,_=e._holding_fix('VP2',entry)
    # A different ring/radius identifier may describe the same physical point.
    e._holds['VP2']={'other':{'slot':(99,0,0),'fix':first}}
    second,_=e._holding_fix('VP2',entry)
    assert (abs(second[2]-first[2])>=e.policy['pilot']['traffic_vertical_m'] or
        haversine_m(second[:2],first[:2])>=e.policy['pilot']['traffic_horizontal_m'])

def test_dense_waiting_preserves_existing_horizontal_or_vertical_separation():
    e,centre,entry=setup();e._holds['VP2']={};points=[]
    for index in range(80):
        point,slot=e._holding_fix('VP2',entry,600 if index%2 else 500)
        for old in points:
            assert (abs(point[2]-old[2])>=e.policy['pilot']['traffic_vertical_m'] or
                haversine_m(point[:2],old[:2])>=e.policy['pilot']['traffic_horizontal_m'])
        points.append(point);e._holds['VP2'][str(index)]={'slot':slot,'fix':point}
    assert len(set(points))==80

def test_free_near_altitude_is_preferred_over_climbing_the_same_bearing_stack():
    e,centre,entry=setup()
    first,slot=e._holding_fix('VP2',entry)
    e._holds['VP2']={'other':{'slot':slot,'fix':first}}
    second,_=e._holding_fix('VP2',entry)
    assert abs(second[2]-entry[2])<=120
    assert haversine_m(entry[:2],second[:2])<800

def test_small_radius_setting_does_not_reduce_the_existing_port_clearance_floor():
    e,centre,entry=setup();e.policy['psu'].update(hold_min_radius_m=100.,hold_radius_m=200.)
    point,_=e._holding_fix('VP2',entry)
    assert haversine_m(centre,point[:2])>=399
