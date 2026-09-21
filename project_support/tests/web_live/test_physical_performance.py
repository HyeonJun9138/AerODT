"""Preserve observations and decisions while removing scheduling stalls."""
import asyncio
from copy import deepcopy
import json
import random
import threading
import time
from types import SimpleNamespace
from unittest.mock import patch
import pytest
from data.ingestion.physical_packets import PhysicalPackets
from data.simulation.physical_operations import PhysicalOperationsRecords
from data.simulation.operations_records import _atomic_json
from digital_twin.model_library import ground_routes as geometry
from user_application.apps.physical_uam.fleet import PhysicalFleet
from user_application.apps.physical_uam.operations import FleetObservation
from user_application.uam_mission.scenario_observation import ScenarioObservation
from project_support.tests.web_live.test_physical_operations import journal
from collections import deque
from zlib import crc32


def test_latest_index_matches_retained_log_for_every_shard_cursor_and_eviction():
    store=PhysicalPackets(limit=53);retained=deque(maxlen=53);rng=random.Random(49)
    for sequence in range(1,201):
        p={'sequence':sequence,'aircraft_id':f'A{rng.randrange(13)}','samples':[sequence],'sensors':{'x':sequence}}
        retained.append(deepcopy(p));store.append(p);p['sensors']['x']=-1
        for shard in range(4):
            after=rng.randrange(sequence+1)
            selected=[p for p in retained if p['sequence']>after and crc32(p['aircraft_id'].encode())%4==shard]
            latest={p['aircraft_id']:p for p in selected}
            expected=sorted([dict(p,samples=[]) for p in latest.values()],key=lambda p:p['sequence'])
            body=store.read(after,latest_only=True,shard=shard,shards=4)
            assert body['packets']==expected
            assert body['coalesced_packets']==len(selected)-len(expected)
            if body['packets']:body['packets'][0]['sensors']['x']=-2
    store.clear();assert not store.read(latest_only=True)['packets'] and not store.by_aircraft


def test_point_broadphase_matches_exact_sweep_including_clipped_and_tangent_paths():
    rng=random.Random(7401)
    for case in range(3000):
        points=tuple((rng.uniform(-100,100),rng.uniform(-100,100)) for _ in range(rng.randint(1,12)))
        route=geometry.route_geometry(points);radius=rng.choice([0.,1e-6,7.,14.,rng.uniform(0,30)])
        point=(rng.uniform(-150,150),rng.uniform(-150,150))
        if case%3==0:point=(points[0][0]+radius,points[0][1])
        start=rng.random()*route.length_m;end=rng.uniform(start,route.length_m)
        expected=[]
        for _,a,b,origin,span in geometry._segments(route):
            if origin+span<start-geometry._EPS or origin>end+geometry._EPS:continue
            interval=geometry._circle_interval(a,b,point,radius)
            if interval is not None:
                low=max(start,origin+span*interval[0]);high=min(end,origin+span*interval[1])
                if low<=high+geometry._EPS:expected.append((low,high))
        assert route.occupied_intervals(geometry.route_geometry((point,)),radius,start,end)==geometry._merge(expected)


def test_record_cursor_handles_ring_eviction_and_does_not_copy_old_events():
    r=PhysicalOperationsRecords(None)
    events=[{'event_sequence':i,'detail':{'x':i}} for i in range(1,20001)]
    r.observe_events(events);events=events[5000:]+[{'event_sequence':20001,'detail':{'x':9}}]
    with patch('data.simulation.physical_operations.deepcopy',wraps=deepcopy) as copy:
        r.observe_events(events);r.observe_events(events)
        assert copy.call_count==1
    events[-1]['detail']['x']=99
    assert len(r.events)==20001 and r.events[-1]['detail']['x']==9


