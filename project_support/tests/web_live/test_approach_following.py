"""Following traffic must retain space when its predecessor slows for approach."""
from user_application.uam_mission.traffic_awareness import TrafficAwareness

def following_rows(room=35):
    own=dict(aircraft_id='A',latitude_deg=37.,longitude_deg=127.,altitude_m=300,
        phase='cruise',heading_deg=0,speed_mps=45,right_room_m=room)
    ahead=dict(own,aircraft_id='B',latitude_deg=37.+400/111320,speed_mps=20)
    return [own,ahead]

def test_wing_speed_floor_does_not_prevent_checked_lateral_separation():
    c=TrafficAwareness().commands(following_rows(),{},0)['A']
    assert c['action']=='avoid_right'
    assert c['right_m']==35
    assert c['speed_factor']==.75

def test_no_lateral_room_preserves_speed_only_guidance():
    c=TrafficAwareness().commands(following_rows(0),{},0)['A']
    assert c['right_m']==0
    assert c['action']=='slow'

def test_lateral_separation_never_commands_left_or_more_than_available_room():
    c=TrafficAwareness().commands(following_rows(12),{},0)['A']
    assert 0<=c['right_m']<=12

def test_neighbor_in_the_right_lane_prevents_moving_into_it():
    rows=following_rows()
    neighbor=dict(rows[0],aircraft_id='C',longitude_deg=127.+35/(111320*.7986355))
    c=TrafficAwareness().commands([*rows,neighbor],{},0)['A']
    assert c['right_m']==0

