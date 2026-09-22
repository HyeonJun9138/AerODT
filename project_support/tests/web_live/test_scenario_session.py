"""Driving a scheduled day, and handing the twin over to it.

The session owns the clock and nothing else: how scenario time relates to wall
time, what a speed change does to time already flown, and when the day is being
written down. These tests hold it to that, and hold the wire to serving it.
"""
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from communication.web.scenario_routes import create_scenario_router
from digital_twin.model_library.route_network import network as build_network
from digital_twin.model_library.vertiport_layout import generate_layout, validate_definition
from user_application.uam_mission import scenario_session as session_module
from user_application.uam_mission.scenario_session import ScenarioSession, epoch_of


def vertiport(identifier, name, latitude, longitude, **changes):
    definition = validate_definition({"name": name, "latitude": latitude, "longitude": longitude,
                                      "heading_deg": 0, "gates": 4, "platform_height_m": 20,
                                      "fatos": [{"role": "takeoff"}, {"role": "landing"}], **changes})
    return {**definition, "id": identifier, "layout": generate_layout(definition)}


VERTIPORTS = [vertiport("VP1", "여의도", 37.525, 126.920), vertiport("VP2", "봉천", 37.478, 126.941)]
NODES = [{"id": "WP1", "name": "영등포", "latitude": 37.515, "longitude": 126.925, "altitude_m": 304.8,
          "altitude_reference": "agl"}]
LINKS = [{"id": "L1", "from": "fato:VP1:F1", "to": "WP1", "segment": "C", "width_m": None, "name": "출발"},
         {"id": "L2", "from": "WP1", "to": "fato:VP2:F2", "segment": "G", "width_m": None, "name": "도착"}]
NETWORK = build_network(NODES, LINKS, VERTIPORTS)

CSV = ("flight_plan_id,aircraft_id,seat_capacity,passenger_count,origin_vertiport_id,"
       "destination_vertiport_id,departure_stand_id,departure_fato_id,arrival_stand_id,"
       "arrival_fato_id,off_block_time,touchdown_time,flight_status,scenario_date\n"
       "F1,A1,4,2,VP1,VP2,G1,F1,G2,F2,06:31:00,06:45:00,ready,2026-10-10\n"
       "F2,A2,8,6,VP1,VP2,G2,F1,G3,F2,06:31:30,06:46:00,ready,2026-10-10\n"
       "F3,A1,4,3,VP2,VP1,G2,F1,G1,F2,07:20:00,07:35:00,ready,2026-10-10\n")


class Clock:
    """A wall clock the test moves by hand."""

    def __init__(self, start=1000.0):
        self.now = start

    def __call__(self):
        return self.now

    def tick(self, seconds):
        self.now += seconds
        return self.now


def make(directory=None, clock=None):
    clock = clock or Clock()
    session = ScenarioSession(vertiports=lambda: VERTIPORTS, network=lambda: NETWORK,
                              directory=directory, now=clock)
    return session, clock


def test_stop_close_clear_writes_daily_analysis_only_once(tmp_path, monkeypatch):
    from data.simulation import operations_records
    writes = []
    original = operations_records.write_operations
    def write(directory, source):
        writes.append(source)
        return original(directory, source)
    monkeypatch.setattr(operations_records, 'write_operations', write)
    session, clock = make(tmp_path)
    session.load(CSV)
    session.play()
    clock.tick(65)
    session.tick()
    session.stop()
    session.close_control()
    session.clear()
    assert len(writes) == 1


def test_failed_final_save_is_retried_on_stop(tmp_path, monkeypatch):
    from data.simulation import operations_records
    original = operations_records.write_operations
    session, _ = make(tmp_path)
    session.load(CSV)
    def fail(*args):
        raise OSError('disk unavailable')
    monkeypatch.setattr(operations_records, 'write_operations', fail)
    with pytest.raises(OSError):
        session.stop()
    assert not session.recorder.finalized
    monkeypatch.setattr(operations_records, 'write_operations', original)
    session.stop()
    assert session.recorder.finalized
    session.clear()


