"""Keeping the pilot off the day's lock.

One `RLock` guards the whole session, and `advance_view` holds it for about a
tenth of a second per tick while it walks the fleet. The cockpit socket sends a
pose roughly twenty times a second and reads its clearance once a second; every
one of those used to take the same lock, so the pilot spent most of a second
waiting per second flown and one simulated second took three real ones.

So the two calls on the per-message path take no lock at all. A pose is left in
a mailbox and a clearance is read out of a cache; the tick -- which already owns
the fleet -- drains the one and refills the other. These tests hold that line:
that the hot calls do not block, that nothing posted is lost, and that the day
being paused does not stop the person still holding the stick.
"""
import threading
import time

import pytest

from user_application.uam_mission import scenario_session as session_module
from user_application.uam_mission.scenario_session import MANUAL_ADVICE_INTERVAL_S
from project_support.tests.web_live.test_scenario_session import CSV, make

POSE = {"latitude": 37.53, "longitude": 126.93, "altitude": 240.0,
        "heading": 180.0, "step": 1.0, "airborne": True, "speed_mps": 42.0}


def flying(clock=None):
    """A running day with one airframe handed to a person."""
    session, clock = make(clock=clock)
    session.load(CSV, name="하루")
    session.open_control()
    session.play()
    aircraft_id = session.assign_manual(vertiport="VP1")["aircraft_id"]
    return session, clock, aircraft_id


def held_lock(session):
    """Hold the session lock on another thread until the caller lets go."""
    taken, release = threading.Event(), threading.Event()

    def hold():
        with session._lock:
            taken.set()
            release.wait(10)

    thread = threading.Thread(target=hold, daemon=True)
    thread.start()
    assert taken.wait(5), "잠금을 잡는 스레드가 시작되지 않았습니다"
    return thread, release


def test_the_two_calls_on_the_pilot_s_path_never_wait_for_the_lock():
    # This is the fix, stated as a test: with the day's lock held by somebody
    # else for half a second, posting a pose and reading a clearance still
    # return at once. Everything the cockpit does per message is on this path.
    session, _, aircraft_id = flying()
    session.manual_watch(aircraft_id)
    thread, release = held_lock(session)
    blocked = threading.Event()

    def serialized():
        session.manual_advisory(aircraft_id)   # the endpoint's path, still serialized
        blocked.set()

    waiter = threading.Thread(target=serialized, daemon=True)
    waiter.start()
    try:
        started = time.perf_counter()
        for _ in range(20):                    # one second of cockpit messages
            assert session.place_manual(aircraft_id, **POSE) is True
        advice = session.manual_advice(aircraft_id)
        elapsed = time.perf_counter() - started
        # The control: a method that does take the lock is still sitting there.
        still_waiting = not blocked.is_set()
    finally:
        release.set()
    thread.join(5)
    waiter.join(5)

    assert elapsed < .25, f"수동 경로가 잠금을 기다렸습니다: {elapsed:.3f}s"
    assert advice is not None, "조종석은 캐시에서 읽는다"
    assert still_waiting, "잠금이 실제로 잡혀 있지 않았다면 이 시험은 아무것도 증명하지 않는다"


def test_a_posted_pose_reaches_the_fleet_on_the_next_tick():
    session, clock, aircraft_id = flying()
    aircraft = session.engine.aircraft[aircraft_id]
    before = (aircraft.latitude, aircraft.longitude, aircraft.airborne)

    assert session.place_manual(aircraft_id, **POSE) is True
    # The mailbox is not the fleet, and nobody could see it either way: the wire
    # samples `entities()` once per tick, inside the same lock as the tick.
    assert (aircraft.latitude, aircraft.longitude, aircraft.airborne) == before

    clock.tick(.5)
    session.tick()
    assert aircraft.latitude == pytest.approx(POSE["latitude"])
    assert aircraft.longitude == pytest.approx(POSE["longitude"])
    assert aircraft.airborne is True
    assert aircraft.speed_mps == pytest.approx(POSE["speed_mps"])

    entity = next(item for item in session.entities()
                  if item.entity_id == f"scenario:{aircraft_id}")
    assert entity.latitude_deg == pytest.approx(POSE["latitude"])
    assert entity.altitude_m == pytest.approx(POSE["altitude"])
    assert not session._manual_poses, "우편함은 비워진다"


