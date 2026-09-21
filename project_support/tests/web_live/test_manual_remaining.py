"""How long a hand-flown flight has left, and why it used to grow as it arrived.

The landing slot is booked at `eta_s = now + remaining`, and `remaining` is
walked from the aircraft's route index. A hand-flown aircraft is handed over
with that index at zero and it never advances -- its phase follows the wheels,
not the plan -- so the walk began at the departure gate however far the
aircraft had actually flown, and measured the taxi back to the origin, at taxi
speed, as time still to come.

The answer therefore grew the closer the aircraft got, which is exactly when a
pilot reads it: one arriving over the deck was told 74 minutes, and the slot was
booked that far out. A pilot is not flying the plan, so the plan cannot say what
is left; the distance to the touchdown point can.
"""
import pytest

from digital_twin.simulation import manual_takeover
from project_support.tests.web_live.test_scenario_engine import engine_of, row


def handed_over():
    engine = engine_of(row('F1', 'A1', 'VP1', 'VP2', '06:30:00'))
    manual_takeover.hand_over(engine, 'A1')
    manual_takeover.request(engine, 'A1', 'departure')
    return engine, engine.aircraft['A1']


def along(engine, aircraft, fraction, altitude=300.0):
    """Put the aircraft `fraction` of the way back from its destination."""
    route = aircraft.route
    origin = route.phases[0].points[0]
    touchdown = route.phases[route.landing_index].points[-1]
    manual_takeover.place(engine, 'A1', altitude=altitude, heading=0.0, step=1.0,
                          airborne=True, speed_mps=40.0,
                          latitude=touchdown[0] + (origin[0] - touchdown[0]) * fraction,
                          longitude=touchdown[1] + (origin[1] - touchdown[1]) * fraction)
    return engine._remaining_native(aircraft)


def test_what_is_left_falls_as_the_aircraft_nears_its_destination():
    engine, aircraft = handed_over()
    seen = [along(engine, aircraft, fraction) for fraction in (1.0, .8, .6, .4, .2, .05)]
    assert seen == sorted(seen, reverse=True), seen
    # And it is a real decrease, not a rounding wobble: arriving is worth
    # something against setting off.
    assert seen[-1] < seen[0] * .75, seen


def test_arriving_over_the_deck_is_not_an_hour_of_flying_away():
    engine, aircraft = handed_over()
    overhead = along(engine, aircraft, 0.0, altitude=120.0)
    # It used to answer 4422 s here, which is what put the landing slot 74
    # minutes out. Whatever the profile, being there is minutes, not an hour.
    assert overhead < 300, overhead


def test_the_plan_is_still_walked_for_an_aircraft_nobody_is_flying():
    engine, aircraft = handed_over()
    flown = along(engine, aircraft, .5)
    # The same aircraft, no longer hand-flown, is back on the plan-walking path.
    aircraft.external = None
    assert engine._remaining_native(aircraft) != pytest.approx(flown)


def test_an_aircraft_on_the_ground_is_not_measured_as_if_it_were_flying():
    engine, aircraft = handed_over()
    route = aircraft.route
    gate = route.phases[0].points[0]
    manual_takeover.place(engine, 'A1', latitude=gate[0], longitude=gate[1], altitude=gate[2],
                          heading=0.0, step=1.0, airborne=False, speed_mps=0.0)
    assert aircraft.airborne is False
    # Still at the gate with the whole flight ahead: the plan is the best
    # answer there is, and it is the one used.
    assert engine._remaining_native(aircraft) > 0


def test_a_reserved_holding_bay_still_decides_the_way_home():
    engine, aircraft = handed_over()
    along(engine, aircraft, .3)
    direct = engine._remaining_native(aircraft)
    bay = engine.reserve_manual_bay(aircraft, engine.time_s)
    assert bay is not None
    # Having been sent somewhere to wait, what is left is the way back to the
    # approach and in -- not the straight line it would have flown.
    engine._remaining_step_cache = None
    assert engine._remaining_native(aircraft) != pytest.approx(direct)