def test_analysis_cache_key_ignores_clock_but_changes_after_reset():
    session, clock = make()
    session.load(CSV)
    session.play()
    original = session.analysis_cache_key()
    clock.tick(6)
    session.tick()
    assert session.analysis_cache_key() == original
    session.reset()
    session.play()
    assert session.analysis_cache_key() != original


def test_loading_a_day_answers_what_it_contains_and_where_it_starts():
    session, _ = make()
    assert session.description() == {"schema_version": 1, "state": "idle", "loaded": False,
                                     "speeds": list(session_module.SPEEDS)}
    described = session.load(CSV, name="FPL.csv")
    assert described["state"] == "ready" and described["loaded"] is True
    assert described["name"] == "FPL.csv"
    assert described["schedule"]["flights"] == 3 and described["schedule"]["aircraft"] == 2
    assert described["speeds"] == [1, 2, 4, 6, 8, 10]
    placements = described["initial_state"]["placements"]
    assert {item["aircraft_id"] for item in placements} == {"A1", "A2"}
    assert described["initial_state"]["opens"] == "06:30:00" or \
           described["initial_state"]["opens"] == "06:31:00"
    # The display draws each cabin's own asset at the size the visual library
    # gives it; the schedule names the asset and decides nothing about its size.
    assert described["schedule"]["visual_policy"] == "single_flight_asset"


def test_planned_closing_time_does_not_freeze_unfinished_aircraft():
    session, clock = make()
    session.load(CSV)
    session.engine.closes_s = session.engine.time_s + 1
    session.play()
    clock.tick(2)
    session.tick()
    assert session.status()["state"] == "playing"
    for aircraft in session.engine.aircraft.values():
        aircraft.flight = None
        aircraft.next_flight = len(aircraft.flights)
    clock.tick(1)
    session.tick()
    assert session.status()["state"] == "finished"


def test_the_twin_is_not_handed_over_until_the_console_is_opened():
    session, _ = make()
    session.load(CSV)
    assert session.entities() == () and session.epoch_time() is None
    session.open_control()
    # Opening moves the twin to the scheduled morning, with the fleet on stands.
    assert session.epoch_time() == epoch_of("2026-10-10", session.engine.time_s)
    entities = session.entities()
    assert len(entities) == 2
    assert {entity.kind for entity in entities} == {"uam"}
    assert {entity.source for entity in entities} == {"scenario"}
    assert {entity.provenance for entity in entities} == {"simulation"}
    assert all(entity.entity_id.startswith("scenario:") for entity in entities)
    # Two cabins, two airframes, so the map can tell them apart.
    assert len({entity.visual_asset_id for entity in entities}) == 2
    # Closing gives the twin back to the live clock without losing the day.
    session.close_control()
    assert session.entities() == () and session.epoch_time() is None
    assert session.status()["loaded"] is True


def test_the_day_advances_with_the_wall_clock_times_the_speed():
    session, clock = make()
    session.load(CSV)
    session.open_control()
    opened = session.engine.time_s
    session.play()
    clock.tick(10)
    session.tick()
    assert session.engine.time_s == pytest.approx(opened + 10, abs=1)
    session.set_speed(6)
    clock.tick(10)
    session.tick()
    assert session.engine.time_s == pytest.approx(opened + 70, abs=2), "sixty seconds of day in ten of ours"
    # Pausing stops the clock, and time passing while paused is not owed.
    session.pause()
    paused = session.engine.time_s
    clock.tick(600)
    session.tick()
    assert session.engine.time_s == paused
    session.play()
    clock.tick(5)
    session.tick()
    assert session.engine.time_s == pytest.approx(paused + 30, abs=2)


