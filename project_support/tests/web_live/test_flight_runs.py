"""The simulation loop as the architecture draws it: the engine flies a plan,
the Data Layer keeps what it produced, and the wire replays it."""
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from communication.web.run_routes import create_run_router
from data.simulation.flight_runs import FlightRuns
from digital_twin.model_library import flight_plan as fp
from digital_twin.simulation import flight_simulation as engine
from project_support.tests.web_live.test_flight_plan import NETWORK, VERTIPORTS


def plan():
    asked = fp.validate_request({"from_vertiport": "VP1", "to_vertiport": "VP2", "passengers": 3},
                                fp.plan_options(VERTIPORTS, NETWORK))
    return fp.build_plan(asked, VERTIPORTS, NETWORK)


# ---------------------------------------------------------------- the engine

def test_the_engine_produces_a_state_every_tick_from_the_first_second_to_the_last():
    flown = engine.run(plan(), rate_hz=5)
    states, summary = flown["states"], flown["summary"]
    total = plan()["totals"]["duration_s"]
    assert summary["engine"] == engine.ENGINE and summary["rate_hz"] == 5
    assert summary["states"] == len(states) > 100
    assert states[0]["t"] == 0.0
    assert states[-1]["t"] == pytest.approx(total, abs=0.01), "the flight ends at the stand, not short of it"
    # Evenly spaced, and never going backwards.
    steps = [round(after["t"] - before["t"], 3) for before, after in zip(states, states[1:])]
    assert all(step > 0 for step in steps)
    assert max(steps[:-1]) == pytest.approx(0.2, abs=0.001), "five a second"
    assert [state["leg"] for state in states] == sorted(state["leg"] for state in states)


def test_a_state_is_the_whole_vehicle_at_one_instant():
    states = engine.run(plan(), rate_hz=2)["states"]
    for state in states:
        assert set(state) >= {"t", "leg", "f", "stage", "kind", "mode", "latitude", "longitude",
                              "altitude_m", "datum", "heading_deg", "pitch_deg", "tilt_deg",
                              "speed_mps", "battery_pct", "distance_done_m"}
        assert 0 <= state["f"] <= 1 and 0 <= state["battery_pct"] <= 100
        assert state["mode"] in ("multirotor", "transition", "fixed_wing")
    # The height is left on the datum it was designed against, for the display
    # to stand on the terrain: resolving it here would be resolving it blind.
    assert {state["datum"] for state in states} >= {"agl"}
    assert any(state["datum"].startswith("deck:") for state in states)
    # Every stage of the flight is actually flown through.
    assert {state["stage"] for state in states} == set(fp.STAGE_IDS)
    # The rotors turn forward through the climb and back through the descent.
    climb = [s["tilt_deg"] for s in states if s["stage"] == "climb"]
    descent = [s["tilt_deg"] for s in states if s["stage"] == "descent"]
    assert climb == sorted(climb) and climb[0] < 10 and climb[-1] > 80
    assert descent == sorted(descent, reverse=True)
    assert {s["mode"] for s in states if s["stage"] == "cruise"} == {"fixed_wing"}
    assert {s["mode"] for s in states if s["stage"] == "gate_out"} == {"multirotor"}


def test_the_engine_reports_what_the_run_amounted_to_and_refuses_what_it_cannot_fly():
    summary = engine.run(plan(), rate_hz=10)["summary"]
    assert summary["battery_start_pct"] == 100.0
    assert summary["battery_min_pct"] < summary["battery_start_pct"], "flying spends"
    assert summary["battery_end_pct"] == 100.0, "and it is charged back at the stand"
    # The corridor decides the height; the operating profile decides the speed.
    assert summary["max_altitude_m"] > 300
    from digital_twin.model_library import uam_operating_profile
    assert summary["max_speed_mps"] == pytest.approx(uam_operating_profile.speeds()["cruise_mps"], abs=0.01)
    assert set(summary["stage_states"]) == set(fp.STAGE_IDS)
    for bad, field in (({"legs": []}, "plan"), (None, "plan")):
        with pytest.raises(ValueError) as error:
            engine.run(bad)
        assert str(error.value).startswith(field + ":")
    for rate in (0.1, 500, "빠르게"):
        with pytest.raises(ValueError, match="rate_hz"):
            engine.run(plan(), rate_hz=rate)


# ---------------------------------------------------------------- the shelf

def test_a_run_is_kept_whole_and_read_back_without_re_flying_it(tmp_path):
    runs = FlightRuns(tmp_path)
    assert runs.list() == []
    built = plan()
    flown = engine.run(built, rate_hz=5)
    manifest = runs.create(built, flown["states"], flown["summary"])
    run_id = manifest["run_id"]
    assert manifest["label"] == "여의도 → 봉천"
    assert manifest["vehicle"]["passengers"] == 3 and manifest["summary"]["states"] == len(flown["states"])
    listed = runs.list()
    assert [item["run_id"] for item in listed] == [run_id]
    assert runs.get(run_id)["created_at"].endswith("Z")
    assert runs.plan(run_id)["legs"][0]["stage"] == "gate_out", "the plan it flew is kept with it"
    states = runs.states(run_id)
    assert states == flown["states"], "read back exactly as they were produced"
    # A window is read without pulling the whole flight.
    window = runs.states(run_id, since=60, until=70)
    assert window and all(60 <= state["t"] <= 70 for state in window)
    assert len(runs.states(run_id, limit=5)) == 5
    # Newest first, so the panel opens on what was just flown — even for two
    # runs asked for inside the same second, which the folder name alone
    # cannot order because it ends in a random suffix.
    second = runs.create(built, flown["states"][:10], flown["summary"])
    assert second["created_at"] > manifest["created_at"]
    assert [item["run_id"] for item in runs.list()] == [second["run_id"], run_id]
    assert runs.delete(run_id) is True and runs.get(run_id) is None
    assert runs.delete(run_id) is False


