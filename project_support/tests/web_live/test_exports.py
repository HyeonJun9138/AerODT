"""Downloads: what the Library offers, what each file contains, and the header
that makes the browser save it on the computer that asked."""
import csv
import io
import json
import zipfile

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from communication.web.export_routes import create_export_router
from data.simulation.flight_runs import STATE_EXPORT_CHUNK_BYTES
from user_application.apps.web_dashboard.exports import EXPORT_IDS, Exports, filename, media_type

VERTIPORTS = [{"id": "VP001", "name": "여의도", "latitude": 37.52, "longitude": 126.93, "gates": 4,
               "fatos": [{"id": "F1", "role": "both", "side": "front"}],
               "layout": {"pattern": "row", "gates": [], "fatos": []}}]
NETWORK = {"nodes": [{"id": "WP001", "name": "가양대교", "latitude": 37.57, "longitude": 126.86, "altitude_m": 304.8}],
           "links": [{"id": "LK1", "from": "fato:VP001:F1", "to": "WP001", "segment": "C", "width_m": None}],
           "fatos": [{"id": "fato:VP001:F1", "kind": "fato", "role": "both"}],
           "dropped_links": []}
ROUTE_OPTIONS = {"segments": [{"id": "C", "label": "Climb-out"}]}
VERTIPORT_OPTIONS = {"patterns": [{"id": "row"}], "rules": {"fato_diameter": "1.5 D"}}
RUN = {"run_id": "20260910T040506Z-abcd1234", "label": "여의도 → 봉천",
       "summary": {"engine": "kinematic-plan-integrator", "states": 3, "rate_hz": 5}}
RUN_STATES = [{"t": 0.0, "leg": 0, "stage": "gate_out", "battery_pct": 100.0},
              {"t": 0.2, "leg": 0, "stage": "gate_out", "battery_pct": 99.9},
              {"t": 0.4, "leg": 1, "stage": "takeoff", "battery_pct": 99.8}]


class Runs:
    def __init__(self, listed=(RUN,)):
        self.listed = list(listed)

    def list(self):
        return list(self.listed)

    @staticmethod
    def plan(run_id):
        return {"legs": [{"stage": "gate_out"}], "vehicle": {"id": "UAM-1"}}

    @staticmethod
    def states(run_id):
        return list(RUN_STATES)


COLLECTION = {"type": "FeatureCollection", "features": [
    {"type": "Feature", "id": "p73", "geometry": {"type": "Polygon", "coordinates": []},
     "properties": {"name": "RK P73A", "kind": "prohibited"}}]}
# 2026-09-10T04:05:06Z
WHEN = 1789013106.0


def library(airspace=COLLECTION, clock=lambda: WHEN, flight_runs=None, **changes):
    sources = {"vertiports": lambda: VERTIPORTS, "routes": lambda: NETWORK,
               "route_options": lambda: ROUTE_OPTIONS, "vertiport_options": lambda: VERTIPORT_OPTIONS,
               "airspace": (lambda: airspace) if airspace is not None else None,
               "flight_runs": flight_runs if flight_runs is not None else Runs()}
    sources.update(changes)
    return Exports(clock=clock, **sources)


def test_a_filename_says_what_it_is_and_the_day_it_left():
    from datetime import datetime, timezone
    when = datetime(2026, 9, 10, tzinfo=timezone.utc)
    assert filename("routes", when) == "aerodt-routes-20260910.json"
    assert filename("network", when) == "aerodt-network-20260910.json"
    assert filename("flight_run", when) == "aerodt-flight-run-20260910.zip"
    assert filename("airspace", when) == "aerodt-airspace-20260910.geojson", "GIS tools read the extension"
    assert media_type("airspace").startswith("application/geo+json")
    assert media_type("vertiports").startswith("application/json")
    assert media_type("flight_run") == "application/zip"
    with pytest.raises(ValueError) as error:
        filename("everything", when)
    assert str(error.value).startswith("kind:")


def test_the_catalogue_says_what_each_file_would_hold_right_now():
    described = library().describe()
    items = {item["id"]: item for item in described["exports"]}
    assert list(items) == list(EXPORT_IDS), "every export is listed, in order"
    assert items["vertiports"]["summary"] == "버티포트 1개" and items["vertiports"]["available"] is True
    assert items["routes"]["summary"] == "지점 1개 · 구간 1개"
    assert items["network"]["summary"] == "버티포트 1개 · 지점 1개 · 구간 1개"
    assert items["airspace"]["summary"] == "1개 구역" and items["airspace"]["format"] == "geojson"
    assert items["flight_run"]["summary"] == "여의도 → 봉천 · 상태 3개"
    assert items["routes"]["filename"] == "aerodt-routes-20260910.json"
    assert all(item["note"] and item["label"] for item in items.values()), "each says what it is for"


