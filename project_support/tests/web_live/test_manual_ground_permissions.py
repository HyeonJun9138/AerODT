from project_support.tests.web_live.test_scenario_engine import engine_of,row

def test_manual_ground_pose_is_observed_but_not_submitted_as_automatic_progress():
    e=engine_of(row("F1","A1","VP1","VP2","06:30:00"))
    from user_application.uam_mission.ground_control import VertiportGroundControl
    e.ground_control=VertiportGroundControl()
    a=e.aircraft["A1"]
    for _ in range(300):
        e.advance(e.time_s+1)
        if a.phase=="gate_out" and a.ground:break
    assert a.phase=="gate_out" and a.ground
    a.external={"departed":True}
    a.latitude+=.0001
    observed=tuple(e._ground_observations())
    assert any(o.aircraft_id=="A1" for o in observed)
    before=(a.latitude,a.longitude)
    e._ground_permissions(e.time_s,observed)
    assert a.ground is None
    assert (a.latitude,a.longitude)==before
    assert any(o.aircraft_id=="A1" for o in e._ground_observations())
