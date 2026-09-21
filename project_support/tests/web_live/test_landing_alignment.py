"""Arrival taxi heading is a pilot goal, never a post-hoc airborne pose edit."""
import copy
import math
import subprocess

import pytest

from digital_twin.simulation import native_flight_engine as native


def delta(a, b):
    return (b - a + 180) % 360 - 180


def test_arrival_heading_uses_first_taxi_tangent_not_gate_bearing():
    plan = {'legs': [
        {'kind': 'vertical', 'stage': 'landing'},
        {'kind': 'ground', 'stage': 'gate_in', 'ground_motion': {'headings_deg': [275, 180]},
         'path': [[127, 37, 0], [127, 37.001, 0], [127.001, 37.001, 0]]}]}
    before = copy.deepcopy(plan)
    assert native.arrival_heading_of(plan) == 275
    assert plan == before


def test_arrival_heading_falls_back_to_first_nonzero_taxi_segment_and_is_optional():
    assert native.arrival_heading_of({'legs': []}) is None
    plan = {'legs': [{'kind': 'vertical', 'stage': 'landing'},
                     {'stage': 'gate_in', 'path': [[127, 37, 0], [127, 37, 0], [127, 37.001, 0]]}]}
    assert native.arrival_heading_of(plan) == pytest.approx(0)
    plan['legs'][1]['path'] = [[127, 37, 0], [127, 37, 0]]
    assert native.arrival_heading_of(plan) is None


def test_optional_landing_yaw_pipe_input_is_finite_and_backward_compatible():
    assert 'landing_yaw' not in native.render_input([])
    assert 'landing_yaw 275\n' in native.render_input([], landing_yaw_deg=275)
    for value in (float('nan'), float('inf')):
        with pytest.raises(ValueError, match='landing_yaw'):
            native.render_input([], landing_yaw_deg=value)


@pytest.mark.parametrize('heading', [90, -90, 180, 350])
@pytest.mark.skipif(native.runner_path('.') is None, reason='native runner not built')
def test_real_pilot_turns_in_hover_before_descending(heading):
    points = [dict(north_m=0, east_m=0, down_m=z, speed_mps=3, fixed_wing=False, capture_m=1.5)
              for z in (-30, 0)]
    command = native.render_input(points, emit_s=.1, timeout_s=240, landing_yaw_deg=heading)
    result = subprocess.run([str(native.runner_path('.'))], input=command, text=True,
                            capture_output=True, timeout=60)
    states, end, error = native.parse_output(result.stdout)
    assert result.returncode == 0 and not error and end['reached'] == 2
    landing = [s for s in states if s['waypoint'] == 1 and not s['grounded']]
    turning = [s for s in landing if abs(delta(s['yaw_deg'], heading)) > 2]
    assert turning, 'the heading change must happen before touchdown'
    assert all(abs(s['down_m'] + 30) < .65 for s in turning)
    assert all(math.hypot(s['north_m'], s['east_m']) < .6 for s in landing)
    descending = [s for s in landing if s['down_m'] > -28]
    assert descending and all(abs(delta(s['yaw_deg'], heading)) < 1.5 for s in descending)
    increments = [delta(a['yaw_deg'], b['yaw_deg']) for a, b in zip(landing, landing[1:])]
    assert sum(abs(d) for d in increments) < abs(delta(0, heading)) + 2, 'take the short turn, not a full loop'
    assert max(abs(d)/(b['t']-a['t']) for d,a,b in zip(increments,landing,landing[1:])) < 13
    assert states[-1]['grounded'] and abs(delta(states[-1]['yaw_deg'], heading)) < .2


@pytest.mark.skipif(native.runner_path('.') is None, reason='native runner not built')
def test_native_plan_lands_already_facing_the_arrival_taxi():
    from project_support.tests.web_live.test_native_flight_engine import plan
    original = plan()
    before = copy.deepcopy(original)
    flown = native.run(original, root='.')
    assert original == before, 'execution re-timing must not mutate prepared intent'
    goal = native.arrival_heading_of(original)
    landing = [s for s in flown['states'] if s['stage'] == 'landing']
    assert all(abs(delta(s['heading_deg'], goal)) < 1.5 for s in landing if s['physics_altitude_m'] < 28)
    assert landing[-1]['grounded'] and abs(delta(landing[-1]['heading_deg'], goal)) < .2
    taxi = [s for s in flown['states'] if s['stage'] == 'gate_in']
    waiting = [s for s in taxi if s['f'] == 0]
    assert waiting and max(abs(delta(landing[-1]['heading_deg'], s['heading_deg'])) for s in waiting) < .2
    assert all(b['t'] > a['t'] for a,b in zip(flown['states'], flown['states'][1:]))