def test_an_export_with_nothing_behind_it_is_listed_as_unavailable_rather_than_hidden():
    empty = library(airspace=None, vertiports=lambda: [], flight_runs=Runs([]),
                    routes=lambda: {"nodes": [], "links": [], "fatos": []})
    items = {item["id"]: item for item in empty.describe()["exports"]}
    assert items["airspace"]["available"] is False and "인증 설정" in items["airspace"]["summary"]
    assert items["flight_run"]["available"] is False and items["flight_run"]["summary"] == "기록된 비행 없음"
    assert empty.build("flight_run") is None, "no run, no file"
    assert items["vertiports"]["available"] is False and items["routes"]["available"] is False
    assert items["network"]["available"] is True, "the bundle is still a valid, if empty, handover"
    assert empty.build("airspace") is None, "there is no file to make"
    # A store that cannot be read costs a summary, not the panel.
    def broken():
        raise OSError("disk")
    items = {item["id"]: item for item in library(vertiports=broken).describe()["exports"]}
    assert items["vertiports"] == {**items["vertiports"], "summary": "확인할 수 없음", "available": False}


def test_each_file_carries_when_it_left_what_it_holds_and_the_rules_it_was_built_under():
    exports = library()
    name, kind, document = exports.build("vertiports")
    assert name == "aerodt-vertiports-20260910.json" and kind.startswith("application/json")
    assert document["exported_at"] == "2026-09-10T04:05:06Z" and document["source"] == "AeroDT Live Twin"
    assert document["kind"] == "vertiports" and document["count"] == 1
    assert document["vertiports"] == VERTIPORTS
    assert document["design_rules"] == VERTIPORT_OPTIONS, "what the generated numbers mean"

    _, _, routes = exports.build("routes")
    assert routes["counts"] == {"nodes": 1, "links": 1, "fatos": 1}
    assert routes["nodes"] == NETWORK["nodes"] and routes["links"] == NETWORK["links"]
    assert routes["fatos"] == NETWORK["fatos"], "derived, but carried so a reader can resolve a link's ends"
    assert routes["segments"] == ROUTE_OPTIONS

    _, _, bundle = exports.build("network")
    assert bundle["counts"] == {"vertiports": 1, "nodes": 1, "links": 1, "fatos": 1}
    assert bundle["vertiports"] == VERTIPORTS and bundle["routes"]["links"] == NETWORK["links"]
    assert bundle["reference"].endswith("uam_network_data_handoff.md"), "the field-by-field description"

    # A recorded run travels as a bounded ZIP: metadata and plan are small
    # JSON documents, while states remain independently readable JSONL parts.
    name, media, archive = exports.build("flight_run")
    assert name.endswith(".zip") and media == "application/zip"
    with zipfile.ZipFile(io.BytesIO(b"".join(archive))) as package:
        assert set(package.namelist()) == {"README.txt", "manifest.json", "plan.json", "states/part-00001.jsonl"}
        manifest = json.loads(package.read("manifest.json"))
        assert manifest["run"]["run_id"] == RUN["run_id"]
        assert manifest["state_chunk_max_bytes"] == STATE_EXPORT_CHUNK_BYTES
        assert json.loads(package.read("plan.json"))["vehicle"]["id"] == "UAM-1"
        states = [json.loads(line) for line in package.read("states/part-00001.jsonl").splitlines()]
        assert states == RUN_STATES

    name, kind, geo = exports.build("airspace")
    assert name.endswith(".geojson") and kind.startswith("application/geo+json")
    assert geo["type"] == "FeatureCollection", "a GIS tool reads it as it stands"
    assert geo["features"] == COLLECTION["features"] and geo["exported_at"] == "2026-09-10T04:05:06Z"

    with pytest.raises(ValueError):
        exports.build("everything")


class Day:
    """A scheduled day that has been replayed, in the shape Exports asks for."""

    FILES = {"flights.csv": "flight_plan_id,aircraft_id\nFPL000001,UAM0001\n",
             "tracks.jsonl": '{"t":1,"aircraft_id":"UAM0001"}\n{"t":2,"aircraft_id":"UAM0001"}\n',
             "holds.json": '{"schema_version":1,"holds":[]}'}

    def __init__(self, files=None):
        self.files = self.FILES if files is None else files
        self.asked = []

    def export(self, name):
        self.asked.append(name)
        return self.files.get(name)

    def export_summary(self, name):
        return (f"{name} 준비됨", name in self.files)


