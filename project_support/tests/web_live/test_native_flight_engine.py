"""The native engine: the C++ tiltrotor flying a plan the dashboard made.

Two kinds of test live here. The conversions -- a plan into waypoints, the
runner's lines back into states, a plan re-timed to the flight -- are pure and
always run. The flight itself needs the runner to have been built, so those
tests skip where it has not, and say so rather than passing quietly.
"""
import pytest
import subprocess

from digital_twin.model_library import flight_plan as fp
from digital_twin.simulation import flight_simulation, native_flight_engine as native
from project_support.tests.web_live.test_flight_plan import NETWORK, VERTIPORTS

ROOT = "."


def plan():
    asked = fp.validate_request({"from_vertiport": "VP1", "to_vertiport": "VP2", "passengers": 3},
                                fp.plan_options(VERTIPORTS, NETWORK))
    return fp.build_plan(asked, VERTIPORTS, NETWORK)


def built():
    return native.runner_path(ROOT) is not None


needs_runner = pytest.mark.skipif(not built(), reason="the native flight runner has not been built")


@needs_runner
@pytest.mark.parametrize('approach_m', [100.0, 2000.0])
def test_short_and_long_arrivals_complete_reverse_transition_before_descent(approach_m):
    points = [
        dict(north_m=0, east_m=0, down_m=-30, speed_mps=2, fixed_wing=False, capture_m=1),
        dict(north_m=1000, east_m=0, down_m=-150, speed_mps=30, fixed_wing=True, capture_m=60),
        dict(north_m=2000, east_m=0, down_m=-150, speed_mps=30, fixed_wing=True, capture_m=60),
        dict(north_m=2000+approach_m, east_m=0, down_m=-30, speed_mps=28, fixed_wing=False, capture_m=60),
        dict(north_m=2000+approach_m, east_m=0, down_m=0, speed_mps=2, fixed_wing=False, capture_m=8),
    ]
    process = subprocess.run([str(native.runner_path(ROOT))],
        input=native.render_input(points, timeout_s=2000, emit_s=.2),
        text=True, capture_output=True, timeout=120, check=True)
    states, end, problem = native.parse_output(process.stdout)
    assert problem is None and end['reached'] == len(points)
    assert states[-1]['grounded']
    descending = [s for s in states if s['waypoint'] == 3]
    assert any(s['down_m'] > -140 for s in descending)
    assert all(s['tilt_deg'] <= 14.2 and s['blend'] == 0
               for s in descending if s['down_m'] > -147)
    down_rates = [(b['down_m']-a['down_m'])/(b['t']-a['t'])
                  for a,b in zip(descending, descending[1:]) if b['t'] > a['t']]
    assert max(down_rates) < 2.8  # 2.54 m/s intent plus measured controller tracking tolerance.


# ---------------------------------------------------------------- the plan, as waypoints

def test_only_the_airborne_legs_are_flown_by_the_physics():
    made = plan()
    first, last = native.air_block(made)
    assert made["legs"][first]["stage"] == "takeoff"
    assert made["legs"][last]["stage"] == "landing"
    assert all(made["legs"][index]["kind"] == "ground"
               for index in range(len(made["legs"])) if not first <= index <= last)


def test_a_plan_with_no_airborne_leg_is_refused_rather_than_flown_empty():
    assert native.air_block({"legs": [{"kind": "ground", "stage": "charge"}]}) is None
    with pytest.raises(ValueError, match="plan"):
        native.run({"legs": [{"kind": "ground", "stage": "charge"}]})


def test_waypoints_are_metres_from_the_departure_fato():
    points, origin = native.waypoints_of(plan())
    assert points, "an airborne plan has waypoints"
    assert origin["latitude"] == plan()["legs"][1]["path"][0][1]
    # The first waypoint is the hover above the departure deck: straight up.
    first = points[0]
    assert abs(first["north_m"]) < 1 and abs(first["east_m"]) < 1
    assert first["down_m"] < -5, "down is negative going up"
    # Every waypoint sits on a leg, in order, and covers that leg end to end.
    assert [point["leg"] for point in points] == sorted(point["leg"] for point in points)
    for point in points:
        assert 0.0 <= point["from_f"] < point["f"] <= 1.0


def test_the_last_waypoint_of_every_leg_is_the_end_of_it():
    points, _ = native.waypoints_of(plan())
    ends = {}
    for point in points:
        ends[point["leg"]] = point["f"]
    assert set(ends.values()) == {1.0}, "a leg is flown to its end, not part way"


def test_the_cruise_asks_for_fixed_wing_and_the_hover_does_not():
    points, _ = native.waypoints_of(plan())
    by_stage = {}
    for point in points:
        by_stage.setdefault(point["stage"], []).append(point["fixed_wing"])
    assert all(by_stage["cruise"]), "the cruise is flown as a fixed wing"
    assert not any(by_stage["takeoff"]) and not any(by_stage["landing"])


