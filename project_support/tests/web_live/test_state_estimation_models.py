"""Data alignment and state estimation: the model the operator chooses, the
switch that turns the estimator off, and the predicted path of one aircraft.

The estimate is what the twin does between the 25-30 s observations a
surveillance feed delivers. Which model does it is a decision, so it is tested
as one: the choice reaches the running twin, each model carries an aircraft the
way it says it does, and nothing is projected when the operator asked for none.
"""
import math

import pytest
from fastapi.testclient import TestClient

from data.ingestion.source_records import SourceRecords
from digital_twin.live_twin import motion
from digital_twin.live_twin import trajectory as rc
from digital_twin.live_twin.model_setup import aircraft_model, aircraft_models, estimation_policy, load_definitions
from digital_twin.live_twin.state_synchronization import LiveSynchronizer
from foundation.geodesy import from_ecef, to_ecef, velocity_ecef
from user_application.apps.web_dashboard.application import create_app
from user_application.apps.web_dashboard.library_settings import (DEFAULTS, ESTIMATION_MODELS, LibraryPolicy,
                                                                  PREDICTION_MODELS, describe_library,
                                                                  validate_settings)

LAT, LON, ALT, SPEED = 37.0, 127.0, 9000.0, 200.0
TURNING = {"enabled": True, "model": "coordinated_turn_v1", "prediction": True, "prediction_seconds": 15}
STRAIGHT = {**TURNING, "model": "constant_velocity_v1"}


def ground_track(position, velocity):
    """The compass track of an ECEF velocity where it stands, for checking a turn."""
    latitude, longitude, _ = from_ecef(position)
    lat, lon = math.radians(latitude), math.radians(longitude)
    north = (-math.sin(lat) * math.cos(lon), -math.sin(lat) * math.sin(lon), math.cos(lat))
    east = (-math.sin(lon), math.cos(lon), 0.0)
    return math.degrees(math.atan2(sum(e * v for e, v in zip(east, velocity)),
                                   sum(n * v for n, v in zip(north, velocity)))) % 360


def observation(t, track=90.0, latitude=LAT, longitude=LON):
    return [dict(id="abc123", name="TEST123", latitude=latitude, longitude=longitude, altitude_m=ALT,
                 track_deg=track, speed_mps=SPEED, vertical_rate_mps=0, observed_at=t)]


class Flight:
    """One aircraft observed on a cadence, ticked like the runtime does."""

    def __init__(self, estimation=None):
        self.store = SourceRecords()
        self.sync = LiveSynchronizer(estimation=estimation)
        self.previous = ()

    def observe(self, t, track=90.0, **place):
        self.store.register("test", observation(t, track, **place), t + 1, format="aircraft_v1")

    def tick(self, t):
        self.previous = self.sync.synchronize(self.store.records(), t, previous=self.previous)
        return self.previous[0]


# ------------------------------------------------------------------ the kinematics

def test_a_coordinated_turn_flies_the_arc_a_standard_rate_turn_actually_flies():
    position = to_ecef(LAT, LON, ALT)
    velocity = velocity_ecef(LAT, LON, 90.0, SPEED, 0.0)
    up = motion.up_at(LAT, LON)
    radius = SPEED / math.radians(3.0)
    turned, after = motion.advance_state(position, velocity, up, 3.0, 30.0)
    assert math.dist(position, turned) == pytest.approx(radius * math.sqrt(2), rel=0.001), "a quarter circle"
    assert ground_track(turned, after) == pytest.approx(180.0, abs=0.2), "090 plus 30 s at 3 deg/s"
    assert math.hypot(*after) == pytest.approx(SPEED, rel=1e-9), "a turn changes direction, not speed"
    assert from_ecef(turned)[2] == pytest.approx(ALT, abs=3), "level in, level out"
    straight, unchanged = motion.advance_state(position, velocity, up, None, 30.0)
    assert math.dist(position, straight) == pytest.approx(SPEED * 30, rel=1e-6)
    assert unchanged == velocity
    assert motion.advance_state(position, velocity, up, 3.0, 0) == (position, velocity)
    # A climbing turn still climbs: the vertical part of the velocity is untouched.
    climbing = velocity_ecef(LAT, LON, 90.0, SPEED, 10.0)
    up_and_over, _ = motion.advance_state(position, climbing, up, 3.0, 30.0)
    assert from_ecef(up_and_over)[2] == pytest.approx(ALT + 300, abs=5)


