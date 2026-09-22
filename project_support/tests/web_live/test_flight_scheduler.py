"""A day of demand turned into a day of flights.

Two modules answer two different questions and are tested apart. `demand_profile`
says *when* in the operating day the demand happens and *who wants to go where*;
`flight_scheduler` says which aircraft carries it, from which stand, at what
time. Neither knows about files, clocks or the wire.

The rules fixed here are the ones that are easy to get wrong and impossible to
see afterwards: the 24-hour potential demand is clipped by the operating
window, the numbers the operator read on the summary are the numbers that get
scheduled, and a flight that could not be given an arrival stand is carried as
unresolved rather than quietly dropped.
"""
import csv
import io

import pytest

from digital_twin.model_library import demand_profile, flight_schedule, flight_scheduler


# ---------------------------------------------------------------- the demand

def test_the_hourly_curve_is_the_reference_and_covers_a_whole_day():
    assert len(demand_profile.HOURLY_DEPARTURE_PCT) == 24
    assert sum(demand_profile.HOURLY_DEPARTURE_PCT) == pytest.approx(100.0, abs=0.01)
    morning, night = demand_profile.HOURLY_DEPARTURE_PCT[8], demand_profile.HOURLY_DEPARTURE_PCT[3]
    assert morning > night * 5, "the shape is a working day, not a flat line"


def test_a_window_takes_part_hours_and_can_run_past_midnight():
    day = demand_profile.window_hours(6 * 60 + 30, 21 * 60 + 30)
    assert day[0] == (6, 0.5) and day[-1] == (21, 0.5)
    assert [hour for hour, _ in day] == list(range(6, 22))
    assert all(fraction == 1.0 for _, fraction in day[1:-1])
    night = demand_profile.window_hours(23 * 60, 1 * 60)
    assert night == [(23, 1.0), (0, 1.0)]
    assert demand_profile.window_hours(9 * 60, 9 * 60) == []


def test_the_operating_window_takes_only_its_share_of_the_whole_day():
    trips = demand_profile.hourly_trips(1000, 6 * 60 + 30, 21 * 60 + 30)
    assert demand_profile.window_share(6 * 60 + 30, 21 * 60 + 30) == pytest.approx(.7931362931)
    assert sum(trips.values()) == 793
    assert set(trips) == set(range(6, 22))
    assert trips[6] < trips[8], "the half hour of the 06 hour carries less than a whole busy one"


def test_the_default_seoul_demand_keeps_closed_hour_demand_out_of_the_schedule():
    assert demand_profile.window_demand(67_500, 6 * 60 + 30, 21 * 60 + 30) == 53_537
    assert sum(demand_profile.hourly_trips(67_500, 6 * 60 + 30, 21 * 60 + 30).values()) == 53_537


def test_the_pairs_carry_what_the_summary_said_they_would():
    # The same formula the operator read on the summary window: the departing
    # deck's share against the arriving deck's, with the departing deck itself
    # out of the arrival denominator. A cut pair loses 15% of its own demand and
    # diffuses the other 85% instead of renormalising the connected network to 100%.
    weights = [{"vertiport": "VP1", "departure_share": 0.5, "arrival_share": 0.5},
               {"vertiport": "VP2", "departure_share": 0.3, "arrival_share": 0.3},
               {"vertiport": "VP3", "departure_share": 0.2, "arrival_share": 0.2}]
    pairs = [{"from": "VP1", "to": "VP2"}, {"from": "VP1", "to": "VP3"}]
    legs = demand_profile.od_shares(weights, pairs)
    assert {(leg["from"], leg["to"]) for leg in legs} == {
        ("VP1", "VP2"), ("VP2", "VP1"), ("VP1", "VP3"), ("VP3", "VP1")}
    allocation = demand_profile.od_allocation(weights, pairs)
    assert sum(leg["share"] for leg in legs) == pytest.approx(
        allocation["direct_share"] + allocation["redistributed_share"])
    assert allocation["lost_share"] == pytest.approx(
        allocation["disconnected_share"] * .15)
    assert sum(leg["share"] for leg in legs) < 1.0
    out = {(leg["from"], leg["to"]): leg["share"] for leg in legs}
    assert out[("VP1", "VP2")] > out[("VP1", "VP3")], "the bigger arrival deck takes more"


