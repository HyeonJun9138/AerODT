"""A day of flights read from somebody else's file.

The file is intent we did not produce. These tests fix what is accepted, what is
refused by name rather than half-read, and what is carried through unchanged
because it is a fact about the day rather than a fault in it.
"""
import pytest

from digital_twin.model_library import flight_schedule

HEADER = ("scenario_id,scenario_date,flight_plan_id,aircraft_id,aircraft_type_id,seat_capacity,passenger_count,"
          "origin_vertiport_id,origin_vertiport_name,destination_vertiport_id,destination_vertiport_name,"
          "departure_stand_id,departure_fato_id,arrival_stand_id,arrival_fato_id,"
          "off_block_time,departure_handoff_time,touchdown_time,in_block_time,turnaround_complete_time,"
          "lift_off_time,airborne_time_sec,flight_status")


def row(flight="FPL000001", aircraft="UAM0001", seats=4, passengers=2, origin="VP001", destination="VP002",
        stand="G1", arrival_stand="G5", off="06:30:00", touchdown="06:48:17", in_block="06:53:01",
        turnaround="07:03:01", status="ready", handoff=None, lift=None, airborne="800.2"):
    # The lift-off and the handoff follow the off-block time unless a test is
    # about them, so moving one flight later does not leave them behind it.
    start = flight_schedule.clock_seconds(off) if off else None
    lift = (flight_schedule.clock_text(start + 297) if start is not None else "") if lift is None else lift
    handoff = (flight_schedule.clock_text(start + 314) if start is not None else "") if handoff is None else handoff
    return (f"804590474748,2026-10-10,{flight},{aircraft},a{seats},{seats},{passengers},"
            f"{origin},여의도,{destination},잠실,{stand},F1,{arrival_stand},F2,"
            f"{off},{handoff},{touchdown},{in_block},{turnaround},{lift},{airborne},{status}")


def read(*rows, vertiports=("VP001", "VP002", "VP003")):
    text = "\n".join([HEADER, *rows]) + "\n"
    return flight_schedule.read_schedule(text, vertiports=[{"id": item} for item in vertiports])


def test_a_day_is_read_into_flights_aircraft_and_the_window_it_runs_in():
    schedule = read(row(), row(flight="FPL000002", aircraft="UAM0002", seats=8, off="07:10:00",
                              touchdown="07:30:00", in_block="07:35:00", turnaround="07:50:00"))
    assert [flight["flight_id"] for flight in schedule["flights"]] == ["FPL000001", "FPL000002"]
    assert schedule["date"] == "2026-10-10"
    assert schedule["window"] == {"start_s": 23400, "end_s": 28200, "seconds": 4800,
                                  "start": "06:30:00", "end": "07:50:00"}
    # Times are seconds from the date's midnight, so no time zone has to exist.
    assert schedule["flights"][0]["off_block_s"] == 6 * 3600 + 30 * 60
    assert schedule["flights"][0]["touchdown_s"] == 6 * 3600 + 48 * 60 + 17
    assert schedule["vertiports"] == ["VP001", "VP002"]
    assert schedule["problem_count"] == 0
    # The same bytes give the same identity, so reloading a file is recognisable.
    assert schedule["schedule_id"] == read(row(), row(flight="FPL000002", aircraft="UAM0002", seats=8,
                                                     off="07:10:00", touchdown="07:30:00", in_block="07:35:00",
                                                     turnaround="07:50:00"))["schedule_id"]


def test_the_cabin_decides_the_airframe_and_how_it_flies():
    """Four cabins, four airframes, so a size is something an operator can tell
    apart on the map.

    How large each is *drawn* is not decided here: the display draws the asset
    the visual library holds, at the size that library gives it."""
    assets = {item["seats"]: flight_schedule.seat_class(item["seats"])["asset_id"]
              for item in flight_schedule.SEAT_CLASSES}
    assert len(set(assets.values())) == 4, "a cabin size an operator can tell apart on the map"
    # A size between the classes flies in the next one up, and one above them all
    # still flies rather than being refused.
    assert flight_schedule.seat_class(3)["seats"] == 4
    assert flight_schedule.seat_class(40)["seats"] == 8
    # A bigger cabin is heavier: it cruises slower and takes longer to turn round.
    small, large = flight_schedule.seat_class(2), flight_schedule.seat_class(8)
    assert small["cruise_speed_mps"] > large["cruise_speed_mps"]
    assert small["turnaround_seconds"] < large["turnaround_seconds"]


def test_where_every_aircraft_stands_when_the_day_opens():
    """An aircraft's first flight says where it must already be. Two of them on
    one stand is the file's problem to have and ours to place, so the second is
    moved to a free stand and the move is reported rather than hidden."""
    schedule = read(row(aircraft="UAM0001", stand="G1"),
                    row(flight="FPL000002", aircraft="UAM0002", stand="G1", off="06:31:00"),
                    row(flight="FPL000003", aircraft="UAM0003", origin="VP003", stand="G2", off="06:40:00"))
    state = flight_schedule.initial_state(schedule)
    assert len(state["placements"]) == 3, "one entry per airframe, not per flight"
    stands = {(item["vertiport_id"], item["stand_id"]) for item in state["placements"]}
    assert len(stands) == 3, "no two aircraft on the same stand"
    assert state["reassigned"] == ["UAM0002"]
    assert state["opens"] == "06:30:00"
    first = next(item for item in state["placements"] if item["aircraft_id"] == "UAM0001")
    assert first["vertiport_id"] == "VP001" and first["stand_id"] == "G1"
    assert first["asset_id"] == flight_schedule.seat_class(4)["asset_id"]


