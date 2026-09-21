"""Gate placement, incremental pilot observations and source-route contracts."""
import math
import pytest
from communication.python.native_pilot import NativePilotLibrary
from digital_twin.model_library import flight_plan, flight_schedule, scheduled_route
from digital_twin.simulation.scenario_engine import ScenarioEngine
from user_application.uam_mission.scenario_pilots import ScenarioPilots
from project_support.tests.web_live.test_scenario_engine import (
    VERTIPORTS, NETWORK, engine_of, row, schedule_of, vertiport)


def test_actual_rotated_gate_centres_and_duplicate_assignment_are_used():
    place = vertiport("VP1", "출발", 37.525, 126.92, heading_deg=55)
    engine = engine_of(row("F1", "A1", "VP1", "VP2", "06:30:00"),
                       row("F2", "A2", "VP1", "VP2", "06:30:10"),
                       vertiports=[place, VERTIPORTS[1]])
    a, b = engine.aircraft.values()
    assert (a.stand, b.stand) == ("G1", "G2")
    assert engine.initial_state["reassigned"] == ["A2"]
    for aircraft in (a, b):
        gate = next(g for g in place["layout"]["gates"] if g["id"] == aircraft.stand)
        expected = flight_plan._local_to_global(place["layout"]["frame"], *gate["center_m"])
        assert (aircraft.latitude, aircraft.longitude) == expected
    assert flight_plan.haversine_m((a.latitude, a.longitude), (b.latitude, b.longitude)) > 10
    assert engine.psu._stands.occupant("VP1", "G2") == "A2"
    engine.advance(engine.time_s + 20)
    assert b.route.departure["gate"] == "G2"


def test_overflow_never_creates_nonexistent_gates():
    rows = [row(f"F{i}", f"A{i}", "VP1", "VP2", "06:30:00") for i in range(5)]
    with pytest.raises(ValueError, match="실제 Gate"):
        engine_of(*rows)


def test_deck_elevation_is_ground_plus_platform_and_manual_is_not_resampled():
    engine = engine_of(row("F1", "A1", "VP1", "VP2", "06:30:00"), elevation=lambda lon, lat: (90, 1))
    assert engine.aircraft["A1"].altitude == 110
    place = vertiport("VP1", "수동", 37.525, 126.92, altitude_m=400, ground_reference="manual")
    engine = engine_of(row("F1", "A1", "VP1", "VP2", "06:30:00"),
                       vertiports=[place, VERTIPORTS[1]], elevation=lambda lon, lat: 90)
    assert engine.aircraft["A1"].altitude == 420


def test_supplied_route_order_is_exact_and_missing_points_are_not_direct_fallback():
    names = [NETWORK["fatos"][0]["name"], "영등포", "신림동",
             next(f["name"] for f in NETWORK["fatos"] if f["id"] == "fato:VP2:F2")]
    route = scheduled_route.resolve(NETWORK, names, "fato:VP1:F1", "fato:VP2:F2")
    assert route["nodes"] == ["fato:VP1:F1", "WP1", "WP2", "fato:VP2:F2"]
    assert [l["segment"] for l in route["links"]] == ["C", "F", "G"]
    with pytest.raises(ValueError, match="지도에 없습니다"):
        scheduled_route.resolve(NETWORK, [names[0], "unknown", names[-1]], "fato:VP1:F1", "fato:VP2:F2")
    temporary = scheduled_route.resolve(NETWORK, [names[0], names[1], "지점 20", names[2], names[-1]],
                                        "fato:VP1:F1", "fato:VP2:F2", ("지점 20",))
    assert temporary["provisional_waypoints"] == ["지점 20"]
    assert len(NETWORK["nodes"]) == 2, "the shared network is not rewritten"


def test_opposing_cruise_tracks_shift_right_and_merge_at_unchanged_endpoints():
    northbound = [(37, 127, 300), (37.02, 127, 300)]
    forward = scheduled_route.right_cruise(northbound)
    reverse = scheduled_route.right_cruise(list(reversed(northbound)))
    assert forward[0] == northbound[0] and forward[-1] == northbound[-1]
    assert all(p[1] > 127 for p in forward[1:-1]), "northbound is east of centreline"
    assert all(p[1] < 127 for p in reverse[1:-1]), "southbound is west of centreline"
    assert all(p[2] == 300 for p in forward+reverse)
    assert len(forward) == 4