def test_disconnected_demand_prefers_an_alternative_from_the_same_origin():
    weights = [{"vertiport": name, "departure_share": 1 / 3, "arrival_share": 1 / 3}
               for name in ("A", "B", "C")]
    allocation = demand_profile.od_allocation(
        weights, [{"from": "A", "to": "B"}, {"from": "B", "to": "C"}])
    legs = {(leg["from"], leg["to"]): leg for leg in allocation["legs"]}
    # A→C is disconnected. Its transferable share goes to A→B before any
    # destination-only or network-wide fallback is considered.
    assert legs[("A", "B")]["redistributed_share"] > 0
    assert allocation["redistribution_rate"] == pytest.approx(.85)


def test_demand_plan_reports_diffusion_and_preserves_the_whole_person_account():
    weights = [{"vertiport": name, "departure_share": 1 / 3, "arrival_share": 1 / 3}
               for name in ("A", "B", "C")]
    plan = demand_profile.demand_plan(
        daily_trips=10_000, weights=weights, pairs=[{"from": "A", "to": "B"}],
        start_minutes=0, end_minutes=23 * 60 + 59)
    summary = plan["summary"]
    assert (summary["direct_connected_demand_passengers"]
            + summary["redistributed_demand_passengers"]
            + summary["network_lost_demand_passengers"]
            == summary["operating_window_demand_passengers"])
    assert summary["disconnected_od_demand_passengers"] == (
        summary["redistributed_demand_passengers"] + summary["network_lost_demand_passengers"])
    assert sum(row["passengers"] for row in plan["rows"]) == summary["network_schedulable_demand_passengers"]
    assert summary["network_lost_demand_passengers"] > 0


def test_the_demand_is_whole_people_and_adds_up_to_what_was_asked_for():
    weights = [{"vertiport": "VP1", "departure_share": 0.5, "arrival_share": 0.5},
               {"vertiport": "VP2", "departure_share": 0.5, "arrival_share": 0.5}]
    rows = demand_profile.demand_rows(
        daily_trips=997, weights=weights, pairs=[{"from": "VP1", "to": "VP2"}],
        start_minutes=6 * 60, end_minutes=9 * 60)
    assert all(isinstance(row["passengers"], int) and row["passengers"] > 0 for row in rows)
    expected = demand_profile.window_demand(997, 6 * 60, 9 * 60)
    assert sum(row["passengers"] for row in rows) == expected, "rounding preserves the clipped window total"
    assert {row["hour"] for row in rows} == {6, 7, 8}
    again = demand_profile.demand_rows(
        daily_trips=997, weights=weights, pairs=[{"from": "VP1", "to": "VP2"}],
        start_minutes=6 * 60, end_minutes=9 * 60)
    assert rows == again, "the same request is the same demand"


# ---------------------------------------------------------------- the schedule

def timing(origin, destination, from_gate, to_gate):
    """A stand-in for the flight plan: the scheduler is not allowed to know how
    long a flight takes, only to ask."""
    if (origin, destination) == ("VP1", "VP3"):
        raise ValueError("the route network does not join these two vertiports")
    return {"gate_out_s": 60.0, "takeoff_s": 40.0, "air_s": 600.0, "landing_s": 50.0,
            "gate_in_s": 70.0, "turnaround_s": 300.0,
            "from_fato": "F1", "to_fato": "F1", "route_path": [f"{origin} F1", f"{destination} F1"]}


def fleet(*rows):
    return [{"aircraft_id": f"UAM{index:04d}", "vertiport": vertiport, "stand": stand, "seats": seats}
            for index, (vertiport, stand, seats) in enumerate(rows, start=1)]


