"""Nothing the pilot sends waits for the day's lock.

`ScenarioSession` serialises nearly its whole API on one `RLock`, and
`advance_view` holds that lock for about 110 ms of every tick -- measured with
py-spy at 62% of wall-clock time while a day plays. Both of the day calls this
socket made per message went through it, so every message queued about 55 ms
behind work that was not its own. The socket got 6-7 messages a second instead
of the 17 real time needs, and the simulated clock is made of messages: the
pilot reported it as one second of flight taking three real seconds.

The day now keeps a watched aircraft's advisory ready inside its own tick and
takes poses through a mailbox its tick drains, so the socket reads and writes
without the lock. Registering and dropping that watch still takes it, which is
the point -- paid once at each end of a flight rather than twice a message.

These tests pin the property rather than the implementation: between 'ready'
and the end of the flight, whatever the pilot sends, the socket must not call a
method the real session serialises.
"""
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from communication.web.manual_routes import create_manual_router
from test_manual_day_bridge import Day, Planning

# Which of the day's methods take the session's lock in the real
# `ScenarioSession`, and which are the two that were made lock-free for this
# socket. Handing an airframe over and handing it back may take it: they happen
# once each, and nobody is waiting on a frame of flight for them.
LOCKED = ('manual_assignment', 'manual_advisory', 'manual_watch', 'manual_unwatch', 'release_manual')
LOCK_FREE = ('place_manual', 'manual_advice')


def app_for(day, directory):
    app = FastAPI()
    app.include_router(create_manual_router(Planning(), directory, scenario=lambda: day))
    return app


def command(sequence):
    return {'sequence': sequence, 'throttle': 0.2, 'roll': 0.0, 'pitch': 0.0,
            'yaw': 0.0, 'flight_mode': 'multirotor'}


def fly(ws, aircraft_id='A1'):
    ws.send_json({'aircraft_id': aircraft_id, 'altitude_m': 30, 'contact_decks': []})
    ready = ws.receive_json()
    assert ready['type'] == 'ready', ready
    return ready


def test_no_message_the_pilot_sends_takes_the_days_lock(tmp_path):
    day = Day()
    with TestClient(app_for(day, tmp_path)) as client:
        with client.websocket_connect('/api/simulation/manual') as ws:
            fly(ws)
            flying = len(day.calls)
            for sequence in range(1, 7):
                ws.send_json(command(sequence))
                assert ws.receive_json()['type'] == 'state'
            # A keepalive is the message that always syncs the ground, so it is
            # where the advisory read is certain to show up: the command path
            # syncs once a second and a test is faster than that.
            for _ in range(3):
                ws.send_json({'type': 'keepalive'})
                assert ws.receive_json()['type'] == 'alive'
            ws.send_json({'type': 'ground', 'action': 'disembark', 'request_id': 'r1'})
            assert ws.receive_json()['type'] == 'ground_ack'
            during = day.calls[flying:]
            ws.send_json({'type': 'stop'})
    taken = [name for name in during if name in LOCKED]
    assert not taken, f'조종사 메시지 경로가 잠금을 잡았다: {taken}'
    # And it did do the work -- an empty message path would pass the line above
    # for the wrong reason.
    assert 'place_manual' in during, during
    assert 'manual_advice' in during, during
    assert set(during) <= set(LOCK_FREE), during


def test_the_watch_is_registered_once_and_before_the_first_advisory_is_read(tmp_path):
    day = Day()
    with TestClient(app_for(day, tmp_path)) as client:
        with client.websocket_connect('/api/simulation/manual') as ws:
            fly(ws)
            assert day.watched == ['A1']
            assert day.calls.count('manual_watch') == 1, day.calls
            # The cache is empty until the day has been asked to keep one, so a
            # sync that ran first would read nothing and the flight would start
            # a tick behind.
            assert day.calls.index('manual_watch') < day.calls.index('manual_advice'), day.calls
            assert 'manual_advisory' not in day.calls, day.calls
            ws.send_json({'type': 'stop'})


def settled(day, deadline=5.0):
    """Wait, bounded, for the socket's own teardown to finish.

    The flight ends on the server's side a moment after the client stops
    talking, so there is nothing to receive that says it is over. Waiting on
    the teardown itself keeps this quick when it works and still fails on the
    assertions below, not on a timeout, when it does not.

    It also has to happen while the websocket block is still open. Starlette's
    TestClient cancels the server task when the session is torn down, and
    `CancelledError` is not an `Exception`, so a teardown still in progress at
    that moment is simply dropped -- which is a property of the harness, not of
    the socket, and not what these tests are about.
    """
    end = time.monotonic() + deadline
    while not day.released and time.monotonic() < end:
        time.sleep(0.02)