@pytest.fixture
def library():
    try:
        return NativePilotLibrary()
    except (OSError, RuntimeError):
        pytest.skip("Build aerodt_uam_pilot for native integration tests")


def test_each_native_pilot_has_independent_state_and_external_hold_does_not_skip_waypoints(library):
    points = [(0, 0, -30, 2, 0, 8), (400, 0, -80, 20, 1, 8),
              (800, 0, -80, 20, 1, 8), (800, 0, -30, 8, 0, 8), (800, 0, 0, 2, 0, 8)]
    a, b = library.create(points, 0, 0), library.create(points, 180, 0)
    try:
        original = b.advance(0)
        for _ in range(40):
            before = a.advance(1)
        assert before[0] == pytest.approx(40)
        assert before[3] < -25 and before[15] > 100
        assert b.advance(0) == original
        fix, index = before[1:4], before[14]
        for _ in range(120):
            held = a.advance(1, fix)
        assert held[14] == index and held[10] < 1
        assert math.dist(held[1:4], fix) < 3
        for _ in range(1200):
            final = a.advance(1)
            if final[16]:
                break
        assert final[16] and final[13] and abs(final[3]) < .01
    finally:
        a.close(); b.close(); a.close()
    with pytest.raises(RuntimeError, match="closed"):
        a.advance(1)


def test_native_flight_traverses_stages_and_does_not_use_phase_time_for_air_position(library):
    pilots = ScenarioPilots(library)
    engine = ScenarioEngine(schedule_of(row("F1", "A1", "VP1", "VP2", "06:30:00")),
                            vertiports=VERTIPORTS, network=NETWORK, pilots=pilots)
    seen, peak_tilt, attitudes = set(), 0, []
    try:
        for _ in range(4000):
            engine.advance(engine.time_s+1)
            aircraft = engine.aircraft["A1"]
            seen.add(aircraft.phase)
            peak_tilt = max(peak_tilt, aircraft.telemetry.get("tilt_deg", 0))
            attitudes.append(abs(aircraft.telemetry.get("pitch_deg", 0)))
            if aircraft.failed or aircraft.completed:
                break
        assert not engine.problems
        assert aircraft.completed == 1 and not pilots.flights
        assert {"takeoff", "climb", "cruise", "descent", "landing", "gate_in", "parked"} <= seen
        assert peak_tilt > 60 and max(attitudes) > 1
        assert engine.summary()["flight_engine"] == "native-fastphysics-simpleflight"
        assert aircraft.stand == "G2"
    finally:
        engine.close()


def test_closing_console_ends_native_simulation_and_reopening_starts_fresh(library):
    from user_application.uam_mission.scenario_session import ScenarioSession
    from project_support.tests.web_live.test_scenario_session import Clock, CSV
    clock = Clock()
    session = ScenarioSession(vertiports=lambda: VERTIPORTS, network=lambda: NETWORK,
        pilots_factory=lambda: ScenarioPilots(library), now=clock)
    session.load(CSV)
    assert not session.entities()
    session.open_control(); session.play()
    for _ in range(160):
        clock.tick(1); session.tick()
    assert session.engine.pilots.flights
    session.close_control()
    assert session.state == "finished" and not session.showing and not session.entities()
    assert not session.engine.pilots.flights
    ended = session.engine.time_s
    clock.tick(100); session.tick()
    assert session.engine.time_s == ended
    session.open_control()
    assert session.state == "ready" and session.engine.time_s == session.engine.opens_s
    session.close()


def test_parallel_native_pilots_match_serial_samples_and_release_workers(library):
    route_engine = engine_of(row("F1", "A1", "VP1", "VP2", "06:30:00"))
    route = route_engine.route(route_engine.flights["F1"])
    serial, parallel = ScenarioPilots(library, workers=1), ScenarioPilots(library, workers=4)
    try:
        for pilots in (serial, parallel):
            for i in range(8):
                pilots.start(str(i), route, i*15)
        for _ in range(40):
            a = [serial.submit(str(i), 1) for i in range(8)]
            b = [parallel.submit(str(i), 1) for i in range(8)]
            assert [f.result() for f in a] == [f.result() for f in b]
    finally:
        serial.close(); parallel.close()
    assert parallel._pool is None and not parallel.flights


