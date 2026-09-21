"""One schedule per address, not per process.

CelesTrak blocked this machine because nothing outside a running process
remembered when the provider had last been asked. A restart was a fresh
request, a second dashboard was a second client, and a failure was retried by
each of them on its own. These tests fix the guard that replaced that.
"""
import json

import pytest

from data.ingestion.collection_guard import UNGUARDED, CollectionGuard


class Clock:
    def __init__(self, now=1_000_000.0):
        self.now = now

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds
        return self.now


@pytest.fixture
def guard(tmp_path):
    clock = Clock()
    return CollectionGuard(tmp_path / "collection/guard.json", clock=clock), clock


def test_a_source_nobody_has_asked_may_be_asked_at_once(guard):
    schedule, _ = guard
    assert schedule.seconds_until_allowed("celestrak") == 0
    assert schedule.claim("celestrak", 7200) is True


def test_the_slot_is_taken_before_the_request_not_after(guard):
    # A process that dies mid-request must not free the provider for the next
    # one to hammer: the claim is written first and stands on its own.
    schedule, clock = guard
    assert schedule.claim("celestrak", 7200) is True
    assert schedule.claim("celestrak", 7200) is False
    assert schedule.seconds_until_allowed("celestrak") == pytest.approx(7200)
    clock.advance(7199)
    assert schedule.claim("celestrak", 7200) is False
    clock.advance(2)
    assert schedule.claim("celestrak", 7200) is True


def test_a_second_process_reading_the_same_file_sees_the_claim(tmp_path):
    clock = Clock()
    path = tmp_path / "guard.json"
    first = CollectionGuard(path, clock=clock)
    second = CollectionGuard(path, clock=clock)
    assert first.claim("celestrak", 7200) is True
    assert second.claim("celestrak", 7200) is False, "two dashboards are one client to the provider"


def test_a_restart_does_not_buy_a_new_request(tmp_path):
    # The bug in one line: restarting the server used to ask again immediately.
    clock = Clock()
    path = tmp_path / "guard.json"
    CollectionGuard(path, clock=clock).claim("celestrak", 7200)
    clock.advance(30)
    assert CollectionGuard(path, clock=clock).claim("celestrak", 7200) is False


def test_a_success_puts_the_next_slot_a_full_interval_away(guard):
    schedule, clock = guard
    schedule.claim("celestrak", 7200)
    schedule.record_success("celestrak", 7200)
    assert schedule.state("celestrak")["failures"] == 0
    clock.advance(7000)
    assert schedule.claim("celestrak", 7200) is False
    clock.advance(300)
    assert schedule.claim("celestrak", 7200) is True


def test_a_failure_holds_the_source_for_as_long_as_the_caller_says(guard):
    schedule, clock = guard
    schedule.claim("celestrak", 7200)
    assert schedule.record_failure("celestrak", 21600) is None, "an ordinary failure is not a stop"
    assert schedule.state("celestrak")["failures"] == 1
    clock.advance(21599)
    assert schedule.claim("celestrak", 7200) is False
    clock.advance(2)
    assert schedule.claim("celestrak", 7200) is True
    schedule.record_failure("celestrak", 60)
    assert schedule.state("celestrak")["failures"] == 2
    schedule.record_success("celestrak", 7200)
    assert schedule.state("celestrak")["failures"] == 0, "one good answer clears the count"


@pytest.mark.parametrize("code", [301, 302, 403, 404, 410, 451])
def test_an_answer_that_will_not_change_stops_collection_entirely(guard, code):
    # CelesTrak's usage policy asks a client to stop and let a person look
    # rather than keep knocking. A redirect counts: the address has moved.
    schedule, clock = guard
    assert schedule.record_failure("celestrak", 60, code) == f"HTTP {code}"
    assert schedule.stopped("celestrak") == f"HTTP {code}"
    assert schedule.seconds_until_allowed("celestrak") == float("inf")
    clock.advance(365 * 86400)
    assert schedule.claim("celestrak", 7200) is False, "a year later it is still stopped"


@pytest.mark.parametrize("code", [429, 500, 502, 503, None])
def test_an_answer_that_might_change_is_only_a_wait(guard, code):
    schedule, clock = guard
    assert schedule.record_failure("celestrak", 600, code) is None
    clock.advance(601)
    assert schedule.claim("celestrak", 7200) is True


def test_a_stop_survives_a_restart_and_only_the_operator_clears_it(tmp_path):
    clock = Clock()
    path = tmp_path / "guard.json"
    CollectionGuard(path, clock=clock).record_failure("celestrak", 60, 403)
    restarted = CollectionGuard(path, clock=clock)
    assert restarted.stopped("celestrak") == "HTTP 403"
    restarted.resume("celestrak")
    assert restarted.stopped("celestrak") is None
    assert restarted.claim("celestrak", 7200) is True


def test_the_conditional_request_value_is_kept_for_next_time(guard):
    schedule, _ = guard
    assert schedule.validator("celestrak") == ""
    schedule.record_validator("celestrak", "Mon, 08 Sep 2026 10:00:00 GMT")
    assert schedule.validator("celestrak") == "Mon, 08 Sep 2026 10:00:00 GMT"
    schedule.record_validator("celestrak", "")
    assert schedule.validator("celestrak") == "Mon, 08 Sep 2026 10:00:00 GMT", "an absent header keeps the old one"


def test_the_journal_answers_how_often_we_actually_asked(guard):
    schedule, clock = guard
    for _ in range(3):
        schedule.claim("celestrak", 1)
        schedule.record_success("celestrak", 1)
        clock.advance(2)
    outcomes = [entry["outcome"] for entry in schedule.journal()]
    assert outcomes == ["attempt", "success"] * 3
    assert all(entry["source"] == "celestrak" for entry in schedule.journal())


def test_the_journal_does_not_grow_without_end(tmp_path):
    schedule = CollectionGuard(tmp_path / "guard.json", clock=Clock(), journal_limit=10)
    for _ in range(40):
        schedule.record_failure("celestrak", 0)
    assert len(schedule.journal()) == 10
    assert schedule.state("celestrak")["failures"] == 40, "the count is not lost with the journal"


def test_a_damaged_or_missing_file_does_not_stop_collection(tmp_path):
    path = tmp_path / "guard.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{ this is not json", encoding="utf-8")
    schedule = CollectionGuard(path, clock=Clock())
    assert schedule.state("celestrak") == {} and schedule.stopped("celestrak") is None
    assert schedule.claim("celestrak", 7200) is True
    assert json.loads(path.read_text(encoding="utf-8"))["sources"]["celestrak"]["next_allowed"] > 0


def test_a_silly_source_name_is_refused_before_it_reaches_the_file(guard):
    schedule, _ = guard
    for name in ("../escape", "a/b", ""):
        with pytest.raises(ValueError):
            schedule.claim(name, 60)


def test_a_source_that_never_leaves_the_machine_is_not_scheduled():
    # Fixtures tick every five seconds; writing a schedule for them would churn
    # the file and bury the journal that has to answer for the real requests.
    for _ in range(3):
        assert UNGUARDED.claim("fixture_aircraft", 5) is True
    assert UNGUARDED.stopped("fixture_aircraft") is None
    assert UNGUARDED.record_failure("fixture_aircraft", 60, 403) is None
    assert UNGUARDED.seconds_until_allowed("fixture_aircraft") == 0
