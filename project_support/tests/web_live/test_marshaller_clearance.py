import math
from types import SimpleNamespace as NS
from user_application.uam_mission.scenario_observation import ScenarioObservation, marshaller_post, _segment_distance


def layout():
    return {'frame':{'latitude':37,'longitude':127},'platform':{'corners_m':[[-40,-40],[40,-40],[40,40],[-40,40]]},
            'dimensions':{'vehicle_d_m':14},'gates':[{'id':'G1','center_m':[0,0],'radius_m':7}],
            'fatos':[{'id':'F1','center_m':[0,30],'radius_m':9}],
            'edges':[{'width_m':8,'points_m':[[0,0],[0,30]]}]}


def test_post_is_fixed_off_the_entire_taxi_corridor():
    l=layout();p=marshaller_post(l,l['gates'][0],7)
    assert p is not None
    assert _segment_distance(p,[0,0],[0,30])>=9
    assert math.dist(p,[0,0])>=9
    assert math.dist(p,[0,30])>=11
    assert p==marshaller_post(l,l['gates'][0],7)
    large=marshaller_post(l,l['gates'][0],12)
    assert large is not None and math.dist(large,[0,0])>=14


def test_no_safe_deck_space_has_no_unsafe_fallback():
    l=layout();l['platform']['corners_m']=[[-4,-4],[4,-4],[4,4],[-4,4]]
    assert marshaller_post(l,l['gates'][0],7) is None


def test_actual_aircraft_footprint_suppresses_fixed_post():
    l=layout();p=marshaller_post(l,l['gates'][0],7)
    a=NS(phase='gate_out',flight={'origin':'V','destination':'W','flight_id':'F'},stand='G1',
         latitude=37,longitude=127,airborne=False,speed_mps=1,instruction={},aircraft_id='A')
    e=NS(aircraft={'A':a},_layout=lambda _:l,_ground_radius=lambda _:7,_deck_height=lambda _:10)
    observation=ScenarioObservation();observation.engine=e
    before=observation._ground_crew(0)
    assert len(before)==1
    a.latitude=before[0]['latitude'];a.longitude=before[0]['longitude']
    assert observation._ground_crew(0)==[]