def test_native_controls_do_not_catch_up_physics_and_wire_slice_is_bounded(library, monkeypatch):
    from user_application.uam_mission.scenario_session import ScenarioSession
    from project_support.tests.web_live.test_scenario_session import Clock, CSV
    clock = Clock()
    session = ScenarioSession(vertiports=lambda: VERTIPORTS, network=lambda: NETWORK,
        pilots_factory=lambda: ScenarioPilots(library), now=clock)
    session.load(CSV); session.play()
    start = session.engine.time_s
    clock.tick(20)
    session.set_speed(10)
    assert session.engine.time_s == start
    clock.tick(20)
    _, _, rate = session.advance_view()
    assert session.engine.time_s-start <= 1.201 and rate == 10
    current = session.engine.time_s
    clock.tick(50);session.pause()
    assert session.engine.time_s == current
    session.close()


def test_occupied_gate_is_not_overwritten_and_is_reconsidered_after_release():
    from digital_twin.simulation.psu_sequencing import PsuSequencer
    psu = PsuSequencer(stands=lambda _: ["G1"])
    psu.take_stand("VP1", "G1", "resident")
    c = psu.request_arrival(flight_id="arrival", vertiport="VP1", fato="F2", stand="G1", earliest_s=100, now_s=0)
    assert c.stand is None and psu._stands.occupant("VP1", "G1") == "resident"
    psu.leave_stand("VP1", "G1", "resident")
    psu.reconsider_arrival("arrival", 120)
    assert c.stand == "G1" and psu._stands.occupant("VP1", "G1") is None
    assert psu._stands.reservation("VP1", "G1") == "arrival"


def test_example_reads_workspace_file_fresh_and_reports_missing(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from user_application.apps.web_dashboard.application import create_app
    app = create_app({"workspace_directory": str(tmp_path), "cache_directory": str(tmp_path)}, sources=[])
    received = []
    def load(body, **kwargs):
        received.append(body)
        return {"loaded": True}
    monkeypatch.setattr(app.state.scenario_session, "load", load)
    source = tmp_path / "simulation/examples/fpl_all.csv"
    with TestClient(app) as client:
        assert client.post('/api/simulation/scenario/example').status_code == 422
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_bytes(b'first')
        assert client.post('/api/simulation/scenario/example').status_code == 201
        source.write_bytes(b'replacement')
        assert client.post('/api/simulation/scenario/example').status_code == 201
    assert received == [b'first', b'replacement']


def test_live_snapshot_removes_scenario_aircraft_even_if_synchronization_fails(tmp_path, monkeypatch):
    import json
    import time
    from fastapi.testclient import TestClient
    from user_application.apps.web_dashboard.application import create_app
    from digital_twin.live_twin.state_synchronization import LiveSynchronizer
    from project_support.tests.web_live.test_scenario_session import CSV
    folder = tmp_path / "simulation"
    folder.mkdir()
    (folder / "vertiports.json").write_text(json.dumps({"schema_version": 1, "vertiports": VERTIPORTS}), encoding="utf-8")
    app = create_app({"workspace_directory": str(tmp_path), "cache_directory": str(tmp_path),
                      "tick_seconds": .02, "stream_seconds": .01}, sources=[])
    with TestClient(app) as client:
        session = app.state.scenario_session
        session.load(CSV); session.open_control()
        for _ in range(100):
            snapshot = client.get('/api/live/snapshot').json()
            if any(x['source'] == 'scenario' for x in snapshot['entities']):
                break
            time.sleep(.02)
        assert any(x['source'] == 'scenario' for x in snapshot['entities'])
        def fail(*args, **kwargs):
            raise RuntimeError('deliberate synchronization failure')
        monkeypatch.setattr(LiveSynchronizer, 'synchronize', fail)
        answer = client.post('/api/simulation/scenario/control', json={'action': 'close_control'})
        assert answer.status_code == 200 and answer.json()['state'] == 'finished'
        for _ in range(100):
            snapshot = client.get('/api/live/snapshot').json()
            if all(x['source'] != 'scenario' for x in snapshot['entities']):
                break
            time.sleep(.02)
        assert all(x['source'] != 'scenario' for x in snapshot['entities'])
        assert snapshot['epoch'] >= 2