def test_nonsense_never_enters_the_mailbox():
    # The guard `manual_takeover.place` applies, applied at the door instead --
    # a pose the tick could not use must not be left for the tick to fail on.
    session, clock, aircraft_id = flying()
    assert session.place_manual(aircraft_id, **{**POSE, "latitude": float("nan")}) is False
    assert session.place_manual(aircraft_id, **{**POSE, "altitude": None}) is False
    assert session.place_manual(aircraft_id, longitude=126.9, altitude=10.0) is False
    assert session._manual_poses == {}
    clock.tick(.5)
    assert session.tick() is True


def test_two_messages_collapsed_into_one_still_report_the_climb_they_flew():
    # `step` is how long it took to get here, and it is the only thing that
    # turns two heights into a rate. Collapsing two messages and keeping only
    # the newer `step` would halve the time and double the climb -- a rate the
    # aircraft never flew, carried onto the wire as its velocity.
    session, clock, aircraft_id = flying()
    aircraft = session.engine.aircraft[aircraft_id]

    session.place_manual(aircraft_id, **{**POSE, "altitude": 100.0, "step": .06})
    clock.tick(.1)
    session.tick()
    assert aircraft.altitude == pytest.approx(100.0)

    # Two messages, 60 ms each, three metres each, inside one tick.
    session.place_manual(aircraft_id, **{**POSE, "altitude": 103.0, "step": .06})
    session.place_manual(aircraft_id, **{**POSE, "altitude": 106.0, "step": .06})
    assert session._manual_poses[aircraft_id]["step"] == pytest.approx(.12)
    clock.tick(.1)
    session.tick()
    assert aircraft.altitude == pytest.approx(106.0)
    assert aircraft.climb_mps == pytest.approx(6.0 / .12), \
        "합쳐진 메시지는 두 메시지가 걸린 시간을 그대로 들고 가야 한다"

    # A pose the tick has already taken starts the next one's clock afresh.
    session.place_manual(aircraft_id, **{**POSE, "altitude": 109.0, "step": .06})
    assert session._manual_poses[aircraft_id]["step"] == pytest.approx(.06)


def test_the_last_pose_written_during_a_running_tick_is_the_one_applied():
    session, clock, first = flying()
    second = session.assign_manual(vertiport="VP1")["aircraft_id"]
    assert second != first
    stop = threading.Event()
    written = []

    def pilot():
        count = 0
        while not stop.is_set():
            count += 1
            for offset, identifier in enumerate((first, second)):
                session.place_manual(identifier, **{**POSE,
                                                    "latitude": 37.4 + offset * .05 + count * 1e-6,
                                                    "altitude": 200.0 + count})
            written.append(count)

    thread = threading.Thread(target=pilot, daemon=True)
    thread.start()
    try:
        for _ in range(60):
            clock.tick(.05)
            session.tick()
    finally:
        stop.set()
    thread.join(5)
    assert written, "조종사 스레드가 아무것도 쓰지 않았습니다"

    # Now the quiet round: with nobody else writing, the last pose each aircraft
    # was given is the one the fleet ends up holding. A drain that dropped it
    # would leave the aircraft frozen at whatever it happened to catch.
    final = {first: 38.10, second: 38.20}
    for identifier, latitude in final.items():
        assert session.place_manual(identifier, **{**POSE, "latitude": latitude}) is True
    clock.tick(.05)
    session.tick()
    for identifier, latitude in final.items():
        assert session.engine.aircraft[identifier].latitude == pytest.approx(latitude)
    assert not session._manual_poses


def test_a_pose_arriving_mid_drain_is_kept_rather_than_swallowed(monkeypatch):
    # Swapping the mailbox out (`poses, self._manual_poses = self._manual_poses, {}`)
    # loses a pose that lands between the two assignments, because the writer
    # holds the dict that was just thrown away. Popping one key at a time cannot:
    # the mailbox is the same object throughout, and a pose that arrives after
    # its own pop simply waits for the next tick.
    session, clock, aircraft_id = flying()
    mailbox = id(session._manual_poses)
    seen, real = [], session_module.manual_takeover.place

    def place(engine, identifier, **pose):
        seen.append(id(session._manual_poses))
        if len(seen) == 1:                     # a cockpit message, mid-drain
            session.place_manual(identifier, **{**POSE, "latitude": 39.5, "altitude": 300.0})
        return real(engine, identifier, **pose)

    monkeypatch.setattr(session_module.manual_takeover, "place", place)

    assert session.place_manual(aircraft_id, **POSE) is True
    clock.tick(.5)
    session.tick()
    assert seen == [mailbox], "배수 중에도 우편함은 같은 객체여야 한다"
    assert id(session._manual_poses) == mailbox, "우편함을 통째로 갈아끼우지 않는다"
    assert session._manual_poses.get(aircraft_id) is not None, \
        "배수 도중 도착한 자세가 버려졌습니다"

    clock.tick(.5)
    session.tick()
    assert session.engine.aircraft[aircraft_id].latitude == pytest.approx(39.5)
    assert not session._manual_poses


