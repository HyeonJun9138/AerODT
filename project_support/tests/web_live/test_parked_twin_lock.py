"""Stop recognition must survive latency and isolated noisy observations."""
from copy import deepcopy
import math
from digital_twin.live_twin.uam_sensor_fusion import estimate
from digital_twin.simulation.physical_sensors import PhysicalSensors
from project_support.tests.web_live.test_ground_sensor_stability import parked
from project_support.tests.web_live.test_physical_uam import MODEL,record,packet,state


def acquire():
    old=None
    for i in range(5):old=estimate(parked(1000+i),1000+i,old)
    return old


def test_parked_candidate_does_not_walk_during_acquisition_or_regular_three_second_latency():
    old=None;poses=[]
    for i in range(18):
        r=parked(1000+i,math.sin(i)*.8,145+math.sin(i)*.25)
        old=estimate(r,1003+i,old)
        assert old.heading_deg is not None
        poses.append((*old.position_ecef_m,old.heading_deg,old.pitch_deg,old.roll_deg))
        assert old.quality=='stale' and not old.estimation.stationary
    assert all(math.dist(p,poses[0])<1e-6 for p in poses)
    assert old.estimation_state.stationary_position is not None
    # A fresh sample confirms the same stop without a display jump.
    old=estimate(parked(1018,.5),1018,old)
    assert old.estimation.stationary
    assert math.dist(old.position_ecef_m,poses[0][:3])<1e-6


def test_single_rejected_fix_or_ahrs_spike_cannot_unlock_a_parked_aircraft():
    for kind in ('gnss','ahrs','velocity'):
        old=acquire();pose=old.position_ecef_m;heading=old.heading_deg
        bad=parked(1005,100 if kind=='gnss' else .2,170 if kind=='ahrs' else 145)
        if kind=='velocity':bad['packet']['sensors']['gnss']['values']['velocity_ned_mps']=[20,0,0]
        original=deepcopy(bad)
        for tick in range(5):
            old=estimate(bad,1005+tick*.1,old)
            assert math.dist(old.position_ecef_m,pose)<1e-6
            assert old.heading_deg==heading
            assert old.estimation_state.stationary_position is not None
        assert original==bad
        old=estimate(parked(1006,.3),1006,old)
        assert math.dist(old.position_ecef_m,pose)<1e-6
        assert old.estimation.stationary


def test_sustained_displacement_and_rotation_can_override_a_stuck_parked_phase():
    for kind in ('position','rotation'):
        old=acquire()
        for i in range(3):
            r=parked(1005+i,50+i if kind=='position' else 0,165 if kind=='rotation' else 145)
            old=estimate(r,1005+i,old)
        assert old.estimation_state.stationary_position is None
        assert not old.estimation.stationary


def test_zero_speed_taxi_intent_releases_lock_without_waiting_for_gnss_motion():
    old=acquire()
    r=parked(1005);r['packet']['sensors']['vehicle']['values']['flight_phase']='gate_out'
    old=estimate(r,1005,old)
    assert old.estimation_state.stationary_position is None
    assert not old.estimation.stationary


def test_fresh_gyro_motion_releases_immediately_and_an_old_packet_cannot_extend_stop_grace():
    old=acquire();r=parked(1005)
    r['packet']['sensors']['imu']['values']['angular_rate_radps']=[0,0,.08]
    assert estimate(r,1005,old).estimation_state.stationary_position is None
    old=acquire();r=parked(1004)
    for tick in range(5):old=estimate(r,1004+tick,old)
    assert old.estimation_state.stationary_position is not None
    old=estimate(r,1011,old)
    assert old.estimation_state.stationary_position is not None
    assert old.quality=='stale' and not old.estimation.stationary
    assert estimate(r,1035,old) is None


def test_sparse_parked_reports_do_not_reanchor_at_each_six_second_gap():
    old=acquire();pose=old.position_ecef_m;heading=old.heading_deg
    for i in range(1,6):
        at=1004+i*9
        r=parked(at,math.sin(i),145+math.sin(i)*.3)
        old=estimate(r,at+3,old)
        old=estimate(r,at+7,old)
        assert math.dist(old.position_ecef_m,pose)<1e-6
        assert old.heading_deg==heading
        assert old.quality=='stale' and not old.estimation.stationary


def test_long_unobserved_interval_starts_a_new_pose_instead_of_retaining_an_old_gate():
    old=acquire()
    new=estimate(parked(1040,50),1040,old)
    assert new.discontinuity
    assert math.dist(new.position_ecef_m,old.position_ecef_m)>20


def test_real_sensor_generator_noise_at_one_hz_with_jitter_is_stable_after_stop_capture():
    for seed in range(8):
        sensor=PhysicalSensors(MODEL,seed=seed);old=None;poses=[];target=0
        true=state();true.update(velocity_ned_mps=[0,0,0],grounded=True,heading_deg=145,tilt_deg=0,rotor_radps=0)
        for i in range(60):
            at=1000+i;sensor.sample(true,i,at,'parked');p=packet(at,i+1)
            p.update(sensors=deepcopy(sensor.latest),report_hz=1,surface_reference={'vertiport_id':'VP1','altitude_m':200})
            p['intent']['phase']='parked'
            lag=[.4,1.1,2.4,3.1][i%4]
            target=max(target+.1,at+lag)
            old=estimate(record(p),target,old)
            if i>=5:poses.append((*old.position_ecef_m,old.heading_deg,old.pitch_deg,old.roll_deg))
        assert all(math.dist(p,poses[0])<1e-6 for p in poses),seed