def test_the_descent_requests_multirotor_early_and_never_returns_to_fixed_wing():
    points, _ = native.waypoints_of(plan())
    descent = [point for point in points if point["stage"] == "descent"]
    assert descent[-1]["fixed_wing"] is False
    winged = [p for p in descent if p['fixed_wing']]
    assert not winged, 'reverse transition must precede descent at every path length'
    flags = [p['fixed_wing'] for p in descent]
    assert flags == sorted(flags, reverse=True)


def test_segmented_descent_has_one_early_reverse_transition():
    made = plan()
    leg = next(l for l in made['legs'] if l['stage'] == 'descent')
    start, end = leg['path'][0], leg['path'][-1]
    leg['path'] = [[start[j] + (end[j] - start[j]) * t if j < 3 else start[j]
                    for j in range(len(start))] for t in (0, .1, .2, .5, .8, 1)]
    points, _ = native.waypoints_of(made)
    flags = [p['fixed_wing'] for p in points if p['stage'] == 'descent']
    assert flags == sorted(flags, reverse=True), 'no repeated forward tilt on later descent segments'
    assert flags[-1] is False


def test_short_approach_starts_reverse_transition_immediately():
    made = plan()
    leg = next(l for l in made['legs'] if l['stage'] == 'descent')
    start = leg['path'][0]
    leg['path'] = [start, [start[0] + .0001, start[1], start[2] - 10, *start[3:]]]
    points, _ = native.waypoints_of(made)
    assert all(not p['fixed_wing'] for p in points if p['stage'] == 'descent')


def test_a_vertical_hop_is_captured_closely_and_a_route_waypoint_loosely():
    points, _ = native.waypoints_of(plan())
    hover = [point["capture_m"] for point in points if point["leg_kind"] == "vertical"]
    route = [point["capture_m"] for point in points if point["leg_kind"] == "air"]
    assert max(hover) <= native.HOVER_CAPTURE_M < min(route)


# ---------------------------------------------------------------- the protocol

def test_the_input_is_the_settings_then_the_waypoints_then_run():
    points, _ = native.waypoints_of(plan())
    lines = native.render_input(points, step_s=0.004, emit_s=0.2, timeout_s=90).splitlines()
    assert lines[0] == "step 0.004" and lines[1] == "emit 0.2"
    assert lines[3] == "timeout 90" and lines[-1] == "run"
    assert sum(1 for line in lines if line.startswith("waypoint ")) == len(points)
    assert all(len(line.split()) == 7 for line in lines if line.startswith("waypoint "))


def test_output_lines_become_states_and_an_ending():
    text = ("state 0.0000 1.0 2.0 -3.0 0.1 0.2 -0.3 45.0 -2.0 1.0 90.0 1.0 12.5 0 2\n"
            "done 3 3 61.5000 0.0040\n")
    flown, ending, problem = native.parse_output(text)
    assert problem is None and ending == {"reached": 3, "total": 3, "elapsed_s": 61.5}
    assert flown[0]["north_m"] == 1.0 and flown[0]["down_m"] == -3.0
    assert flown[0]["tilt_deg"] == 90.0 and flown[0]["waypoint"] == 2
    assert flown[0]["grounded"] is False


def test_a_reported_failure_is_read_as_one_and_stops_the_run():
    flown, ending, problem = native.parse_output("error no waypoints given\n")
    assert flown == [] and ending is None and problem == "no waypoints given"


def test_a_flight_that_stopped_short_is_read_as_stopping_short():
    _, ending, _ = native.parse_output("state 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\ndone 2 5 30.0 0.004\n")
    assert ending["reached"] < ending["total"], "the run refuses this rather than trimming the flight"


def test_a_plan_cannot_be_flown_where_nothing_has_been_built(tmp_path):
    with pytest.raises(ValueError, match="not built"):
        native.run(plan(), root=tmp_path, runner=str(tmp_path / "missing.exe"))


def test_the_runner_is_looked_for_where_a_build_leaves_it(tmp_path):
    made = tmp_path / native.RUNNER_PATHS[0]
    made.mkdir(parents=True)
    (made / f"{native.RUNNER_NAME}.exe").write_text("")
    assert native.runner_path(tmp_path).name.startswith(native.RUNNER_NAME)
    assert native.available(tmp_path)


# ---------------------------------------------------------------- re-timing

def test_the_plan_is_re_timed_to_the_flight_and_the_battery_follows_it():
    made = plan()
    first, last = native.air_block(made)
    # The flight took twice as long in the air as the plan expected.
    stretched = {index: made["legs"][index]["duration_s"] * 2 for index in range(first, last + 1)}
    retimed = native.retime(made, stretched)
    assert retimed["legs"][first]["duration_s"] == pytest.approx(made["legs"][first]["duration_s"] * 2)
    assert retimed["legs"][0]["duration_s"] == made["legs"][0]["duration_s"], "the taxi is untouched"
    # Time runs through without a gap, and the battery with it.
    assert retimed["legs"][0]["start_s"] == 0.0
    for before, after in zip(retimed["legs"], retimed["legs"][1:]):
        assert after["start_s"] == pytest.approx(before["end_s"], abs=0.05)
        assert after["battery_start_pct"] == pytest.approx(before["battery_end_pct"], abs=0.01)
    # Twice as long in the air costs more, so the charge that follows is longer.
    assert retimed["totals"]["battery_landing_pct"] < made["totals"]["battery_landing_pct"]
    assert retimed["legs"][-1]["duration_s"] > made["legs"][-1]["duration_s"]
    assert retimed["legs"][-1]["battery_end_pct"] == pytest.approx(
        made["legs"][-1]["battery_end_pct"], abs=0.01), "it still charges to the same target"
    assert retimed["totals"]["duration_s"] == pytest.approx(retimed["legs"][-1]["end_s"], abs=0.05)


