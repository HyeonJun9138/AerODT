import json
import pytest
from communication.twinning_tcp import parse_message
from digital_twin.runtime.twinning_test import TwinningTestRuntime


def packet(seq=1, stamp=10000, **sensors):
    return json.dumps(dict(version=2, device_id='phone', seq=seq,
                          sent_at_unix_ms=stamp, **sensors)).encode()+b'\n'


def gps(stamp=10000, **changes):
    return dict(observed_at_unix_ms=stamp, latitude_deg=37.5, longitude_deg=127.0,
                altitude_m=50., altitude_reference='msl', horizontal_accuracy_m=5.,
                vertical_accuracy_m=8., **changes)


def test_v2_gps_only_and_acceleration_explicit_units():
    s=parse_message(packet(gps=gps()))
    assert s.gps.latitude_deg == 37.5 and s.roll_deg is None
    a=dict(observed_at_unix_ms=10000, x_mps2=1., y_mps2=2., z_mps2=-9.8,
           includes_gravity=True, frame='body_frd')
    assert parse_message(packet(acceleration=a)).acceleration.includes_gravity
    for value in (dict(a, frame='unknown'), dict(a, includes_gravity='true'), dict(a, x_mps2=float('nan'))):
        with pytest.raises(ValueError): parse_message(packet(acceleration=value))


def test_bad_gps_and_missing_observation_time_are_rejected():
    for changes in ({'latitude_deg':91}, {'longitude_deg':181}, {'horizontal_accuracy_m':-1},
                    {'altitude_reference':'unknown'}, {'altitude_m':float('nan')}, {'observed_at_unix_ms':None}):
        with pytest.raises(ValueError): parse_message(packet(gps=dict(gps(), **changes)))
    with pytest.raises(ValueError): parse_message(packet())


def test_sensor_freshness_is_independent_and_duplicates_do_not_refresh():
    r=TwinningTestRuntime()
    r.observe(parse_message(packet(gps=gps())), 1)
    r.observe(parse_message(packet(seq=2,stamp=11000,gps=gps())), 2)
    s=r.snapshot(7)
    assert s.sensors['gps']['status']=='stale'
    assert s.sensors['attitude']['status']=='waiting'
    r.observe(parse_message(packet(seq=3,stamp=17000,attitude=dict(observed_at_unix_ms=17000,
                  roll_deg=10,pitch_deg=20,yaw_deg=30))), 8)
    s=r.snapshot(8)
    assert s.sensors['attitude']['status']=='receiving' and s.sensors['gps']['status']=='stale'


def test_gps_first_valid_altitude_anchors_height_and_reset_clears_it():
    r=TwinningTestRuntime()
    r.observe(parse_message(packet(gps=gps())), 1)
    assert r.snapshot(1).gps_height_above_start_m == 0
    r.observe(parse_message(packet(seq=2,stamp=11000,gps=dict(gps(11000),altitude_m=62.5))), 2)
    s=r.snapshot(2)
    assert s.gps_height_above_start_m == 12.5
    assert s.gps.altitude_m == 62.5
    previous=s.session_id
    r.reset()
    assert r.snapshot(3).gps is None and r.snapshot(3).session_id > previous


def test_old_source_observation_is_not_fresh_or_a_height_origin():
    r=TwinningTestRuntime()
    r.observe(parse_message(packet(stamp=20000,gps=gps())), 1)
    assert r.snapshot(1).sensors['gps']['status']=='stale'
    assert r.snapshot(1).gps_origin_altitude_m is None


def test_history_is_bounded_and_only_keeps_received_sensor_values():
    from data.ingestion.twinning_test_history import TwinningTestHistory
    history=TwinningTestHistory()
    runtime=TwinningTestRuntime()
    for seq in range(1500):
        sample=parse_message(packet(seq=seq,stamp=10000+seq*100,gps=gps(10000+seq*100)))
        history.observe(sample, runtime.observe(sample, seq*.1), seq*.1)
    result=history.read(150.,runtime.session_id)
    assert len(result['rows']) <= 1200
    assert all(row['time_s'] >= 90 for row in result['rows'])
    assert result['rows'][-1]['attitude'] is None
    before=len(result['rows'])
    history.observe(sample, {}, 150.)
    assert len(history.read(150.,runtime.session_id)['rows']) == before


def test_tcp_counts_real_bytes_and_sequence_gaps():
    import asyncio
    from communication.twinning_tcp import TcpAttitudeReceiver
    async def run():
        receiver=TcpAttitudeReceiver(lambda sample: None)
        await receiver.start('127.0.0.1',0)
        try:
            reader,writer=await asyncio.open_connection('127.0.0.1',receiver.port)
            raw=packet(seq=1,gps=gps())+packet(seq=4,gps=gps())
            writer.write(raw);await writer.drain()
            for _ in range(100):
                if getattr(receiver,'received_bytes',0)==len(raw): break
                await asyncio.sleep(.01)
            assert receiver.received_bytes==len(raw)
            assert receiver.sequence_gaps==2
            writer.close();await writer.wait_closed()
        finally: await receiver.stop()
    asyncio.run(run())