def test_cached_static_range_union_matches_flat_cells_for_sliding_boundaries():
    rng=random.Random(864)
    for _ in range(15):
        route=geometry.route_geometry(tuple((rng.uniform(-30,30),rng.uniform(-30,30)) for _ in range(18)))
        other=geometry.route_geometry(tuple((rng.uniform(-30,30),rng.uniform(-30,30)) for _ in range(26)))
        radius=geometry._route_cache_clearance(7.)
        groups=geometry._cells_by_other_segment(route,other,radius)
        for first in range(len(groups)):
            for last in range(first,len(groups)):
                expected=geometry._merge((lo,hi) for group in groups[first:last+1] for _,lo,hi in geometry._CELL.iter_unpack(group))
                assert geometry._segment_range_intervals(route,other,radius,first,last)==expected
        assert hash(route)==hash(geometry.RouteGeometry(route.points,route.distances,route.bounds))


def test_checkpoint_pins_generation_without_blocking_input_or_exposing_mutable_records(tmp_path):
    r,raw=journal(tmp_path);entered=threading.Event();finish=threading.Event();captured=[]
    def write(path,value):
        entered.set();assert finish.wait(3);captured.append(deepcopy(value))
    with patch('data.simulation.physical_operations.write_operations',side_effect=write):
        thread=threading.Thread(target=r.checkpoint);thread.start();assert entered.wait(2)
        try:
            public=r.analysis_input();public['events'][0]['event_sequence']=-9
            n=len(raw['events']);r.observe_events([dict(raw['events'][-1],event_sequence=n+1)])
            r.observe(r.frame,r.header,1001)
            assert len(r.analysis_input()['events'])==n+1
        finally:finish.set();thread.join(3)
    assert captured==[raw]


def test_record_json_preserves_unicode_values_limits_and_atomic_last_good_file(tmp_path):
    path=tmp_path/'operations.json'
    value={'schema_version':1,'plans':[{'name':'이착륙','value':[1,1.2,None,True]}]*500,'events':[]}
    _atomic_json(path,value,1000000);assert json.loads(path.read_text(encoding='utf-8'))==value
    original=path.read_bytes()
    with pytest.raises(ValueError):_atomic_json(path,value,100)
    assert path.read_bytes()==original and not list(tmp_path.glob('*.pending'))
    with pytest.raises(ValueError):_atomic_json(path,{'events':[{'x':float('nan')}]},1000)
    assert path.read_bytes()==original and not list(tmp_path.glob('*.pending'))


def test_overload_retains_unpublished_observations_with_original_times():
    async def run():
        f=PhysicalFleet(None,PhysicalPackets(),{},None)
        f.sensor_elapsed=10.;f.plan_time=100.;f.anchor=0.;f.sensor_epoch=990.;f.wait_s=0
        f.finished_at=None;f.last_overview=10.;f.last_operation_save=20.;f.paused=False
        f.active={'settings':{'repeat':False}};f.engine=SimpleNamespace(time_s=110.,opens_s=100.)
        f.samples={'A':[{'sample_time':999.}]}
        f.pending.append((19.,{'sequence':1,'aircraft_id':'A','sent_time':999.}))
        f.pending.append((21.,{'sequence':2,'aircraft_id':'A','sent_time':1000.}))
        async def step(dt):f.sensor_elapsed+=dt
        f.step=step
        with patch('user_application.apps.physical_uam.fleet.time.monotonic',return_value=20.),patch('user_application.apps.physical_uam.fleet.time.time',return_value=1020.):
            await f.tick()
        assert f.packets.read()['packets'][0]['sent_time']==999.
        assert f.packets.read()['packets'][0]['published_time']==1020.
        assert len(f.pending)==1 and f.pending[0][1]['sent_time']==1000.
        assert f.samples['A']==[{'sample_time':999.}]
    asyncio.run(run())


