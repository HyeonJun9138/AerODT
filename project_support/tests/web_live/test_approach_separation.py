"""Regression for a final-ETA follower frozen beside a wait_clear leader."""
import math
from user_application.uam_mission.approach_separation import candidates, clear_transfer
from user_application.uam_mission.traffic_awareness import relative


def pair():
    leader=dict(aircraft_id='A',latitude_deg=37.,longitude_deg=127.,altitude_m=200.,speed_mps=0,
        phase='hold',airborne=True,guidance={'landing_yaw_mutable':True})
    follower=dict(leader,aircraft_id='B',latitude_deg=37.+84/111320,altitude_m=156.,
        instruction={'action':'yield','traffic_id':'A'})
    return leader,follower


def test_follower_has_level_away_goal_even_with_short_final_eta():
    a,b=pair();targets=candidates(b,[a,b],{})
    assert targets
    for t in targets:
        assert t[2]==b['altitude_m']
        p=dict(latitude_deg=t[0],longitude_deg=t[1],altitude_m=t[2])
        assert math.hypot(*relative(a,p)[:2])>=140
        assert clear_transfer(b,t,[a,b],{})


def test_committed_vertical_landing_and_moving_wing_cannot_relocate():
    a,b=pair();b['guidance']={'landing_yaw_mutable':False}
    assert not candidates(b,[a,b],{})
    b['guidance']={'landing_yaw_mutable':True};b['speed_mps']=15
    assert not candidates(b,[a,b],{})


def test_no_goal_may_cross_a_third_aircraft_or_another_reserved_transfer():
    a,b=pair();target=candidates(b,[a,b],{})[0]
    third=dict(a,aircraft_id='C',latitude_deg=(target[0]+b['latitude_deg'])/2,altitude_m=b['altitude_m'])
    assert not clear_transfer(b,target,[a,b,third],{})
    third['latitude_deg']=target[0];third['longitude_deg']=127.+300/111320
    third['separation_target']=(target[0],127.-300/111320,b['altitude_m'])
    assert not clear_transfer(b,target,[a,b,third],{})


def test_existing_close_pair_never_moves_toward_each_other():
    a,b=pair()
    assert not clear_transfer(b,(a['latitude_deg'],a['longitude_deg'],b['altitude_m']),[a,b],{})
    a['speed_mps']=5
    assert not candidates(b,[a,b],{})


def test_new_traffic_can_stop_an_existing_transfer():
    a,b=pair();target=candidates(b,[a,b],{})[0]
    third=dict(a,aircraft_id='C',latitude_deg=target[0],altitude_m=target[2])
    assert not clear_transfer(b,target,[a,b,third],{})


def test_crossing_the_horizontal_threshold_does_not_invent_new_traffic():
    a,b=pair();target=candidates(b,[a,b],{})[0]
    b['latitude_deg']=a['latitude_deg']+122/111320
    assert clear_transfer(b,target,[a,b],{})


def test_native_altitude_tracking_error_does_not_restart_a_level_transfer():
    a,b=pair();target=candidates(b,[a,b],{})[0]
    b['altitude_m']+=.25
    assert clear_transfer(b,target,[a,b],{})
    b['altitude_m']+=3
    assert not clear_transfer(b,target,[a,b],{})


def test_engine_rejects_missing_terrain_or_a_hill_along_transfer():
    from test_scenario_engine import engine_of,row
    e=engine_of(row('F','B','VP1','VP2','06:30:00'))
    a=e.aircraft['B'];e._maybe_depart(a,e.time_s)
    lat,lon=a.latitude,a.longitude;a.place(lat,lon,100)
    target=(lat+180/111320,lon,100)
    class Pilots:
        def separation_candidates(self,*args):return [target]
    e.pilots=Pilots();e._elevation=None
    assert e._separation_fix(a) is None
    e._elevation=lambda lon,lat:0
    assert e._separation_fix(a)==target
    e._elevation=lambda longitude,latitude:80 if latitude>lat+60/111320 else 0
    assert e._separation_fix(a) is None
