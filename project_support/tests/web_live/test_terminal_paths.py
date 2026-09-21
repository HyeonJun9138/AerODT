from types import SimpleNamespace
from digital_twin.model_library.terminal_paths import conflict, segment_distance
from digital_twin.simulation.psu_sequencing import PadTimeline, ARRIVAL, DEPARTURE


def route(points,stage='descent'):
    return SimpleNamespace(phases=[SimpleNamespace(stage=stage,points=points)])


def test_mixed_pad_gap_is_required_before_an_already_booked_landing():
    pad=PadTimeline('shared');pad.hold(70,90,'arrival',ARRIVAL)
    assert pad.earliest(0,DEPARTURE,60)==160
    pad=PadTimeline('shared');pad.hold(75,90,'arrival',ARRIVAL)
    assert pad.earliest(0,DEPARTURE,60)==0


def test_mixed_pad_gap_is_required_after_a_departure():
    pad=PadTimeline('shared');pad.hold(0,60,'departure',DEPARTURE)
    assert pad.earliest(60,ARRIVAL,90)==75


def test_remote_pads_with_crossing_approaches_are_not_independent():
    a=route([(37,127,100),(37.01,127.01,100)])
    b=route([(37,127.01,100),(37.01,127,100)])
    assert conflict(a,ARRIVAL,b,ARRIVAL,150,50)['reason']=='terminal_paths_overlap'


def test_separate_routes_and_altitude_disjoint_routes_can_operate_independently():
    a=route([(37,127,100),(37.01,127,100)])
    b=route([(37,127.01,100),(37.01,127.01,100)])
    c=route([(37,127.01,200),(37.01,127,200)])
    assert conflict(a,ARRIVAL,b,ARRIVAL,150,50) is None
    assert conflict(a,ARRIVAL,c,ARRIVAL,150,50) is None


def test_departure_and_arrival_crossing_and_vertical_segments():
    a=route([(37,127,0),(37,127,100)],'takeoff')
    b=route([(37.001,127,100),(37,127,0)],'landing')
    assert conflict(a,DEPARTURE,b,ARRIVAL,150,50)
    assert segment_distance((0,0),(0,0),(2,0),(3,0))==2
    assert segment_distance((0,0),(1,0),(2,0),(3,0))==1