def test_a_speed_change_does_not_re_fly_the_time_already_flown():
    """The anchor moves with the speed. Without that, changing to ten times
    would multiply everything since the last anchor and the day would jump."""
    session, clock = make()
    session.load(CSV)
    session.open_control()
    session.play()
    clock.tick(20)
    session.tick()
    before = session.engine.time_s
    session.set_speed(10)
    assert session.engine.time_s == pytest.approx(before, abs=1), "changing speed is not a jump"
    clock.tick(1)
    session.tick()
    assert session.engine.time_s == pytest.approx(before + 10, abs=1)


def test_a_long_gap_is_walked_rather_than_sprinted():
    """A tab left in the background stops being ticked. Flying the gap in one
    step would resolve every hold in it at once, so it is walked and the anchor
    comes with it."""
    session, clock = make()
    session.load(CSV)
    session.open_control()
    session.play()
    clock.tick(3600)
    session.tick()
    covered = session.engine.time_s - session.engine.opens_s
    assert covered <= session_module.MAX_ADVANCE_S + 1
    # And it does not then sprint to catch up on the next tick.
    clock.tick(1)
    session.tick()
    assert session.engine.time_s - session.engine.opens_s <= session_module.MAX_ADVANCE_S + 3


def test_resetting_puts_the_day_and_the_sequence_back():
    session, clock = make()
    session.load(CSV)
    session.open_control()
    session.play()
    session.set_speed(10)
    clock.tick(60)
    session.tick()
    assert session.status()["flights_started"] >= 1
    session.reset()
    status = session.status()
    assert status["state"] == "ready" and status["speed"] == 1
    assert status["clock"] == "06:31:00" or status["time_s"] == session.engine.opens_s
    assert status["flights_started"] == 0 and status["psu"]["requests"] == 0
    # And the clock does not resume from where it was when play is pressed again.
    session.play()
    clock.tick(1)
    session.tick()
    assert session.engine.time_s - session.engine.opens_s < 5


def test_stopping_writes_what_the_day_produced(tmp_path):
    session, clock = make(directory=tmp_path)
    session.load(CSV)
    session.open_control()
    session.play()
    session.set_speed(10)
    for _ in range(30):
        clock.tick(10)
        session.tick()
    session.stop()
    assert session.status()["state"] == "finished"
    written = {item["name"] for item in session.recording()["files"]}
    assert written == {"tracks.jsonl", "events.jsonl", "diagnostics.jsonl",
                       "flights.csv", "holds.json", "summary.json"}
    folder = tmp_path / session.scenario_id
    # A track row per flying aircraft per second, and nothing for the ones parked.
    rows = [json.loads(line) for line in (folder / "tracks.jsonl").read_text(encoding="utf-8").splitlines()]
    assert rows and all(row["flight_id"] for row in rows)
    assert {"t", "aircraft_id", "flight_id", "phase", "lat", "lon", "alt"} <= set(rows[0])
    # One row per flight, planned against actual, whether it flew or not.
    # Read as bytes: a spreadsheet sees exactly these rows, and a file whose
    # line endings were translated twice would show every other row blank.
    raw = (folder / "flights.csv").read_bytes().decode("utf-8-sig")
    doubled = bytes([13, 13, 10])
    assert doubled not in (folder / "flights.csv").read_bytes(), "one row per row"
    flights = raw.splitlines()
    assert flights[0].startswith("flight_plan_id,aircraft_id,seats")
    assert len(flights) == 4, "a header and the three flights"
    assert "hold_seconds" in flights[0] and "landing_sequence" in flights[0]
    summary = json.loads((folder / "summary.json").read_text(encoding="utf-8"))
    assert summary["schedule"]["flights"] == 3 and summary["result"]["flights_started"] >= 1
    holds = json.loads((folder / "holds.json").read_text(encoding="utf-8"))
    assert "statistics" in holds and isinstance(holds["holds"], list)
    operations = [json.loads(line) for line in
                  (folder / 'events.jsonl').read_text(encoding='utf-8').splitlines()]
    diagnostics = [json.loads(line) for line in
                   (folder / 'diagnostics.jsonl').read_text(encoding='utf-8').splitlines()]
    assert any(item['kind'] == 'ground_route_proposals' for item in operations)
    assert any(item['kind'] == 'route_proposals' and
               item['component'] == 'vertiport_ground_control' for item in diagnostics)
    assert all('component' not in item for item in operations)


