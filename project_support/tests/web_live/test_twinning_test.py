import asyncio
import json
import pytest

from communication.twinning_tcp import MAX_LINKS, parse_message, TcpAttitudeReceiver
from digital_twin.runtime.twinning_test import TwinningTestRuntime


def message(seq=1, **changes):
    value = dict(version=1, device_id='iphone_01', seq=seq, sent_at_unix_ms=1000,
                 attitude=dict(roll_deg=20., pitch_deg=10., yaw_deg=179.))
    value.update(changes)
    return json.dumps(value).encode() + b'\n'


def test_parser_contract():
    assert parse_message(message()).roll_deg == 20
    for change in ({'version': 2}, {'seq': True}, {'device_id': ''},
                   {'attitude': dict(roll_deg=float('nan'), pitch_deg=0, yaw_deg=0)}):
        with pytest.raises(ValueError):
            parse_message(message(**change))


def test_runtime_calibration_is_rotation_not_euler_subtraction():
    r = TwinningTestRuntime()
    r.observe(parse_message(message()), 10)
    assert r.snapshot(12).status == 'stale'
    r.calibrate(10)
    assert r.snapshot(10).quaternion_wxyz == pytest.approx((1, 0, 0, 0))
    r.observe(parse_message(message(2, attitude=dict(roll_deg=20, pitch_deg=10, yaw_deg=-179))), 11)
    assert abs(r.snapshot(11).quaternion_wxyz[0]) > .999


def test_tcp_fragmented_combined_invalid_and_shutdown():
    async def run():
        received = []
        receiver = TcpAttitudeReceiver(lambda sample: received.append(sample))
        await receiver.start('127.0.0.1', 0)
        reader, writer = await asyncio.open_connection('127.0.0.1', receiver.port)
        writer.write(message()[:20]); await writer.drain()
        writer.write(message()[20:] + b'bad\n' + message(2) + message(2))
        await writer.drain()
        for _ in range(100):
            if receiver.errors >= 2: break
            await asyncio.sleep(.01)
        assert [x.seq for x in received] == [1, 2]
        assert receiver.errors == 2
        # A second sender is a second device now, not an intruder: it is kept.
        # Only past the cap is a connection turned away, and closing it is how
        # the far end is told -- the old silent hold said nothing to anyone.
        spare = []
        for _ in range(MAX_LINKS - 1):
            extra_reader, extra_writer = await asyncio.open_connection('127.0.0.1', receiver.port)
            spare.append((extra_reader, extra_writer))
        assert len(receiver.links) == MAX_LINKS
        over_reader, over_writer = await asyncio.open_connection('127.0.0.1', receiver.port)
        assert await asyncio.wait_for(over_reader.read(), 1) == b''
        over_writer.close(); await over_writer.wait_closed()
        for _, extra_writer in spare:
            extra_writer.close()
        await asyncio.gather(*(w.wait_closed() for _, w in spare), return_exceptions=True)
        await receiver.stop()
        assert await asyncio.wait_for(reader.read(), 1) == b''
        assert receiver.server is None
        writer.close(); await writer.wait_closed()
    asyncio.run(run())


def test_http_controls_are_off_by_default_and_validate_before_binding():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from user_application.apps.web_dashboard.twinning_test import TwinningTestSession
    from communication.web.twinning_test_routes import create_twinning_test_router
    session = TwinningTestSession(lambda: {'assets': [{'asset_id': 'plane', 'kind': 'aircraft', 'uri': '/visual-assets/a.glb'}]})
    app = FastAPI()
    app.include_router(create_twinning_test_router(session))
    with TestClient(app) as client:
        assert not client.get('/api/twinning-test').json()['enabled']
        assert client.post('/api/twinning-test/start', json={'host': '127.0.0.1', 'port': 5005, 'asset_id': 'bad'}).status_code == 400
        assert client.post('/api/twinning-test/stop', headers={'Origin': 'https://other.test'}).status_code == 403
        assert client.post('/api/twinning-test/calibrate').status_code == 400
        assert client.post('/api/twinning-test/stop').status_code == 200
        oversized = client.post('/api/twinning-test/stop', content=iter([b' ' * 5000, b'{}']), headers={'Content-Type': 'application/json'})
        assert oversized.status_code == 400


def test_stop_arriving_before_start_cancels_that_operation():
    from user_application.apps.web_dashboard.twinning_test import TwinningTestSession
    async def run():
        session = TwinningTestSession(lambda: {'assets': [{'asset_id': 'plane', 'kind': 'aircraft', 'uri': '/visual-assets/a.glb'}]})
        await session.stop('abandoned-start')
        with pytest.raises(ValueError, match='cancelled'):
            await session.start({'host': '127.0.0.1', 'port': 15006, 'asset_id': 'plane', 'operation_id': 'abandoned-start'})
        assert not session.status()['enabled']
    asyncio.run(run())


def test_large_line_closes_connection_and_receiver_can_accept_again():
    async def run():
        receiver = TcpAttitudeReceiver(lambda sample: None)
        await receiver.start('127.0.0.1', 0)
        try:
            reader, writer = await asyncio.open_connection('127.0.0.1', receiver.port)
            writer.write(b'x' * 5000 + b'\n'); await writer.drain()
            assert await asyncio.wait_for(reader.read(), 1) == b''
            assert receiver.errors == 1
            writer.close(); await writer.wait_closed()
            reader, writer = await asyncio.open_connection('127.0.0.1', receiver.port)
            writer.write(message()); await writer.drain()
            await asyncio.sleep(.02)
            assert receiver.peer is not None
            writer.close(); await writer.wait_closed()
        finally:
            await receiver.stop()
    asyncio.run(run())


def test_full_app_test_pose_does_not_enter_live_world_and_shutdown_closes_tcp(tmp_path):
    import socket
    import time
    from fastapi.testclient import TestClient
    from user_application.apps.web_dashboard.application import create_app
    app = create_app({'workspace_directory': str(tmp_path), 'cache_directory': str(tmp_path)}, sources=[])
    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1', 0))
        port = reservation.getsockname()[1]
    with TestClient(app) as client:
        assets = client.get('/api/visual-assets').json()['assets']
        asset = next(a['asset_id'] for a in assets if a['kind'] == 'aircraft')
        response = client.post('/api/twinning-test/start', json={'host': '127.0.0.1', 'port': port, 'asset_id': asset})
        assert response.status_code == 200 and response.json()['enabled']
        stream = socket.create_connection(('127.0.0.1', port))
        stream.sendall(message())
        for _ in range(100):
            status = client.get('/api/twinning-test').json()
            if status['count']: break
            time.sleep(.01)
        assert status['raw']['roll_deg'] == 20
        assert client.get('/api/live/snapshot').json()['entities'] == []
    stream.settimeout(1)
    assert stream.recv(1) == b''
    stream.close()
    assert app.state.twinning_test.status()['enabled'] is False
