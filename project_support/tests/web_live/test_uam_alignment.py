"""Regression cases for received-sensor alignment, gaps and bad fixes."""
from copy import deepcopy
from dataclasses import replace
import math,random
import pytest
from foundation.geodesy import to_ecef
from digital_twin.live_twin.uam_sensor_fusion import estimate
from project_support.tests.web_live.test_physical_uam import packet,record

def measured(at,north,*,east=0,height=200,heading=0,noise=0):
    p=packet(at,int(round((at-1000)*10))+1)
    p['sensors']['gnss']['values'].update(latitude_deg=37.55+north/111000,longitude_deg=127+east/(111000*math.cos(math.radians(37.55))),
        altitude_ellipsoid_m=height,velocity_ned_mps=[20,0,0])
    p['sensors']['gnss']['uncertainty'].update(position_variance_ned_m2=[max(.25,noise**2)]*3,velocity_variance_m2ps2=[.04]*3)
    p['sensors']['barometer']['values']['altitude_ellipsoid_m']=height
    p['sensors']['ahrs']['values'].update(heading_deg=heading,pitch_deg=0,roll_deg=0)
    return record(p)

def test_single_bad_gnss_fix_does_not_teleport_the_twin():
    prior=None
    for i in range(25):prior=estimate(measured(1000+i*.2,4*i),1000+i*.2,prior)
    bad=measured(1005,180)
    entity=estimate(bad,1005,prior)
    expected=to_ecef(37.55+100/111000,127,200)
    assert math.dist(entity.position_ecef_m,expected)<5
    assert entity.estimation.mode=='outlier_rejected'
    assert entity.observation_time==prior.observation_time
    again=estimate(bad,1005.1,entity)
    assert again.estimation.gnss_outliers==entity.estimation.gnss_outliers
    recovered=estimate(measured(1005.2,104),1005.2,again)
    assert recovered.estimation.mode=='filtered'

def test_covariance_filter_reduces_measurement_noise_without_a_truth_input():
    rng=random.Random(621);prior=None;raw=[];filtered=[]
    for i in range(180):
        at=1000+i*.2;north=i*4;noise=rng.gauss(0,3)
        r=measured(at,north+noise,noise=3)
        original=deepcopy(r);prior=estimate(r,at,prior)
        assert r==original
        if i>20:
            truth=to_ecef(37.55+north/111000,127,200)
            raw.append(noise**2);filtered.append(math.dist(prior.position_ecef_m,truth)**2)
    assert math.sqrt(sum(filtered)/len(filtered))<.8*math.sqrt(sum(raw)/len(raw))

def test_short_gap_grows_uncertainty_then_freezes_without_freshening_observation():
    r=measured(1000,0);a=estimate(r,1000);b=estimate(r,1001,a);c=estimate(r,1003,b);d=estimate(r,1007,c)
    assert b.estimation.mode=='coasting'
    assert b.estimation.horizontal_sigma_m>a.estimation.horizontal_sigma_m
    assert c.estimation.mode==d.estimation.mode=='frozen'
    assert math.dist(c.position_ecef_m,d.position_ecef_m)<1e-6
    assert a.observation_time==b.observation_time==c.observation_time==1000
    assert c.quality=='stale'

def test_heading_wrap_and_spike_are_stabilized():
    a=estimate(measured(1000,0,heading=359),1000)
    b=estimate(measured(1000.2,4,heading=1),1000.2,a)
    assert abs((b.heading_deg+180)%360-180)<2
    c=estimate(measured(1000.4,8,heading=170),1000.4,b)
    assert abs((c.heading_deg-b.heading_deg+180)%360-180)<5
    assert c.estimation.attitude_outliers==1

def test_future_fix_and_old_baro_are_not_applied_at_the_current_epoch():
    a=estimate(measured(1000,0),1000)
    future=measured(1004,500)
    b=estimate(future,1000.2,a)
    assert b is not None and b.observation_time==1000
    r=measured(1000.4,8)
    r['packet']['sensors']['barometer']['sample_time']=990
    r['packet']['sensors']['barometer']['values']['altitude_ellipsoid_m']=600
    c=estimate(r,1000.4,b)
    assert abs(c.altitude_m-200)<1
    assert not c.estimation.barometer_used

def test_mission_change_resets_filter_and_never_blends_two_aircraft():
    a=estimate(measured(1000,0),1000)
    r=measured(1001,1000);r['continuity']=2
    b=estimate(r,1001,a)
    assert b.discontinuity and b.continuity_id==2
    assert b.estimation.gnss_outliers==0


def test_late_and_missing_sensors_keep_their_own_timestamp_and_raw_packet():
    from data.ingestion.uam_sensor_records import UamSensorRecords
    store=UamSensorRecords();p=packet(1000,1);store.register(p,1000)
    late=packet(1001,2);late['sensors']['gnss']['sample_time']=999
    original=deepcopy(late);assert store.register(late,1001)
    r=store.read('physical:UAM0001')
    assert r['packet']==original and r['aligned_sensors']['gnss']['sample_time']==1000
    assert r['aligned_sensors']['ahrs']['sample_time']==1001
    assert r['sensor_alignment']['late']==['gnss']
    missing=packet(1002,3);del missing['sensors']['gnss'];store.register(missing,1002)
    r=store.read('physical:UAM0001')
    assert 'gnss' not in r['packet']['sensors']
    assert estimate(r,1002).observation_time==1000
    assert 'gnss' in r['sensor_alignment']['held']
    missing.update(mission_id='other',sequence=4);store.register(missing,1002)
    assert estimate(store.read('physical:UAM0001'),1002) is None