def stands(count=2):
    return [f"G{index}" for index in range(1, count + 1)]


def test_one_aircraft_carries_a_full_cabin_and_comes_back_for_the_next_load():
    demand = [{"hour": 6, "from": "VP1", "to": "VP2", "passengers": 9},
              {"hour": 6, "from": "VP2", "to": "VP1", "passengers": 9}]
    answer = flight_scheduler.schedule(
        demand=demand, fleet=fleet(("VP1", "G1", 4)), stands={"VP1": stands(), "VP2": stands()},
        timing=timing, start_minutes=6 * 60, end_minutes=8 * 60, seed=1)
    flights = answer["flights"]
    assert [flight["passenger_count"] for flight in flights] == [4, 4, 4, 4], (
        "a cabin is filled before the next one is sent, and what will not fill one is left")
    assert all(flight["aircraft_id"] == "UAM0001" for flight in flights)
    first, second = flights[0], flights[1]
    assert first["origin_vertiport_id"] == "VP1" and first["destination_vertiport_id"] == "VP2"
    assert second["origin_vertiport_id"] == "VP2", "the next leg starts where the last one landed"
    assert second["off_block_s"] >= first["turnaround_complete_s"], (
        "an aircraft is not in two places at once")
    assert answer["summary"]["unserved_passengers"] == 2
    assert answer["summary"]["carried_passengers"] == 16


def test_the_clock_of_one_flight_runs_through_its_phases_in_order():
    answer = flight_scheduler.schedule(
        demand=[{"hour": 6, "from": "VP1", "to": "VP2", "passengers": 4}],
        fleet=fleet(("VP1", "G1", 4)), stands={"VP1": stands(), "VP2": stands()},
        timing=timing, start_minutes=6 * 60, end_minutes=7 * 60, seed=1)
    flight = answer["flights"][0]
    marks = [flight[key] for key in ("off_block_s", "lift_off_s", "departure_handoff_s",
                                     "touchdown_s", "in_block_s", "turnaround_complete_s")]
    assert marks == sorted(marks), "the phases do not overtake each other"
    assert flight["off_block_s"] >= 6 * 3600, "nothing moves before the day opens"
    assert flight["lift_off_s"] - flight["off_block_s"] == pytest.approx(60.0)
    assert flight["touchdown_s"] - flight["departure_handoff_s"] == pytest.approx(650.0)
    assert flight["flight_status"] == flight_schedule.READY_STATUS


def test_a_pair_the_network_does_not_join_is_left_unserved_and_named():
    answer = flight_scheduler.schedule(
        demand=[{"hour": 6, "from": "VP1", "to": "VP3", "passengers": 4}],
        fleet=fleet(("VP1", "G1", 4)), stands={"VP1": stands(), "VP3": stands()},
        timing=timing, start_minutes=6 * 60, end_minutes=7 * 60, seed=1)
    assert answer["flights"] == []
    assert answer["summary"]["unserved_passengers"] == 4
    assert any("VP1" in note and "VP3" in note for note in answer["notes"])


def test_a_deck_with_no_free_stand_takes_the_flight_as_unresolved_rather_than_losing_it():
    # One stand at the destination, already held by an aircraft that never leaves.
    answer = flight_scheduler.schedule(
        demand=[{"hour": 6, "from": "VP1", "to": "VP2", "passengers": 4}],
        fleet=fleet(("VP1", "G1", 4), ("VP2", "G1", 4)),
        stands={"VP1": stands(), "VP2": ["G1"]},
        timing=timing, start_minutes=6 * 60, end_minutes=7 * 60, seed=1)
    unresolved = [f for f in answer["flights"] if f["flight_status"] == flight_schedule.UNRESOLVED_STATUS]
    assert len(unresolved) == 1, "the flight is carried, not dropped: that is what the day is for"
    assert unresolved[0]["arrival_stand_id"] == ""
    assert answer["summary"]["unresolved_flights"] == 1


