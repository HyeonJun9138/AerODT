"""The socket a person flies through, and the day that has to see them.

Two ways into the same socket: a saved plan, which is a flight of its own, and
an aircraft id, which is one airframe of a running day. The second is the one
that matters here -- every pose it produces has to go back into the day, because
the rest of the fleet decides what to do by where this aircraft actually is.
"""
from tempfile import TemporaryDirectory

from fastapi import FastAPI
from fastapi.testclient import TestClient

from communication.web.manual_routes import _scenario_plan, _share, create_manual_router


ASSIGNMENT = {"aircraft_id": "A1", "asset_id": "asset-x", "stand": "G1",
              "flight": {"flight_id": "F1", "origin": "VP1", "destination": "VP2",
                         "arrival_stand": "G2", "passengers": 3}}


class Planning:
    """Enough of the planner to say what it was asked to build."""

    def __init__(self):
        self.asked = None

    def build(self, body):
        self.asked = body
        return {"control_mode": "manual", "legs": [{"path": [[127.0, 37.0, 30.0]]}],
                "totals": {"battery_start_pct": 42}, "vehicle": {"passengers": 3, "capacity": 4}}

    def get(self, key):
        return None


class Day:
    """A stand-in for the running scenario, remembering what it was told."""

    def __init__(self, assignment=ASSIGNMENT):
        self.assignment, self.poses, self.released = assignment, [], []
        # What the day was asked for, in order, and the advisory its tick has
        # ready. A watched aircraft's advisory is refreshed by the day's own
        # tick, about once a second; the socket reads that rather than asking
        # for a freshly computed one, because computing one takes the session's
        # lock and the pilot is waiting behind the answer.
        self.calls, self.watched, self.unwatched, self.advice = [], [], [], None

    def manual_assignment(self, aircraft_id):
        self.calls.append("manual_assignment")
        return self.assignment if self.assignment and aircraft_id == self.assignment["aircraft_id"] else None

    def place_manual(self, aircraft_id, **pose):
        self.calls.append("place_manual")
        self.poses.append((aircraft_id, pose))
        return True

    def manual_watch(self, aircraft_id):
        self.calls.append("manual_watch")
        self.watched.append(aircraft_id)
        return True

    def manual_advice(self, aircraft_id):
        self.calls.append("manual_advice")
        return self.advice

    def manual_unwatch(self, aircraft_id):
        self.calls.append("manual_unwatch")
        self.unwatched.append(aircraft_id)
        return True

    def manual_advisory(self, aircraft_id):
        # The locked one. It belongs to the HTTP endpoint; a socket that calls
        # it is back to waiting on the day's tick for every message.
        self.calls.append("manual_advisory")
        return self.advice

    def release_manual(self, aircraft_id=None):
        self.calls.append("release_manual")
        self.released.append(aircraft_id)
        return {"released": True}


def test_the_plan_for_a_handed_over_flight_is_built_from_what_the_day_knows():
    # Built rather than synthesised: the runtime, the ground procedures and the
    # display all already understand a plan, and the day knows every field.
    planning = Planning()
    _scenario_plan(planning, ASSIGNMENT)
    assert planning.asked == {"from_vertiport": "VP1", "to_vertiport": "VP2",
                              "visual_asset_id": "asset-x", "from_gate": "G1", "to_gate": "G2",
                              "passengers": 3, "seat_capacity": 4, "control_mode": "manual"}
    # An assignment with nowhere to go is refused by name rather than building
    # a plan to nowhere.
    try:
        _scenario_plan(planning, {"flight": {}})
    except ValueError as error:
        assert "출발지" in str(error)
    else:
        raise AssertionError("빈 배정은 거절되어야 한다")


def test_a_pose_reaches_the_day_and_a_closed_day_does_not_stop_the_pilot():
    day = Day()
    sample = {"position": {"latitude": 37.5, "longitude": 127.0, "altitude_m": 120.0},
              "heading_deg": 90.0, "airborne": True, "speed_mps": 30.0}
    assert _share(lambda: day, "A1", sample, 0.06) is True
    aircraft_id, pose = day.poses[-1]
    assert aircraft_id == "A1"
    assert pose["latitude"] == 37.5 and pose["altitude"] == 120.0
    assert pose["airborne"] is True and pose["step"] == 0.06

    # The pilot is holding the stick. A day that was closed underneath them, or
    # one that throws, is not their problem and never stops the aircraft.
    assert _share(lambda: None, "A1", sample, 0.06) is False
    assert _share(lambda: day, "A1", {"position": {}}, 0.06) is False

    class Angry(Day):
        def place_manual(self, aircraft_id, **pose):
            raise RuntimeError("day went away")
    assert _share(lambda: Angry(), "A1", sample, 0.06) is False