def test_sixty_hz_history_does_not_collapse_into_one_sliding_bucket():
    from data.ingestion.twinning_test_history import TwinningTestHistory
    history=TwinningTestHistory()
    runtime=TwinningTestRuntime()
    for seq in range(180):
        stamp=10000+seq*16
        sample=parse_message(packet(seq=seq,stamp=stamp,attitude=dict(observed_at_unix_ms=stamp,
                            roll_deg=seq/10,pitch_deg=0,yaw_deg=0)))
        history.observe(sample,runtime.observe(sample,seq/60),seq/60)
    rows=history.read(3,runtime.session_id)['rows']
    assert 55 <= len(rows) <= 61
    assert rows[-1]['attitude'][0]==17.9


def test_changed_altitude_datum_does_not_invent_relative_height():
    r=TwinningTestRuntime()
    r.observe(parse_message(packet(gps=gps())),1)
    r.observe(parse_message(packet(seq=2,stamp=11000,gps=dict(gps(11000),altitude_reference='wgs84_ellipsoid',altitude_m=80))),2)
    assert r.snapshot(2).gps_height_above_start_m is None
    assert r.snapshot(2).gps_origin_altitude_m==50

def test_bandwidth_keeps_high_rate_reads_in_time_buckets(monkeypatch):
    import communication.twinning_tcp as tcp
    receiver=tcp.TcpAttitudeReceiver(lambda sample: None)
    for i in range(400):
        monkeypatch.setattr(tcp.time,'monotonic',lambda i=i: 10+i/200)
        receiver.record_bytes(100)
    monkeypatch.setattr(tcp.time,'monotonic',lambda:12)
    assert 19500 <= receiver.bytes_per_second() <= 20000
    assert receiver.received_bytes==40000
    assert len(receiver.byte_samples)<=42

def test_wire_diagnostic_preserves_ignored_fields_and_clears():
    import asyncio
    from communication.twinning_tcp import TcpAttitudeReceiver
    async def run():
        r=TcpAttitudeReceiver(lambda sample:None)
        await r.start('127.0.0.1',0)
        try:
            _,w=await asyncio.open_connection('127.0.0.1',r.port)
            raw=b'{"version":1,"device_id":"phone","seq":1,"sent_at_unix_ms":1,"attitude":{"roll_deg":0,"pitch_deg":0,"yaw_deg":0},"extra_sensor":{"x":12}}\n'
            w.write(raw);await w.drain()
            for _ in range(100):
                if r.received_bytes:break
                await asyncio.sleep(.01)
            assert r.last_wire==raw.decode()
            r.reset_statistics()
            assert r.last_wire is None
            w.close();await w.wait_closed()
        finally:await r.stop()
    asyncio.run(run())

def test_wire_diagnostic_is_loopback_only_and_not_cached():
    from types import SimpleNamespace
    from fastapi import FastAPI
    import httpx
    from communication.web.twinning_test_routes import create_twinning_test_router
    async def run():
        app=FastAPI()
        app.include_router(create_twinning_test_router(SimpleNamespace(receiver=SimpleNamespace(last_wire='example'))))
        for host,code in [('127.0.0.1',200),('192.0.2.1',403)]:
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app,client=(host,123)),base_url='http://test') as c:
                response=await c.get('/api/twinning-test/wire')
                assert response.status_code==code
                if code==200:
                    assert response.json()=={'wire':'example'}
                    assert response.headers['cache-control']=='no-store'
    import asyncio
    asyncio.run(run())


def test_a_simulator_fix_without_height_or_accuracy_is_accepted_as_sent():
    # What a phone reports about itself -- height, and how sure it is -- a
    # simulator feeding a position does not have. Latitude, longitude and the
    # observation time are the fix; the rest is reported missing, not made up.
    sample = parse_message(packet(
        attitude=dict(observed_at_unix_ms=10000, roll_deg=0, pitch_deg=0, yaw_deg=25),
        acceleration=dict(observed_at_unix_ms=10000, x_mps2=0, y_mps2=0, z_mps2=0,
                          includes_gravity=False, frame='body_frd'),
        gps=dict(observed_at_unix_ms=10000, latitude_deg=37.5665, longitude_deg=126.978)))
    assert (sample.gps.latitude_deg, sample.gps.longitude_deg) == (37.5665, 126.978)
    assert sample.gps.altitude_m is None and sample.gps.altitude_reference is None
    assert sample.gps.horizontal_accuracy_m is None and sample.gps.vertical_accuracy_m is None
    assert sample.yaw_deg == 25.0 and sample.acceleration.includes_gravity is False
    # A fix still needs to be a fix: the two that identify it stay required.
    for missing in ('latitude_deg', 'longitude_deg', 'observed_at_unix_ms'):
        broken = dict(observed_at_unix_ms=10000, latitude_deg=37.5, longitude_deg=127.)
        del broken[missing]
        with pytest.raises(ValueError):
            parse_message(packet(gps=broken))
    # An accuracy that is sent is still checked; only its absence is allowed.
    with pytest.raises(ValueError):
        parse_message(packet(gps=dict(observed_at_unix_ms=10000, latitude_deg=37.5,
                                      longitude_deg=127., horizontal_accuracy_m=-1)))