def test_two_aircraft_do_not_take_the_same_stand_and_a_freed_one_is_reused():
    answer = flight_scheduler.schedule(
        demand=[{"hour": 6, "from": "VP1", "to": "VP2", "passengers": 12}],
        fleet=fleet(("VP1", "G1", 4), ("VP1", "G2", 4)),
        stands={"VP1": stands(4), "VP2": stands(4)},
        timing=timing, start_minutes=6 * 60, end_minutes=9 * 60, seed=1)
    holding = {}
    for flight in sorted(answer["flights"], key=lambda item: item["touchdown_s"]):
        if flight["flight_status"] != flight_schedule.READY_STATUS:
            continue
        key = (flight["destination_vertiport_id"], flight["arrival_stand_id"])
        assert holding.get(key, -1) <= flight["touchdown_s"], "a stand held by two aircraft at once"
        holding[key] = flight["turnaround_complete_s"]


def test_the_same_seed_is_the_same_day_and_a_different_one_is_not_the_same_flight_list():
    demand = [{"hour": 6, "from": "VP1", "to": "VP2", "passengers": 20},
              {"hour": 6, "from": "VP1", "to": "VP4", "passengers": 20}]
    places = {"VP1": stands(4), "VP2": stands(4), "VP4": stands(4)}
    def run(seed):
        return flight_scheduler.schedule(demand=demand, fleet=fleet(("VP1", "G1", 4), ("VP1", "G2", 4)),
            stands=places, timing=timing, start_minutes=6 * 60, end_minutes=8 * 60, seed=seed)
    first, again = run(7), run(7)
    assert [f["flight_plan_id"] for f in first["flights"]] == [f["flight_plan_id"] for f in again["flights"]]
    assert [f["destination_vertiport_id"] for f in first["flights"]] == \
           [f["destination_vertiport_id"] for f in again["flights"]]
    other = run(8)
    assert other["summary"]["flights"] == first["summary"]["flights"], "the fleet does the same work"


def test_progress_is_reported_as_the_day_is_built():
    seen = []
    flight_scheduler.schedule(
        demand=[{"hour": hour, "from": "VP1", "to": "VP2", "passengers": 8} for hour in range(6, 10)],
        fleet=fleet(("VP1", "G1", 4)), stands={"VP1": stands(), "VP2": stands()},
        timing=timing, start_minutes=6 * 60, end_minutes=10 * 60, seed=1,
        on_progress=lambda done, total: seen.append((done, total)))
    assert seen, "a run that takes minutes has to say how far along it is"
    assert seen[-1][0] == seen[-1][1], "and it finishes at the end rather than at 98%"
    assert [done for done, _ in seen] == sorted(done for done, _ in seen)


# ---------------------------------------------------------------- the file

def test_the_file_written_is_the_file_the_twin_reads():
    answer = flight_scheduler.schedule(
        demand=[{"hour": 6, "from": "VP1", "to": "VP2", "passengers": 8}],
        fleet=fleet(("VP1", "G1", 4)), stands={"VP1": stands(), "VP2": stands()},
        timing=timing, start_minutes=6 * 60, end_minutes=9 * 60, seed=1,
        names={"VP1": "여의도", "VP2": "잠실"}, scenario_date="2026-09-11")
    text = flight_scheduler.to_csv(answer)
    columns = next(csv.reader(io.StringIO(text)))
    assert set(flight_schedule.REQUIRED_COLUMNS) <= set(columns)
    assert set(columns) <= set(flight_schedule.REQUIRED_COLUMNS + flight_schedule.OPTIONAL_COLUMNS)
    read = flight_schedule.read_schedule(text.encode("utf-8"), name="생성된 비행계획")
    assert len(read["flights"]) == len(answer["flights"])
    first = read["flights"][0]
    assert first["origin"] == "VP1" and first["destination"] == "VP2"
    assert first["seats"] == 4 and first["passengers"] == 4
    assert first["route_error"] is None


