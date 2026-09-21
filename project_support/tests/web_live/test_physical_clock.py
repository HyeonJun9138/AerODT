"""Clock drift must not discard valid telemetry or re-assimilate held sensors."""
import asyncio
from copy import deepcopy
from dataclasses import replace
import math
import pytest
from communication.external.physical_clock import PhysicalClock
from communication.external.physical_uam import validate_packet
from digital_twin.live_twin.uam_sensor_fusion import estimate
from project_support.tests.web_live.test_uam_alignment import measured
from project_support.tests.web_live.test_parked_twin_lock import acquire
from project_support.tests.web_live.test_ground_sensor_stability import parked

def probe_value(offset,at=1000,rtt=.02):
    return dict(requested=at,received=at+rtt,source_time=at+rtt/2-offset,telemetry_shards=4)

def test_clock_shift_recovers_packets_rejected_by_the_initial_fixed_offset():
    clock=PhysicalClock(None);clock.accept(probe_value(1.26))
    record=measured(1010,200)
    with pytest.raises(ValueError):validate_packet(record['packet'],1008-clock.value['offset_s'])
    clock.accept(probe_value(-1.98,1008))
    validate_packet(record['packet'],1008.04-clock.value['offset_s'])
    assert clock.value['corrections']==1 and clock.value['uncertainty_s']==pytest.approx(.01)

def test_network_jitter_does_not_shift_an_offset_inside_the_probe_interval():
    clock=PhysicalClock(None);clock.accept(probe_value(-2))
    for i in range(10):clock.accept(probe_value(-2+(i-5)*.01,1010+i,rtt=.3))
    assert clock.value['offset_s']==pytest.approx(-2) and clock.value['corrections']==0

def test_refresh_is_nonblocking_and_old_source_probe_is_cancelled():
    async def run():
        gate=asyncio.Event();calls=[];cancelled=[]
        async def probe(client,url,process):
            calls.append((url,process))
            if len(calls)==2:
                try:await gate.wait()
                finally:cancelled.append(process)
            return probe_value(-2 if process=='one' else 3)
        async with PhysicalClock(None,probe,interval=0) as clock:
            initial=await clock.read('a','one')
            assert await asyncio.wait_for(clock.read('a','one'),.1)==initial
            await asyncio.sleep(0)
            for _ in range(20):assert await asyncio.wait_for(clock.read('a','one'),.1)==initial
            assert len(calls)==2
            changed=await clock.read('b','two',1)
            assert cancelled==['one'] and changed['offset_s']==pytest.approx(3)
        assert clock.task is None
    asyncio.run(run())

def test_failed_refresh_preserves_working_mapping_and_first_failure_retries():
    async def run():
        count=0
        async def probe(*_):
            nonlocal count
            count+=1
            if count!=2:raise TimeoutError()
            return probe_value(-2)
        async with PhysicalClock(None,probe,interval=0) as clock:
            with pytest.raises(TimeoutError):await clock.read('a','p')
            initial=await clock.read('a','p')
            await clock.read('a','p');await asyncio.sleep(0)
            assert await clock.read('a','p')==initial
    asyncio.run(run())

@pytest.mark.parametrize('offset',[-3.24,3.24,.03])
def test_held_fix_after_clock_correction_is_not_a_new_measurement(offset):
    record=measured(1000,0);old=estimate(record,1000)
    original=deepcopy(record);record['clock_offset_s']=offset
    changed=estimate(record,1000+offset+.2,old)
    baseline=estimate(original,1000.2,old)
    assert changed.estimation_state.covariance==old.estimation_state.covariance
    assert changed.estimation_state.position==old.estimation_state.position
    assert changed.estimation_state.seen_gnss==pytest.approx(1000+offset)
    assert math.dist(changed.position_ecef_m,baseline.position_ecef_m)<1e-6
    assert changed.estimation.observation_age_s==pytest.approx(.2)
    assert changed.estimation.gnss_outliers==0 and not changed.discontinuity
    later=estimate(measured(1000.2,4)|{'clock_offset_s':offset},1000.2+offset,changed)
    assert later.estimation.mode=='filtered' and later.estimation.gnss_outliers==0

def test_clock_correction_preserves_parked_lock_and_outlier_candidate_counts():
    old=acquire();r=parked(1004);r['clock_offset_s']=-3.24
    changed=estimate(r,1004-3.24,old)
    assert changed.position_ecef_m==old.position_ecef_m and changed.heading_deg==old.heading_deg
    assert changed.estimation_state.stationary_since==pytest.approx(old.estimation_state.stationary_since-3.24)
    assert changed.estimation.stationary
    bad=measured(1010,1000);old=estimate(measured(1009,0),1009)
    old=estimate(bad,1010,old);bad['clock_offset_s']=.5
    again=estimate(bad,1010.5,old)
    assert again.estimation_state.candidate_count==old.estimation_state.candidate_count
    assert again.estimation.gnss_outliers==old.estimation.gnss_outliers

def test_clock_correction_never_extends_the_actual_outage_limit():
    r=measured(1000,0);old=estimate(r,1000);r['clock_offset_s']=3
    a=estimate(r,1008,old);b=estimate(r,1015,a)
    assert a.estimation.mode==b.estimation.mode=='frozen'
    assert a.position_ecef_m==b.position_ecef_m
    assert a.estimation.observation_age_s==5 and b.estimation.observation_age_s==12

def test_slow_physical_clock_does_not_turn_consistent_motion_into_rejected_fixes():
    old=None;utc=1000.;frozen=0
    for i in range(240):
        utc+=.2+(1.0 if i%5==0 else 0)
        r=measured(utc,4*i,noise=1)
        r['packet']['sensors']['gnss']['sample_monotonic_s']=50+i*.2
        old=estimate(r,utc+.1,old)
        frozen+=old.estimation.mode=='frozen'
    assert old.estimation.gnss_outliers==0 and frozen==0
    # No new measurement: the same wall-clock outage still freezes at 2 s.
    stopped=estimate(r,utc+3,old)
    assert stopped.estimation.mode=='frozen' and stopped.estimation.observation_age_s==3

def test_impossible_position_is_still_rejected_with_an_emulated_motion_clock():
    r=measured(1000,0);r['packet']['sensors']['gnss']['sample_monotonic_s']=20
    old=estimate(r,1000)
    bad=measured(1001,1000);bad['packet']['sensors']['gnss']['sample_monotonic_s']=20.2
    rejected=estimate(bad,1001,old)
    assert rejected.estimation.gnss_outliers==1 and rejected.observation_time==1000

@pytest.mark.parametrize('bad',[float('nan'),-1,True])
def test_invalid_optional_sensor_clock_is_rejected_at_the_wire(bad):
    r=measured(1000,0);r['packet']['sensors']['gnss']['sample_monotonic_s']=bad
    with pytest.raises(ValueError):validate_packet(r['packet'],1000)
