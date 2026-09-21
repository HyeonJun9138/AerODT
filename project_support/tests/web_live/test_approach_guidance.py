"""Actual native approach motion, independent of the rendered path."""
import math
import statistics

import pytest

from communication.python.native_pilot import NativePilot, NativePilotLibrary, tuning_array
from digital_twin.simulation import decision_policy


def fly_approach(length=2000, tuning=None):
    library = NativePilotLibrary()
    points = [(0, 0, -30, 2, 0, 8), (1000, 0, -150, 30, 1, 60),
              (3000, 0, -150, 30, 1, 150),
              (3000 + length, 0, -30, 28, 0, 150),
              (3000 + length, 0, 0, 2, 0, 8)]
    pilot = library.create(points, 0, 0, tuning)
    rows = []
    try:
        for _ in range(2000):
            row = pilot.advance(1)
            rows.append(row)
            if row[16]:
                return rows
        pytest.fail(f'approach not complete: {rows[-1]}')
    finally:
        pilot.close()


def steady(rows):
    return [r for r in rows if r[14] == 3 and -125 < r[3] < -50]


def test_long_approach_flows_at_ten_metres_per_second_without_entry_return():
    rows = fly_approach()
    descent = steady(rows)
    assert len(descent) > 30
    assert 9.5 < statistics.median(math.hypot(r[4], r[5]) for r in descent) < 10.5
    assert max(r[6] for r in descent) < 2.8
    assert all(r[10] <= 14.2 and r[11] == 0 for r in descent)
    assert statistics.median(r[10] for r in descent) > 10
    entry = [r for r in rows if r[14] == 3 and r[1] < 3200]
    assert min(r[4] for r in entry) > 0.5, 'no stop and fly-back to the approach entry'
    assert rows[-1][13] and math.dist(rows[-1][1:4], (5000, 0, 0)) < 0.3


def test_saved_horizontal_setting_changes_motion_without_changing_vertical_limit():
    policy = decision_policy.validate({'pilot': {'approach_horizontal_speed_mps': 4.0}})['pilot']
    rows = fly_approach(tuning=tuning_array(policy))
    assert 3.5 < statistics.median(math.hypot(r[4], r[5]) for r in steady(rows)) < 4.5
    assert max(r[6] for r in steady(rows)) < 2.8


def test_short_approach_respects_descent_limit_and_still_aligns_over_fato():
    rows = fly_approach(length=100)
    descent = [r for r in rows if r[14] == 3 and r[3] > -140]
    assert descent and max(r[6] for r in descent) < 2.8
    assert all(r[10] <= 14.2 and r[11] == 0 for r in descent)
    landing = [r for r in rows if r[14] == 4 and r[3] > -25]
    assert landing and max(math.hypot(r[1] - 3100, r[2]) for r in landing) < 1
    assert all(r[10] < 1 for r in landing), 'actual rotors vertical before touchdown descent'
    assert rows[-1][13]


def test_moving_approach_keeps_rotor_mode_through_an_intermediate_corner():
    points = [(0, 0, -30, 2, 0, 8), (1000, 0, -150, 30, 1, 60),
              (3000, 0, -150, 30, 1, 150), (3400, 0, -90, 20, 0, 60),
              (3400, 400, -30, 20, 0, 60), (3400, 400, 0, 2, 0, 8)]
    pilot = NativePilotLibrary().create(points, 0, 90)
    rows = []
    try:
        for _ in range(1500):
            rows.append(pilot.advance(1))
            if rows[-1][16]:
                break
    finally:
        pilot.close()
    assert rows[-1][16] and rows[-1][13]
    approach = [r for r in rows if r[14] in (3, 4) and r[3] > -130]
    assert {r[14] for r in approach} == {3, 4}
    assert all(r[11] == 0 and abs(r[10]) < 14.2 for r in approach)
    assert max(r[6] for r in approach) < 2.8
    assert math.hypot(rows[-1][1]-3400, rows[-1][2]-400) < .3


@pytest.mark.parametrize('abi', [1, 2])
def test_explicit_approach_setting_is_not_silently_ignored_by_old_abi(abi):
    from types import SimpleNamespace
    old = SimpleNamespace(abi=abi, tunable=abi >= 2,
        lib=SimpleNamespace(aerodt_pilot_create=lambda *a: None),
        error=lambda: RuntimeError('legacy creation was called'))
    numbers = tuning_array(decision_policy.validate({})['pilot'])
    with pytest.raises(RuntimeError, match='재빌드'):
        NativePilot(old, [(0, 0, -10, 2, 0, 8)], 0, 0, numbers)


@pytest.mark.parametrize('direction', ['right', 'left'])
def test_winged_turn_recovers_trim_without_a_half_metre_height_sag(direction):
    from project_support.tools.web_visualization.right_lane_tracking_check import cases, targets_of, fly
    points = targets_of(cases()[direction])
    rows = fly(NativePilotLibrary(), points)
    cruise = [r for r in rows if r[10] > 89 and 2 <= r[14] < len(points)-3 and r[0] > 130]
    assert cruise
    assert max(r[3] + 300 for r in cruise) < .4
    assert max(-r[3] - 300 for r in cruise) < .6