def test_a_deck_says_who_is_on_it_who_is_coming_and_who_is_waiting():
    session, clock = make()
    session.load(CSV)
    session.open_control()
    session.play()
    session.set_speed(10)
    for _ in range(12):
        clock.tick(10)
        session.tick()
    deck = session.vertiport("VP2")
    assert deck["vertiport_id"] == "VP2"
    assert set(deck) >= {"standing", "inbound", "outbound", "holding", "pads", "stands", "clock"}
    assert isinstance(deck["pads"], dict)
    arriving = deck["inbound"] + deck["holding"]
    assert all(item["destination"] == "VP2" for item in arriving)
    assert session.vertiport("VP9") is not None, "an unknown deck answers an empty one, not an error"


def test_a_deck_carries_its_own_board_so_the_terminal_needs_no_second_request():
    # The board rides on the deck answer the page already asks for. A route
    # of its own would answer the same thing a moment later, which is how
    # two screens come to disagree about when a flight is leaving.
    session, clock = make()
    session.load(CSV)
    session.open_control()
    session.play()
    session.set_speed(10)
    for _ in range(12):
        clock.tick(10)
        session.tick()
    board = session.vertiport("VP2")["board"]
    assert board["vertiport_id"] == "VP2"
    assert board["clock"] == session.vertiport("VP2")["clock"]
    assert all(row["counterpart"] != "VP2" for row in board["departures"] + board["arrivals"])
    # Every row is one this deck actually has, and the waiting counts are
    # taken from those same rows rather than from a second reading.
    for row in board["departures"]:
        assert row["status_text"] and row["time"]
    from digital_twin.model_library import terminal_board
    assert board["waiting"] == terminal_board.waiting_by_gate(board["departures"])
    assert session.vertiport("VP9")["board"]["departures"] == []


def test_an_aircraft_answers_what_it_is_doing_and_what_it_has_left():
    session, clock = make()
    session.load(CSV)
    session.open_control()
    session.play()
    session.set_speed(10)
    for _ in range(6):
        clock.tick(10)
        session.tick()
    detail = session.aircraft("A1")
    assert detail["state"]["aircraft_id"] == "A1"
    assert detail["completed"] + detail["remaining"] >= 1
    # The wire's own id works too, so a click on the map can ask directly.
    assert session.aircraft("scenario:A1")["state"]["aircraft_id"] == "A1"
    assert session.aircraft("nobody") is None


def test_an_aircraft_carries_its_own_track_and_the_deck_carries_its_passengers():
    session, clock = make()
    session.load(CSV)
    session.open_control()
    session.play()
    session.set_speed(4)
    # A walk takes about half a minute, so the day is sampled finely enough to
    # catch one: at four times speed this is eight seconds of the day a step.
    walked = None
    for _ in range(220):
        clock.tick(2)
        session.tick()
        people = session.passengers()
        if people["aircraft"]:
            walked = walked or people
    # The track is the flight's, and it is asked for by the id on the map.
    track = session.track("scenario:A1")
    assert track["aircraft_id"] == "A1" and track["points"]
    assert set(track["surface_references"]) == {"origin", "destination"}
    assert {item["vertiport_id"] for item in track["surface_references"].values()} == {"VP1", "VP2"}
    assert all(isinstance(item["altitude_m"], float)
               for item in track["surface_references"].values())
    for longitude, latitude, altitude, moment in track["points"]:
        assert 126.0 < longitude < 128.0 and 37.0 < latitude < 38.0 and altitude >= 0
        assert moment <= track["time_s"]
    assert session.track("nobody") is None

    # Somebody was walking to or from an aircraft, with a path to walk along.
    assert walked is not None, "the day loads and unloads people"
    first = walked["aircraft"][0]
    assert first["phase"] in ("boarding", "alighting")
    assert first["count"] >= 1 and first["walk"]["count"] == first["count"]
    assert len(first["walk"]["path"]) >= 2
    assert len(first["walk"]["release_s"]) == first["count"]
    assert first["walk"]["alighting"] is (first["phase"] == "alighting")
    assert first["vertiport"] in ("VP1", "VP2")


