"""출발·도착 안내판: 시각과 상태, 그리고 게이트별 대기 인원.

The board is the one thing in the terminal a person reads for a fact, so the
rule that turns a phase and a clock into a word has to hold on its own. It is
also what says how many people are standing at which gate, so a status that is
too generous fills a lounge that is empty in real life.
"""
import pytest

from digital_twin.model_library import terminal_board as tb


def flight(identifier, origin, destination, off_block_s, **changes):
    return {"flight_id": identifier, "aircraft_id": "A" + identifier[-1],
            "origin": origin, "destination": destination,
            "origin_name": origin + "역", "destination_name": destination + "역",
            "departure_stand": "G1", "arrival_stand": "G2",
            "departure_fato": "F1", "arrival_fato": "F2",
            "passengers": 4, "seats": 6,
            "off_block_s": off_block_s, "lift_off_s": off_block_s + 180,
            "touchdown_s": off_block_s + 900, "in_block_s": off_block_s + 1020, **changes}


NOW = 8 * 3600
DAY = [flight("F1", "VP1", "VP2", NOW + 1800),
       flight("F2", "VP2", "VP1", NOW - 1200),
       flight("F3", "VP1", "VP3", NOW + 300),
       flight("F4", "VP4", "VP5", NOW + 600)]


def test_only_this_deck_and_only_the_hours_either_side_of_now():
    view = tb.board(DAY, {}, "VP1", NOW)
    assert [row["flight_id"] for row in view["departures"]] == ["F3", "F1"], "가까운 것부터"
    # F2 lands at VP1 twenty minutes before its own in-block, which is inside
    # the window a board keeps a flight up for.
    assert [row["flight_id"] for row in view["arrivals"]] == ["F2"]
    assert view["vertiport_id"] == "VP1" and view["clock"]
    # A deck nobody flies to has an empty board rather than no board.
    empty = tb.board(DAY, {}, "VP9", NOW)
    assert empty["departures"] == [] and empty["arrivals"] == []


def test_a_flight_far_out_or_long_gone_is_not_on_the_board():
    far = [flight("F9", "VP1", "VP2", NOW + tb.AHEAD_S + 60)]
    gone = [flight("F8", "VP1", "VP2", NOW - tb.BEHIND_S - 60)]
    assert tb.board(far, {}, "VP1", NOW)["departures"] == []
    assert tb.board(gone, {}, "VP1", NOW)["departures"] == []


@pytest.mark.parametrize("state,expected", [
    (None, "scheduled"),
    ({"phase": "parked"}, "scheduled"),
    ({"phase": "gate_out"}, "taxi"),
    ({"phase": "takeoff", "airborne": False}, "airborne"),
    ({"phase": "cruise", "airborne": True}, "airborne"),
])
def test_a_departure_reads_what_the_aircraft_is_doing(state, expected):
    day = [flight("F1", "VP1", "VP2", NOW + 3600)]
    row = tb.board(day, {"F1": state} if state else {}, "VP1", NOW)["departures"][0]
    assert row["status"] == expected
    assert row["status_text"] == tb.DEPARTURE[expected]


def test_a_departure_standing_at_its_stand_reads_the_clock_instead():
    # The aircraft is doing the same thing at every one of these moments. What
    # changes is how long there is left, which is what a board is for.
    day = [flight("F1", "VP1", "VP2", NOW)]
    at = lambda now: tb.board(day, {"F1": {"phase": "parked"}}, "VP1", now)["departures"][0]["status"]
    assert at(NOW - tb.BOARDING_OPENS_S - 60) == "scheduled"
    assert at(NOW - tb.BOARDING_OPENS_S + 60) == "boarding"
    assert at(NOW) == "boarding"
    assert at(NOW + tb.LATE_S + 1) == "late"


@pytest.mark.parametrize("state,expected", [
    (None, "scheduled"),
    ({"phase": "cruise", "airborne": True}, "approach"),
    ({"phase": "cruise", "airborne": True, "holding": True}, "holding"),
    ({"phase": "landing"}, "landing"),
    ({"phase": "gate_in"}, "arrived"),
    ({"phase": "charge"}, "arrived"),
])
def test_an_arrival_reads_what_the_aircraft_is_doing(state, expected):
    day = [flight("F1", "VP2", "VP1", NOW - 900)]   # in-block is now + 120
    row = tb.board(day, {"F1": state} if state else {}, "VP1", NOW)["arrivals"][0]
    assert row["status"] == expected
    assert row["status_text"] == tb.ARRIVAL[expected]


def test_a_row_carries_what_a_passenger_and_a_lounge_both_need():
    row = tb.board(DAY, {}, "VP1", NOW)["departures"][0]
    assert row["counterpart"] == "VP3" and row["counterpart_name"] == "VP3역"
    assert row["gate"] == "G1" and row["fato"] == "F1"
    assert row["passengers"] == 4 and row["seats"] == 6
    assert row["time"] and row["time_s"] == pytest.approx(NOW + 300)
    arrival = tb.board(DAY, {}, "VP1", NOW)["arrivals"][0]
    assert arrival["gate"] == "G2", "도착은 도착 스탠드"


def test_only_a_called_flight_puts_people_in_its_lounge():
    # Every passenger of the whole day standing in the lounges at once is a
    # terminal that is packed at four in the morning.
    day = [flight("F1", "VP1", "VP2", NOW + 60, departure_stand="G1", passengers=4),
           flight("F2", "VP1", "VP3", NOW + 7200, departure_stand="G2", passengers=6),
           flight("F3", "VP1", "VP4", NOW - 400, departure_stand="G1", passengers=3)]
    rows = tb.board(day, {"F3": {"phase": "gate_out"}}, "VP1", NOW)["departures"]
    waiting = tb.waiting_by_gate(rows)
    assert waiting == {"G1": 4}, waiting
    # F3 has pushed back, so its people are on the aircraft, not in the lounge;
    # F2 is two hours out and has not been called.
    assert "G2" not in waiting


def test_a_late_flight_keeps_its_people_and_says_how_late():
    day = [flight("F1", "VP1", "VP2", NOW - tb.LATE_S - 120, passengers=5)]
    row = tb.board(day, {"F1": {"phase": "parked"}}, "VP1", NOW)["departures"][0]
    assert row["status"] == "late" and row["late_s"] == pytest.approx(tb.LATE_S + 120)
    assert tb.waiting_by_gate([row]) == {"G1": 5}


def test_rubbish_in_the_day_is_skipped_rather_than_raising():
    day = [None, {"origin": "VP1"}, flight("F1", "VP1", "VP2", NOW + 60),
           {"flight_id": "F7", "origin": "VP1", "destination": "VP2"}]
    view = tb.board(day, {}, "VP1", NOW)
    assert [row["flight_id"] for row in view["departures"]] == ["F1"]


def test_the_board_is_capped_and_the_cap_keeps_the_soonest():
    day = [flight(f"F{index}", "VP1", "VP2", NOW + index * 60) for index in range(1, 30)]
    view = tb.board(day, {}, "VP1", NOW, rows=5)
    assert len(view["departures"]) == 5
    assert [row["flight_id"] for row in view["departures"]] == ["F1", "F2", "F3", "F4", "F5"]