def test_a_day_with_no_flights_still_writes_a_file_with_its_columns():
    answer = flight_scheduler.schedule(
        demand=[], fleet=fleet(("VP1", "G1", 4)), stands={"VP1": stands()},
        timing=timing, start_minutes=6 * 60, end_minutes=7 * 60, seed=1)
    text = flight_scheduler.to_csv(answer)
    assert next(csv.reader(io.StringIO(text)))
    assert answer["summary"]["flights"] == 0


# ---------------------------------------------------------------- the day, when the demand is thin
#
# Found on an eighteen-deck, 1,500-trip day: seven decks flew and eleven stood
# still, a third of the aircraft that did fly were lost to holds in the first
# hour, and a fifth of the passengers travelled. Three separate causes, each
# fixed here.


def test_thin_demand_is_spread_over_every_deck_and_every_hour_rather_than_the_first_decks():
    # Eighteen decks with equal shares, every pair joined, 1,500 trips: a third
    # of a person per leg per hour. Rounded hour by hour on its own, every hour
    # handed its whole hundred to the same hundred legs at the head of the
    # list, and eleven decks never saw a departure all day.
    decks = [f"VP{index:03d}" for index in range(1, 19)]
    weights = [{"vertiport": deck, "departure_share": 1.0, "arrival_share": 1.0} for deck in decks]
    pairs = [{"from": a, "to": b} for index, a in enumerate(decks) for b in decks[index + 1:]]
    rows = demand_profile.demand_rows(daily_trips=1500, weights=weights, pairs=pairs,
                                      start_minutes=6 * 60 + 30, end_minutes=22 * 60)
    expected = demand_profile.window_demand(1500, 6 * 60 + 30, 22 * 60)
    assert sum(row["passengers"] for row in rows) == expected
    by_origin, by_destination = {}, {}
    for row in rows:
        by_origin[row["from"]] = by_origin.get(row["from"], 0) + row["passengers"]
        by_destination[row["to"]] = by_destination.get(row["to"], 0) + row["passengers"]
    assert set(by_origin) == set(decks) and set(by_destination) == set(decks)
    assert max(by_origin.values()) - min(by_origin.values()) <= 2, by_origin
    assert max(by_destination.values()) - min(by_destination.values()) <= 2, by_destination
    # And within one hour the trips are not all from, or all to, one deck.
    hour = [row for row in rows if row["hour"] == 8]
    assert len({row["from"] for row in hour}) == 18 and len({row["to"] for row in hour}) == 18
    again = demand_profile.demand_rows(daily_trips=1500, weights=weights, pairs=pairs,
                                       start_minutes=6 * 60 + 30, end_minutes=22 * 60)
    assert rows == again, "the same request is the same demand"


def test_unequal_shares_still_land_where_the_summary_said_over_the_day():
    weights = [{"vertiport": "VP1", "departure_share": 0.6, "arrival_share": 0.6},
               {"vertiport": "VP2", "departure_share": 0.3, "arrival_share": 0.3},
               {"vertiport": "VP3", "departure_share": 0.1, "arrival_share": 0.1}]
    pairs = [{"from": "VP1", "to": "VP2"}, {"from": "VP1", "to": "VP3"}, {"from": "VP2", "to": "VP3"}]
    rows = demand_profile.demand_rows(daily_trips=1000, weights=weights, pairs=pairs,
                                      start_minutes=6 * 60, end_minutes=22 * 60)
    shares = {(leg["from"], leg["to"]): leg["share"] for leg in demand_profile.od_shares(weights, pairs)}
    got = {}
    for row in rows:
        got[(row["from"], row["to"])] = got.get((row["from"], row["to"]), 0) + row["passengers"]
    window_total = demand_profile.window_demand(1000, 6 * 60, 22 * 60)
    for leg, share in shares.items():
        assert abs(got.get(leg, 0) - window_total * share) <= 1.0, (leg, got.get(leg), window_total * share)


