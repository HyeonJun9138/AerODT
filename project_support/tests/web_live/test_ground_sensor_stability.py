from copy import deepcopy
import math
from digital_twin.live_twin.uam_sensor_fusion import estimate
from project_support.tests.web_live.test_uam_alignment import measured


def parked(at,north=0,heading=145):
    r=measured(at,north,height=200+math.sin(at)*.7,heading=heading,noise=1)
    p=r['packet'];p['sensors']['gnss']['values']['velocity_ned_mps']=[.08,-.04,.05]
    p['sensors']['vehicle']['values'].update(flight_phase='parked',grounded=True)
    p['intent']['phase']='parked';p['report_hz']=1
    p['surface_reference']={'vertiport_id':'VP1','altitude_m':200}
    return r


def test_one_hz_parked_noise_settles_without_removing_raw_sensor_noise():
    old=None;poses=[];raw=[]
    for i in range(30):
        r=parked(1000+i,math.sin(i)*.8,145+math.sin(i)*.25);original=deepcopy(r)
        old=estimate(r,1000+i,old)
        assert r==original
        if i>=3:poses.append((old.position_ecef_m,old.heading_deg))
        raw.append(r['packet']['sensors']['gnss']['values']['latitude_deg'])
    assert max(raw)>min(raw)
    assert all(math.dist(p[0],poses[0][0])<1e-6 and p[1]==poses[0][1] for p in poses)
    assert old.estimation.stationary and old.estimation.surface_constrained
    assert abs(old.altitude_m-200)<1e-5
    assert math.hypot(*old.velocity_ecef_mps)<1e-8


def test_actual_taxi_and_airborne_transitions_release_ground_constraints():
    old=None
    for i in range(5):old=estimate(parked(1000+i),1000+i,old)
    start=old.position_ecef_m
    for i in range(1,7):
        at=1004+i*.2;r=parked(at,i*.4)
        r['packet']['sensors']['vehicle']['values']['flight_phase']='gate_out'
        r['packet']['sensors']['gnss']['values']['velocity_ned_mps']=[2,0,0]
        old=estimate(r,at,old)
        assert not old.estimation.stationary
    assert math.dist(start,old.position_ecef_m)>1
    r=parked(1005.4);r['packet']['sensors']['vehicle']['values'].update(flight_phase='takeoff',grounded=False)
    old=estimate(r,1005.4,old)
    assert not old.estimation.surface_constrained


def test_late_ahrs_holds_last_orientation_and_discloses_its_age():
    r=parked(1000,heading=145);old=estimate(r,1000)
    old=estimate(r,1004,old)
    assert old.heading_deg==145 and old.orientation_source=='attitude'
    assert old.estimation.attitude_age_s==4 and old.quality=='stale'
    assert not old.estimation.stationary


def test_motion_contradicting_parked_report_releases_stationarity():
    old=None
    for i in range(5):old=estimate(parked(1000+i),1000+i,old)
    r=parked(1005,1);r['packet']['sensors']['gnss']['values']['velocity_ned_mps']=[1,0,0]
    old=estimate(r,1005,old)
    assert not old.estimation.stationary


def test_delayed_parked_reports_keep_acquired_pose_without_claiming_freshness():
    old=None
    for i in range(5):old=estimate(parked(1000+i),1000+i,old)
    pose=old.position_ecef_m;heading=old.heading_deg
    r=parked(1004)
    old=estimate(r,1006.5,old)
    assert old.quality=='stale' and not old.estimation.stationary
    assert old.estimation_state.stationary_position is not None
    assert math.dist(pose,old.position_ecef_m)<1e-6 and old.heading_deg==heading
    # A late but consistent report, followed by recovery, is the same stop.
    for sample,wall in [(1006,1008.5),(1009,1009)]:
        old=estimate(parked(sample,.4,145.2),wall,old)
        assert math.dist(pose,old.position_ecef_m)<1e-6 and old.heading_deg==heading
    assert old.estimation.stationary
    # Fresh confirmation expires, but missing data is not movement: the last
    # stop pose remains until normal entity expiry, still marked stale.
    old=estimate(parked(1009,.4,145.2),1016,old)
    assert old.estimation_state.stationary_position is not None
    assert old.quality=='stale' and not old.estimation.stationary
    assert math.dist(pose,old.position_ecef_m)<1e-6
    assert estimate(parked(1009,.4,145.2),1040,old) is None


def test_delayed_motion_report_releases_retained_stop_immediately():
    old=None
    for i in range(5):old=estimate(parked(1000+i),1000+i,old)
    r=parked(1005,2);r['packet']['sensors']['gnss']['values']['velocity_ned_mps']=[2,0,0]
    old=estimate(r,1007.5,old)
    assert old.estimation_state.stationary_position is None


def test_ground_wait_can_settle_but_missing_contact_and_disabled_filter_cannot():
    old=None
    for i in range(5):
        r=parked(1000+i);r['packet']['sensors']['vehicle']['values']['flight_phase']='gate_out'
        r['packet']['operations']={'ground_waiting':True}
        old=estimate(r,1000+i,old)
    assert old.estimation.stationary
    r=parked(1005);del r['packet']['sensors']['vehicle']
    assert not estimate(r,1005,old).estimation.stationary
    disabled=estimate(parked(1005),1005,old,{'enabled':False})
    assert not disabled.estimation.stationary and not disabled.estimation.surface_constrained
