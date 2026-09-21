"""The multi-flight setup turned into a day of flights, and handed over.

What is fixed here is the join: the request the panel builds is accepted as it
is written, the route between two decks is planned once and reused, the run says
how far along it is while it runs, and the day it produces is a file the twin
can read back and fly. A request that cannot be built is refused by the name of
the field that stopped it rather than by a stack trace.
"""
import threading
import time

import pytest

from digital_twin.model_library import flight_schedule
from digital_twin.model_library.route_network import network as build_network
from digital_twin.model_library.vertiport_layout import generate_layout, validate_definition
from user_application.uam_mission import plan_generation


def vertiport(identifier, name, latitude, longitude, gates=3):
    definition = validate_definition({"name": name, "latitude": latitude, "longitude": longitude,
                                      "heading_deg": 0, "gates": gates, "platform_height_m": 20,
                                      "fatos": [{"role": "takeoff"}, {"role": "landing"}]})
    return {**definition, "id": identifier, "layout": generate_layout(definition)}


VERTIPORTS = [vertiport("VP1", "여의도", 37.525, 126.920),
              vertiport("VP2", "봉천", 37.478, 126.941),
              vertiport("VP3", "강남", 37.498, 127.028)]
NODES = [{"id": "WP1", "name": "영등포", "latitude": 37.515, "longitude": 126.925,
          "altitude_m": 304.8, "altitude_reference": "agl"},
         {"id": "WP2", "name": "신림동", "latitude": 37.490, "longitude": 126.933,
          "altitude_m": 304.8, "altitude_reference": "agl"}]
LINKS = [{"id": "L1", "from": "fato:VP1:F1", "to": "WP1", "segment": "C", "width_m": None, "name": "출발"},
         {"id": "L2", "from": "WP1", "to": "WP2", "segment": "F", "width_m": 300.0, "name": "순항"},
         {"id": "L3", "from": "WP2", "to": "fato:VP2:F2", "segment": "G", "width_m": None, "name": "도착"}]
NETWORK = build_network(NODES, LINKS, VERTIPORTS)


def vertiports():
    return list(VERTIPORTS)


def network():
    return NETWORK


def request(**changes):
    """What `demand_setup.buildRequest` sends, cut down to three decks."""
    scope = ["VP1", "VP2", "VP3"]
    share = round(1 / len(scope), 6)
    body = {
        "version": 1, "vertiports": scope,
        "pairs": [{"from": "VP1", "to": "VP2"}, {"from": "VP1", "to": "VP3"},
                  {"from": "VP2", "to": "VP3"}],
        "demand": {"mode": "direct", "daily_trips": 400,
                   "distribution": {"basis": "weight_pct", "vertiports": [
                       {"vertiport": identifier, "departure_share": share, "arrival_share": share}
                       for identifier in scope]}},
        "operating": {"start": "07:00", "end": "10:00", "minutes": 180},
        "seed": {"mode": "fixed", "value": 42},
        "fleet": [{"vertiport": identifier, "gates": 3, "aircraft": 2, "seats": 8,
                   "aircraft_by_class": {"seat4": 1, "seat6": 1, "seat8": 0}}
                  for identifier in scope],
        "scenario_date": "2026-09-11",
    }
    body.update(changes)
    return body


# ---------------------------------------------------------------- the request

def test_the_request_the_panel_builds_is_accepted_as_it_is_written():
    asked = plan_generation.validate_request(request())
    assert asked["daily_trips"] == 400
    assert asked["start_minutes"] == 7 * 60 and asked["end_minutes"] == 10 * 60
    assert asked["seed"] == 42
    assert len(asked["weights"]) == 3 and len(asked["pairs"]) == 3