# ---- the wire --------------------------------------------------------------
def client(tmp_path=None):
    session, clock = make(directory=tmp_path)
    app = FastAPI()
    app.include_router(create_scenario_router(session))
    return TestClient(app), session, clock


def test_the_wire_loads_drives_and_reports_the_day(tmp_path):
    api, session, clock = client(tmp_path)
    assert api.get("/api/simulation/scenario").json()["loaded"] is False
    assert api.get("/api/simulation/scenario/flights/F1").status_code == 404

    loaded = api.post("/api/simulation/scenario", content=CSV.encode("utf-8"),
                      headers={"content-type": "text/csv", "x-aerodt-filename": "FPL.csv"})
    assert loaded.status_code == 201 and loaded.json()["schedule"]["flights"] == 3

    opened = api.post("/api/simulation/scenario/control", json={"action": "open_control"}).json()
    assert opened["control_open"] is True and opened["state"] == "ready"
    played = api.post("/api/simulation/scenario/control", json={"action": "play", "speed": 4}).json()
    assert played["state"] == "playing" and played["speed"] == 4
    clock.tick(30)
    before = session.engine.time_s
    status = api.get("/api/simulation/scenario/status").json()
    assert status["time_s"] == before, "status polling must not run physics"
    session.tick()  # The application heartbeat is the sole tick driver.
    status = api.get("/api/simulation/scenario/status").json()
    assert status["time_s"] > session.engine.opens_s
    assert {"clock", "airborne", "parked", "holding", "flights_completed", "psu"} <= set(status)

    detail = api.get("/api/simulation/scenario/flights/F1")
    assert detail.status_code == 200 and detail.json()["flight"]["flight_id"] == "F1"
    assert api.get("/api/simulation/scenario/aircraft/A1").json()["state"]["aircraft_id"] == "A1"
    assert api.get("/api/simulation/scenario/vertiports/VP1").json()["vertiport_id"] == "VP1"
    # Every deck in one answer. The PSU watches all of them at once and the
    # vertiport operators watch one each; asking for them one at a time would be
    # a request per deck for a single screen, and the two parties could end up
    # reading the network a poll apart.
    summary = api.get("/api/simulation/scenario/vertiports").json()
    assert summary["clock"] == api.get("/api/simulation/scenario/status").json()["clock"]
    listed = {row["vertiport_id"]: row for row in summary["vertiports"]}
    assert listed, "a day being flown is using at least one deck"
    assert set(next(iter(listed.values()))) == {"vertiport_id", "standing", "moving", "inbound",
                                                "outbound", "holding", "stands_taken", "pads_busy"}
    for row in listed.values():
        # The same deck, read the other way, has to agree with this line.
        deck = api.get(f"/api/simulation/scenario/vertiports/{row['vertiport_id']}").json()
        assert row["standing"] == len(deck["standing"])
        assert row["inbound"] == len(deck["inbound"])
        assert row["holding"] == len(deck["holding"])
        assert row["stands_taken"] == sorted({a["stand"] for a in deck["standing"] if a["stand"]})
        assert len(row["pads_busy"]) == len(set(row["pads_busy"])), "each pad named once"
    assert isinstance(api.get("/api/simulation/scenario/events").json()["events"], list)
    assert isinstance(api.get("/api/simulation/scenario/holds").json()["holds"], list)

    stopped = api.post("/api/simulation/scenario/control", json={"action": "stop"}).json()
    assert stopped["state"] == "finished"
    assert api.get("/api/simulation/scenario/recording").json()["files"]
    assert api.delete("/api/simulation/scenario").json()["loaded"] is False