def test_flying_one_airframe_of_the_day_shares_every_pose_and_hands_it_back():
    day = Day()
    with TemporaryDirectory() as directory:
        app = FastAPI()
        app.include_router(create_manual_router(Planning(), directory, None, scenario=lambda: day))
        with TestClient(app) as client:
            with client.websocket_connect("/api/simulation/manual") as ws:
                ws.send_json({"aircraft_id": "A1", "altitude_m": 30, "contact_decks": []})
                ready = ws.receive_json()
                assert ready["type"] == "ready"
                # The very first sample is already shared: the day has to see it
                # standing on its deck, not only once it moves.
                assert day.poses and day.poses[0][0] == "A1"
                ws.send_json({"throttle": 0.3, "roll": 0, "pitch": 0, "yaw": 0,
                              "flight_mode": "multirotor", "sequence": 1})
                answer = ws.receive_json()
                assert answer["type"] == "state"
                assert len(day.poses) >= 1
                ws.send_json({"type": "stop"})
    assert day.released == ["A1"], "소켓이 끝나면 기체는 하루로 돌아간다"


def test_an_aircraft_nobody_assigned_is_refused_by_name():
    day = Day(assignment=None)
    with TemporaryDirectory() as directory:
        app = FastAPI()
        app.include_router(create_manual_router(Planning(), directory, None, scenario=lambda: day))
        with TestClient(app) as client:
            with client.websocket_connect("/api/simulation/manual") as ws:
                ws.send_json({"aircraft_id": "A9", "altitude_m": 30})
                answer = ws.receive_json()
                assert answer["type"] == "error"
                assert "배정받은 기체가 아닙니다" in answer["message"]
    # Nothing was taken, so nothing is handed back.
    assert day.released == []


import pytest
from user_application.uam_mission.flight_planning import FlightPlanning
from project_support.tests.web_live.test_flight_plan import VERTIPORTS, NETWORK

@pytest.mark.parametrize('seats,asset', [(4,'projectairsim_airtaxi'),(6,'kp2a'),(8,'amvlab_evtol')])
def test_full_cabin_assignment_opens_real_planner_and_native_manual_socket(seats,asset):
    assignment={**ASSIGNMENT,'seats':seats,'asset_id':asset,
                'flight':{**ASSIGNMENT['flight'],'passengers':seats}}
    planning=FlightPlanning(vertiports=lambda:VERTIPORTS,network=lambda:NETWORK,plans=None)
    day=Day(assignment)
    point=_scenario_plan(planning,assignment)['legs'][0]['path'][0]
    lon,lat=point[:2]
    deck={'id':assignment['flight']['origin'],'height_m':30,
          'outline':[[lon-.001,lat-.001],[lon+.001,lat-.001],[lon+.001,lat+.001],[lon-.001,lat+.001]]}
    with TemporaryDirectory() as directory:
        app=FastAPI();app.include_router(create_manual_router(planning,directory,scenario=lambda:day))
        with TestClient(app) as client:
            with client.websocket_connect('/api/simulation/manual') as ws:
                ws.send_json({'aircraft_id':'A1','altitude_m':30,'contact_decks':[deck]})
                ready=ws.receive_json()
                assert ready['type']=='ready', ready
                assert ready['plan']['vehicle']['capacity']==seats
                assert ready['plan']['vehicle']['passengers']==seats
                assert ready['plan']['request']['seat_capacity']==seats
                ws.send_json({'type':'resume'});assert ws.receive_json()['type']=='resumed'
                ws.send_json({'throttle':0,'roll':0,'pitch':-1,'yaw':0,'flight_mode':'multirotor','sequence':1})
                assert ws.receive_json()['type']=='state'
                ws.send_json({'type':'stop'})
    assert day.released==['A1']


def test_handover_rejects_over_capacity_instead_of_dropping_passengers():
    planning=FlightPlanning(vertiports=lambda:VERTIPORTS,network=lambda:NETWORK,plans=None)
    with pytest.raises(ValueError,match='passengers: 0 to 6'):
        _scenario_plan(planning,{**ASSIGNMENT,'seats':6,'asset_id':'kp2a',
            'flight':{**ASSIGNMENT['flight'],'passengers':7}})
