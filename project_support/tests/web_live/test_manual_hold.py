"""고도 유지 · 위치 유지: 조종사가 버튼 하나로 거는 두 가지.

The route autopilot is a different thing and is tested elsewhere. What matters
here is that a hold holds the right thing, lets go when the pilot takes the
aircraft back, and never commands more than it is allowed to -- and above all
that it pushes the right way, because a sign error in the translation loop flies
the aircraft away from the spot it was asked to keep.
"""
import math

import pytest

from user_application.uam_mission.manual_hold import (
    ALTITUDE, AUTHORITY, ENGAGE_SPEED_LIMIT, OFF, POSITION, RELEASE, ManualHold)

NEUTRAL = {"throttle": .5, "roll": 0, "pitch": 0, "yaw": 0, "flight_mode": "multirotor"}


def sample(**over):
    at = {"latitude": 37.5, "longitude": 127.0, "altitude_m": 200.0}
    at.update(over.pop("position", {}))
    base = {"position": at, "airborne": True, "mode": "multirotor", "tilt_deg": 0.0,
            "heading_deg": 0.0, "speed_mps": 0.0, "velocity_ned_mps": [0.0, 0.0, 0.0]}
    base.update(over)
    return base


def metres_north(degrees):
    return degrees * math.pi / 180 * 6371000


def test_altitude_hold_keeps_the_height_it_was_given():
    hold = ManualHold()
    hold.engage(ALTITUDE, sample(), NEUTRAL)
    assert hold.snapshot()["altitude_m"] == 200.0
    # Sagging below the captured height asks for more collective than the pilot
    # handed over; sitting above it asks for less.
    low = hold.update(sample(position={"altitude_m": 190.0}), NEUTRAL, .05)
    high = hold.update(sample(position={"altitude_m": 210.0}), NEUTRAL, .05)
    assert low["throttle"] > NEUTRAL["throttle"] > high["throttle"]
    # And the stick is left entirely alone: height is the collective's business.
    assert (low["roll"], low["pitch"], low["yaw"]) == (0, 0, 0)


def test_a_hold_may_not_be_engaged_with_the_stick_off_centre():
    hold = ManualHold()
    with pytest.raises(ValueError, match="중립"):
        hold.engage(ALTITUDE, sample(), {**NEUTRAL, "pitch": RELEASE + .05})
    assert hold.mode == OFF


def test_a_hold_may_not_be_engaged_on_the_ground_or_while_the_ground_crew_has_it():
    hold = ManualHold()
    with pytest.raises(ValueError, match="비행 중"):
        hold.engage(ALTITUDE, sample(airborne=False), NEUTRAL)
    with pytest.raises(ValueError, match="지상 작업"):
        hold.engage(ALTITUDE, sample(), NEUTRAL, ground_locked=True)


def test_position_hold_is_a_multirotor_thing():
    hold = ManualHold()
    with pytest.raises(ValueError, match="멀티로터"):
        hold.engage(POSITION, sample(mode="fixed_wing", tilt_deg=90), NEUTRAL)
    with pytest.raises(ValueError, match="멀티로터"):
        hold.engage(POSITION, sample(tilt_deg=40), NEUTRAL)
    with pytest.raises(ValueError, match=f"{ENGAGE_SPEED_LIMIT:.0f} m/s"):
        hold.engage(POSITION, sample(speed_mps=ENGAGE_SPEED_LIMIT + 1), NEUTRAL)
    assert hold.engage(POSITION, sample(), NEUTRAL)


def test_position_hold_pushes_towards_the_spot_it_was_given():
    # The one that a sign error ruins: a hold that pushes the wrong way does not
    # drift, it leaves. Forward is a nose-down stick (the keyboard's ArrowUp,
    # which moves the aircraft forward, sends pitch -1) and right is roll +1.
    hold = ManualHold()
    here = sample()
    hold.engage(POSITION, here, NEUTRAL)
    ahead = sample(position={"latitude": 37.5 - .0005})          # target is now north of us
    flown = hold.update(ahead, NEUTRAL, .05)
    assert flown["pitch"] < 0, "목표가 앞이면 앞으로 민다"
    behind = hold.update(sample(position={"latitude": 37.5 + .0005}), NEUTRAL, .05)
    assert behind["pitch"] > 0, "목표가 뒤면 뒤로 민다"
    # Heading north, a target to the east is off the right wing.
    right = hold.update(sample(position={"longitude": 127.0 - .0005}), NEUTRAL, .05)
    assert right["roll"] > 0, "목표가 오른쪽이면 오른쪽으로 민다"
    left = hold.update(sample(position={"longitude": 127.0 + .0005}), NEUTRAL, .05)
    assert left["roll"] < 0


