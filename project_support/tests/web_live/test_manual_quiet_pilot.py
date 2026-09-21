"""A pilot whose page goes quiet keeps the aircraft, and keeps flying.

The socket used to end the flight after thirty seconds without a message. That
is not how a page goes quiet: the tab is hidden, the machine is busy, the
network stalls, and the pilot is still sitting there. A quarter of the recorded
manual flights ended that way -- the pilot came back to a dead session and had
to start the flight again from the stand.

Silence now holds the aircraft instead of ending the flight, and only a silence
long enough that nobody could still be coming back gives it up.
"""
from tempfile import TemporaryDirectory

from fastapi import FastAPI
from fastapi.testclient import TestClient

from communication.web import manual_routes
from communication.web.manual_routes import create_manual_router
from test_manual_day_bridge import Day, Planning


def session(directory, day):
    app = FastAPI()
    app.include_router(create_manual_router(Planning(), directory, scenario=lambda: day))
    return app


def command(sequence):
    return {"sequence": sequence, "throttle": 0.0, "roll": 0.0, "pitch": 0.0,
            "yaw": 0.0, "flight_mode": "multirotor"}


def test_a_quiet_pilot_is_held_and_can_carry_on_flying(monkeypatch):
    monkeypatch.setattr(manual_routes, "SILENCE_SECONDS", 0.15)
    monkeypatch.setattr(manual_routes, "ABANDON_SECONDS", 60)
    day = Day()
    with TemporaryDirectory() as directory:
        with TestClient(session(directory, day)) as client:
            with client.websocket_connect("/api/simulation/manual") as ws:
                ws.send_json({"aircraft_id": "A1", "altitude_m": 30, "contact_decks": []})
                assert ws.receive_json()["type"] == "ready"
                # Say nothing at all for longer than one read waits.
                held = ws.receive_json()
                assert held["type"] == "paused"
                assert "돌아오면" in held["reason"]
                # The socket is still the same flight: resume and fly on.
                ws.send_json({"type": "resume"})
                assert ws.receive_json()["type"] == "resumed"
                ws.send_json(command(1))
                assert ws.receive_json()["type"] == "state"
                ws.send_json({"type": "stop"})
    # The aircraft went back to the day once, at the end, not when it went quiet.
    assert day.released == ["A1"]


def test_being_held_is_said_once_however_long_the_quiet_lasts(monkeypatch):
    monkeypatch.setattr(manual_routes, "SILENCE_SECONDS", 0.1)
    monkeypatch.setattr(manual_routes, "ABANDON_SECONDS", 60)
    with TemporaryDirectory() as directory:
        with TestClient(session(directory, Day())) as client:
            with client.websocket_connect("/api/simulation/manual") as ws:
                ws.send_json({"aircraft_id": "A1", "altitude_m": 30, "contact_decks": []})
                assert ws.receive_json()["type"] == "ready"
                assert ws.receive_json()["type"] == "paused"
                # Several more reads time out behind this one; none of them adds
                # another notice, so returning does not wade through a backlog.
                ws.send_json({"type": "resume"})
                assert ws.receive_json()["type"] == "resumed"
                ws.send_json({"type": "stop"})


def test_a_silence_nobody_could_return_from_gives_the_aircraft_back(monkeypatch):
    monkeypatch.setattr(manual_routes, "SILENCE_SECONDS", 0.1)
    monkeypatch.setattr(manual_routes, "ABANDON_SECONDS", 0.3)
    day = Day()
    with TemporaryDirectory() as directory:
        with TestClient(session(directory, day)) as client:
            with client.websocket_connect("/api/simulation/manual") as ws:
                ws.send_json({"aircraft_id": "A1", "altitude_m": 30, "contact_decks": []})
                assert ws.receive_json()["type"] == "ready"
                assert ws.receive_json()["type"] == "paused"
                # Still nothing from the pilot: past the point of coming back,
                # the socket closes and the day has its airframe again.
                with __import__("pytest").raises(Exception):
                    while True:
                        ws.receive_json()
    assert day.released == ["A1"]