def test_completed_packets_publish_while_calculation_is_still_running():
    async def run():
        f=PhysicalFleet(None,PhysicalPackets(),{},None);gate=threading.Event();entered=threading.Event()
        def advance(dt):entered.set();assert gate.wait(3)
        f.advance_step=advance
        calculation=asyncio.create_task(f.step(.1));publisher=asyncio.create_task(f.publish())
        try:
            while not entered.is_set():await asyncio.sleep(.001)
            f.pending.append((time.monotonic(),{'sequence':1,'aircraft_id':'A'}))
            for _ in range(100):
                if f.packets.read()['packets']:break
                await asyncio.sleep(.005)
            assert f.packets.read()['packets'] and not calculation.done()
        finally:
            gate.set();await calculation;publisher.cancel();await asyncio.gather(publisher,return_exceptions=True)
    asyncio.run(run())


def test_checkpoint_does_not_hold_the_fleet_tick_and_shutdown_waits_for_it():
    async def run():
        f=PhysicalFleet(None,PhysicalPackets(),{},None);entered=threading.Event();release=threading.Event()
        f.sensor_elapsed=10.;f.plan_time=100.;f.anchor=time.monotonic()-10.;f.wait_s=0
        f.finished_at=None;f.last_overview=10.;f.paused=False
        f.active={'settings':{'repeat':False}};f.engine=SimpleNamespace(time_s=110.,opens_s=100.)
        def save():entered.set();return release.wait(3)
        f.operation_records.checkpoint=save
        try:
            await asyncio.wait_for(f.tick(),.5)
            while not entered.is_set():await asyncio.sleep(.001)
            assert not f.checkpoint_task.done()
            waiter=asyncio.create_task(f.finish_checkpoint());await asyncio.sleep(.02)
            assert not waiter.done()
        finally:release.set()
        await waiter
    asyncio.run(run())


@pytest.mark.parametrize('workers',[0,9,True,2.5])
def test_invalid_worker_counts_are_rejected(workers):
    with pytest.raises(ValueError):PhysicalFleet(None,PhysicalPackets(),{},None,physics_workers=workers)


def test_fleet_view_matches_shared_flight_details_without_per_aircraft_event_rescan():
    class Clearance:
        def as_dict(self):return {'stand':'G1'}
    aircraft={f'A{i}':SimpleNamespace(aircraft_id=f'A{i}',ready_s=1.3,completed=2,flights=[1,2,3],next_flight=2) for i in range(10)}
    events=[{'flight_id':f'F{i%10}','value':i} for i in range(1000)]
    flights={f'F{i}':{'flight_id':f'F{i}'} for i in range(10)}
    states=[{'aircraft_id':f'A{i}','flight_id':f'F{i}'} for i in range(10)]
    engine=SimpleNamespace(aircraft=aircraft,events=events,flights=flights,psu=SimpleNamespace(clearance=lambda _:Clearance()))
    engine._state=lambda a:states[int(a.aircraft_id[1:])]
    engine.flight_detail=lambda id:{'flight':dict(flights[id]),'clearance':Clearance().as_dict(),'events':[e for e in events if e['flight_id']==id][-20:]}
    standard=ScenarioObservation();standard.engine=engine
    fleet=SimpleNamespace(engine=engine,status={'status':'running'})
    fast=FleetObservation(fleet,states)
    for id in aircraft:assert fast.aircraft(id)==standard.aircraft(id)


def test_receiver_separates_source_work_from_post_publication_transport():
    from user_application.apps.web_dashboard.physical_input import PhysicalInput
    from project_support.tests.web_live.test_physical_uam import packet
    feed=PhysicalInput('http://source',lambda:True,lambda:False,{})
    p=packet(1000,1);p['published_time']=1000.4
    feed.records.register(p,1000.7,clock_offset_s=.1)
    with patch('user_application.apps.web_dashboard.physical_input.time.time',return_value=1000.8):
        result=feed.detail('physical:UAM0001')
    assert result['latency_breakdown']==pytest.approx({'sender_age_s':.4,'transport_s':.2,'receiver_age_s':.1})
    assert result['transport_latency_s']==pytest.approx(.2)
    assert result['sensors']==p['sensors']