def test_position_hold_pushes_in_the_aircraft_frame_not_the_worlds():
    hold = ManualHold()
    hold.engage(POSITION, sample(), NEUTRAL)
    # Same displacement, aircraft turned to face east: what was ahead is now off
    # the left wing, so the roll carries it and the pitch does not.
    drifted = {"latitude": 37.5 - .0005}
    facing_north = hold.update(sample(position=drifted), NEUTRAL, .05)
    facing_east = hold.update(sample(position=drifted, heading_deg=90), NEUTRAL, .05)
    assert abs(facing_north["pitch"]) > abs(facing_north["roll"])
    assert abs(facing_east["roll"]) > abs(facing_east["pitch"])
    assert facing_east["roll"] < 0, "동쪽을 보고 있으면 북쪽 목표는 왼쪽이다"


def test_a_hold_never_commands_more_than_its_share_of_the_stick():
    hold = ManualHold()
    hold.engage(POSITION, sample(), NEUTRAL)
    # Half a kilometre off, which is far more than any loop here should try to
    # correct in one step.
    flown = hold.update(sample(position={"latitude": 37.5 - .005}), NEUTRAL, .05)
    assert abs(flown["pitch"]) <= AUTHORITY + 1e-9
    assert abs(flown["roll"]) <= AUTHORITY + 1e-9
    assert 0 <= flown["throttle"] <= 1


def test_the_pilot_taking_the_stick_back_ends_the_hold():
    hold = ManualHold()
    hold.engage(POSITION, sample(), NEUTRAL)
    assert hold.update(sample(), {**NEUTRAL, "roll": RELEASE + .05}, .05) is None
    assert hold.mode == OFF
    assert "유지 해제" in hold.reason
    # Under an altitude hold in a multirotor the stick stays the pilot's, and
    # using it must not take the height away from them.
    hold.engage(ALTITUDE, sample(), NEUTRAL)
    assert hold.update(sample(), {**NEUTRAL, "roll": .9}, .05) is not None
    assert hold.mode == ALTITUDE
    # The throttle is what it owns there, so that is what releases it.
    assert hold.update(sample(), {**NEUTRAL, "throttle": .8}, .05) is None
    assert hold.mode == OFF


def test_touching_down_or_changing_mode_ends_the_hold():
    hold = ManualHold()
    hold.engage(POSITION, sample(), NEUTRAL)
    assert hold.update(sample(airborne=False), NEUTRAL, .05) is None
    assert hold.mode == OFF and "착지" in hold.reason
    hold.engage(POSITION, sample(), NEUTRAL)
    assert hold.update(sample(mode="fixed_wing"), NEUTRAL, .05) is None
    assert hold.mode == OFF and "비행 모드" in hold.reason


def test_a_wing_holds_its_height_with_the_elevator_and_keeps_the_pilots_throttle():
    hold = ManualHold()
    wing = {**NEUTRAL, "flight_mode": "fixed_wing"}
    hold.engage(ALTITUDE, sample(mode="fixed_wing", tilt_deg=90, speed_mps=60), wing)
    low = hold.update(sample(mode="fixed_wing", tilt_deg=90, speed_mps=60,
                             position={"altitude_m": 180.0}), wing, .05)
    assert low["pitch"] > 0, "낮으면 기수를 든다"
    assert low["throttle"] == wing["throttle"], "속도는 조종사 것이다"
    assert abs(low["pitch"]) <= AUTHORITY + 1e-9


def test_a_badly_trimmed_hold_walks_its_trim_towards_the_truth():
    # Engaging in a descent hands over a collective that is too low. The
    # proportional term holds the height meanwhile; the trim has to move or the
    # aircraft sits below its target for ever.
    hold = ManualHold()
    hold.engage(ALTITUDE, sample(), {**NEUTRAL, "throttle": .3})
    start = hold.trim
    for _ in range(200):
        hold.update(sample(position={"altitude_m": 190.0}, velocity_ned_mps=[0, 0, 0]),
                    {**NEUTRAL, "throttle": .3}, .05)
    assert hold.trim > start
    assert hold.trim <= .3 + .25 + 1e-9, "그렇다고 무한정 올라가지는 않는다"


# --- against the real native runtime ------------------------------------
# The loops above are checked against a description of the aircraft. These fly
# the actual one, and they are where the gains came from: measured on this
# airframe, hover is about 0.135 of the lever, a tenth of lever is worth some
# thirteen metres a second of climb, and a third of the stick -- all a hold may
# use -- buys 2.6 degrees of pitch and about 1.5 m/s across the ground. A sign
# error or a gain an order of magnitude out survives a model and does not
# survive this: the first version of the climb loop was ten times too hot and
# these are what said so.
from pathlib import Path
from tempfile import TemporaryDirectory

from communication.python.manual_runtime import ManualRuntime
from user_application.uam_mission.manual_flight import ManualFlight

PLAN = {"legs": [{"stage": "cruise", "kind": "air", "speed_mps": 55,
                  "path": [[127, 37, 250], [127, 37.06, 250]]}],
        "vehicle": {"passengers": 4, "capacity": 4}, "totals": {"battery_start_pct": 100}}
HOVER = .14


def stick(**over):
    command = {"throttle": HOVER, "roll": 0, "pitch": 0, "yaw": 0, "flight_mode": "multirotor"}
    command.update(over)
    return command


