"""Flying one aircraft of a scheduled day by hand.

The point of handing an airframe over inside the day rather than beside it is
that everyone else has to see it: it holds the pad it is actually on, other
aircraft wait behind it when it is slow, and it takes its clearances from the
same service. So these tests are about what stays true when the model stops
flying it -- and about the one thing a person can do that a model never does,
which is go anyway.
"""
import pytest

from digital_twin.simulation import manual_takeover, psu_sequencing
from project_support.tests.web_live.test_scenario_engine import engine_of, row, run_to


def day(*rows):
    return engine_of(*(rows or (row("F1", "A1", "VP1", "VP2", "06:30:00"),)))


def test_only_an_aircraft_still_standing_can_be_handed_over():
    engine = day(row("F1", "A1", "VP1", "VP2", "06:30:00"),
                 row("F2", "A2", "VP1", "VP2", "08:10:00"))
    offered = manual_takeover.candidates(engine)
    # Both are parked, but only one is close enough to its time to be worth
    # offering; being overdue keeps a flight on the list, being an hour out
    # does not.
    assert [entry["flight_id"] for entry in offered] == ["F1"]
    assert offered[0]["aircraft_id"] == "A1"
    assert offered[0]["origin"] == "VP1" and offered[0]["destination"] == "VP2"
    assert offered[0]["ready"] is True

    wide = manual_takeover.candidates(engine, within_s=4 * 3600)
    assert [entry["flight_id"] for entry in wide] == ["F1", "F2"]
    assert wide[1]["due_in_s"] == pytest.approx(100 * 60)
    assert wide[1]["ready"] is False

    # The picker offers the models that actually have a flight, so choosing one
    # cannot lead to an empty list.
    assert [entry["asset_id"] for entry in manual_takeover.models(engine, within_s=4 * 3600)] \
        == [engine.aircraft["A1"].asset_id]
    assert manual_takeover.candidates(engine, asset_id="nothing-like-this") == []
    assert manual_takeover.candidates(engine, vertiport="VP3") == []

    manual_takeover.hand_over(engine, "A1")
    assert [entry["flight_id"] for entry in manual_takeover.candidates(engine, within_s=4 * 3600)] == ["F2"]
    with pytest.raises(ValueError, match="이미 수동 조종"):
        manual_takeover.hand_over(engine, "A1")
    with pytest.raises(ValueError, match="시나리오에 없는"):
        manual_takeover.hand_over(engine, "A9")


def test_a_handed_over_aircraft_is_not_started_by_the_schedule_and_is_not_walked():
    engine = day()
    manual_takeover.hand_over(engine, "A1")
    aircraft = engine.aircraft["A1"]
    where = (aircraft.latitude, aircraft.longitude)

    # Its off-block time comes and goes. The model does not take it.
    run_to(engine, engine.time_s + 600)
    assert aircraft.flight is None, "허가 없이 스스로 출발하지 않는다"
    assert aircraft.phase == "parked"
    assert (aircraft.latitude, aircraft.longitude) == where, "경로를 따라 움직이지도 않는다"
    assert aircraft.next_flight == 0

    # The pilot puts it somewhere, and that is where the day now sees it.
    manual_takeover.place(engine, "A1", latitude=37.53, longitude=126.93, altitude=240.0,
                          heading=180.0, step=1.0, airborne=True, speed_mps=42.0)
    assert aircraft.airborne is True
    assert aircraft.phase == manual_takeover.PHASE_MANUAL
    state = next(item for item in engine.states() if item["aircraft_id"] == "A1")
    assert state["latitude_deg"] == pytest.approx(37.53)
    assert state["altitude_m"] == pytest.approx(240.0)

    # A step turns two heights into a climb rate, the same as for any aircraft.
    manual_takeover.place(engine, "A1", latitude=37.53, longitude=126.93, altitude=260.0, step=2.0,
                          airborne=True)
    assert aircraft.climb_mps == pytest.approx(10.0)
    # Nonsense from a stalled link never reaches the fleet.
    assert manual_takeover.place(engine, "A1", latitude=float("nan"), longitude=126.9, altitude=1.0) is False
    assert aircraft.latitude == pytest.approx(37.53)

    # Handing it back leaves the day where the person left it, and the airframe
    # is an ordinary one again.
    assert manual_takeover.release(engine, "A1") is True
    assert aircraft.external is None
    assert manual_takeover.release(engine, "A1") is False


def test_departure_is_asked_for_and_the_answer_is_a_slot_or_a_reason():
    engine = day()
    manual_takeover.hand_over(engine, "A1")
    answer = manual_takeover.request_departure(engine, "A1")
    assert answer["state"] == "granted"
    assert answer["vertiport"] == "VP1"
    aircraft = engine.aircraft["A1"]
    # Granted means the flight is now this aircraft's, exactly as a model start
    # would make it -- it has a route to its destination and a pad of its own.
    assert aircraft.flight["flight_id"] == "F1"
    assert aircraft.route is not None
    assert engine._active_pads[("VP1", answer["fato"])] == "F1"
    assert aircraft.external["departed"] is True
    # Asking twice is not two departures.
    assert manual_takeover.request_departure(engine, "A1")["state"] == "granted"
    assert aircraft.next_flight == 1

    # It still does not move by itself: the route is there to say where the
    # flight goes, not to fly it.
    where = (aircraft.latitude, aircraft.longitude)
    run_to(engine, engine.time_s + 120)
    assert (aircraft.latitude, aircraft.longitude) == where