@pytest.mark.parametrize('ending', ['stop', 'disconnect', 'failure'])
def test_the_watch_is_dropped_once_however_the_flight_ends(tmp_path, ending):
    day = Day()
    with TestClient(app_for(day, tmp_path)) as client:
        with client.websocket_connect('/api/simulation/manual') as ws:
            fly(ws)
            ws.send_json(command(1))
            assert ws.receive_json()['type'] == 'state'
            if ending == 'stop':
                ws.send_json({'type': 'stop'})
            elif ending == 'failure':
                ws.send_json({**command(2), 'sequence': 'not-a-number'})
                assert ws.receive_json()['type'] == 'error'
            else:
                # The page goes away without saying anything.
                ws.close()
            settled(day)
    assert day.unwatched == ['A1'], f'{ending}: 감시 등록이 해제되지 않았다'
    assert day.calls.count('manual_unwatch') == 1, day.calls
    assert day.released == ['A1'], f'{ending}: 기체가 하루로 돌아가지 않았다'
    # Unwatch first: it discards a pose the pilot posted that the tick has not
    # drained, and the day must not be handed that pose after it has the
    # aircraft back.
    assert day.calls.index('manual_unwatch') < day.calls.index('release_manual'), day.calls


def test_a_socket_that_never_got_an_airframe_unregisters_nothing(tmp_path):
    day = Day(assignment=None)
    with TestClient(app_for(day, tmp_path)) as client:
        with client.websocket_connect('/api/simulation/manual') as ws:
            ws.send_json({'aircraft_id': 'A9', 'altitude_m': 30})
            assert ws.receive_json()['type'] == 'error'
    assert day.watched == [] and day.unwatched == [], day.calls
    assert 'manual_watch' not in day.calls and 'manual_unwatch' not in day.calls, day.calls


def test_a_day_without_the_watch_api_degrades_instead_of_refusing_the_pilot(tmp_path):
    """An older day is a flight without an advisory, not a flight refused.

    Every other call this socket makes into the day already works this way:
    the pilot is holding the stick, and a day that cannot answer is not their
    problem. A dead advisory is the same degraded flight a day that throws has
    always produced.
    """
    class Older(Day):
        def manual_watch(self, aircraft_id):
            raise AttributeError('manual_watch')

        def manual_advice(self, aircraft_id):
            raise AttributeError('manual_advice')

        def manual_unwatch(self, aircraft_id):
            raise AttributeError('manual_unwatch')

    day = Older()
    with TestClient(app_for(day, tmp_path)) as client:
        with client.websocket_connect('/api/simulation/manual') as ws:
            fly(ws)
            ws.send_json(command(1))
            assert ws.receive_json()['type'] == 'state'
            ws.send_json({'type': 'keepalive'})
            assert ws.receive_json()['type'] == 'alive'
            ws.send_json({'type': 'stop'})
            settled(day)
    # The flight happened, and the airframe still went back.
    assert day.poses and day.released == ['A1']


def test_the_cached_advisory_is_what_reaches_the_ground_procedures(tmp_path):
    day = Day()
    with TestClient(app_for(day, tmp_path)) as client:
        with client.websocket_connect('/api/simulation/manual') as ws:
            fly(ws)
            # Nothing computed yet reads as the same `None` a day that could
            # not be reached has always given `sync_psu`, and PSU holds the
            # door shut.
            ws.send_json({'type': 'ground', 'action': 'disembark', 'request_id': 'r1'})
            first = ws.receive_json()
            assert first['type'] == 'ground_ack' and not first['accepted'], first
            assert 'PSU GATE 도착 보고' in first['message'], first

            # Once the day's tick has an answer the socket picks it up from the
            # cache, and PSU is no longer what is in the way. This read is up to
            # a second old, which is the one place on this socket where that is
            # visible: asking the day for a fresh answer is what put the pilot
            # behind the lock.
            day.advice = {'procedure': {'reports': {'report_gate': 10}}}
            ws.send_json({'type': 'ground', 'action': 'disembark', 'request_id': 'r2'})
            second = ws.receive_json()
            assert second['type'] == 'ground_ack', second
            assert 'PSU GATE 도착 보고' not in second['message'], second
            assert 'manual_advisory' not in day.calls, day.calls
            ws.send_json({'type': 'stop'})
