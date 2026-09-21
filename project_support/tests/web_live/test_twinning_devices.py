"""Two senders at once: one pose each, and nothing silently dropped.

A phone and a simulator are two sources with two poses. The receiver used to
take one connection and ignore the next without saying anything, which is the
worst kind of failure: both ends look fine and only one twin moves.
"""
import asyncio
import json
import pytest
from communication.twinning_tcp import MAX_LINKS
from user_application.apps.web_dashboard.twinning_test import TwinningTestSession

CATALOG = {'assets': [{'asset_id': 'kp2a', 'kind': 'aircraft', 'uri': '/visual-assets/a/model.glb'}]}


def packet(device, seq, lat, lon, yaw):
    stamp = 1789372800000 + seq
    return json.dumps({'version': 2, 'device_id': device, 'seq': seq, 'sent_at_unix_ms': stamp,
        'attitude': {'observed_at_unix_ms': stamp, 'roll_deg': 0, 'pitch_deg': 0, 'yaw_deg': yaw},
        'gps': {'observed_at_unix_ms': stamp, 'latitude_deg': lat, 'longitude_deg': lon}}).encode() + b'\n'


async def settle(session, wanted, limit=200):
    for _ in range(limit):
        await asyncio.sleep(.02)
        if len(session.status()['devices']) >= wanted:
            return
    raise AssertionError('devices did not arrive: %d' % len(session.status()['devices']))


def poses(session):
    return {device['device_id']: device for device in session.status()['devices']}


def test_each_sender_keeps_its_own_pose_and_the_first_stays_primary():
    async def run():
        session = TwinningTestSession(lambda: CATALOG)
        await session.start({'host': '127.0.0.1', 'port': 5471, 'asset_id': 'kp2a'})
        try:
            _, a = await asyncio.open_connection('127.0.0.1', 5471)
            _, b = await asyncio.open_connection('127.0.0.1', 5471)
            a.write(packet('phone_A', 101, 37.5665, 126.978, 25.0))
            b.write(packet('sim_B', 54, 37.567, 126.979, 182.3))
            await asyncio.gather(a.drain(), b.drain())
            await settle(session, 2)
            status = session.status()
            assert status['errors'] == 0
            held = poses(session)
            assert held['phone_A']['attitude']['yaw_deg'] == 25.0
            assert held['sim_B']['attitude']['yaw_deg'] == 182.3
            assert held['phone_A']['gps']['latitude_deg'] == 37.5665
            assert held['sim_B']['gps']['latitude_deg'] == 37.567
            assert all(device['connected'] for device in status['devices'])
            # The top level is still one pose, because every single-pose view
            # reads it there; the rest arrive alongside, not instead.
            assert status['selected_device'] == 'phone_A'
            assert status['attitude']['yaw_deg'] == 25.0
            assert len(status['peers']) == 2
            # A later line from one sender does not disturb the other.
            a.write(packet('phone_A', 102, 37.6, 127.0, 90.0))
            await a.drain()
            for _ in range(100):
                await asyncio.sleep(.02)
                if poses(session)['phone_A']['attitude']['yaw_deg'] == 90.0:
                    break
            held = poses(session)
            assert held['phone_A']['attitude']['yaw_deg'] == 90.0
            assert held['sim_B']['attitude']['yaw_deg'] == 182.3
            for writer in (a, b):
                writer.close()
            await asyncio.gather(a.wait_closed(), b.wait_closed(), return_exceptions=True)
        finally:
            await session.stop()
    asyncio.run(run())


def test_the_views_that_show_one_pose_follow_the_sender_that_was_chosen():
    async def run():
        session = TwinningTestSession(lambda: CATALOG)
        await session.start({'host': '127.0.0.1', 'port': 5472, 'asset_id': 'kp2a'})
        try:
            _, a = await asyncio.open_connection('127.0.0.1', 5472)
            _, b = await asyncio.open_connection('127.0.0.1', 5472)
            a.write(packet('phone_A', 1, 37.5, 127.0, 10.0))
            b.write(packet('sim_B', 1, 37.6, 127.1, 200.0))
            await asyncio.gather(a.drain(), b.drain())
            await settle(session, 2)
            assert session.status()['attitude']['yaw_deg'] == 10.0
            status = session.select('sim_B')
            assert status['selected_device'] == 'sim_B'
            assert status['attitude']['yaw_deg'] == 200.0, 'the chart and horizon follow the choice'
            # Choosing a sender changes nothing about what is received.
            assert len(status['devices']) == 2 and status['errors'] == 0
            with pytest.raises(ValueError):
                session.select('never_connected')
            for writer in (a, b):
                writer.close()
            await asyncio.gather(a.wait_closed(), b.wait_closed(), return_exceptions=True)
        finally:
            await session.stop()
    asyncio.run(run())


def test_a_second_socket_for_one_sender_is_refused_out_loud():
    async def run():
        session = TwinningTestSession(lambda: CATALOG)
        await session.start({'host': '127.0.0.1', 'port': 5473, 'asset_id': 'kp2a'})
        try:
            _, a = await asyncio.open_connection('127.0.0.1', 5473)
            a.write(packet('phone_A', 1, 37.5, 127.0, 10.0))
            await a.drain()
            await settle(session, 1)
            _, twin = await asyncio.open_connection('127.0.0.1', 5473)
            twin.write(packet('phone_A', 900, 37.9, 127.9, 99.0))
            await twin.drain()
            for _ in range(100):
                await asyncio.sleep(.02)
                if session.status()['errors']:
                    break
            status = session.status()
            assert status['errors'] >= 1
            assert 'device_already_connected' in [event['message'] for event in status['events']]
            assert poses(session)['phone_A']['attitude']['yaw_deg'] == 10.0, 'the first socket keeps the pose'
            assert len(status['devices']) == 1
            for writer in (a, twin):
                writer.close()
            await asyncio.gather(a.wait_closed(), twin.wait_closed(), return_exceptions=True)
        finally:
            await session.stop()
    asyncio.run(run())


def test_more_senders_than_the_limit_are_turned_away_rather_than_held_unread():
    async def run():
        session = TwinningTestSession(lambda: CATALOG)
        await session.start({'host': '127.0.0.1', 'port': 5474, 'asset_id': 'kp2a'})
        writers = []
        try:
            for at in range(MAX_LINKS + 2):
                _, writer = await asyncio.open_connection('127.0.0.1', 5474)
                writers.append(writer)
                writer.write(packet('sender_%d' % at, 1, 37.5 + at / 100, 127.0, at))
                try:
                    await writer.drain()
                except (ConnectionError, OSError):
                    pass
            await asyncio.sleep(.6)
            status = session.status()
            assert len(status['devices']) <= MAX_LINKS
            assert any('연결 한도' in event['message'] for event in status['events'])
            for writer in writers:
                writer.close()
            await asyncio.gather(*(w.wait_closed() for w in writers), return_exceptions=True)
        finally:
            await session.stop()
    asyncio.run(run())