def test_a_paused_day_still_flies_the_aircraft_somebody_is_holding():
    # Pausing stops the schedule, not the person. Their poses still land and
    # their clearances still refresh, which is why the pump runs before the
    # early return rather than after it.
    session, clock, aircraft_id = flying()
    session.manual_watch(aircraft_id)
    session.pause()
    assert session.status()["state"] == "paused"

    assert session.place_manual(aircraft_id, **{**POSE, "latitude": 37.54, "altitude": 260.0}) is True
    clock.tick(2)
    assert session.tick() is False, "멈춘 하루는 운항 시계를 진행시키지 않는다"

    aircraft = session.engine.aircraft[aircraft_id]
    assert aircraft.latitude == pytest.approx(37.54)
    assert aircraft.altitude == pytest.approx(260.0)
    assert aircraft.airborne is True

    advice = session.manual_advice(aircraft_id)
    assert advice is not None
    assert advice["clock"]["state"] == "paused"
    assert advice["airborne"] is True, "방금 도착한 자세로 판단한 허가여야 한다"


def test_watching_seeds_the_cache_and_unwatching_empties_it():
    session, clock, aircraft_id = flying()
    assert session.manual_advice(aircraft_id) is None, "조종석이 붙기 전에는 캐시가 없다"

    seeded = session.manual_watch(aircraft_id)
    assert seeded is not None and "clock" in seeded
    first = session.manual_advice(aircraft_id)
    assert first is not None, "첫 읽기부터 답이 있어야 한다"
    assert first["clock"]["state"] == "playing"
    assert first["departed"] is False

    parked = session.engine.aircraft[aircraft_id].latitude
    assert session.place_manual(aircraft_id, **POSE) is True
    assert session.manual_unwatch(aircraft_id) is True
    assert session.manual_advice(aircraft_id) is None
    assert aircraft_id not in session._manual_poses

    clock.tick(5)
    session.tick()
    assert session.engine.aircraft[aircraft_id].latitude == pytest.approx(parked), \
        "조종석이 떠나며 버린 자세는 끝내 반영되지 않는다"
    assert session.manual_advice(aircraft_id) is None
    assert session.manual_unwatch(aircraft_id) is False


def test_advice_refreshes_once_an_interval_and_only_for_a_watched_cockpit(monkeypatch):
    session, clock, watched = flying()
    other = session.assign_manual(vertiport="VP1")["aircraft_id"]
    assert other != watched

    asked, real = [], session_module.manual_takeover.advisory

    def advisory(engine, identifier, **kwargs):
        asked.append(identifier)
        return real(engine, identifier, **kwargs)

    monkeypatch.setattr(session_module.manual_takeover, "advisory", advisory)

    session.manual_watch(watched)
    assert asked == [watched], "조종석이 붙는 순간 한 번 계산한다"
    del asked[:]

    clock.tick(MANUAL_ADVICE_INTERVAL_S * .3)
    session.tick()
    clock.tick(MANUAL_ADVICE_INTERVAL_S * .3)
    session.tick()
    assert asked == [], f"{MANUAL_ADVICE_INTERVAL_S}초 안에는 다시 계산하지 않는다"

    clock.tick(MANUAL_ADVICE_INTERVAL_S * .5)
    session.tick()
    assert asked == [watched], "간격이 지나면 한 번, 그리고 조종석이 붙은 기체만"
    del asked[:]

    clock.tick(MANUAL_ADVICE_INTERVAL_S * .2)
    session.tick()
    assert asked == []
    clock.tick(MANUAL_ADVICE_INTERVAL_S)
    session.tick()
    assert asked == [watched]
    assert other not in asked, "조종석이 없는 기체의 위반을 만들어내지 않는다"


def test_clearing_the_day_takes_the_mailbox_with_it():
    session, clock, aircraft_id = flying()
    session.manual_watch(aircraft_id)
    assert session.place_manual(aircraft_id, **POSE) is True

    session.clear()
    assert session._manual_poses == {} and session._manual_watch == set()
    assert session.manual_advice(aircraft_id) is None
    # And with no day loaded there is nowhere for a pose to go.
    assert session.place_manual(aircraft_id, **POSE) is False