def test_a_half_written_run_is_skipped_and_an_id_cannot_reach_outside_the_shelf(tmp_path):
    runs = FlightRuns(tmp_path)
    built = plan()
    runs.create(built, engine.run(built, rate_hz=2)["states"], {})
    # A folder without a manifest is a run that never finished being written.
    (tmp_path / "20990101T000000Z-broken").mkdir()
    assert len(runs.list()) == 1, "a run is only listed once it is complete"
    for bad in ("../secrets", "a/b", ".hidden", ""):
        assert runs.get(bad) is None and runs.states(bad) == [] and runs.delete(bad) is False
    assert runs.plan("nothing-here") is None
    assert FlightRuns(tmp_path / "absent").list() == []


# ---------------------------------------------------------------- the wire

def client(tmp_path):
    runs = FlightRuns(tmp_path)

    class Runs:
        @staticmethod
        def list():
            return runs.list()

        @staticmethod
        def get(run_id):
            return runs.get(run_id)

        @staticmethod
        def plan(run_id):
            return runs.plan(run_id)

        @staticmethod
        def states(run_id, since=None, until=None):
            return runs.states(run_id, since=since, until=until)

        @staticmethod
        def delete(run_id):
            return runs.delete(run_id)

        @staticmethod
        def fly(body):
            asked = fp.validate_request(body, fp.plan_options(VERTIPORTS, NETWORK))
            built = fp.build_plan(asked, VERTIPORTS, NETWORK)
            flown = engine.run(built, (body or {}).get("rate_hz", engine.DEFAULT_RATE_HZ))
            return {"run": runs.create(built, flown["states"], flown["summary"]),
                    "plan": built, "states": flown["states"]}

    app = FastAPI()
    app.include_router(create_run_router(Runs()))
    return TestClient(app), runs


def test_the_wire_flies_a_plan_stores_it_and_replays_it(tmp_path):
    http, runs = client(tmp_path)
    with http:
        assert http.get("/api/simulation/runs").json()["runs"] == []
        flown = http.post("/api/simulation/runs",
                          json={"from_vertiport": "VP1", "to_vertiport": "VP2", "passengers": 2, "rate_hz": 4})
        assert flown.status_code == 201
        body = flown.json()
        run_id = body["run"]["run_id"]
        assert body["run"]["summary"]["rate_hz"] == 4 and len(body["states"]) == body["run"]["summary"]["states"]
        assert body["plan"]["vehicle"]["passengers"] == 2
        # It is on the shelf, not only in the answer.
        assert [item["run_id"] for item in http.get("/api/simulation/runs").json()["runs"]] == [run_id]
        one = http.get(f"/api/simulation/runs/{run_id}").json()
        assert one["run"]["run_id"] == run_id and one["plan"]["legs"][0]["stage"] == "gate_out"
        replay = http.get(f"/api/simulation/runs/{run_id}/states").json()
        assert replay["states"] == body["states"], "replayed from storage, not re-flown"
        window = http.get(f"/api/simulation/runs/{run_id}/states", params={"since": 10, "until": 20}).json()
        assert window["states"] and all(10 <= state["t"] <= 20 for state in window["states"])
        assert http.get("/api/simulation/runs/nothing/states").status_code == 404
        assert http.get("/api/simulation/runs/nothing").status_code == 404
        assert http.delete(f"/api/simulation/runs/{run_id}").status_code == 204
        assert http.get("/api/simulation/runs").json()["runs"] == []
        assert http.delete(f"/api/simulation/runs/{run_id}").status_code == 404


def test_a_flight_the_engine_cannot_run_is_refused_by_field(tmp_path):
    http, _ = client(tmp_path)
    with http:
        for body, field in (({"from_vertiport": "VP1", "to_vertiport": "VP1"}, "to_vertiport"),
                            ({"from_vertiport": "VP1", "to_vertiport": "VP2", "rate_hz": 900}, "rate_hz"),
                            ({"passengers": 1}, "from_vertiport")):
            refused = http.post("/api/simulation/runs", json=body)
            assert refused.status_code == 422 and refused.json()["field"] == field

@pytest.mark.parametrize('identifier', [m['id'] for m in fp.VISUAL_MODELS])
def test_visual_selection_survives_run_api_storage_and_replay(tmp_path, identifier):
    wire, runs = client(tmp_path)
    answer = wire.post('/api/simulation/runs', json={'from_vertiport':'VP1', 'to_vertiport':'VP2',
        'visual_asset_id':identifier, 'passengers':0, 'rate_hz':2})
    assert answer.status_code == 201
    payload = answer.json()
    run_id = payload['run']['run_id']
    assert payload['plan']['aircraft']['asset_id'] == identifier
    assert runs.plan(run_id)['aircraft']['id'] == fp.AIRCRAFT['id']
    assert wire.get('/api/simulation/runs/'+run_id).json()['plan']['aircraft']['asset_id'] == identifier
