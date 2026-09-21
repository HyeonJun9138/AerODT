"""Flight guidance regressions, independent of editable vertiport layouts."""
import math
import subprocess

import pytest

from digital_twin.simulation import native_flight_engine as native


@pytest.fixture(scope="module")
def flight():
    binary = native.runner_path(".")
    if binary is None:
        pytest.skip("native runner is not built")
    command = """step 0.004
emit 0.2
timeout 800
initial_yaw 90
smooth_flight 1
waypoint 0 0 -30 3 0 2
waypoint 1100 0 -300 30 1 60
waypoint 2200 300 -300 40 1 60
waypoint 2400 300 -150 28 1 60
waypoint 2600 300 -30 15 0 60
waypoint 2600 300 0 3 0 8
run
"""
    result = subprocess.run([str(binary)], input=command, text=True,
                            capture_output=True, timeout=120)
    states, ending, error = native.parse_output(result.stdout)
    assert result.returncode == 0, (ending, error)
    assert ending["reached"] == ending["total"] == 6
    return states


def test_spool_precedes_lift_and_vertical_speed_is_bounded(flight):
    spool = [s for s in flight if s["t"] < 6]
    assert max(abs(s["down_m"]) for s in spool) < 0.02
    assert spool[-1]["rotor_radps"] > 150
    assert all(b["rotor_radps"] >= a["rotor_radps"] for a, b in zip(spool, spool[1:]))
    lift = [s for s in flight if s["waypoint"] == 0]
    assert lift[-1]["t"] > 20
    assert max(s["speed_mps"] for s in lift) < 2.5


def test_departure_yaw_is_gradual_and_lift_stays_in_column(flight):
    lift = [s for s in flight if s["waypoint"] == 0]
    assert max(math.hypot(s["north_m"], s["east_m"]) for s in lift) < 0.5
    for a, b in zip(lift, lift[1:]):
        yaw = abs((b["yaw_deg"] - a["yaw_deg"] + 180) % 360 - 180)
        assert yaw / (b["t"] - a["t"]) < 13


def test_tilt_is_measured_and_changes_slowly_in_both_directions(flight):
    assert max(s["tilt_deg"] for s in flight) > 85
    assert flight[-1]["tilt_deg"] < 1
    for a, b in zip(flight, flight[1:]):
        if b["t"] > a["t"]:
            assert abs(b["tilt_deg"] - a["tilt_deg"]) / (b["t"] - a["t"]) < 8.0


def test_arrival_hover_precedes_vertical_descent_and_touchdown_is_real(flight):
    landing = [s for s in flight if s["waypoint"] == 5]
    assert landing[0]["down_m"] < -29
    low = [s for s in landing if s["down_m"] > -28]
    assert max(math.hypot(s["north_m"] - 2600, s["east_m"] - 300) for s in low) < 1
    assert max(s["speed_mps"] for s in low) < 1.6
    assert flight[-1]["grounded"]
    assert abs(flight[-1]["down_m"]) < 0.02
    assert flight[-1]["speed_mps"] < 0.05
    assert flight[-1]["rotor_radps"] > 150, "touchdown is not motor shutdown"


def test_account_preserves_native_vertical_motion():
    plan = {"legs": [{"start_s": 0, "duration_s": 10, "distance_m": 0,
                       "battery_start_pct": 100, "battery_end_pct": 99,
                       "path": [[127, 37, 30, "deck:VP"], [127, 37, 0, "deck:VP"]]}]}
    state = {"t": 5, "leg": 0, "f": 0.5, "engine": "native", "physics_altitude_m": 18}
    actual = native._account(state, plan)
    assert actual["planned_altitude_m"] == 15
    assert actual["altitude_m"] == 18
    assert actual["height_error_m"] == 3


def test_ground_rotors_idle_then_shutdown_without_faking_telemetry():
    plan = {"legs": [{"end_s": 20}, {"end_s": 30}]}
    states = [{"t": t, "leg": int(t >= 20), "stage": "gate_in" if t < 20 else "charge",
               "heading_deg": 90} for t in (1, 10, 15, 18, 20, 25)]
    native._ground_motor_lifecycle(states, plan, {"t": 0, "heading_deg": 0, "rotor_radps": 190})
    assert states[0]["rotor_visual_radps"] == 190
    assert states[2]["rotor_visual_radps"] > states[3]["rotor_visual_radps"] > 0
    assert states[-1]["rotor_visual_radps"] == 0
    assert all("rotor_radps" not in state for state in states)
    # Taxi geometry now owns heading (ADR 0025 follow-up). The motor lifecycle
    # must not reintroduce the removed post-hoc yaw filter.
    assert states[0]["heading_deg"] == 90