def test_a_turn_rate_is_measured_along_the_shorter_arc_and_capped_at_what_can_be_flown():
    assert motion.turn_rate_between(350, 10, 20, 3.0) == pytest.approx(1.0), "through north, not the long way"
    assert motion.turn_rate_between(10, 350, 20, 3.0) == pytest.approx(-1.0)
    assert motion.turn_rate_between(0, 90, 5, 3.0) == 3.0, "an impossible rate becomes a firm turn"
    assert motion.turn_rate_between(0, 90, 5, 3.0) == -motion.turn_rate_between(0, 270, 5, 3.0)
    for missing in [(None, 10, 20), (10, None, 20), (10, 20, 0), (10, 20, None)]:
        assert motion.turn_rate_between(*missing, 3.0) is None
    assert motion.blend_turn_rate(None, 2.0, 0.6) == 2.0, "the first measurement is taken whole"
    assert motion.blend_turn_rate(1.0, 2.0, 0.6) == pytest.approx(1.6)
    assert motion.blend_turn_rate(1.0, None, 0.6) == 1.0, "nothing measured keeps what was known"


# ------------------------------------------------------------------ the model is a choice

def test_the_model_library_offers_the_models_and_an_unknown_choice_still_flies():
    definitions = load_definitions()
    offered = aircraft_models(definitions)
    assert [model["model_id"] for model in offered] == ["constant_velocity_v1", "coordinated_turn_v1"]
    assert all(model["label"] and model["note"] for model in offered)
    assert aircraft_model(definitions, "coordinated_turn_v1")["turn"] is True
    assert aircraft_model(definitions, "constant_velocity_v1").get("turn") is False
    # Whichever is chosen, the shared limits come with it.
    for model_id in (None, "constant_velocity_v1", "coordinated_turn_v1", "no_such_model"):
        model = aircraft_model(definitions, model_id)
        assert model["max_extrapolation_seconds"] == 60 and model["max_speed_mps"] == 450
    assert aircraft_model(definitions, "no_such_model")["model_id"] == "constant_velocity_v1", "falls back, never fails"
    assert estimation_policy(None)["prediction"] is False, "an engine asked for nothing projects nothing"
    assert estimation_policy(lambda: {"prediction": True})["enabled"] is True, "a partial policy is completed"


def test_a_turning_aircraft_is_carried_around_the_turn_only_by_the_turning_model():
    """Two ticks of a right turn, then the gap the estimator must bridge."""
    tracks = [(100, 90.0), (130, 180.0)]   # 90 degrees over 30 s: a standard rate turn
    carried = {}
    for name, policy in (("straight", STRAIGHT), ("turning", TURNING)):
        flight = Flight(policy)
        for moment, track in tracks:
            # The observed place matters less than the reported track; both models
            # take the same observations, so any difference is the model itself.
            flight.observe(moment, track)
            flight.tick(moment + 1)
        state = flight.tick(160)   # 30 s after the last observation, nothing new
        carried[name] = state
    assert carried["straight"].heading_deg == pytest.approx(180, abs=1), "a straight model keeps the last track"
    assert carried["turning"].heading_deg == pytest.approx(270, abs=6), "a turning model keeps turning"
    apart = math.dist(carried["straight"].position_ecef_m, carried["turning"].position_ecef_m)
    assert apart > 2000, f"after 30 s the two models are {apart:.0f} m apart, which is the point of choosing"
    assert carried["turning"].quality == "valid" and carried["turning"].derivation == "estimated"


def test_a_sustained_turn_keeps_its_rate_instead_of_decaying_into_the_estimate():
    """The rate is measured between reported tracks, never against a heading the
    model has already turned: comparing with its own estimate would measure what
    is left over and fade a steady turn to nothing."""
    flight = Flight(TURNING)
    measured = []
    for index in range(5):
        moment = 100 + 30 * index
        flight.observe(moment, (90 * index) % 360)   # a standard rate turn, held
        flight.tick(moment + 1)
        measured.append(flight.sync._turn.get("test:abc123"))
    assert measured[0] is None, "one observation is not a turn"
    assert all(rate == pytest.approx(3.0, abs=0.01) for rate in measured[1:]), measured
    # The same observation arriving again on the next tick is not a second measurement.
    flight.tick(240)
    assert flight.sync._turn["test:abc123"] == pytest.approx(3.0, abs=0.01)
    # Rolling out is followed as readily as rolling in.
    for moment in (250, 280):
        flight.observe(moment, 0.0)
        flight.tick(moment + 1)
    assert abs(flight.sync._turn["test:abc123"]) < 1.0, "a turn that stopped stops being carried"


