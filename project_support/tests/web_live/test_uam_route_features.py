"""Turning a flight we hold into what the UAM networks ask to be fed.

The route half is the interesting one: those models want the remaining flight
as up to forty-eight segments of thirteen values, in coordinates aligned with
where the aircraft is pointing now, cut at the distance it could cover in the
horizon. All of that is checkable on its own, and these tests check it.
"""
import math

import pytest

from digital_twin.simulation import uam_route_features as rf

# A flight due north, then a right turn to the east. Latitudes are cheap to
# reason about: a thousandth of a degree of latitude is about 111 m.
NORTH = (37.500, 127.000, 300.0)
CORNER = (37.510, 127.000, 300.0)
EAST = (37.510, 127.020, 300.0)
LEG = [NORTH, CORNER, EAST]


def metres(a, b):
    east, north, up = rf._enu(a, b)
    return math.sqrt(east * east + north * north + up * up)


def test_a_corridor_becomes_segments_measured_from_where_the_aircraft_points():
    """Body-aligned: an aircraft heading north sees a leg due north as straight
    ahead, and the turn that follows as being to its right."""
    rows, mask = rf.route_segments(LEG, NORTH, 0.0, horizon_seconds=240, target_speed_mps=50)
    assert len(rows) == len(mask) == 2 and all(mask)
    first, second = rows
    assert first[0] == pytest.approx(metres(NORTH, CORNER), rel=0.01), "straight ahead"
    assert abs(first[1]) < 1.0, "and not to either side"
    assert first[3] == pytest.approx(1.0, abs=0.01), "the direction is forward"
    assert abs(first[4]) < 0.01
    # The turn at the end of the first segment is to the right, so its sine is
    # positive in a frame where right is positive.
    assert first[11] == 1.0 and first[9] > 0.5, "a right turn, and it is marked valid"
    assert first[12] == 0.0 and second[12] == 1.0, "only the last segment is terminal"
    # Distance along the route accumulates and does not restart.
    assert first[7] == 0.0
    assert first[8] == pytest.approx(first[6], rel=1e-6)
    assert second[7] == pytest.approx(first[8], rel=1e-6)
    assert second[8] > second[7]


def test_the_route_starts_where_the_aircraft_is_not_at_a_waypoint_it_has_passed():
    half = (37.505, 127.000, 300.0)
    rows, _ = rf.route_segments(LEG, half, 0.0, horizon_seconds=240, target_speed_mps=50)
    assert rows[0][0] == pytest.approx(metres(half, CORNER), rel=0.01)
    assert rows[0][6] == pytest.approx(metres(half, CORNER), rel=0.01), "half a leg, not a whole one"
    # And the whole remaining route is shorter than it was from the start.
    whole, _ = rf.route_segments(LEG, NORTH, 0.0, horizon_seconds=240, target_speed_mps=50)
    assert rows[-1][8] < whole[-1][8]


def test_the_route_is_cut_at_what_the_aircraft_could_fly_in_the_horizon():
    """Ten seconds at fifty metres a second is five hundred metres of route, and
    the segment that crosses that boundary is kept rather than clipped."""
    assert rf.crop_distance(10, 50) == 500
    short, _ = rf.route_segments(LEG, NORTH, 0.0, horizon_seconds=10, target_speed_mps=50)
    assert len(short) == 1, "the first segment already crosses the boundary"
    assert short[0][8] > 500, "and it is kept whole"
    long_route, _ = rf.route_segments(LEG, NORTH, 0.0, horizon_seconds=240, target_speed_mps=50)
    assert len(long_route) == 2, "a longer horizon reaches the end"
    # A horizon of nothing is not a crop of nothing: it is the whole route.
    assert len(rf.route_segments(LEG, NORTH, 0.0, horizon_seconds=0, target_speed_mps=0)[0]) == 2


def test_a_corridor_that_repeats_its_junctions_does_not_produce_empty_segments():
    """A plan's legs meet at a shared point, so joining them repeats every
    junction. A zero-length segment carries no direction and would tell the
    model nothing."""
    joined = [NORTH, CORNER, CORNER, EAST, EAST]
    rows, mask = rf.route_segments(joined, NORTH, 0.0, horizon_seconds=240, target_speed_mps=50)
    assert len(rows) == 2, "two real legs, however many times the junction is written"
    assert all(row[6] > 1.0 for row in rows), "and every segment has a length"
    assert all(row[3] ** 2 + row[4] ** 2 + row[5] ** 2 > 0.9 for row in rows), "and a direction"