@pytest.mark.parametrize("changes, field", [
    ({"vertiports": ["VP1"]}, "vertiports"),
    ({"pairs": []}, "pairs"),
    ({"demand": {"daily_trips": 0, "distribution": {"vertiports": [{"vertiport": "VP1"}]}}},
     "demand.daily_trips"),
    ({"operating": {"start": "0700", "end": "10:00"}}, "operating.start"),
    ({"operating": {"start": "07:00", "end": "07:00"}}, "operating.end"),
    ({"seed": {"mode": "fixed", "value": 0}}, "seed.value"),
    ({"fleet": []}, "fleet"),
])
def test_a_request_that_cannot_be_built_names_the_field_that_stopped_it(changes, field):
    with pytest.raises(plan_generation.GenerationError) as raised:
        plan_generation.validate_request(request(**changes))
    assert raised.value.field == field
    assert str(raised.value)


def test_a_drawn_seed_is_reported_so_the_run_can_be_repeated():
    asked = plan_generation.validate_request(request(seed={"mode": "random", "value": None}))
    assert isinstance(asked["seed"], int) and asked["seed"] >= 1


def test_the_decks_hold_the_aircraft_they_have_stands_for():
    stands = {"VP1": ["G1", "G2"], "VP2": ["G1"]}
    rows = plan_generation._fleet_rows(
        {"fleet": [{"vertiport": "VP1", "aircraft_by_class": {"seat4": 1, "seat6": 1, "seat8": 1}},
                   {"vertiport": "VP2", "aircraft_by_class": {"seat4": 2}}]}, stands)
    assert [row["vertiport"] for row in rows] == ["VP1", "VP1", "VP2"], "a third aircraft has no stand"
    assert [row["seats"] for row in rows] == [4, 6, 4], "the smallest cabins take the first stands"
    assert [row["stand"] for row in rows] == ["G1", "G2", "G1"]
    assert len({row["aircraft_id"] for row in rows}) == 3


# ---------------------------------------------------------------- the run

def test_a_day_is_built_and_reads_back_as_the_day_the_twin_will_fly():
    seen = []
    built = plan_generation.generate(plan_generation.validate_request(request()),
                                     vertiports=vertiports, network=network,
                                     on_progress=lambda percent, phase, message: seen.append((percent, phase)))
    summary = built["summary"]
    assert summary["flights"] > 0, "three decks, six aircraft and 400 trips is a day"
    assert summary["demand_passengers"] == 400
    assert summary["carried_passengers"] + summary["unserved_passengers"] <= 400 + summary["flights"]
    assert summary["routed_pairs"] + summary["blocked_pairs"] == 6, "both directions of three pairs"
    assert summary["direct_pairs"] == 0, "missing routes must not become invented corridors"
    assert summary["blocked_pairs"] == 5, "this fixture has only one departure/arrival pair"
    read = flight_schedule.read_schedule(built["csv"].encode("utf-8"), vertiports=VERTIPORTS,
                                         name="생성된 비행계획")
    assert len(read["flights"]) == summary["flights"]
    assert {flight["origin"] for flight in read["flights"]} <= {"VP1", "VP2", "VP3"}
    assert all(flight["seats"] in (4, 6) for flight in read["flights"])
    assert all(flight["off_block_s"] >= 7 * 3600 for flight in read["flights"])
    assert all(flight["route_path"] == ["fato:VP1:F1", "WP1", "WP2", "fato:VP2:F2"]
               for flight in read["flights"]), "the generated CSV carries every planned waypoint"


def test_no_connected_pairs_fails_before_dispatch_or_applying_a_day():
    empty = build_network(NODES, [], VERTIPORTS)
    with pytest.raises(plan_generation.GenerationError, match="직항으로 대체하지 않습니다") as raised:
        plan_generation.generate(plan_generation.validate_request(request()),
                                 vertiports=vertiports, network=lambda: empty)
    assert raised.value.field == "pairs"


