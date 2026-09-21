"""Single-run and incremental fleet execution must fly the same observations.

These tests run FastPhysics, not the kinematic rehearsal or visual interpolation.
The short climb and close turn used to trap the fleet pilot behind a waypoint.
"""
import math
import subprocess

import pytest

from communication.python.native_pilot import NativePilotLibrary
from digital_twin.model_library import flight_plan
from digital_twin.simulation import native_flight_engine as single
from digital_twin.simulation.scenario_engine import Phase, Route
from user_application.uam_mission.scenario_pilots import FlightPilot


POINTS = [(0, 0, -30, 2, 0, 8), (650, 0, -300, 47, 1, 60),
          (850, 200, -300, 60, 1, 60), (2000, 2000, -300, 60, 1, 60),
          (5000, 2500, -300, 60, 1, 60), (5500, 2900, -30, 25, 0, 60),
          (5500, 2900, 0, 2, 0, 8)]


@pytest.fixture(scope="module")
def library():
    try:
        return NativePilotLibrary()
    except (OSError, RuntimeError):
        pytest.skip("build aerodt_uam_pilot to validate actual flight guidance")


def fly(library, points=POINTS, yaw=170, landing=75, chunks=(1.0,)):
    pilot = library.create(points, yaw, landing)
    rows = []
    try:
        for _ in range(1800):
            for seconds in chunks:
                state = pilot.advance(seconds)
            rows.append(state)
            if state[16]:
                return rows
        pytest.fail(f"pilot failed to finish: waypoint {state[14]}, position {state[1:4]}")
    finally:
        pilot.close()


@pytest.fixture(scope="module")
def flown(library):
    return fly(library)


def test_takeoff_rises_once_then_aligns_at_hover_height(flown):
    lifting = [r for r in flown if r[14] == 0]
    assert len(lifting) > 20
    assert max(r[10] for r in lifting) < 1
    assert all(abs(r[7] - 170) < 0.1 for r in lifting), "no turn before the hover"
    assert max(b[3] - a[3] for a, b in zip(lifting, lifting[1:])) < 0.05
    assert all(abs(r[3]) < 0.01 for r in lifting if r[0] <= 6)
    assert lifting[4][15] > lifting[0][15], "spool-up is measured actuator motion"
    # A fly-by may begin yawing again before the climb vertex. Only the
    # initial departure alignment should be checked against the hover height.
    departure = [r for r in flown if r[14] == 1]
    moving = next(i for i, r in enumerate(departure) if math.hypot(r[4], r[5]) > 0.5)
    turning = [r for r in departure[:moving] if abs(r[7]) > 8]
    assert abs(departure[moving][7]) < 2, "acceleration starts only after actual alignment"
    assert len(turning) >= 10, "the 170-degree alignment is gradual"
    assert max(abs(-r[3] - 30) for r in turning) < 0.6
    assert max(math.hypot(r[4], r[5]) for r in turning) < 0.5
    assert max(r[10] for r in turning) < 1


def test_short_climb_and_corners_do_not_interrupt_winged_cruise(flown):
    modes = []
    for r in flown:
        mode = 0 if r[10] <= 15 else 2 if r[10] >= 75 else 1
        if not modes or modes[-1] != mode:
            modes.append(mode)
    assert modes == [0, 1, 2, 1, 0], "only the planned forward and reverse transitions"
    # Exclude the last winged waypoint, which includes the approach braking.
    cruise = [r for r in flown if r[14] in (2, 3)]
    assert len(cruise) > 20 and min(r[10] for r in cruise) > 75
    assert min(r[12] for r in cruise) > 20
    assert max(-r[3] for r in flown) < 340, "no transition balloon hundreds of metres high"
    assert flown[-1][16] and flown[-1][13]
    assert math.dist(flown[-1][1:4], POINTS[-1][:3]) < 0.3


def test_single_runner_and_fleet_bridge_share_the_entire_flight(flown):
    runner = single.runner_path(".")
    if runner is None:
        pytest.skip("build aerodt_uam_flight_runner for cross-entry-point parity")
    points = [dict(zip(("north_m", "east_m", "down_m", "speed_mps", "fixed_wing", "capture_m"), p))
              for p in POINTS]
    result = subprocess.run([str(runner)], input=single.render_input(
        points, initial_yaw_deg=170, landing_yaw_deg=75, emit_s=1, timeout_s=1800),
        text=True, capture_output=True, timeout=120, check=True)
    rows = [tuple(map(float, line.split()[1:])) for line in result.stdout.splitlines()
            if line.startswith("state ")][1:]
    assert len(rows) == len(flown)
    for observed, expected in zip(rows, flown):
        # The CLI prints four fractional digits; the ABI exposes full doubles.
        assert observed == pytest.approx(expected[:16], abs=5.1e-5)


def test_incremental_delivery_does_not_change_the_physical_trajectory(library, flown):
    chunked = fly(library, chunks=(0.07, 0.33, 0.6))
    assert chunked == flown


def test_single_and_fleet_use_the_same_waypoint_capture_rules():
    path = lambda n, e, h: [127 + e / (111320 * math.cos(math.radians(37))),
                            37 + n / 111320, h, "msl"]
    legs = [{"stage": stage, "name": stage, "kind": kind,
             "path": [path(*a), path(*b)], "speed_mps": speed}
            for stage, kind, a, b, speed in (
                ("takeoff", "vertical", (0, 0, 0), (0, 0, 30), 2),
                ("climb", "air", (0, 0, 30), (700, 0, 300), 45),
                ("cruise", "air", (700, 0, 300), (5000, 0, 300), 60),
                ("descent", "air", (5000, 0, 300), (6000, 0, 30), 25),
                ("landing", "vertical", (6000, 0, 30), (6000, 0, 0), 2))]
    phases = [Phase(leg["stage"], leg["name"], [(p[1], p[0], p[2]) for p in leg["path"]],
                    60, leg["speed_mps"], {}) for leg in legs]

    class Capture:
        def create(self, points, *args):
            self.points = points
            return None

    capture = Capture()
    FlightPilot(capture, Route("parity", phases, {}, {}), 0)
    points, _ = single.waypoints_of({"legs": legs})
    for incremental, batch in zip(capture.points, points):
        assert incremental == pytest.approx(tuple(float(batch[k]) for k in
            ("north_m", "east_m", "down_m", "speed_mps", "fixed_wing", "capture_m")))
    assert capture.points[2][-1] == flight_plan.ROUTE_CAPTURE_M