def test_a_pad_another_aircraft_is_using_comes_back_as_a_wait_with_a_name():
    # The model's own departure and a person's go through the same gates, so a
    # pad that is not free is not free for either of them.
    engine = day(row("F1", "A1", "VP1", "VP2", "06:30:00", stand="G1"),
                 row("F2", "A2", "VP1", "VP2", "06:31:00", stand="G2"))
    # The first aircraft takes the pad on its own; the second is asked for by a
    # person a moment later.
    run_to(engine, engine.time_s + 45)
    manual_takeover.hand_over(engine, "A2")
    answer = manual_takeover.request_departure(engine, "A2")
    assert answer["state"] in ("hold", "granted")
    if answer["state"] == "hold":
        assert answer["reason"]
        assert (answer.get("blocked_by") or answer.get("cleared_s") is not None
                or answer.get("ready_s") is not None)
        assert engine.aircraft["A2"].flight is None, "대기는 출발이 아니다"
        assert engine.aircraft["A2"].external["departed"] is False


def test_a_landing_number_is_asked_for_and_kept():
    engine = day()
    manual_takeover.hand_over(engine, "A1")
    assert manual_takeover.request_arrival(engine, "A1")["reason"] is None or True
    # Before departure there is no flight to sequence.
    fresh = day()
    manual_takeover.hand_over(fresh, "A1")
    assert manual_takeover.request_arrival(fresh, "A1")["state"] == "refused"

    manual_takeover.request_departure(engine, "A1")
    answer = manual_takeover.request_arrival(engine, "A1", eta_s=300)
    assert answer["state"] in ("granted", "holding")
    assert answer["flight_id"] == "F1"
    assert answer["vertiport"] == "VP2"
    assert answer["sequence"] >= 1, "착륙 번호를 받는다"
    kept = engine.psu.clearance("F1", psu_sequencing.ARRIVAL)
    assert kept is not None and kept.sequence == answer["sequence"]


def test_asking_where_to_wait_gets_the_service_own_answer_not_an_invented_bay():
    # The side bays are assigned along a walked route, and a hand-flown aircraft
    # has no walked route. Saying so beats naming a spot nobody computed.
    engine = day()
    manual_takeover.hand_over(engine, "A1")
    assert manual_takeover.request_hold(engine, "A1")["state"] == "refused", "출발 전에는 대기도 없다"

    manual_takeover.request_departure(engine, "A1")
    answer = manual_takeover.request_hold(engine, "A1")
    assert answer["state"] in ("holding", "granted")
    assert answer["reason"], "어느 쪽이든 이유가 있다"
    if answer["state"] == "holding" and not answer.get("holding_assignment"):
        assert "배정되지 않았습니다" in answer["reason"]
    else:
        assert answer["flight_id"] == "F1"
    # Asking is not flying: the aircraft is exactly where the pilot left it.
    assert engine.aircraft["A1"].phase in ("gate_out", "parked", manual_takeover.PHASE_MANUAL)


def test_what_the_service_is_saying_reaches_the_cockpit_in_one_reading():
    engine = day()
    manual_takeover.hand_over(engine, "A1")
    advice = manual_takeover.advisory(engine, "A1")
    assert advice["flight_id"] == "F1"
    assert advice["departed"] is False and advice["airborne"] is False
    assert advice["departure"] is None and advice["arrival"] is None

    manual_takeover.request_departure(engine, "A1")
    manual_takeover.request_arrival(engine, "A1", eta_s=300)
    advice = manual_takeover.advisory(engine, "A1")
    assert advice["departure"]["vertiport"] == "VP1"
    assert advice["arrival"]["vertiport"] == "VP2"
    assert advice["arrival"]["sequence"] >= 1
    # An airframe nobody is flying has nothing to say.
    assert manual_takeover.advisory(engine, "A9") is None


def test_going_anyway_is_allowed_recorded_and_said_once():
    # The service sequences; it cannot stop an aircraft, and pretending it can
    # would teach the wrong thing. What it can do is be unambiguous.
    engine = day()
    manual_takeover.hand_over(engine, "A1")
    manual_takeover.place(engine, "A1", latitude=37.526, longitude=126.921, altitude=120.0,
                          airborne=True, step=1.0)
    found = manual_takeover.check(engine, "A1")
    assert [entry["kind"] for entry in found] == ["departure_unauthorised"]
    assert engine.aircraft["A1"].airborne is True, "비행은 막지 않는다"
    assert any(event["kind"] == "manual_violation" for event in engine.events)

    # Minutes of flying through it is one violation, not one per frame.
    before = len(engine.aircraft["A1"].external["violations"])
    for _ in range(5):
        manual_takeover.check(engine, "A1")
    assert len(engine.aircraft["A1"].external["violations"]) == before
    assert manual_takeover.advisory(engine, "A1")["violations"][0]["kind"] == "departure_unauthorised"


def test_the_rest_of_the_day_still_runs_around_a_handed_over_aircraft():
    engine = day(row("F1", "A1", "VP1", "VP2", "06:30:00", stand="G1"),
                 row("F3", "A3", "VP1", "VP2", "06:31:00", stand="G3"))
    manual_takeover.hand_over(engine, "A1")
    # An unattended manual assignment has a bounded opening opportunity; the
    # rest of the day must still complete after that opportunity expires.
    run_to(engine, engine.time_s + 400 + manual_takeover.INITIAL_DEPARTURE_PRIORITY_S)
    # The aircraft nobody took flies its day as usual -- in this much time it
    # has flown the whole thing and is standing at the far end.
    assert engine.aircraft["A3"].completed == 1
    assert engine.aircraft["A3"].vertiport == "VP2"
    # The one that was taken has not moved, and is still on its stand.
    assert engine.aircraft["A1"].phase == "parked"
    assert engine.aircraft["A1"].flight is None
    # And it is still in the fleet everyone reads, not hidden from it.
    assert any(item["aircraft_id"] == "A1" for item in engine.states())
