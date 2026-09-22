"""Timetable capacity, calibrated phase floors and robust aircraft rotations."""
import pytest

from digital_twin.model_library import flight_scheduler, schedule_planning


def _timing_options(_origin, _destination, _from_gate, _to_gate):
    return [
        {"gate_out_s": 10.0, "takeoff_s": 10.0, "air_s": 10.0, "landing_s": 10.0,
         "gate_in_s": 10.0, "turnaround_s": 100.0,
         "from_fato": "F1", "to_fato": "F1", "route_path": ["F1", "A", "D1"]},
        {"gate_out_s": 10.0, "takeoff_s": 10.0, "air_s": 10.0, "landing_s": 10.0,
         "gate_in_s": 10.0, "turnaround_s": 100.0,
         "from_fato": "F2", "to_fato": "F2", "route_path": ["F2", "B", "D2"]},
    ]


def _fleet(*rows):
    return [{"aircraft_id": f"UAM{index:04d}", "vertiport": deck, "stand": stand, "seats": seats}
            for index, (deck, stand, seats) in enumerate(rows, start=1)]


def test_calibrated_phase_floors_keep_route_cruise_time_but_protect_terminal_time():
    raw = {"gate_out_s": 20, "takeoff_s": 5, "climb_s": 10, "cruise_s": 333,
           "descent_s": 10, "air_s": 353, "landing_s": 5, "gate_in_s": 20,
           "turnaround_s": 200}
    timed = schedule_planning.apply_phase_floors(raw)
    assert timed["gate_out_s"] == pytest.approx(177.5)
    assert timed["cruise_s"] == 333
    assert timed["air_s"] == pytest.approx(46.1 + 333 + 45.1)
    assert timed["planning_calibration_id"] == "seoul_uam_20260921"


def test_two_fatos_take_two_simultaneous_slots_and_the_third_waits():
    demand = [{"hour": 6, "from": "A", "to": "B", "passengers": 12}]
    answer = flight_scheduler.schedule(
        demand=demand,
        fleet=_fleet(("A", "G1", 4), ("A", "G2", 4), ("A", "G3", 4)),
        stands={"A": ["G1", "G2", "G3"], "B": ["G1", "G2", "G3"]},
        timing=_timing_options, start_minutes=6 * 60, end_minutes=7 * 60,
        planning={"fato_headway_s": 60, "turnaround_recovery_s": 0})
    flights = sorted(answer["flights"], key=lambda item: item["off_block_s"])
    assert [flight["off_block_s"] for flight in flights] == [21600, 21600, 21660]
    assert {flight["departure_fato_id"] for flight in flights[:2]} == {"F1", "F2"}
    assert flights[-1]["departure_resource_wait_s"] == 60
    assert answer["summary"]["capacity_delayed_flights"] == 1
    assert answer["summary"]["fato_slot_reservations"] == 6


def test_rotation_waits_for_cabin_turnaround_and_recovery_buffer():
    demand = [{"hour": 6, "from": "A", "to": "B", "passengers": 4},
              {"hour": 6, "from": "B", "to": "A", "passengers": 4}]
    answer = flight_scheduler.schedule(
        demand=demand, fleet=_fleet(("A", "G1", 4)),
        stands={"A": ["G1"], "B": ["G1"]}, timing=_timing_options,
        start_minutes=6 * 60, end_minutes=7 * 60,
        planning={"fato_headway_s": 0, "turnaround_recovery_s": 120})
    first, second = answer["flights"]
    assert second["off_block_s"] >= first["in_block_s"] + 720, (
        "4-seat minimum turnaround is 600 s and the robust recovery is 120 s")
    assert answer["summary"]["turnaround_recovery_seconds"] == 120
    assert answer["summary"]["rotation_flights_max"] == 2


def test_shared_air_route_does_not_delay_a_resource_only_timetable():
    def shared_route_options(*_args):
        options = _timing_options(*_args)
        for option in options:
            option["route_path"] = ["SHARED-A", "SHARED-B"]
        return options
    answer = flight_scheduler.schedule(
        demand=[{"hour": 6, "from": "A", "to": "B", "passengers": 8}],
        fleet=_fleet(("A", "G1", 4), ("A", "G2", 4)),
        stands={"A": ["G1", "G2"], "B": ["G1", "G2"]}, timing=shared_route_options,
        start_minutes=6 * 60, end_minutes=7 * 60,
        planning={"fato_headway_s": 60, "turnaround_recovery_s": 0})
    flights = sorted(answer["flights"], key=lambda item: item["off_block_s"])
    assert [flight["off_block_s"] for flight in flights] == [21600, 21600]
    assert {flight["departure_fato_id"] for flight in flights} == {"F1", "F2"}
    assert all(flight["departure_resource_wait_s"] == 0 for flight in flights)
    assert "corridor_slot_reservations" not in answer["summary"]


def test_abandoned_fato_wait_does_not_leak_into_the_next_demand_hour():
    one_fato = lambda *_args: _timing_options(*_args)[:1]
    answer = flight_scheduler.schedule(
        demand=[{"hour": 6, "from": "A", "to": "B", "passengers": 8},
                {"hour": 7, "from": "A", "to": "B", "passengers": 4}],
        fleet=_fleet(("A", "G1", 4), ("A", "G2", 4), ("A", "G3", 4)),
        stands={"A": ["G1", "G2", "G3"], "B": ["G1", "G2", "G3"]},
        timing=one_fato, start_minutes=6 * 60, end_minutes=8 * 60,
        planning={"fato_headway_s": 60, "turnaround_recovery_s": 0})
    hour_seven = [flight for flight in answer["flights"] if flight["demand_hour"] == 7]
    assert hour_seven
    assert hour_seven[0]["departure_resource_wait_s"] == 0