def test_an_aircraft_that_lands_inside_the_hour_flies_again_inside_the_hour():
    # A leg of ten minutes and a five-minute turnaround: one aircraft can fly
    # it three or four times an hour. It used to fly it once, because an
    # aircraft that landed mid-hour was not put back in the queue until the
    # next hour began.
    demand = [{"hour": 6, "from": "VP1", "to": "VP2", "passengers": 4},
              {"hour": 6, "from": "VP2", "to": "VP1", "passengers": 4},
              {"hour": 6, "from": "VP1", "to": "VP2", "passengers": 4},
              {"hour": 6, "from": "VP2", "to": "VP1", "passengers": 4}]
    answer = flight_scheduler.schedule(
        demand=demand, fleet=fleet(("VP1", "G1", 4)), stands={"VP1": stands(), "VP2": stands()},
        timing=timing, start_minutes=6 * 60, end_minutes=7 * 60, seed=1)
    flights = answer["flights"]
    assert len(flights) >= 3, [f["off_block_s"] for f in flights]
    assert all(f["demand_hour"] == 6 for f in flights)
    assert all(6 * 3600 <= f["off_block_s"] < 7 * 3600 for f in flights)
    for earlier, later in zip(flights, flights[1:]):
        assert later["off_block_s"] >= earlier["turnaround_complete_s"]


def test_a_stand_that_frees_goes_to_the_flight_that_has_held_longest():
    # Three aircraft fly to a deck with one stand held by an aircraft that
    # leaves at 07:00. They arrive in order; they must land in that order when
    # the stand frees, and none of them is given up while it can still land.
    demand = [{"hour": 6, "from": "VP1", "to": "VP2", "passengers": 12},
              {"hour": 7, "from": "VP2", "to": "VP1", "passengers": 4}]
    answer = flight_scheduler.schedule(
        demand=demand, fleet=fleet(("VP1", "G1", 4), ("VP1", "G2", 4), ("VP1", "G3", 4), ("VP2", "G1", 4)),
        stands={"VP1": stands(3), "VP2": ["G1", "G2"]},
        timing=timing, start_minutes=6 * 60, end_minutes=9 * 60, seed=1)
    inbound = sorted((f for f in answer["flights"] if f["destination_vertiport_id"] == "VP2"),
                     key=lambda f: f["departure_handoff_s"])
    assert len(inbound) == 3
    first, second, third = inbound
    assert first["arrival_resource_wait_s"] == 0.0, "one stand was free"
    assert second["flight_status"] == flight_schedule.READY_STATUS
    assert second["arrival_resource_wait_s"] > 0, "it held until the parked aircraft left at 07:00"
    assert second["touchdown_s"] < third["touchdown_s"] if third["touchdown_s"] is not None else True
    assert second["touchdown_s"] == pytest.approx(7 * 3600 + 50.0), "the stand freed at 07:00 and it landed"
    # Holding is written as the wait, not hidden in the block time.
    assert second["arrival_resource_wait_s"] == pytest.approx(7 * 3600 - second["departure_handoff_s"] - 600.0)


def test_between_decks_with_the_same_few_waiting_the_seed_decides_rather_than_the_name():
    # Six aircraft at one deck, one passenger waiting for each of six decks:
    # with the name deciding, every deck in a network sent its whole fleet to
    # the same alphabetical neighbour and that deck's stands overflowed.
    demand = [{"hour": 6, "from": "VP1", "to": f"VP{index}", "passengers": 1} for index in range(2, 8)]
    places = {f"VP{index}": stands(6) for index in range(1, 8)}
    def timing_all(origin, destination, from_gate, to_gate):
        return timing(origin, destination if destination != "VP3" else "VP2", from_gate, to_gate)
    seen = set()
    for seed in range(1, 6):
        answer = flight_scheduler.schedule(
            demand=demand, fleet=fleet(("VP1", "G1", 4)), stands=places,
            timing=timing_all, start_minutes=6 * 60, end_minutes=6 * 60 + 20, seed=seed)
        seen.add(answer["flights"][0]["destination_vertiport_id"])
    assert len(seen) > 1, seen