def test_every_export_can_be_read_by_whatever_its_format_promises():
    """A CSV inside a JSON envelope is not a CSV. Each export hands over the
    thing its extension says it is, and a reader for that format parses it."""
    exports = library(scenario=Day())
    for kind in EXPORT_IDS:
        built = exports.build(kind)
        assert built is not None, kind
        name, media, document = built
        if name.endswith(".csv"):
            assert isinstance(document, str) and media.startswith("text/csv")
            rows = list(csv.reader(io.StringIO(document)))
            assert rows and rows[0][0] == "flight_plan_id"
        elif name.endswith(".jsonl"):
            assert isinstance(document, str) and media.startswith("application/x-ndjson")
            lines = [line for line in document.splitlines() if line.strip()]
            assert lines and all(json.loads(line) for line in lines), "one object per line"
        elif name.endswith(".zip"):
            with zipfile.ZipFile(io.BytesIO(b"".join(document))) as package:
                assert "manifest.json" in package.namelist()
        else:
            json.loads(json.dumps(document, ensure_ascii=False))


def test_a_day_nobody_has_replayed_is_listed_and_unavailable_rather_than_empty():
    exports = library()  # no scenario connected at all
    described = {item["id"]: item for item in exports.describe()["exports"]}
    for kind in ("scenario_flights", "scenario_tracks", "scenario_holds"):
        assert kind in described, "the operator should see the file exists"
        assert described[kind]["available"] is False
        assert exports.build(kind) is None, "and downloading it answers nothing rather than an empty file"
    # A day that has been loaded but produced no tracks yet says so too.
    partial = library(scenario=Day(files={"flights.csv": "flight_plan_id\n"}))
    assert partial.build("scenario_tracks") is None
    assert partial.build("scenario_flights") is not None


def client(exports):
    app = FastAPI()
    app.include_router(create_export_router(exports))
    return TestClient(app)


def test_the_download_is_saved_by_the_computer_that_asked_under_the_name_the_catalogue_gave():
    with client(library()) as http:
        listed = http.get("/api/library/exports")
        assert listed.status_code == 200 and listed.headers["cache-control"] == "no-store"
        response = http.get("/api/library/exports/routes")
        assert response.status_code == 200
        disposition = response.headers["content-disposition"]
        assert disposition.startswith("attachment;"), "the browser saves it rather than showing it"
        assert 'filename="aerodt-routes-20260910.json"' in disposition
        assert "filename*=UTF-8''aerodt-routes-20260910.json" in disposition
        assert response.headers["content-type"].startswith("application/json")
        assert json.loads(response.text)["counts"]["nodes"] == 1
        assert response.text.count("\n") > 1, "indented, so the file opens readably"

        flight = http.get("/api/library/exports/flight_run")
        assert flight.status_code == 200
        assert flight.headers["content-type"].startswith("application/zip")
        assert 'filename="aerodt-flight-run-20260910.zip"' in flight.headers["content-disposition"]
        with zipfile.ZipFile(io.BytesIO(flight.content)) as package:
            assert json.loads(package.read("manifest.json"))["run"]["run_id"] == RUN["run_id"]


def test_a_long_run_keeps_its_state_parts_separate_inside_the_zip():
    class ChunkedRuns(Runs):
        def __init__(self):
            super().__init__()
            self.max_bytes = None

        def state_chunks(self, run_id, *, max_bytes):
            self.max_bytes = max_bytes
            yield b'{"t":0}\n'
            yield b'{"t":1}\n'

    runs = ChunkedRuns()
    _, _, archive = library(flight_runs=runs).build("flight_run")
    with zipfile.ZipFile(io.BytesIO(b"".join(archive))) as package:
        assert package.namelist()[-2:] == ["states/part-00001.jsonl", "states/part-00002.jsonl"]
        assert package.read("states/part-00001.jsonl") == b'{"t":0}\n'
        assert package.read("states/part-00002.jsonl") == b'{"t":1}\n'
    assert runs.max_bytes == STATE_EXPORT_CHUNK_BYTES


def test_an_unknown_or_empty_export_says_so_and_a_broken_store_never_leaks_its_words():
    with client(library(airspace=None)) as http:
        assert http.get("/api/library/exports/everything").status_code == 404
        empty = http.get("/api/library/exports/airspace")
        assert empty.status_code == 409 and empty.json()["error"] == "export_empty"

    class Exploding:
        @staticmethod
        def describe():
            return {"exports": []}

        @staticmethod
        def build(kind):
            raise OSError("D:/secret/path/routes.json is locked")

    with client(Exploding()) as http:
        failed = http.get("/api/library/exports/routes")
        assert failed.status_code == 503 and failed.json() == {"schema_version": 1, "error": "export_failed"}
        assert "secret" not in failed.text
