"""The pilot's clock against the rate their browser can send at.

The browser sends control messages from the main thread: the send timer and the
reply handler both queue behind the frame, so messages per second follows the
page's frame rate. The server advances the flown aircraft by at most
`STEPS_PER_MESSAGE * STEP_SECONDS` per message, so that ceiling is what decides
whether a page drawing slowly can still fly in real time. Reported as "one
second of flight takes three real seconds", which is this arithmetic at about
five and a half frames a second.
"""
import pytest

from communication.web.manual_routes import CARRY_SECONDS, STEPS_PER_MESSAGE, STEP_SECONDS


def clock_rate(messages_per_second, seconds=20.0):
    """What the loop in `manual_routes` advances per real second at that cadence."""
    interval = 1.0 / messages_per_second
    remainder = advanced = 0.0
    for _ in range(int(seconds * messages_per_second)):
        remainder += min(CARRY_SECONDS, interval)
        steps = min(STEPS_PER_MESSAGE, max(0, int(remainder / STEP_SECONDS)))
        remainder -= steps * STEP_SECONDS
        advanced += steps * STEP_SECONDS
    return advanced / seconds


def test_one_message_carries_enough_flight_time_for_a_slow_page():
    # 60 ms held real time only above about 17 messages a second. A page drawing
    # 12 frames a second flew at 0.72x and the shortfall accumulated in
    # `remainder` rather than being caught up.
    assert STEPS_PER_MESSAGE * STEP_SECONDS >= .1, "a ten-frame-a-second page must still fly in real time"


@pytest.mark.parametrize("fps", [20, 17, 15, 12, 10])
def test_a_page_down_to_ten_frames_a_second_still_flies_in_real_time(fps):
    assert clock_rate(fps) == pytest.approx(1.0, abs=.02), f"{fps} messages a second must keep the clock"


def test_the_ceiling_never_binds_on_a_page_that_is_keeping_up():
    # It is a ceiling, not a step size: at 20 Hz a message carries 50 ms and
    # always did, so raising it changed nothing for a page that was already fine.
    interval = 1 / 20
    assert int(interval / STEP_SECONDS) < STEPS_PER_MESSAGE


def test_the_clock_never_runs_ahead_of_real_time():
    for fps in (60, 30, 20, 12, 8):
        assert clock_rate(fps) <= 1.0 + 1e-9, f"{fps} messages a second outran the wall clock"


def test_a_slower_page_is_never_given_a_faster_clock():
    # Whole steps of 4 ms leave a sub-tenth-of-a-percent wobble between cadences
    # that all hold real time; what must never happen is the clock materially
    # improving as the page slows, which is the shape a mis-set ceiling makes.
    rates = [clock_rate(fps) for fps in (30, 20, 17, 15, 12, 10, 8, 6)]
    for faster, slower in zip(rates, rates[1:]):
        assert slower <= faster + .01, f"the clock rose from {faster:.3f} to {slower:.3f} as the page slowed"
