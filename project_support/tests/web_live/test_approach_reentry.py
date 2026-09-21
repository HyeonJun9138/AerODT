"""Stopped arrivals check the intended re-entry before releasing a hold."""
from user_application.uam_mission.traffic_awareness import TrafficAwareness, resumed_approach

def rows():
    leader=dict(aircraft_id='A',latitude_deg=37.,longitude_deg=127.,altitude_m=100.,
        phase='descent',route_phase='descent',sequence=1,approach_started_s=1,speed_mps=0,heading_deg=0)
    follower=dict(leader,aircraft_id='B',latitude_deg=37.-180/111320,sequence=2,
        approach_started_s=2,phase='hold',resume_target=[37.+200/111320,127.,100.])
    return leader,follower

def awareness():
    a=TrafficAwareness()
    a.previous={'B':dict(action='yield',observed_s=0,traffic_id='A',right_m=0,speed_factor=1)}
    return a

def test_stopped_follower_cannot_release_into_the_same_predecessor():
    a=awareness();leader,follower=rows()
    for t in (20,30,60):
        c=a.commands([leader,follower],{},t)
        assert c['B']['action']=='yield'
        assert 'A' not in c, 'leader must remain free to vacate the approach'

def test_release_after_departing_traffic_stays_clear_for_the_release_interval():
    a=awareness();leader,follower=rows()
    assert a.commands([leader,follower],{},20)['B']['action']=='yield'
    leader['longitude_deg']+=1000/111320
    assert a.commands([leader,follower],{},24)['B']['action']=='yield'
    assert 'B' not in a.commands([leader,follower],{},29)

def test_release_check_does_not_project_beyond_the_next_waypoint():
    a=awareness();leader,follower=rows()
    follower['resume_target']=[37.-170/111320,127.,100.]
    assert 'B' not in a.commands([leader,follower],{},20)

def test_release_checks_level_transition_as_well_as_planned_descent():
    a=awareness();leader,follower=rows()
    follower['altitude_m']=140
    follower['resume_target'][2]=0
    leader['altitude_m']=180
    assert a.commands([leader,follower],{},20)['B']['action']=='yield'

def test_invalid_or_missing_resume_target_is_not_extrapolated():
    _,f=rows()
    for target in (None,[],[1,2,float('nan')]):
        f['resume_target']=target
        assert resumed_approach(f,{},35) is None

def test_release_respects_large_vertical_separation():
    a=awareness();leader,follower=rows()
    leader['altitude_m']=300
    assert 'B' not in a.commands([leader,follower],{},20)

