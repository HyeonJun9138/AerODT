from copy import deepcopy
import math
from digital_twin.live_twin.uam_sensor_fusion import estimate
from project_support.tests.web_live.test_uam_alignment import measured

def test_observed_pose_never_contains_the_wall_clock_extrapolation():
    r=measured(1000,0);r['packet']['sensors']['gnss']['sample_monotonic_s']=50
    original=deepcopy(r);a=estimate(r,1000);b=estimate(r,1001.5,a)
    assert math.dist(a.position_ecef_m,b.position_ecef_m)>20
    assert a.display_observation.position_ecef_m==b.display_observation.position_ecef_m
    assert b.display_observation.time==50 and b.display_observation.observation_time==1000
    assert b.display_observation.context==a.display_observation.context
    assert r==original

def test_rejected_fix_and_clock_correction_do_not_create_new_display_samples():
    r=measured(1000,0);r['packet']['sensors']['gnss']['sample_monotonic_s']=50;a=estimate(r,1000)
    bad=measured(1000.2,1000);bad['packet']['sensors']['gnss']['sample_monotonic_s']=50.2
    b=estimate(bad,1000.2,a)
    assert b.display_observation.time==a.display_observation.time
    assert b.display_observation.position_ecef_m==a.display_observation.position_ecef_m
    r['clock_offset_s']=2;c=estimate(r,1002.5,a)
    assert c.display_observation.time==50 and c.display_observation.observation_time==1002

def test_display_observation_wire_has_no_posterior_and_expired_fix_is_still_stale():
    import json
    from digital_twin.contracts.live import Snapshot
    from communication.web.wire_snapshot import encode_snapshot
    r=measured(1000,0);a=estimate(r,1000);b=estimate(r,1005,a)
    assert b.quality=='stale'
    wire=json.loads(encode_snapshot(Snapshot(1,1,1005,(b,),()),{}))
    e=wire['entities'][0]
    assert 'estimation_state' not in e and e['display_observation']['observation_time']==1000
    assert 'covariance' not in e['display_observation']


def test_legacy_held_fix_keeps_display_identity_across_clock_recalibration():
    r=measured(1000,0);r['packet']['sensors']['gnss'].pop('sample_monotonic_s',None);a=estimate(r,1000)
    r['clock_offset_s']=2;b=estimate(r,1002.4,a)
    assert a.display_observation.time==b.display_observation.time==1000
    assert a.display_observation.context==b.display_observation.context
    assert b.display_observation.observation_time==1002


def test_reacquisition_breaks_display_continuity_once_for_unobserved_motion():
    r=measured(1000,0);r['packet']['sensors']['gnss']['sample_monotonic_s']=50
    a=estimate(r,1000)
    r=measured(1003,60);r['packet']['sensors']['gnss']['sample_monotonic_s']=53
    b=estimate(r,1003,a);c=estimate(r,1003.1,b)
    assert b.discontinuity
    assert b.display_observation.context!=a.display_observation.context
    assert c.display_observation.context==b.display_observation.context


def test_host_pause_preserves_consistent_motion_without_shrinking_outage_limit():
    r=measured(1000,0);r['packet']['sensors']['gnss']['sample_monotonic_s']=50
    a=estimate(r,1000);stale=estimate(r,1002.5,a)
    assert stale.quality=='stale'
    r=measured(1003,4);r['packet']['sensors']['gnss']['sample_monotonic_s']=50.2
    b=estimate(r,1003,stale)
    assert not b.discontinuity and b.estimation.mode=='filtered'
    assert b.display_observation.context==a.display_observation.context


def test_borrowed_records_preserve_raw_data_and_return_only_immutable_estimates():
    from user_application.apps.web_dashboard.physical_input import PhysicalInput
    feed=PhysicalInput('',lambda:True,lambda:False,{});feed.active=True
    p=measured(1000,0)['packet'];feed.records.register(p,1000)
    before=feed.records.read();entities=()
    for i in range(20):entities=feed.entities(1000+i*.05,entities)
    assert feed.records.read()==before
    # Public readers still cannot change the stored sensor or accepted output.
    external=feed.records.read();external[0][1]['packet']['sensors']['gnss']['values']['latitude_deg']=0
    assert feed.records.read()==before
    assert entities[0].display_observation.position_ecef_m!=[0,0,0]


def test_disabling_forward_prediction_does_not_break_normal_observation_playback():
    cfg={'coast_seconds':0};a=estimate(measured(1000,0),1000,settings=cfg)
    b=estimate(measured(1000.2,4),1000.2,a,cfg)
    assert b.display_observation.context==a.display_observation.context and not b.discontinuity
    stale=estimate(measured(1000.2,4),1000.3,b,cfg)
    assert stale.estimation.prediction_seconds==0 and stale.quality=='stale'