def test_repeated_world_ticks_do_not_shrink_the_measurement_covariance():
    r=measured(1000,0,noise=3);a=estimate(r,1000);p=a.estimation_state
    for i in range(1,100):a=estimate(r,1000+i*.01,a)
    assert a.estimation_state.covariance==p.covariance
    assert a.estimation_state.time==1000
    assert a.estimation.horizontal_sigma_m>math.sqrt(p.covariance[0][0]+p.covariance[1][0])


def test_uncertainty_budget_freezes_early_and_configuration_resets_continuity():
    r=measured(1000,0,noise=1);policy={'coast_seconds':5,'max_sigma_m':3}
    a=estimate(r,1000,settings=policy);b=estimate(r,1004,a,policy);c=estimate(r,1008,b,policy)
    assert b.valid_until<1005 and b.estimation.mode=='frozen'
    assert b.position_ecef_m==c.position_ecef_m
    fresh=estimate(measured(1008.2,164,noise=1),1008.2,c,{'enabled':False})
    assert fresh.estimation.mode=='aligned' and fresh.discontinuity


def test_reacquisition_requires_consistent_fixes_and_never_accepts_impossible_speed():
    a=estimate(measured(1000,0),1000)
    for i in range(3):
        at=1003+i*.2;a=estimate(measured(at,500+4*i),at,a)
        assert a.estimation.mode==('reacquired' if i==2 else 'frozen')
    assert a.discontinuity and a.observation_time==1003.4
    for i in range(5):
        at=1007+i*.2;r=measured(at,600+400*i)
        r['packet']['sensors']['gnss']['values']['velocity_ned_mps']=[2000,0,0]
        a=estimate(r,at,a)
    assert a.observation_time==1003.4 and a.estimation.mode=='frozen'


def test_covariance_stays_positive_semidefinite_across_maneuvers():
    rng=random.Random(302);a=None
    for i in range(600):
        r=measured(1000+i*.1,2*i+rng.gauss(0,2),east=8*math.sin(i*.02),noise=2)
        a=estimate(r,1000+i*.1,a)
        for pp,pv,vv in a.estimation_state.covariance:
            assert pp>0 and vv>0 and pp*vv-pv*pv>=-1e-10


def test_wire_exposes_diagnostics_without_internal_filter_memory():
    import json
    from digital_twin.contracts.live import Snapshot
    from communication.web.wire_snapshot import encode_snapshot
    e=estimate(measured(1000,0),1000)
    result=json.loads(encode_snapshot(Snapshot(1,1,1000,(e,),()),{}))
    wire=result['entities'][0]
    assert wire['estimation']['mode']=='filtered'
    assert 'estimation_state' not in wire and 'anchor' not in wire['estimation']


def test_alignment_api_validates_and_persists_without_touching_raw_measurements(tmp_path):
    import asyncio,httpx
    from fastapi import FastAPI
    from communication.web.physical_uam_routes import create_physical_uam_router
    from user_application.apps.web_dashboard.physical_input import PhysicalInput
    from data.settings.uam_alignment import UamAlignmentSettings
    path=tmp_path/'alignment.json'
    feed=PhysicalInput('',lambda:True,lambda:False,{},alignment_store=UamAlignmentSettings(path))
    feed.records.register(packet(),1000);before=feed.records.read()
    async def run():
        app=FastAPI();app.include_router(create_physical_uam_router(feed))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
            assert (await client.get('/api/live/uam/alignment')).json()['settings']['coast_seconds']==2
            response=await client.put('/api/live/uam/alignment',json={'coast_seconds':3})
            assert response.status_code==200 and response.json()['settings']['coast_seconds']==3
            for value in [{'coast_seconds':-1},{'max_sigma_m':0},{'enabled':1},[],{'unknown':1}]:
                assert (await client.put('/api/live/uam/alignment',json=value)).status_code==422
            assert (await client.put('/api/live/uam/alignment',json={},headers={'Origin':'https://foreign.example'})).status_code==403
    asyncio.run(run())
    assert feed.records.read()==before
    assert PhysicalInput('',lambda:True,lambda:False,{},alignment_store=UamAlignmentSettings(path)).alignment['coast_seconds']==3


def test_prediction_history_uses_stabilized_world_and_remains_ready_between_gnss_reports():
    from user_application.apps.web_dashboard.physical_input import PhysicalInput
    feed=PhysicalInput('',lambda:True,lambda:False,{});feed.active=True
    old=()
    for i in range(310):
        at=1000+i*.1
        if i%2==0:
            p=measured(at,i*2,noise=2)['packet']
            feed.records.register(p,at)
        old=feed.entities(at,old)
    capture=feed.capture(old[0])
    assert all(w['status']=='ready' for w in capture['windows'].values())
    before=feed.history.latest(old[0].entity_id,capture['context'])
    feed.records.register(measured(1031,1000)['packet'],1031)
    rejected=feed.entities(1031,old)[0]
    assert rejected.estimation.mode=='outlier_rejected' and feed.capture(rejected) is None
    assert feed.history.latest(old[0].entity_id,capture['context'])==before
