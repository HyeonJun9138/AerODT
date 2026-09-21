import asyncio
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import patch
import pytest
from communication.external.physical_polls import PhysicalPolls
from data.ingestion.physical_packets import PhysicalPackets
from data.ingestion.uam_sensor_records import UamSensorRecords
from user_application.apps.physical_uam.fleet import PhysicalFleet
from project_support.tests.web_live.test_physical_uam import packet


def test_four_shards_cover_each_aircraft_exactly_once():
    store=PhysicalPackets()
    for seq in range(1,301):
        store.append({'sequence':seq,'aircraft_id':f'UAM{seq%100:04}','aircraft_sequence':seq//100+1,'samples':[{'huge':'raw'}]})
    parts=[store.read(latest_only=True,shard=i,shards=4) for i in range(4)]
    ids=[p['aircraft_id'] for part in parts for p in part['packets']]
    assert len(ids)==len(set(ids))==100
    assert max(len(part['packets']) for part in parts)<35
    assert all(not p['samples'] for part in parts for p in part['packets'])
    for args in [dict(shards=9),dict(shards=4,shard=4),dict(shards=0)]:
        with pytest.raises(ValueError):store.read(**args)


def test_cross_aircraft_arrival_order_is_not_mistaken_for_old_telemetry():
    store=UamSensorRecords()
    def p(aircraft,seq,own,at=1000):
        x=packet(at,seq);x.update(aircraft_id=aircraft,aircraft_sequence=own);return x
    assert store.register(p('A',100,1),1000,unordered=True)
    assert store.register(p('B',90,1),1000,unordered=True)
    assert store.register(p('B',95,2,1001),1001,unordered=True)
    assert not store.register(p('B',91,1),1001,unordered=True)
    assert store.sequence==100 and store.missing==0
    assert store.register(p('A',110,3,1002),1002,unordered=True)
    assert store.missing==1
    original=deepcopy(store.read('physical:A'))
    assert not store.register(p('A',111,4,999),1003,unordered=True)
    assert store.read('physical:A')==original


def test_lightweight_status_preserves_held_sensor_time_and_clock_offset():
    store=UamSensorRecords();assert store.latest_observation_time()==0
    store.register(packet(),1000.1,clock_offset_s=2)
    late=packet(999,2);late['sent_time']=1001
    assert store.register(late,1001.1,clock_offset_s=2)
    assert store.latest_observation_time()==1002
    missing=packet(1002,3);missing['sensors'].pop('gnss')
    store.register(missing,1002.1,clock_offset_s=2)
    assert store.latest_observation_time()==1002
    store.clear();assert store.latest_observation_time()==0


def test_slow_shard_does_not_block_fast_shards_and_cancellation_drains_tasks():
    async def run():
        gate=asyncio.Event();started=set();closed=[]
        async def fetch(client,url,*,shard,shards,**_):
            started.add(shard)
            try:
                if shard==0:await gate.wait()
                return {'packets':[{'aircraft_sequence':1}],'shard':shard,'shards':shards,'latest_sequence':shard+1}
            finally:closed.append(shard)
        async with PhysicalPolls(None,fetch) as polls:
            parts=[await asyncio.wait_for(polls.read('test',shards=4),.5) for _ in range(3)]
            assert {b['shard'] for b in parts}=={1,2,3}
            assert started=={0,1,2,3} and 0 not in closed
        assert 0 in closed and not polls.tasks
    asyncio.run(run())


def test_overload_keeps_sensor_identity_and_yields_after_bounded_advances():
    async def run():
        f=PhysicalFleet(None,PhysicalPackets(),{},None)
        f.sensor_elapsed=10.;f.plan_time=100.;f.anchor=0.;f.sensor_epoch=990.;f.wait_s=0
        f.finished_at=None;f.last_overview=10.;f.paused=False
        f.active={'settings':{'repeat':False}}
        f.engine=SimpleNamespace(time_s=110.,opens_s=100.)
        sensor=object();f.samplers={'A':sensor};f.missions={'A':{'id':'same','start':995.}}
        f.samples={'A':[{'sample_time':999.}]};f.pending.append((0,{'sequence':1}))
        calls=[]
        async def step(dt):calls.append(dt);f.sensor_elapsed+=dt
        f.step=step;f.update_overview=lambda:None
        with patch('user_application.apps.physical_uam.fleet.time.monotonic',return_value=20.),patch('user_application.apps.physical_uam.fleet.time.time',return_value=1020.):
            await f.tick()
        assert f.samplers['A'] is sensor and f.missions['A']=={'id':'same','start':995.}
        assert f.sensor_elapsed==pytest.approx(10.1) and len(calls)<=2
        assert f.sensor_epoch+f.sensor_elapsed==pytest.approx(1020.)
        assert not f.pending and f.samples['A']==[{'sample_time':999.}]
        assert f.packets.read()['packets']==[{'sequence':1,'published_time':1020.}]
        await f.finish_checkpoint()
    asyncio.run(run())


def test_parallel_latest_api_is_bounded_and_returns_disjoint_json_shards():
    import httpx
    from fastapi import FastAPI
    from communication.web.physical_publisher_routes import create_publisher_router
    store=PhysicalPackets()
    for i in range(100):store.append({'sequence':i+1,'aircraft_id':f'A{i}','aircraft_sequence':1})
    def telemetry(after,process,aircraft=None,delivery='ordered',shard=0,shards=1):
        return store.read(after,aircraft,latest_only=delivery=='latest',shard=shard,shards=shards)
    app=FastAPI();app.include_router(create_publisher_router(status=lambda:{},telemetry=telemetry,plan=lambda:{},
        truth=lambda:{},control=lambda *_:True,page=lambda:''))
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
            results=await asyncio.gather(*(client.get(f'/api/v1/telemetry?delivery=latest&shards=4&shard={i}') for i in range(4)))
            ids=[p['aircraft_id'] for r in results for p in r.json()['packets']]
            assert len(ids)==len(set(ids))==100
            for query in ['shards=100','shards=4&shard=4&delivery=latest','shards=4&delivery=ordered']:
                assert (await client.get('/api/v1/telemetry?'+query)).status_code==422
    asyncio.run(run())
