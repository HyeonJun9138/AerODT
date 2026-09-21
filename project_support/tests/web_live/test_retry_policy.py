"""A failing provider is asked less often, never more.

This machine lost CelesTrak on 2026-09-07: the address was blocked after
repeated requests, and the collector's error path then shortened the wait from
two hours to five minutes, so it kept knocking 288 times a day at a door that
was answering nothing. These tests fix the rule that replaced it.
"""
import pytest

from user_application.apps.web_dashboard.library_settings import retry_delay_seconds

CELESTRAK = 7200
AIRCRAFT = 45


def test_a_failing_source_is_never_asked_sooner_than_a_working_one():
    # The bug in one line: 300 seconds after an error on a source whose own
    # interval is two hours.
    assert retry_delay_seconds(CELESTRAK, 1) >= CELESTRAK
    assert retry_delay_seconds(AIRCRAFT, 1) >= AIRCRAFT


def test_the_wait_doubles_while_the_failures_continue():
    waits = [retry_delay_seconds(CELESTRAK, n) for n in range(1, 6)]
    assert waits[:3] == [7200, 14400, 21600]
    assert waits == sorted(waits), "never comes back down while it keeps failing"


def test_the_wait_stops_growing_so_a_provider_that_returns_is_found_again():
    # Six hours at the most: a blocked address is four requests a day, and a
    # provider that comes back is picked up the same day without a restart.
    assert retry_delay_seconds(CELESTRAK, 50) == 21600
    # A source polled every minute must not disappear for six hours over a blip.
    assert retry_delay_seconds(AIRCRAFT, 50) == 1800
    assert retry_delay_seconds(AIRCRAFT, 3) == 240


def test_a_provider_that_asks_for_a_longer_wait_gets_one():
    assert retry_delay_seconds(AIRCRAFT, 1, 429) == 600
    assert retry_delay_seconds(AIRCRAFT, 1, 503) == 60
    # Never shorter than the backoff already reached.
    assert retry_delay_seconds(CELESTRAK, 3, 429) == 21600


def test_a_missing_or_silly_interval_still_waits_a_sensible_time():
    for interval in (None, 0, -5, 1):
        assert retry_delay_seconds(interval, 1) == 60
    assert retry_delay_seconds(CELESTRAK, 0) == CELESTRAK, "counted from the first failure"


def test_the_collector_uses_it_and_no_longer_shortens_the_wait():
    source = (__import__("pathlib").Path("user_application/apps/web_dashboard/application.py")
              .read_text(encoding="utf-8"))
    assert "retry_delay_seconds(library.interval(source.id) or source.interval_seconds, failures, code)" in source
    assert "min(library.interval(source.id) or source.interval_seconds, 300)" not in source
    # The operator is told how long the wait is and when to suspect the address.
    assert "회 연속" in source and "주소 차단 여부 확인 필요" in source