def test_reverse_cruise_is_scheduled_and_keeps_its_traversal_in_the_csv():
    from digital_twin.simulation.scenario_engine import ScenarioEngine
    reverse_links = [*LINKS,
        {"id": "L4", "from": "fato:VP2:F1", "to": "WP2", "segment": "C"},
        {"id": "L5", "from": "WP1", "to": "fato:VP1:F2", "segment": "G"}]
    net = build_network(NODES, reverse_links, VERTIPORTS)
    built = plan_generation.generate(plan_generation.validate_request(request()),
                                     vertiports=vertiports, network=lambda: net)
    read = flight_schedule.read_schedule(built["csv"], vertiports=VERTIPORTS)
    reverse = [f for f in read["flights"] if f["origin"] == "VP2"]
    assert reverse
    expected = ["fato:VP2:F1", "WP2", "WP1", "fato:VP1:F2"]
    assert all(f["route_path"] == expected for f in reverse)
    engine = ScenarioEngine(read, vertiports=VERTIPORTS, network=net)
    route = engine.route(reverse[0])
    carried = []
    for phase in route.phases:
        for waypoint in phase.detail.get("supplied_waypoints", ()):
            if not carried or carried[-1] != waypoint:
                carried.append(waypoint)
    assert carried == expected
    assert not route.direct


def test_the_run_says_how_far_along_it_is_and_ends_at_a_hundred():
    seen = []
    plan_generation.generate(plan_generation.validate_request(request()),
                             vertiports=vertiports, network=network,
                             on_progress=lambda percent, phase, message: seen.append((percent, phase, message)))
    percents = [percent for percent, _, _ in seen]
    assert percents == sorted(percents), "a bar that goes backwards is worse than no bar"
    assert percents[-1] == 100
    assert [phase for _, phase, _ in seen][:1] == ["demand"]
    assert {phase for _, phase, _ in seen} == {"demand", "routes", "dispatch", "file"}
    assert all(message.strip() for _, _, message in seen), "every step says what it is doing"
    assert any("항로" in message for _, _, message in seen)


def test_the_same_seed_builds_the_same_day():
    first = plan_generation.generate(plan_generation.validate_request(request()),
                                     vertiports=vertiports, network=network)
    again = plan_generation.generate(plan_generation.validate_request(request()),
                                     vertiports=vertiports, network=network)
    assert first["csv"] == again["csv"]


def test_a_deck_the_twin_does_not_have_is_refused_by_name():
    asked = plan_generation.validate_request(request(vertiports=["VP8", "VP9"],
                                                     pairs=[{"from": "VP8", "to": "VP9"}]))
    with pytest.raises(plan_generation.GenerationError) as raised:
        plan_generation.generate(asked, vertiports=vertiports, network=network)
    assert raised.value.field == "vertiports"


# ---------------------------------------------------------------- the job

def test_apply_preparation_never_reports_completion_and_measures_current_stage():
    entered, release = threading.Event(), threading.Event()
    now = [10.0]
    def apply(text, summary, *, on_progress):
        on_progress('forecast', 3, 10)
        entered.set()
        release.wait(5)
        return {'ready': True}
    generator = plan_generation.PlanGenerator(vertiports=vertiports, network=network,
        apply=apply, clock=lambda:now[0])
    generator.start(request())
    try:
        assert entered.wait(5)
        now[0] = 17.0
        state = generator.status()
        assert state['state']=='running' and state['percent'] < 100
        assert state['phase']=='forecast' and '3/10' in state['message']
        assert state['phase_elapsed_s']==7
    finally:release.set()
    state=finished(generator)
    assert state['percent']==100 and state['applied']['ready']
    assert state['phase_seconds']['forecast']==7
    now[0]=40
    assert generator.status()['elapsed_s']==state['elapsed_s']

def finished(generator, timeout=60.0):
    limit = time.monotonic() + timeout
    while time.monotonic() < limit:
        state = generator.status()
        if state["state"] in ("done", "error"):
            return state
        time.sleep(0.02)
    raise AssertionError(f"the run never finished: {generator.status()}")