def test_switching_estimation_off_leaves_each_aircraft_at_its_last_observation():
    off = Flight({**STRAIGHT, "enabled": False})
    on = Flight(STRAIGHT)
    for flight in (off, on):
        flight.observe(100)
        flight.tick(101)
    first = off.tick(130)
    moving = on.tick(130)
    observed = to_ecef(LAT, LON, ALT)
    assert math.dist(first.position_ecef_m, observed) < 1, "nothing is invented between observations"
    assert first.derivation == "observed"
    # And when the aircraft is missing from a batch entirely it is carried the
    # same way: still where it was seen, and still called an observation.
    carried = off.sync.synchronize((), 140, previous=off.previous)[0]
    assert math.dist(carried.position_ecef_m, observed) < 1
    assert carried.derivation == "observed", "nothing was estimated, so nothing says it was"
    kept = on.sync.synchronize((), 140, previous=on.previous)[0]
    assert kept.derivation == "estimated" and math.dist(kept.position_ecef_m, observed) > 1000
    assert math.dist(moving.position_ecef_m, observed) == pytest.approx(SPEED * 30, rel=0.02), "the estimate carries on"
    # A new observation is taken as it is rather than blended in.
    for flight in (off, on):
        flight.observe(130, latitude=LAT + 0.05)
    jumped, absorbed = off.tick(131), on.tick(131)
    assert jumped.latitude_deg == pytest.approx(LAT + 0.05, abs=1e-6), "the observation is the state"
    assert absorbed.latitude_deg < LAT + 0.05, "with estimation on the correction is eased in"
    assert off.sync.trajectory(jumped, 131) is None, "an estimator that is off predicts nothing"


# ------------------------------------------------------------------ the predicted path

def test_the_predicted_path_is_the_next_seconds_of_the_chosen_model_and_says_so():
    flight = Flight(STRAIGHT)
    flight.observe(100)
    state = flight.tick(110)
    path = flight.sync.trajectory(state, 110)
    assert path["kind"] == "aircraft" and path["derivation"] == "estimated"
    assert path["reference_frame"] == "ecef_m" and path["entity_id"] == state.entity_id
    # One point a second, from now to a little past the fifteen that are drawn.
    assert [point[0] for point in path["points"]] == [110 + step for step in range(24)]
    assert path["span_seconds"] == 15
    assert path["summary"]["distance_m"] == pytest.approx(SPEED * 15, rel=0.01)
    assert path["summary"]["model"] == "constant_velocity_v1" and path["summary"]["model_label"] == "등속 외삽"
    assert path["summary"]["observation_age_seconds"] == 10 and path["summary"]["truncated"] is False
    assert path["summary"]["turn_rate_dps"] is None and path["summary"]["ground_speed_mps"] == pytest.approx(SPEED, rel=1e-6)
    assert "비행계획" in path["note"] and "궤적이 아닙니다" in path["note"]
    assert rc._at(path["points"], 125) == path["points"][15][1:], "the drawn window ends where it says"
    # Every drawn point is where the model would have put the aircraft anyway.
    carried = flight.sync.synchronize(flight.store.records(), 120, previous=flight.previous)[0]
    at_120 = next(point for point in path["points"] if point[0] == 120)
    assert math.dist(carried.position_ecef_m, at_120[1:]) < 1


def test_a_turning_prediction_curves_and_a_longer_one_is_cut_at_the_validity_edge():
    flight = Flight({**TURNING, "prediction_seconds": 60})
    for moment, track in ((100, 90.0), (130, 180.0)):
        flight.observe(moment, track)
        flight.tick(moment + 1)
    state = flight.tick(150)
    path = flight.sync.trajectory(state, 150)
    assert path["summary"]["turn_rate_dps"] == pytest.approx(3.0, abs=0.01), "a standard rate turn, carried"
    assert path["span_seconds"] == pytest.approx(40), "cut where the estimate stops being valid (130 + 60)"
    assert path["summary"]["truncated"] is True and path["valid_until"] == pytest.approx(190)
    straight_line = math.dist(path["points"][0][1:], path["points"][-1][1:])
    along_path = sum(math.dist(a[1:], b[1:]) for a, b in zip(path["points"], path["points"][1:]))
    assert along_path > straight_line * 1.1, "the drawn path curves rather than running straight"
    assert path["summary"]["heading_end_deg"] == pytest.approx((state.heading_deg + 120) % 360, abs=2)
    # Once the state is past its own validity edge there is nothing left to project from.
    assert flight.sync.trajectory(flight.tick(200), 200) is None