def test_the_wire_refuses_what_it_cannot_stand_behind():
    api, session, _ = client()
    assert api.post("/api/simulation/scenario", content=b"").status_code == 422
    assert api.post("/api/simulation/scenario", content=b"a,b\n1,2\n").status_code == 422
    # Driving a day nobody has loaded says so rather than starting one.
    refused = api.post("/api/simulation/scenario/control", json={"action": "play"})
    assert refused.status_code == 422 and "비행계획" in refused.json()["message"]
    api.post("/api/simulation/scenario", content=CSV.encode("utf-8"))
    for bad in ({"action": "fly"}, {"speed": 3}, {"speed": "fast"}):
        answer = api.post("/api/simulation/scenario/control", json=bad)
        assert answer.status_code == 422, bad
    assert api.post("/api/simulation/scenario/control", content=b"not json").status_code == 422


def test_a_day_without_a_date_is_still_flown_against_a_real_clock():
    """The date anchors the sky. Without one the day runs against today, which
    only means the satellites over it are today's."""
    assert epoch_of("2026-10-10", 0) == epoch_of("2026-10-10", 0)
    assert epoch_of("2026-10-10", 60) - epoch_of("2026-10-10", 0) == 60
    assert epoch_of("", 0) == epoch_of(None, 0)
    assert epoch_of("not-a-date", 3600) - epoch_of("not-a-date", 0) == 3600


def test_a_climbing_aircraft_carries_its_climb_so_a_prediction_can_see_it():
    """The velocity handed to the twin used to be purely horizontal.

    That made every prediction level by construction: an aircraft climbing out
    or coming down was drawn flying straight on at the height it happened to be
    at, and the whole of its speed was spent on the ground track, so it was also
    drawn running ahead of itself.
    """
    import math
    velocity_of = session_module._velocity_ecef
    latitude, longitude = 37.5, 127.0
    up = (math.cos(math.radians(latitude)) * math.cos(math.radians(longitude)),
          math.cos(math.radians(latitude)) * math.sin(math.radians(longitude)),
          math.sin(math.radians(latitude)))

    def parts(velocity):
        vertical = sum(u * v for u, v in zip(up, velocity))
        total = math.sqrt(sum(v * v for v in velocity))
        return vertical, math.sqrt(max(0.0, total * total - vertical * vertical)), total

    level = parts(velocity_of(latitude, longitude, 90.0, 45.0, 0.0))
    assert level[0] == pytest.approx(0.0, abs=1e-9), "level flight has no vertical part"
    assert level[1] == pytest.approx(45.0, abs=1e-9)

    climbing = parts(velocity_of(latitude, longitude, 90.0, 45.0, 5.0))
    assert climbing[0] == pytest.approx(5.0, abs=1e-9), "a climb is in the velocity"
    assert climbing[2] == pytest.approx(45.0, abs=1e-9), "and comes out of the same speed"
    assert climbing[1] == pytest.approx(math.sqrt(45.0 ** 2 - 25.0), abs=1e-9),         "so the ground track is the rest of it, not all of it"

    descending = parts(velocity_of(latitude, longitude, 90.0, 45.0, -4.0))
    assert descending[0] == pytest.approx(-4.0, abs=1e-9)

    # Straight up, and standing still.
    hover = parts(velocity_of(latitude, longitude, 90.0, 3.0, 3.0))
    assert hover[0] == pytest.approx(3.0, abs=1e-9) and hover[1] == pytest.approx(0.0, abs=1e-6)
    assert velocity_of(latitude, longitude, 90.0, 0.0, 0.0) is None, "a parked aircraft is not moving"
    assert velocity_of(latitude, longitude, None, 45.0, 5.0) is None, "and one with no track has no vector"


