from types import SimpleNamespace
from user_application.uam_mission.replay_prediction import manual_reference

def entity(lat,lon,alt=100,heading=0):
    return SimpleNamespace(latitude_deg=lat,longitude_deg=lon,altitude_m=alt,heading_deg=heading,
        velocity_ecef_mps=None,entity_id='manual',state_time=10,flight_phase='cruise')

def test_passed_waypoint_is_not_retargeted_when_next_leg_climbs():
    plan={'legs':[{'stage':'cruise','path':[[127,37,100],[127,37.001,100],[127,37.01,1000]],'speed_mps':30}]}
    intent=manual_reference(entity(37.0015,127.0001),plan)
    assert intent.waypoints[0].end==(37.01,127,1000)

def test_nearby_opposite_direction_segment_does_not_replace_recent_progress():
    plan={'legs':[{'stage':'cruise','path':[[127,37,100],[127,37.01,100],[127.0001,37.01,100],[127.0001,37,100]]}]}
    prior=manual_reference(entity(37.008,127.0001,heading=180),plan)
    assert prior.waypoints[0].end==(37,127.0001,100)
    intent=manual_reference(entity(37.007,127,heading=180),plan,prior)
    assert intent.waypoints[0].end==prior.waypoints[0].end