def test_the_job_runs_on_its_own_and_hands_the_finished_day_over():
    applied = []
    generator = plan_generation.PlanGenerator(
        vertiports=vertiports, network=network,
        apply=lambda text, summary: applied.append((text, summary)) or {"flights": summary["flights"]})
    started = generator.start(request())
    assert started["state"] in ("running", "done"), "a small connected network may finish before start returns"
    state = finished(generator)
    assert state["state"] == "done", state.get("error")
    assert state["percent"] == 100
    assert state["applied"]["flights"] == state["summary"]["flights"]
    assert len(applied) == 1 and applied[0][0].startswith("scenario_id,")
    assert generator.csv() == applied[0][0]


def test_a_second_run_while_one_is_going_is_refused_rather_than_racing_it():
    gate = threading.Event()
    generator = plan_generation.PlanGenerator(
        vertiports=vertiports, network=network, apply=lambda text, summary: gate.wait(5) or None)
    generator.start(request())
    for _ in range(200):
        if generator.running:
            break
        time.sleep(0.01)
    with pytest.raises(plan_generation.GenerationError) as raised:
        generator.start(request())
    assert raised.value.field == "state"
    gate.set()
    finished(generator)


def test_a_run_that_fails_says_so_rather_than_staying_at_ninety_nine():
    def explode(_text, _summary):
        raise RuntimeError("계획을 실을 수 없습니다")
    generator = plan_generation.PlanGenerator(vertiports=vertiports, network=network, apply=explode)
    generator.start(request())
    state = finished(generator)
    assert state["state"] == "error"
    assert "계획을 실을 수 없습니다" in state["error"]
    assert state["summary"], "what was built is still reported, so the failure can be read"


# ---------------------------------------------------------------- the wire

def client():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from communication.web.plan_generation_routes import create_plan_generation_router
    generator = plan_generation.PlanGenerator(vertiports=vertiports, network=network)
    app = FastAPI()
    app.include_router(create_plan_generation_router(generator))
    return TestClient(app), generator


def test_the_wire_starts_a_run_reports_it_and_hands_the_file_over():
    http, generator = client()
    assert http.get("/api/simulation/plans/multi/status").json()["state"] == "idle"
    assert http.get("/api/simulation/plans/multi/file").status_code == 404
    started = http.post("/api/simulation/plans/multi", json=request())
    assert started.status_code == 202
    assert started.json()["state"] in ("running", "done")
    state = finished(generator)
    assert state["state"] == "done", state.get("error")
    reported = http.get("/api/simulation/plans/multi/status").json()
    assert reported["percent"] == 100 and reported["summary"]["flights"] == state["summary"]["flights"]
    assert http.get("/api/simulation/plans/multi/status").headers["cache-control"] == "no-store"
    file = http.get("/api/simulation/plans/multi/file")
    assert file.status_code == 200
    assert file.text.startswith("scenario_id,")
    assert "attachment" in file.headers["content-disposition"]


def test_the_wire_refuses_a_bad_request_by_field_and_a_second_run_as_busy():
    http, generator = client()
    answer = http.post("/api/simulation/plans/multi", json=request(pairs=[]))
    assert answer.status_code == 422
    assert answer.json()["field"] == "pairs"
    http.post("/api/simulation/plans/multi", json=request())
    busy = http.post("/api/simulation/plans/multi", json=request())
    assert busy.status_code in (202, 409)
    if busy.status_code == 409:
        assert busy.json()["error"] == "busy"
    finished(generator)


def test_preparation_type_error_is_not_retried_and_error_timing_freezes():
    now, calls = [1.0], []
    def apply(text, summary, *, on_progress):
        calls.append(text)
        on_progress('forecast', 0, 1)
        now[0] = 4.0
        raise TypeError('preparation failed')
    generator = plan_generation.PlanGenerator(vertiports=vertiports, network=network,
        apply=apply, clock=lambda: now[0])
    generator.start(request())
    state = finished(generator)
    assert state['state'] == 'error' and state['percent'] < 100
    assert len(calls) == 1 and state['phase_seconds']['forecast'] == 3
    now[0] = 20.0
    assert generator.status()['elapsed_s'] == 3
    state['phase_seconds']['forecast'] = 99
    assert generator.status()['phase_seconds']['forecast'] == 3