def test_the_served_path_runs_past_the_drawn_window_so_the_display_can_slide_it():
    """The display draws `seconds` of path but keeps sliding it along until the
    next fetch, so what is served has to cover a little more than that."""
    flight = Flight(STRAIGHT)
    flight.observe(100)
    state = flight.tick(110)
    path = flight.sync.trajectory(state, 110)
    summary = path["summary"]
    assert summary["seconds"] == 15, "what is drawn is what was asked for"
    assert summary["covered_seconds"] == 15 + rc.PREDICTION_LEAD_SECONDS
    assert path["points"][-1][0] == pytest.approx(110 + summary["covered_seconds"])
    assert summary["distance_m"] == pytest.approx(SPEED * 15, rel=0.01), "measured over the drawn window"
    # Near the validity edge both are cut, and the display simply has less to slide.
    late = flight.sync.trajectory(flight.tick(150), 150)
    assert late["summary"]["seconds"] == pytest.approx(10) and late["summary"]["covered_seconds"] == pytest.approx(10)
    assert late["summary"]["truncated"] is True


def test_a_prediction_is_bounded_in_points_and_never_asks_for_the_impossible():
    flight = Flight({**STRAIGHT, "prediction_seconds": 120})
    flight.observe(100)
    state = flight.tick(101)
    path = flight.sync.trajectory(state, 101)
    assert 2 <= len(path["points"]) <= 300
    assert path["points"][-1][0] == pytest.approx(101 + path["span_seconds"])
    import dataclasses
    for broken in (dataclasses.replace(state, velocity_ecef_mps=None), dataclasses.replace(state, kind="unknown")):
        assert flight.sync.trajectory(broken, 101) is None


# ------------------------------------------------------------------ the operator's decision

def test_estimation_and_prediction_are_two_settings_that_reach_the_running_twin():
    """They are different jobs: one makes the twin's state, the other draws a
    picture of one object. A model that can do one cannot always do the other,
    so they are chosen apart and land in their own group."""
    described = describe_library()
    sources = {item["id"]: item for item in described["sources"]}
    estimation, prediction = sources["state_estimation"], sources["trajectory_prediction"]
    assert estimation["group"] == "ai_models" and prediction["group"] == "ai_models"
    assert [field["name"] for field in estimation["fields"]] == ["enabled", "model"]
    assert [field["name"] for field in prediction["fields"]] == ["enabled", "model", "seconds"]
    # The model is chosen from the AI library, not from a list of names.
    assert [field["kind"] for field in estimation["fields"]] == ["toggle", "model"]
    assert estimation["fields"][1]["job"] == "estimation" and prediction["fields"][1]["job"] == "prediction"
    assert estimation["provider"] == "등속 외삽" and prediction["provider"] == "추정 모델과 동일"
    assert "트윈의 상태 자체를" in estimation["note"] and "비행계획이 아닙니다" in prediction["note"]
    assert DEFAULTS["state_estimation"] == {"enabled": True, "model": "constant_velocity_v1"}
    assert DEFAULTS["trajectory_prediction"] == {"enabled": True, "model": "same_as_estimation", "seconds": 15}
    # A learned model may draw a path but is never offered as the estimator.
    assert "gru_direct_v1_1" in [model["model_id"] for model in PREDICTION_MODELS]
    assert "gru_direct_v1_1" not in [model["model_id"] for model in ESTIMATION_MODELS]
    settled = validate_settings({"sources": {"state_estimation": {"model": "coordinated_turn_v1"},
                                             "trajectory_prediction": {"model": "constant_velocity_v1", "seconds": 30}}})
    assert settled["sources"]["state_estimation"] == {"enabled": True, "model": "coordinated_turn_v1"}
    assert settled["sources"]["trajectory_prediction"] == {"enabled": True, "model": "constant_velocity_v1", "seconds": 30}
    for source, bad, field in [("state_estimation", {"model": "kalman"}, "model"),
                               ("state_estimation", {"model": "gru_direct_v1_1"}, "model"),
                               ("trajectory_prediction", {"seconds": 300}, "seconds"),
                               ("trajectory_prediction", {"seconds": 1}, "seconds"),
                               ("trajectory_prediction", {"enabled": "yes"}, "enabled")]:
        with pytest.raises(ValueError) as error:
            validate_settings({"sources": {source: bad}})
        assert str(error.value).startswith(f"{source}.{field}:")
    # The running twin reads both every tick, so a change needs no restart.
    policy = LibraryPolicy(settled)
    synchronizer = LiveSynchronizer(estimation=policy.estimation)
    assert synchronizer.aircraft_model()["model_id"] == "coordinated_turn_v1"
    assert synchronizer.prediction_model()["model_id"] == "constant_velocity_v1", "parted from the estimator on purpose"
    policy.apply(validate_settings({"sources": {"state_estimation": {"model": "constant_velocity_v1"},
                                                "trajectory_prediction": {"model": "same_as_estimation"}}}, base=settled))
    assert synchronizer.aircraft_model()["model_id"] == "constant_velocity_v1"
    assert synchronizer.prediction_model()["model_id"] == "constant_velocity_v1", "following the estimator again"