def test_an_aircraft_gets_its_climb_from_the_height_it_actually_gained():
    """Whether a pilot flew it or the engine walked it along a phase."""
    from digital_twin.simulation.scenario_engine import Aircraft
    aircraft = Aircraft({"aircraft_id": "UAM0062", "seats": 4, "type_id": "t",
                         "home": "VP001", "stand": "G1", "flights": []})
    assert aircraft.climb_mps == 0.0

    # Placed once: nothing to compare against yet, so no rate is claimed.
    aircraft.place(37.5, 127.0, 500.0, 90.0, 2.0)
    assert aircraft.climb_mps == 0.0
    # Twenty metres higher two seconds later is ten metres a second.
    aircraft.place(37.5, 127.001, 520.0, 90.0, 2.0)
    assert aircraft.climb_mps == pytest.approx(10.0)
    aircraft.place(37.5, 127.002, 512.0, 90.0, 2.0)
    assert aircraft.climb_mps == pytest.approx(-4.0), "and coming down is negative"
    # A placement that is not motion -- a reset, a stand -- leaves it alone.
    aircraft.place(37.5, 127.0, 20.0, 90.0)
    assert aircraft.climb_mps == pytest.approx(-4.0)


def test_native_velocity_is_not_rotated_to_attitude_yaw_or_counted_twice():
    import math
    session, _ = make()
    session.load(CSV)
    state = session.engine.states()[0]
    state.update(heading_deg=90, speed_mps=13, velocity_ned_mps=(12, 0, -5), climb_mps=5)
    e = session._entity(state, 100)
    lat, lon = math.radians(e.latitude_deg), math.radians(e.longitude_deg)
    north = (-math.sin(lat)*math.cos(lon), -math.sin(lat)*math.sin(lon), math.cos(lat))
    east = (-math.sin(lon), math.cos(lon), 0)
    up = (math.cos(lat)*math.cos(lon), math.cos(lat)*math.sin(lon), math.sin(lat))
    assert sum(a*b for a, b in zip(north, e.velocity_ecef_mps)) == pytest.approx(12)
    assert sum(a*b for a, b in zip(east, e.velocity_ecef_mps)) == pytest.approx(0, abs=1e-8)
    assert sum(a*b for a, b in zip(up, e.velocity_ecef_mps)) == pytest.approx(5)
    assert e.heading_deg == 90, "attitude remains authoritative and independent"
    state["velocity_ned_mps"] = (0, 0, 0)
    assert session._entity(state, 100).velocity_ecef_mps == (0, 0, 0), "a measured stop is not missing velocity"


def test_prediction_input_reads_a_consistent_copy_without_advancing_the_day():
    session, _ = make()
    session.load(CSV)
    session.open_control()
    before = session.engine.time_s
    state, intent = session.prediction_input("scenario:A1")
    assert intent.entity_id == state.entity_id and intent.state_time == state.state_time
    assert intent.phase == state.flight_phase == "parked"
    assert intent.waypoints == ()
    assert session.engine.time_s == before
    assert session.prediction_input("scenario:missing") is None


def test_learned_history_uses_actual_flight_elapsed_and_resets_without_advancing():
    session, clock = make()
    session.load(CSV)
    session.play()
    for _ in range(800):
        clock.tick(.5)
        session.advance_view()
        captured = session.learned_prediction_input('scenario:A1')
        if captured and captured['windows']['uam_route_mlp_mid']['status'] == 'ready':
            break
    assert captured['windows']['uam_route_mlp_mid']['status'] == 'ready'
    before = session.engine.time_s
    row = captured['windows']['uam_route_mlp_mid']['rows'][-1]
    departure = next(e['time_s'] for e in session.engine.events if e['kind']=='off_block' and e['flight_id']=='F1')
    assert row[0] == pytest.approx(before-departure)
    again = session.learned_prediction_input('scenario:A1')
    assert session.engine.time_s == before and again['windows']==captured['windows']
    assert session.prediction_context_matches(captured)
    session.reset()
    assert not session.prediction_context_matches(captured)
    reset = session.learned_prediction_input('scenario:A1')
    assert reset['context'] != captured['context']
    assert reset['windows']['uam_route_mlp_short']['status']=='warming_up'

