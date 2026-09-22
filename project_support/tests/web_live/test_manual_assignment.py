"""Being given one aircraft of a running day, over the wire.

The session owns the clock, so it is the session that has to notice flying by
hand only works in real time. And the wire has to answer the two questions a
picker asks -- which airframes have a flight, and which flights -- before it can
offer anything.
"""
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from communication.web.scenario_routes import create_scenario_router
from project_support.tests.web_live.test_scenario_session import CSV, make


def loaded(clock=None):
    session, clock = make(clock=clock)
    session.load(CSV, name="하루")
    session.open_control()
    return session, clock


def client_of(session):
    app = FastAPI()
    app.include_router(create_scenario_router(session))
    return TestClient(app)


def test_the_day_drops_to_real_time_when_someone_takes_an_aircraft_and_goes_back_after():
    # Flying by hand at x8 is not flying by hand. Doing it for the operator
    # beats refusing: they asked to fly, not to think about the clock.
    session, clock = loaded()
    session.set_speed(8)
    session.play()
    clock.tick(5)

    answer = session.assign_manual(asset_id=None, vertiport="VP1")
    assert answer["speed"] == 1, "수동을 잡으면 실시간으로 내려간다"
    assert answer["restored_speed"] == 8, "그리고 원래 배속을 기억한다"
    assert session.status()["speed"] == 1
    assert session.status()["manual_aircraft"] == answer["aircraft_id"]

    # The day did not jump when the speed changed: time already flown stays flown.
    before = session.engine.time_s
    clock.tick(10)
    session.tick()
    assert session.engine.time_s == pytest.approx(before + 10, abs=1.0)

    session.release_manual()
    assert session.status()["speed"] == 8, "끝나면 원래 배속으로"
    assert session.status()["manual_aircraft"] is None
    # Releasing again is not a second restore.
    assert session.release_manual()["released"] is False
    assert session.status()["speed"] == 8


def test_a_day_already_at_real_time_is_left_alone():
    session, _ = loaded()
    session.play()
    answer = session.assign_manual(vertiport="VP1")
    assert answer["speed"] == 1 and answer["restored_speed"] is None
    session.release_manual()
    assert session.status()["speed"] == 1


def test_the_wire_offers_airframes_and_flights_and_hands_one_over():
    session, _ = loaded()
    session.play()
    client = client_of(session)

    offers = client.get("/api/simulation/scenario/manual/offers")
    assert offers.status_code == 200
    body = offers.json()
    assert body["models"], "고를 기체가 있어야 고를 수 있다"
    assert {row["flight_id"] for row in body["flights"]} >= {"F1", "F2"}
    model = body["models"][0]["asset_id"]
    assert all(row["asset_id"] == model
               for row in client.get(f"/api/simulation/scenario/manual/offers?asset_id={model}").json()["flights"])
    # A departure vertiport nobody leaves from offers nothing, and says so by
    # being empty rather than by failing.
    assert client.get("/api/simulation/scenario/manual/offers?vertiport=VP2").json()["flights"] == []

    taken = client.post("/api/simulation/scenario/manual/assign",
                        json={"asset_id": model, "vertiport": "VP1"})
    assert taken.status_code == 200
    assignment = taken.json()
    aircraft_id = assignment["aircraft_id"]
    assert assignment["flight"]["origin"] == "VP1"
    assert assignment["departed"] is False
    assert client.get("/api/simulation/scenario/status").json()["manual_aircraft"] == aircraft_id

    # Asking for something nobody has is a plain answer, not a crash.
    refused = client.post("/api/simulation/scenario/manual/assign", json={"vertiport": "VP3"})
    assert refused.status_code == 422
    assert "출발 예정편이 없습니다" in refused.json()["message"]

    client.post("/api/simulation/scenario/manual/release", json={"aircraft_id": aircraft_id})
    assert client.get("/api/simulation/scenario/status").json()["manual_aircraft"] is None


def test_the_cockpit_reads_the_service_and_asks_it_for_things():
    session, _ = loaded()
    session.play()
    client = client_of(session)
    aircraft_id = client.post("/api/simulation/scenario/manual/assign",
                              json={"vertiport": "VP1"}).json()["aircraft_id"]

    advice = client.get(f"/api/simulation/scenario/manual/{aircraft_id}")
    assert advice.status_code == 200
    assert advice.json()["departed"] is False
    assert advice.json()["departure"] is None
    assert client.get("/api/simulation/scenario/manual/A9").status_code == 404

    granted = client.post(f"/api/simulation/scenario/manual/{aircraft_id}/request",
                          json={"kind": "departure"})
    assert granted.status_code == 200
    assert granted.json()["state"] in ("granted", "hold")

    if granted.json()["state"] == "granted":
        landing = client.post(f"/api/simulation/scenario/manual/{aircraft_id}/request",
                              json={"kind": "arrival", "eta_s": 300})
        assert landing.json()["state"] == "hold"
        assert "이륙 완료 보고" in landing.json()["reason"]
        assert client.get(f"/api/simulation/scenario/manual/{aircraft_id}").json()["arrival"] is None

    unknown = client.post(f"/api/simulation/scenario/manual/{aircraft_id}/request", json={"kind": "tea"})
    assert unknown.status_code == 422
    assert "알 수 없는 요청" in unknown.json()["message"]


def test_putting_the_day_away_lets_go_of_the_aircraft_with_it():
    # There is nothing to hand back to once the engine is gone, and a stale
    # assignment would hold the speed down for the next day loaded.
    session, _ = loaded()
    session.set_speed(4)
    session.play()
    session.assign_manual(vertiport="VP1")
    assert session.status()["manual_aircraft"] is not None
    session.close_control()
    assert session.status()["manual_aircraft"] is None
    session.clear()
    assert session.status()["manual_aircraft"] is None