def test_gru_without_injected_provider_history_draws_nothing():
    """Available weights alone do not supply corrected provider inputs."""
    flight = Flight({**STRAIGHT, "prediction_model": "gru_direct_v1_1"})
    flight.observe(100)
    state = flight.tick(110)
    assert flight.sync.prediction_model()['model_id'] == 'gru_direct_v1_1'
    assert flight.sync.trajectory(state, 110) is None
    following = Flight({**STRAIGHT, "prediction_model": "same_as_estimation"})
    following.observe(100)
    assert following.sync.trajectory(following.tick(110), 110) is not None


def test_the_wire_serves_the_prediction_only_while_it_is_switched_on(tmp_path):
    import time

    async def fetch():
        return observation(time.time() - 5)

    from user_application.apps.web_dashboard.application import SourceBinding
    binding = SourceBinding("test", "aircraft_v1", fetch, 5)
    config = {"cache_directory": str(tmp_path), "workspace_directory": str(tmp_path), "tick_seconds": 0.05,
              "stream_seconds": 5, "celestrak_enabled": False, "opensky_enabled": False}
    with TestClient(create_app(config, sources=[binding])) as client:
        for _ in range(80):
            snapshot = client.get("/api/live/snapshot").json()
            if snapshot["entities"]:
                break
            time.sleep(0.05)
        entity = snapshot["entities"][0]
        assert entity["kind"] == "aircraft"
        path = client.get(f"/api/live/trajectory/{entity['entity_id']}")
        assert path.status_code == 200, "the default settings draw the next fifteen seconds"
        body = path.json()
        assert body["kind"] == "aircraft" and body["span_seconds"] == 15
        assert body["summary"]["covered_seconds"] == 23, "fifteen drawn, the rest for the display to slide into"
        assert len(body["points"]) == 24
        assert client.put("/api/library/sources", json={"sources": {"trajectory_prediction": {"enabled": False}}}).status_code == 200
        assert client.get(f"/api/live/trajectory/{entity['entity_id']}").status_code == 404, "asked for none, none served"
        assert client.put("/api/library/sources", json={"sources": {"trajectory_prediction": {"enabled": True, "model": "coordinated_turn_v1"}}}).status_code == 200
        turned = client.get(f"/api/live/trajectory/{entity['entity_id']}").json()
        assert turned["summary"]["model"] == "coordinated_turn_v1", "the choice applied without a restart"
        stored = client.get("/api/library/sources").json()["values"]
        assert stored["state_estimation"] == {"enabled": True, "model": "constant_velocity_v1"}
        assert stored["trajectory_prediction"] == {"enabled": True, "model": "coordinated_turn_v1", "seconds": 15}
        # The card says which model draws and which estimates, separately.
        state = {item["id"]: item["message"] for item in client.get("/api/library/sources").json()["state"]}
        assert "등속 외삽" in state["state_estimation"]
        assert "선회 보정 외삽" in state["trajectory_prediction"] and "15초" in state["trajectory_prediction"]
        assert client.put("/api/library/sources", json={"sources": {"trajectory_prediction": {"model": "gru_direct_v1_1"}}}).status_code == 200
        state = {item["id"]: item for item in client.get("/api/library/sources").json()["state"]}
        assert state["trajectory_prediction"]["status"] == "ready"
        assert "보정 입력" in state["trajectory_prediction"]["message"]
        learned = client.get(f"/api/live/trajectory/{entity['entity_id']}")
        assert learned.status_code == 200
        assert len(learned.json()['points']) == 76
        assert '보정 입력' in learned.json()['note']