def test_the_mask_and_the_padding_are_what_the_model_is_given():
    rows, mask = rf.route_segments(LEG, NORTH, 0.0, horizon_seconds=240, target_speed_mps=50)
    padded_rows, padded_mask = rf.padded(rows, mask)
    assert len(padded_rows) == rf.MAX_SEGMENTS and len(padded_mask) == rf.MAX_SEGMENTS
    assert all(len(row) == rf.ROUTE_FEATURES for row in padded_rows)
    assert padded_mask[:2] == [True, True] and not any(padded_mask[2:])
    assert all(value == 0.0 for row in padded_rows[2:] for value in row), "padding is zeros"
    # Valid segments come first, which is what the delivery asks for.
    assert padded_rows[0] == list(rows[0])


def test_nothing_ahead_is_answered_as_nothing_rather_than_as_a_segment():
    assert rf.route_segments([], NORTH, 0.0)[0] == []
    assert rf.route_segments([NORTH], NORTH, 0.0)[0] == []
    # Standing on the last point of the route.
    assert rf.route_segments(LEG, EAST, 0.0)[0] == []
    padded_rows, padded_mask = rf.padded([], [])
    assert len(padded_rows) == rf.MAX_SEGMENTS and not any(padded_mask)


def test_a_state_row_is_the_twenty_one_columns_in_the_delivered_order():
    state = {"latitude_deg": 37.500, "longitude_deg": 127.000, "altitude_m": 300.0,
             "heading_deg": 0.0, "speed_mps": 50.0}
    before = {"latitude_deg": 37.4995, "longitude_deg": 127.000, "altitude_m": 294.0,
              "heading_deg": -1.2, "speed_mps": 50.0}
    row = rf.state_row(state, elapsed_s=12.5, origin=(37.552, 127.0), route_points=LEG,
                       previous=before, dt=2.0)
    assert len(row) == rf.STATE_FEATURES == 21
    assert row[0] == 12.5, "t"
    # x and y are metres from the reference the training run used, so a point
    # south of it is negative north.
    assert row[2] == pytest.approx(-5786, rel=0.02)
    assert row[3] == 300.0, "z is the altitude as it stands"
    # The project's heading is the model's yaw plus ninety degrees.
    assert row[6] == pytest.approx(0.0 + rf.YAW_FROM_HEADING_DEG)
    assert row[7] == 50.0 and row[8] == 0.0, "forward speed, nothing sideways"
    assert row[9] == pytest.approx(3.0), "six metres of climb in two seconds"
    assert row[12] == pytest.approx(0.6), "and 1.2 degrees of turn in two"
    assert row[4] > 0, "a right turn banks right"
    assert row[5] > 0, "and a climb pitches up"
    assert row[16] == 50.0, "the controller is aiming at the speed it is flying"
    assert row[17] == 0.0, "cross-track: the engine flies the corridor exactly"
    assert row[18] == pytest.approx(metres((37.5, 127.0, 300.0), CORNER), rel=0.02), "the next waypoint ahead"


def test_a_state_with_nothing_before_it_reports_no_rates_rather_than_invented_ones():
    state = {"latitude_deg": 37.5, "longitude_deg": 127.0, "altitude_m": 300.0,
             "heading_deg": 90.0, "speed_mps": 40.0}
    row = rf.state_row(state, elapsed_s=0.0, origin=(37.552, 127.0), route_points=LEG)
    assert row[4] == row[5] == 0.0, "no attitude without a step to compare"
    assert row[10] == row[11] == row[12] == 0.0, "and no rates"
    assert row[7] == 40.0, "the speed is still known"


def test_what_was_built_is_described_so_a_caller_can_refuse_to_run_on_it():
    rows, mask = rf.route_segments(LEG, NORTH, 0.0, horizon_seconds=240, target_speed_mps=50)
    described = rf.describe(rows, mask, points=LEG, horizon_seconds=240, target_speed_mps=50)
    assert described["schema"] == "shared_segment_v014"
    assert described["segments"] == 2 and described["max_segments"] == 48
    assert described["features"] == 13
    assert described["complete"] is True, "the route reaches its end inside the horizon"
    assert described["crop_m"] == 12000
    # The one column a kinematic engine cannot fill honestly is named.
    assert described["cross_track_is_zero"] is True
    short = rf.route_segments(LEG, NORTH, 0.0, horizon_seconds=10, target_speed_mps=50)
    assert rf.describe(*short, points=LEG, horizon_seconds=10, target_speed_mps=50)["complete"] is False


def test_body_coordinates_turn_with_the_aircraft():
    """The same place is ahead of one heading and to the side of another."""
    east, north, up = 0.0, 1000.0, 0.0
    ahead = rf.to_body(east, north, up, 0.0)
    assert ahead[0] == pytest.approx(1000.0) and abs(ahead[1]) < 1e-9
    beside = rf.to_body(east, north, up, 90.0)
    assert abs(beside[0]) < 1e-9 and beside[1] == pytest.approx(-1000.0), "north is to the left facing east"
    behind = rf.to_body(east, north, up, 180.0)
    assert behind[0] == pytest.approx(-1000.0)