def test_a_state_is_placed_on_the_stretch_it_has_passed_not_the_one_it_aims_at():
    points, _ = native.waypoints_of(plan())
    # Sitting at the first waypoint while already aiming at the second: the
    # capture radius is wide, so this is where a real flight spends time.
    at_first = {**points[0], "waypoint": 1}
    target, along = native._segment(points, 1, at_first)
    assert target is points[0] and along == pytest.approx(1.0, abs=0.02), (
        "it is at the end of the first stretch, not the start of the second")


# ---------------------------------------------------------------- the flight itself

@needs_runner
def test_the_native_engine_flies_the_plan_and_answers_what_every_other_engine_does():
    made = plan()
    flown = native.run(made, rate_hz=5, root=ROOT)
    states, summary = flown["states"], flown["summary"]
    assert summary["engine"] == native.ENGINE
    assert summary["ground_engine"] == flight_simulation.ENGINE
    assert flown["schema_version"] == flight_simulation.SCHEMA_VERSION
    assert summary["states"] == len(states) > 100
    # A state has everything a kinematic one has, so nothing downstream changes.
    kinematic = flight_simulation.run(made, rate_hz=5)["states"][10]
    assert set(kinematic) <= set(states[10])
    assert states[0]["t"] == 0.0
    assert states[-1]["t"] == pytest.approx(flown["plan"]["totals"]["duration_s"], abs=0.2)


@needs_runner
def test_the_flight_runs_forwards_through_the_plan_from_the_stand_to_the_charger():
    flown = native.run(plan(), rate_hz=5, root=ROOT)
    states = flown["states"]
    assert [state["t"] for state in states] == sorted(state["t"] for state in states)
    # Never back to an earlier leg. Within one, a flown aircraft can drift a
    # little against its own track while it turns or slows -- that is the
    # physics, not a fault -- but it never gives back a real part of the leg.
    for before, after in zip(states, states[1:]):
        assert after["leg"] >= before["leg"]
        if after["leg"] == before["leg"]:
            assert after["f"] >= before["f"] - 0.01
    assert states[0]["stage"] == "gate_out" and states[-1]["stage"] == "charge"
    assert {state["leg"] for state in states} == set(range(len(flown["plan"]["legs"])))


@needs_runner
def test_the_rotors_really_tilt_through_the_transition_and_come_back():
    states = native.run(plan(), rate_hz=5, root=ROOT)["states"]
    tilts = [state["tilt_deg"] for state in states]
    assert max(tilts) > 85, "the climb tilts the rotors forward"
    assert states[0]["tilt_deg"] == pytest.approx(0.0, abs=0.5)
    assert states[-1]["tilt_deg"] == pytest.approx(0.0, abs=0.5)
    assert {state["mode"] for state in states} == {"multirotor", "transition", "fixed_wing"}
    # A tilt that only the plan asserted would step between stages; a flown one
    # passes through every angle on the way.
    turning = sorted({round(tilt / 10) for tilt in tilts})
    assert len(turning) >= 8, "the transition is flown, not switched"


@needs_runner
def test_the_flight_is_flown_and_the_ground_is_not_pretended_to_be():
    states = native.run(plan(), rate_hz=5, root=ROOT)["states"]
    engines = {state["stage"]: state["engine"] for state in states}
    assert engines["cruise"] == "native" and engines["climb"] == "native"
    assert engines["gate_out"] == "kinematic" and engines["charge"] == "kinematic"


@needs_runner
def test_what_the_physics_reached_is_recorded_beside_the_designed_height():
    states = native.run(plan(), rate_hz=5, root=ROOT)["states"]
    airborne = [state for state in states if state["engine"] == "native"]
    assert all("physics_altitude_m" in state for state in airborne)
    assert max(state["physics_altitude_m"] for state in airborne) > 100
    # The height a display draws is the designed one, resolved against terrain
    # by the datum it carries.
    assert {state["datum"] for state in states} >= {"agl"}


@needs_runner
def test_the_run_says_which_engine_it_was_and_how_far_it_differed_from_the_plan():
    made = plan()
    summary = native.run(made, rate_hz=5, root=ROOT)["summary"]
    assert summary["planned_flight_duration_s"] > 0
    assert summary["flight_duration_s"] > 0
    assert summary["native_states"] > summary["kinematic_states"] / 10
    assert summary["waypoints"] == len(native.waypoints_of(made)[0])
    assert summary["max_speed_mps"] > 10 and summary["max_tilt_deg"] > 85
