"""Mission intent improves the projection without moving simulation truth."""
from dataclasses import replace
import math

import pytest

from digital_twin.contracts.live import TwinEntity
from digital_twin.contracts.prediction import PredictionWaypoint, UamPredictionIntent
from digital_twin.live_twin.uam_trajectory import uam_trajectory, _ecef


def entity(phase="cruise", speed=20, climb=0, altitude=300):
    # Equator: ECEF x is up, z is north, y is east. Attitude yaw intentionally
    # differs from the northward velocity, as it can in a real native turn.
    return TwinEntity("scenario:A", "A", "uam", _ecef(0, 0, altitude), (climb, 0, speed),
                      0, 0, altitude, 90, 100, 100, 100, None, "simulated", "nominal", "scenario",
                      "asset_states", "airtaxi", flight_phase=phase)


def waypoint(north, east, height=300, speed=20, phase="cruise", start=(0, 0, 300)):
    return PredictionWaypoint(start, (north / 111320, east / 111320, height), speed, phase)


def intent_for(e, points=(), **kw):
    return UamPredictionIntent(e.entity_id, e.state_time, "F1", e.flight_phase, tuple(points), **kw)


def height(point):
    return math.hypot(*point[1:]) - 6378137


def test_idle_does_not_invent_a_departure_and_input_is_immutable():
    e = entity("parked", 0)
    before = repr(e)
    path = uam_trajectory(e, 60, intent_for(e))
    assert path["summary"]["basis"] == "mission_intent"
    assert all(math.dist(p[1:], e.position_ecef_m) < .001 for p in path["points"])
    assert repr(e) == before


def test_turn_uses_remaining_targets_in_order_and_starts_with_measured_velocity():
    e = entity()
    a = waypoint(180, 0)
    b = waypoint(180, 800, start=a.end)
    path = uam_trajectory(e, 35, intent_for(e, [a, b]))
    points = path["points"]
    first_delta = [b-a for a, b in zip(points[0][1:], points[1][1:])]
    assert first_delta[2] > 9, "uses northward velocity, not east-facing attitude"
    assert abs(first_delta[1]) < .5
    assert points[-1][2] > 300, "anticipates the eastbound next leg"
    assert abs(points[-1][3] - 180) < 80, "does not extrapolate north past the corner"
    assert all(b[0] > a[0] for a, b in zip(points, points[1:]))
    speeds = [math.dist(a[1:], b[1:]) / (b[0]-a[0]) for a, b in zip(points, points[1:])]
    assert max(speeds) <= 20.2


def test_takeoff_stays_vertical_then_follows_the_climb():
    e = entity("takeoff", 0, 2, 20)
    a = waypoint(0, 0, 60, 2, "takeoff", start=(0, 0, 20))
    b = waypoint(500, 0, 120, 20, "climb", start=a.end)
    path = uam_trajectory(e, 60, intent_for(e, [a, b]))
    early = path["points"][10]
    assert math.hypot(early[2], early[3]) < .01
    assert height(early) > 28
    assert path["points"][-1][3] > 100


def test_approach_respects_vertical_rate_and_landing_does_not_pass_through_deck():
    e = entity("landing", 0, -1.2, 25)
    path = uam_trajectory(e, 60, intent_for(e, [waypoint(0, 0, 20, 1.2, "landing", start=(0, 0, 25))]))
    heights = [height(p) for p in path["points"]]
    assert min(heights) >= 19.8
    assert heights[-1] == pytest.approx(20, abs=1)
    rates = [(b-a)/.5 for a, b in zip(heights, heights[1:])]
    assert min(rates) >= -1.21


def test_hold_does_not_resume_the_route_without_another_clearance():
    e = entity("hold", 4)
    path = uam_trajectory(e, 90, intent_for(e, [waypoint(30, 0, speed=6, phase="hold")], holding=True))
    assert path["summary"]["holding"] is True
    assert math.dist(path["points"][-1][1:], _ecef(30/111320, 0, 300)) < 2


def test_old_mission_context_is_not_attached_to_a_new_state():
    e = entity()
    context = replace(intent_for(e, [waypoint(0, 1000)]), state_time=99)
    path = uam_trajectory(e, 240, context)
    assert path["summary"]["basis"] == "velocity_fallback"
    assert path["summary"]["seconds"] == 10
    assert path["summary"]["requested_seconds"] == 240
    assert "임무 정보" in path["note"]


def test_horizon_points_and_validity_are_bounded():
    e = entity()
    context = intent_for(e, [waypoint(20000, 0)])
    path = uam_trajectory(e, 999999, context)
    assert len(path["points"]) <= 300
    assert path["summary"]["seconds"] == 240
    assert path["points"][-1][0] == pytest.approx(348)
    e = replace(e, valid_until=107.3)
    path = uam_trajectory(e, 60, context)
    assert path["points"][-1][0] == pytest.approx(107.3)
    assert uam_trajectory(replace(e, valid_until=99), 60, context) is None
    assert uam_trajectory(e, float("nan"), context) is None


def test_bad_route_data_is_rejected_without_nan_output():
    e = entity()
    bad = PredictionWaypoint((0, 0, 300), (float("nan"), 0, 300), 20, "cruise")
    assert uam_trajectory(e, 60, intent_for(e, [bad])) is None


def test_cruise_does_not_accelerate_to_a_catalogue_speed_the_aircraft_is_not_flying():
    e = entity(speed=12)
    path = uam_trajectory(e, 30, intent_for(e, [waypoint(20000, 0, speed=60)]))
    assert math.dist(path["points"][0][1:], path["points"][20][1:]) == pytest.approx(120, abs=1)


def test_idle_without_a_velocity_still_has_a_stationary_mission_prediction():
    e = replace(entity("parked", 0), velocity_ecef_mps=None)
    assert uam_trajectory(e, 60, intent_for(e))["summary"]["distance_m"] < .01