def test_a_deck_of_shared_pads_wired_one_way_each_still_receives_flights():
    """Two 'both' pads, the network leaving from F1 and arriving at F2: the day
    generator must route into the deck by F2 instead of asking for F1 and
    reporting the deck as not joined - which made such a deck departures-only."""
    definition = validate_definition({"name": "천호", "latitude": 37.540, "longitude": 127.120, "heading_deg": 0,
                                      "gates": 3, "platform_height_m": 20,
                                      "fatos": [{"role": "both"}, {"role": "both"}]})
    shared = {**definition, "id": "VP4", "layout": generate_layout(definition)}
    ports = [*VERTIPORTS, shared]
    links = [*LINKS,
             {"id": "L4", "from": "WP2", "to": "fato:VP4:F2", "segment": "G", "width_m": None, "name": "천호 도착"},
             {"id": "L5", "from": "fato:VP4:F1", "to": "WP2", "segment": "C", "width_m": None, "name": "천호 출발"},
             {"id": "L6", "from": "WP1", "to": "fato:VP1:F2", "segment": "G", "width_m": None, "name": "여의도 도착"}]
    net = build_network(NODES, links, ports)
    timings, notes, blocked = plan_generation.build_timings([{"from": "VP1", "to": "VP4"}], ports, net, None)
    assert not blocked, notes
    assert timings[("VP1", "VP4")]["to_fato"] == "F2"
    assert timings[("VP4", "VP1")]["from_fato"] == "F1"


def test_status_lists_every_stage_with_its_state_time_and_count():
    """The whole process, not one bar: what is done, what runs, how long."""
    from user_application.uam_mission.plan_generation import PlanGenerator, STAGES
    clock = [100.0]
    generator = PlanGenerator(vertiports=lambda: [], network=lambda: {}, clock=lambda: clock[0])
    generator._state = {"state": "running", "percent": 0, "phase": "demand", "message": "", "summary": None,
                        "error": "", "field": "", "applied": None, "started_at": 100.0}
    generator._phase_started = 100.0
    generator._phase_seconds = {}
    clock[0] = 102.0
    generator._set_progress(10, "routes", "항로를 계산하는 중입니다 · 24/306")
    clock[0] = 105.0
    stages = generator.status()["stages"]
    assert [s["id"] for s in stages] == [name for name, _ in STAGES]
    by_id = {s["id"]: s for s in stages}
    assert by_id["demand"]["state"] == "done" and by_id["demand"]["seconds"] == 2.0
    assert by_id["routes"]["state"] == "running" and by_id["routes"]["seconds"] == 3.0
    assert by_id["routes"]["count"] == {"done": 24, "total": 306}, 'the numbers in the sentence, as numbers'
    assert by_id["dispatch"]["state"] == "pending" and by_id["dispatch"]["seconds"] is None
    assert by_id["publish"]["state"] == "pending"
    # A new stage forgets the old count until it says one of its own.
    generator._set_progress(80, "forecast", "기체 예측 준비를 처리하는 중입니다")
    assert "count" not in {s["id"]: s for s in generator.status()["stages"]}["forecast"]
    generator._set_progress(85, "forecast", "기체 예측 준비를 처리하는 중입니다 · 31/100대")
    assert {s["id"]: s for s in generator.status()["stages"]}["forecast"]["count"] == {"done": 31, "total": 100}
    # Finished: every stage is done, including the ones that took no time.
    generator._state.update(state="done", finished_at=clock[0], phase="done", percent=100)
    assert all(s["state"] == "done" for s in generator.status()["stages"])
    # Failed: the stage it failed in says so, the rest wait.
    generator._state.update(state="error", phase="forecast")
    states = {s["id"]: s["state"] for s in generator.status()["stages"]}
    assert states["forecast"] == "error" and states["publish"] == "pending" and states["routes"] == "done"