def hovering(flight):
    """Airborne and settled, which is where a pilot reaches for a hold."""
    for _ in range(40):
        flight.step(stick(throttle=.6), 25)
    for _ in range(150):
        state = flight.step(stick(), 25)
    assert state["airborne"], "시험을 시작하려면 먼저 떠야 한다"
    return state


def test_altitude_hold_keeps_the_height_on_the_real_aircraft():
    with TemporaryDirectory() as directory:
        flight = ManualFlight(PLAN, [127, 37, 80], ManualRuntime(), Path(directory))
        try:
            hovering(flight)
            held = stick()
            state = flight.step(held, 25)
            assert flight.hold_request(ALTITUDE)["accepted"]
            target = state["position"]["altitude_m"]
            worst = 0.0
            for _ in range(600):
                state = flight.step(held, 25)
                worst = max(worst, abs(state["position"]["altitude_m"] - target))
            assert flight.hold.mode == ALTITUDE, flight.hold.reason
            assert worst < 10, f"60초 동안 {worst:.1f} m 벗어났다"
            assert abs(state["position"]["altitude_m"] - target) < 3
        finally:
            flight.close("stopped")


def test_altitude_hold_taken_in_a_climb_finds_the_trim_and_comes_back():
    # The hard case, and the reason the trim is free to travel the whole range:
    # a hold engaged at 0.6 of the lever is holding a climb of nearly twenty
    # metres a second and has to walk all the way down to hover.
    with TemporaryDirectory() as directory:
        flight = ManualFlight(PLAN, [127, 37, 80], ManualRuntime(), Path(directory))
        try:
            for _ in range(190):
                state = flight.step(stick(throttle=.6), 25)
            assert -state["velocity_ned_mps"][2] > 10, "시험 전제: 빠르게 상승 중"
            held = stick(throttle=.6)
            state = flight.step(held, 25)
            assert flight.hold_request(ALTITUDE)["accepted"]
            target = state["position"]["altitude_m"]
            for _ in range(600):
                state = flight.step(held, 25)
            assert flight.hold.mode == ALTITUDE, flight.hold.reason
            assert abs(state["position"]["altitude_m"] - target) < 5, "결국 돌아온다"
            assert abs(flight.hold.trim - .125) < .03, f"호버 트림을 찾았다 ({flight.hold.trim:.3f})"
        finally:
            flight.close("stopped")


def test_position_hold_keeps_the_spot_on_the_real_aircraft():
    with TemporaryDirectory() as directory:
        flight = ManualFlight(PLAN, [127, 37, 80], ManualRuntime(), Path(directory))
        try:
            hovering(flight)
            # Moving when it is handed over, which is the ordinary case: a pilot
            # stops pushing and asks for the spot they have arrived at.
            for _ in range(60):
                flight.step(stick(pitch=-.3), 25)
            held = stick()
            state = flight.step(held, 25)
            assert flight.hold_request(POSITION)["accepted"], flight.hold.reason
            start = state["position"]
            worst = 0.0
            for _ in range(700):
                state = flight.step(held, 25)
                worst = max(worst, metres_north(abs(state["position"]["latitude"] - start["latitude"])))
            assert flight.hold.mode == POSITION, flight.hold.reason
            assert worst < 40, f"{worst:.0f} m 까지 밀려났다"
            assert metres_north(abs(state["position"]["latitude"] - start["latitude"])) < 10
            assert abs(state["position"]["altitude_m"] - start["altitude_m"]) < 10, "높이도 같이 지킨다"
        finally:
            flight.close("stopped")


def test_a_hold_gives_up_when_the_pilot_moves_the_stick_on_the_real_aircraft():
    with TemporaryDirectory() as directory:
        flight = ManualFlight(PLAN, [127, 37, 80], ManualRuntime(), Path(directory))
        try:
            hovering(flight)
            flight.step(stick(), 25)
            assert flight.hold_request(POSITION)["accepted"], flight.hold.reason
            flight.step(stick(pitch=-.9), 25)
            assert flight.hold.mode == OFF
            assert "유지 해제" in flight.hold.reason
        finally:
            flight.close("stopped")


def test_a_hold_and_the_route_autopilot_do_not_both_have_the_stick():
    with TemporaryDirectory() as directory:
        flight = ManualFlight(PLAN, [127, 37, 80], ManualRuntime(), Path(directory))
        try:
            hovering(flight)
            flight.step(stick(), 25)
            assert flight.hold_request(ALTITUDE)["accepted"]
            # The autopilot cannot be engaged here anyway (it wants fixed-wing
            # cruise), so the exclusion is checked from the side that can be:
            # asking for a hold while the autopilot is on takes the autopilot off.
            flight.autopilot.enabled = True
            flight.autopilot.reason = "NAV / ALT / SPEED"
            assert flight.hold_request(POSITION)["accepted"], flight.hold.reason
            assert flight.autopilot.enabled is False
            assert "유지 사용" in flight.autopilot.reason
        finally:
            flight.close("stopped")
