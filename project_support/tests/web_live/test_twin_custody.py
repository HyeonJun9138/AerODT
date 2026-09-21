"""One globe, one clock, one fleet -- and two things that could drive them.

Running a whole scheduled day and a single flight of its own at the same time
is not a smaller version of either: it is two sets of aircraft on one map with
two clocks, which is what was reported as everything going at once. So the twin
is held by exactly one of them, and the other is refused by name.

The exception is the aircraft of a running day that a person is flying by hand.
That is the day, not a second thing beside it, so it does not ask.
"""
from tempfile import TemporaryDirectory

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from communication.web.manual_routes import create_manual_router
from communication.web.scenario_routes import create_scenario_router
from project_support.tests.web_live.test_manual_day_bridge import ASSIGNMENT, Day, Planning as DayPlanning
from project_support.tests.web_live.test_scenario_session import CSV, make
from user_application.uam_mission import twin_custody
from user_application.uam_mission.twin_custody import DAY, SINGLE, TwinBusy, TwinCustody
class Planning(DayPlanning):
    """The same stand-in, with one saved plan, so a flight of its own can start."""

    PLAN = {"control_mode": "manual", "legs": [{"path": [[127.0, 37.0, 30.0]]}],
            "totals": {"battery_start_pct": 42}, "vehicle": {"passengers": 0, "capacity": 4}}

    def get(self, key):
        return {"plan": self.PLAN} if key == "test" else None



def test_one_holder_at_a_time_and_the_refusal_names_who_has_it():
    held = TwinCustody()
    assert held.holder is None
    assert held.check(DAY) and held.check(SINGLE)

    held.take(DAY)
    assert held.holder == DAY
    assert held.check(DAY), "자기 자신에게는 막히지 않는다"
    assert not held.check(SINGLE)
    with pytest.raises(TwinBusy) as refused:
        held.take(SINGLE)
    assert refused.value.holder == DAY
    assert "다중 비행" in str(refused.value), "무엇이 잡고 있는지 말한다"
    assert "먼저 종료" in str(refused.value), "그리고 어떻게 하라고 말한다"
    # A refusal the routes already know how to turn into an answer.
    assert isinstance(refused.value, ValueError)

    # Taken twice by the same holder and given back twice: a day is opened once
    # but the sessions inside it come and go.
    held.take(DAY)
    assert held.release(DAY) is True
    assert held.holder == DAY, "아직 하나가 남아 있다"
    assert held.release(DAY) is True
    assert held.holder is None
    # Releasing what nobody holds is not an error: every way out calls it.
    assert held.release(DAY) is False
    assert held.release(SINGLE) is False

    # A teardown that cannot fail drops it whatever the count.
    held.take(SINGLE); held.take(SINGLE)
    assert held.clear(DAY) is False, "남의 것을 놓아줄 수는 없다"
    assert held.clear(SINGLE) is True
    assert held.holder is None
    assert held.state() == {"holder": None, "label": None, "depth": 0}


def day_session(custody):
    session, _ = make()
    session.custody = custody
    session.load(CSV, name="하루")
    return session


def test_a_day_cannot_open_while_a_single_flight_is_flying_it():
    held = TwinCustody()
    held.take(SINGLE)
    session = day_session(held)
    with pytest.raises(TwinBusy, match="단일 비행"):
        session.open_control()
    assert session.status()["control_open"] is False

    held.release(SINGLE)
    assert session.open_control()["control_open"] is True
    assert session.status()["twin_holder"] == DAY
    # Opening an already-open console is not a second claim to release.
    session.open_control()
    session.close_control()
    assert held.holder is None, "닫으면 셈이 아니라 통째로 놓는다"
    assert session.status()["twin_holder"] is None


def test_a_flight_of_its_own_is_refused_while_a_day_is_driving_and_the_day_s_own_is_not():
    held = TwinCustody()
    held.take(DAY)
    day = Day()
    with TemporaryDirectory() as directory:
        app = FastAPI()
        app.include_router(create_manual_router(Planning(), directory, None,
                                                scenario=lambda: day, custody=held))
        with TestClient(app) as client:
            # A saved plan is a flight of its own. It drives the twin, so not now.
            with client.websocket_connect("/api/simulation/manual") as ws:
                ws.send_json({"plan_id": "test", "altitude_m": 30})
                answer = ws.receive_json()
                assert answer["type"] == "error"
                assert "다중 비행" in answer["message"]
                assert "먼저 종료" in answer["message"]
            assert held.holder == DAY, "거절은 남의 것을 건드리지 않는다"

            # One airframe of that same day, flown by hand, is the day. It asks
            # nobody, because there is nobody else to ask.
            with client.websocket_connect("/api/simulation/manual") as ws:
                ws.send_json({"aircraft_id": "A1", "altitude_m": 30, "contact_decks": []})
                assert ws.receive_json()["type"] == "ready"
                assert held.holder == DAY
                ws.send_json({"type": "stop"})
    assert day.released == ["A1"]


def test_a_flight_of_its_own_takes_the_twin_and_gives_it_back_however_it_ends():
    held = TwinCustody()
    with TemporaryDirectory() as directory:
        app = FastAPI()
        app.include_router(create_manual_router(Planning(), directory, None,
                                                scenario=lambda: None, custody=held))
        with TestClient(app) as client:
            with client.websocket_connect("/api/simulation/manual") as ws:
                ws.send_json({"plan_id": "test", "altitude_m": 30})
                assert ws.receive_json()["type"] == "ready"
                assert held.holder == SINGLE, "단일 비행이 트윈을 잡는다"
                ws.send_json({"type": "stop"})
    assert held.holder is None, "끝나면 어떻게 끝났든 돌려준다"

    # Including when it ends by failing.
    with TemporaryDirectory() as directory:
        app = FastAPI()
        app.include_router(create_manual_router(Planning(), directory, None, custody=held))
        with TestClient(app) as client:
            with client.websocket_connect("/api/simulation/manual") as ws:
                ws.send_json({"plan_id": "nothing-saved", "altitude_m": 30})
                assert ws.receive_json()["type"] == "error"
    assert held.holder is None


def test_the_wire_answers_a_busy_twin_by_name_rather_than_by_failing():
    held = TwinCustody()
    held.take(SINGLE)
    session = day_session(held)
    app = FastAPI()
    app.include_router(create_scenario_router(session))
    client = TestClient(app)
    answer = client.post("/api/simulation/scenario/control", json={"action": "open_control"})
    assert answer.status_code == 422
    assert "단일 비행" in answer.json()["message"]
    # And the page can grey the button instead of pressing it to find out.
    assert client.get("/api/simulation/scenario/status").json()["twin_holder"] == SINGLE
    assert twin_custody.LABELS[SINGLE] == "단일 비행"