def test_passenger_response_has_snapshot_time_for_shared_display_clock():
    session, _ = make()
    session.load(CSV)
    session.open_control()
    before = session.engine.time_s
    answer = session.passengers()
    assert answer['state_time'] == session.epoch_time()
    assert answer['scenario_id'] == session.scenario_id
    assert session.engine.time_s == before


def test_loading_reports_forecast_preparation_before_publication(monkeypatch):
    from digital_twin.simulation.scenario_engine import ScenarioEngine
    events = []
    calls = []
    class Forecasts:
        def estimate_to_entry(self, route, heading):
            calls.append(heading)
            if len(calls) == 1:
                raise ValueError('forecast unavailable: preserve fallback')
    # Exercise real warmup routes without a native library or moving live pilots.
    original = ScenarioEngine._warm_entry_estimates
    def warm(engine, on_prepare=None):
        pilots = engine.pilots
        before = engine.time_s
        engine.pilots = Forecasts()
        try:
            original(engine, on_prepare)
            assert engine.time_s == before
        finally:
            engine.pilots = pilots
    monkeypatch.setattr(ScenarioEngine, '_warm_entry_estimates', warm)
    session, _ = make()
    session.load(CSV, on_progress=lambda *event: events.append(event))
    assert events[0][0] == 'initialize'
    assert [e for e in events if e[0] == 'forecast'] == [
        ('forecast', 0, 2), ('forecast', 1, 2), ('forecast', 2, 2)]
    assert len(calls) == 2
    assert events[-1][0] == 'publish'
    assert session.description()['state'] == 'ready'


# ---------------------------------------------------------------- the ground crew and the battery on the wire


def test_the_wire_entity_carries_the_battery_the_energy_model_has():
    session, clock = make()
    session.load(CSV)
    session.open_control()
    uam = [e for e in session.entities() if e.kind == "uam"]
    assert uam, "the day's aircraft are on the wire once the console is open"
    for entity in uam:
        assert entity.battery_pct is not None and 0 <= entity.battery_pct <= 100
        assert entity.charge_state in ("disconnected", "connecting", "charging", "complete", "unavailable")


def test_a_marshaller_meets_a_taxiing_aircraft_and_a_hand_walks_the_cable_to_a_parked_one():
    session, clock = make()
    session.load(CSV)
    session.open_control()
    session.play()
    session.set_speed(4)
    marshalled, cabled, plugged = None, None, None
    for _ in range(600):
        clock.tick(2)
        session.tick()
        crew = session.passengers()["crew"]
        for row in crew:
            if row["role"] == "marshaller":
                marshalled = marshalled or row
            if row["role"] == "charger" and row["action"] == "walk":
                cabled = cabled or row
            if row["role"] == "charger" and row["state"] in ("charging", "complete"):
                plugged = plugged or row
        if marshalled and cabled and plugged:
            break
    assert marshalled is not None, "somebody stands off the stand while an aircraft taxis"
    assert 126.0 < marshalled["longitude"] < 128.0 and 37.0 < marshalled["latitude"] < 38.0
    assert 0 <= marshalled["heading"] < 360 and marshalled["action"] in ("signal", "idle")
    assert marshalled["asset_id"] and marshalled["height_m"] == 1.75
    assert cabled is not None, "the cable is walked from the cabinet before it is connected"
    assert len(cabled["path"]) == 2 and cabled["walk_s"] > 0 and cabled["cable"]
    cabinet, port = cabled["path"]
    assert 0.5 < ((cabinet[0]-port[0])*88000)**2 + ((cabinet[1]-port[1])*111320)**2 < 50**2, "the walk is metres, not nothing and not across the city"
    assert plugged is not None, "and then the aircraft is on charge with the hand beside it"
    assert plugged["action"] in ("plug", "idle")