def test_a_flight_the_file_could_not_land_is_carried_and_marked():
    """A row with no touchdown is the case the rehearsal exists to look at. It
    is kept, and it is not allowed to read as ready."""
    schedule = read(row(), row(flight="FPL000002", aircraft="UAM0002", off="06:40:00",
                               touchdown="", in_block="", turnaround="", airborne="",
                               status="arrival_unresolved"))
    unresolved = schedule["flights"][1]
    assert unresolved["status"] == flight_schedule.UNRESOLVED_STATUS
    assert unresolved["resolved"] is False and unresolved["touchdown_s"] is None
    assert unresolved["off_block_s"] is not None, "it still pushes back"
    summary = flight_schedule.summary(schedule)
    assert summary["unresolved"] == 1 and summary["unresolved_flights"] == ["FPL000002"]
    # A row that says ready but has no touchdown is corrected, not believed.
    said_ready = read(row(touchdown="", in_block="", turnaround="", airborne="", status="ready"))
    assert said_ready["flights"][0]["status"] == flight_schedule.UNRESOLVED_STATUS


def test_a_day_that_runs_past_midnight_keeps_going_forwards():
    schedule = read(row(off="23:50:00", lift="23:54:00", handoff="23:56:00",
                        touchdown="00:12:00", in_block="00:18:00", turnaround="00:33:00"))
    flight = schedule["flights"][0]
    assert flight["off_block_s"] == 23 * 3600 + 50 * 60
    assert flight["touchdown_s"] == 24 * 3600 + 12 * 60, "twelve past midnight is later, not earlier"
    assert flight["in_block_s"] > flight["touchdown_s"] > flight["off_block_s"]
    assert flight_schedule.clock_text(flight["touchdown_s"]) == "24:12:00"


def test_what_cannot_be_flown_is_refused_by_name():
    # A deck the twin has not placed cannot be flown to, and saying which one
    # lets the operator place it and load again.
    schedule = read(row(), row(flight="FPL000002", aircraft="UAM0002", destination="VP099", off="06:40:00"))
    assert len(schedule["flights"]) == 1
    assert any("VP099" in problem for problem in schedule["problems"])
    for bad, says in [
        (row(flight=""), "flight_plan_id"),
        (row(flight="FPL000009", aircraft=""), "aircraft_id"),
        (row(flight="FPL000010", seats=0), "seat_capacity"),
        (row(flight="FPL000011", destination="VP001"), "같습니다"),
        (row(flight="FPL000012", off=""), "off_block_time"),
    ]:
        assert any(says in problem for problem in read(row(), bad)["problems"]), says
    # The same flight twice is a fault, not two flights.
    assert len(read(row(), row())["flights"]) == 1
    # Nothing readable at all is an error rather than an empty day.
    with pytest.raises(ValueError):
        read(row(flight=""))
    with pytest.raises(ValueError) as error:
        flight_schedule.read_schedule("a,b,c\n1,2,3\n")
    assert "필요한 열" in str(error.value)
    with pytest.raises(ValueError):
        flight_schedule.read_schedule("")


def test_more_passengers_than_seats_is_corrected_and_said():
    schedule = read(row(seats=4, passengers=9))
    assert schedule["flights"][0]["passengers"] == 4
    assert schedule["flights"][0]["load_factor"] == 1.0
    assert any("탑승객" in problem for problem in schedule["problems"])


def test_the_summary_is_what_a_panel_says_before_anything_is_flown():
    schedule = read(row(seats=2, passengers=2), row(flight="FPL000002", aircraft="UAM0002", seats=8,
                                                    passengers=6, off="06:40:00"))
    summary = flight_schedule.summary(schedule)
    assert summary["flights"] == 2 and summary["aircraft"] == 2
    assert summary["passengers"] == 8 and summary["seats"] == 10
    assert [item["seats"] for item in summary["by_seat_class"]] == [2, 8]
    assert summary["by_seat_class"][0]["asset_id"] != summary["by_seat_class"][1]["asset_id"]
    # How large each airframe is drawn belongs to the visual library, not here:
    # the schedule names the asset and says nothing about its size. The empty map
    # is sent rather than omitted so a display that was given sizes by an older
    # build lets go of them.
    assert summary["visual_policy"] == "single_flight_asset"
    assert summary["model_spans"] == {}


def test_a_clock_reads_both_ways_and_a_blank_is_an_answer():
    assert flight_schedule.clock_seconds("06:30:00") == 23400
    assert flight_schedule.clock_seconds("06:30") == 23400
    assert flight_schedule.clock_seconds("") is None and flight_schedule.clock_seconds(None) is None
    assert flight_schedule.clock_text(23400) == "06:30:00" and flight_schedule.clock_text(None) == ""
    for bad in ("6", "06:60:00", "aa:bb:cc", "06:30:00:00"):
        with pytest.raises(ValueError):
            flight_schedule.clock_seconds(bad)
