"""Physical fly-bys, not animation: lane recovery, ordered crossings and tilt."""
import math

import pytest

from communication.python.native_pilot import NativePilotLibrary
from digital_twin.model_library import flight_plan, scheduled_route
from digital_twin.simulation import decision_policy
from project_support.tools.web_visualization.right_lane_tracking_check import (
    cases, fly, measure, targets_of)


@pytest.fixture(scope="module")
def library():
    try:
        return NativePilotLibrary()
    except (OSError, RuntimeError):
        pytest.skip("build native pilot for physical right-lane checks")


@pytest.fixture(scope="module", params=list(cases()))
def route(request, library):
    centreline = cases()[request.param]
    targets = targets_of(centreline)
    rows = fly(library, targets)
    return request.param, rows, targets, measure(rows, targets, centreline)


def test_fly_bys_do_not_cause_reverse_tilt_or_unordered_wp_jumps(route):
    name, rows, targets, result = route
    assert result["done"] and rows[-1][13], name
    assert result["mode_sequence"] == ["rotor", "transition", "wing", "transition", "rotor"]
    assert all(after == before + 1 for _, before, after in result["index_changes"])
    assert [after for _, _, after in result["index_changes"]] == list(range(1, len(targets)+1))
    def remaining(row):
        index = int(row[14])
        return math.dist(row[1:3], targets[index][:2]) + sum(
            math.dist(a[:2], b[:2]) for a, b in zip(targets[index:], targets[index+1:]) if b[4])
    # The final 700 m of the winged polyline intentionally includes approach
    # reversal; waypoint index alone is not a flight-mode boundary.
    cruise = [r for r in rows if 3 <= r[14] < len(targets)-2 and remaining(r) > 1000]
    assert cruise and min(r[10] for r in cruise) > 75
    assert min(r[12] for r in cruise) > 26, "turns retain a margin above wing recovery speed"
    assert max(x for x in result["waypoint_nearest_m"] if x is not None) < 250


def test_right_lane_recovered_after_turn_and_crossing(route):
    name, _, _, result = route
    if name == "sharp_143":
        # The near-hairpin is a stress case, not separation assurance. Record
        # its transient excursion instead of pretending it remains in-lane.
        assert result["max_lane_error_m"] < 230
        assert result["margins"]["300"]["minimum_right_m"] > -180
    else:
        steady = result["margins"]["300"]
        assert steady["samples"] > 100
        assert 0 < steady["minimum_right_m"] <= steady["maximum_right_m"] < 150
        assert steady["wrong_side_samples"] == 0


def test_capture_tolerance_and_preview_are_not_the_same_setting():
    parameter = next(p for p in decision_policy.PILOT_PARAMETERS if p["id"] == "turn_capture_m")
    assert flight_plan.ROUTE_CAPTURE_M == parameter["default"] == 150
    assert flight_plan.waypoint_capture_m(False, 0) == 150
    assert flight_plan.waypoint_capture_m(True, 30) == pytest.approx(1.8)
    assert flight_plan.waypoint_capture_m(True, -30) == 8


def test_right_lane_keeps_height_and_intersection_offset_and_tapers_only_at_ends():
    points = [(37, 127, 300), (37.03, 127, 400), (37.03, 127.04, 500)]
    lane = scheduled_route.right_cruise(points)
    assert lane[0] == points[0] and lane[-1] == points[-1]
    assert scheduled_route.RIGHT_OFFSET_M == 75
    assert scheduled_route.MERGE_LENGTH_M == 300
    # A right-angle join stays on the right of BOTH incident segments.
    corner = next(p for p in lane if p[2] == 400)
    assert corner[0] < points[1][0] and corner[1] > points[1][1]
    assert math.isclose((points[1][0]-corner[0])*111320, 75, abs_tol=.1)
    narrow = scheduled_route.right_cruise(points, 20)
    assert abs(narrow[1][1]-127) < abs(lane[1][1]-127)
    assert points[1] == (37.03, 127, 400), "source network is immutable"
