"""Airspace: provider answers become one collection, kept a day, served with a status."""
import asyncio
import json

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from communication.external.airspace import (KINDS, VWORLD_LAYERS, AirspaceSource, kind_of, limits_of, normalise,
                                             vworld_page, vworld_request, wfs_request)
from communication.web.airspace_routes import create_airspace_router

SQUARE = {"type": "Polygon", "coordinates": [[[126.9, 37.5], [127.0, 37.5], [127.0, 37.6], [126.9, 37.6], [126.9, 37.5]]]}


def feature(name, geometry=SQUARE, **properties):
    return {"type": "Feature", "id": name.lower(), "geometry": geometry, "properties": {"name": name, **properties}}


def test_every_kind_reads_and_words_place_a_feature_when_the_layer_does_not():
    assert set(VWORLD_LAYERS.values()) <= set(KINDS)
    assert kind_of("prohibited", {}) == "prohibited", "the layer decides"
    assert kind_of("other", {"name": "P-73 비행금지구역"}) == "prohibited"
    assert kind_of("other", {"type": "R", "name": "R-75 restricted"}) == "restricted"
    assert kind_of("other", {"name": "김포 관제권 CTR"}) == "control"
    assert kind_of("other", {"name": "한강회랑"}) == "corridor"
    assert kind_of("other", {"name": "무엇"}) == "other"


def test_features_are_normalised_to_the_same_properties_and_lines_are_left_out():
    raw = [feature("P-73", UPR_LMT="UNL", LWR_LMT="GND"),
           {"type": "Feature", "geometry": {"type": "LineString", "coordinates": [[0, 0], [1, 1]]}, "properties": {"name": "route"}},
           {"type": "Feature", "geometry": {"type": "MultiPolygon", "coordinates": [SQUARE["coordinates"]]}, "properties": {"AIR_NM": "김포 관제권", "ceiling": "5000 ft"}},
           "not a feature"]
    out = normalise(raw, "LT_C_AISPRHC", "prohibited")
    assert [f["properties"]["name"] for f in out] == ["P-73", "김포 관제권"], "the line is not an area"
    first = out[0]
    assert first["id"] == "LT_C_AISPRHC:p-73"
    assert first["properties"] == {"name": "P-73", "kind": "prohibited", "kind_label": "비행금지구역", "lower": "GND", "upper": "UNL", "layer": "LT_C_AISPRHC"}
    assert out[1]["properties"]["upper"] == "5000 ft" and out[1]["properties"]["lower"] is None
    assert out[1]["geometry"]["type"] == "MultiPolygon"
    unnamed = normalise([{"type": "Feature", "geometry": SQUARE, "properties": {}}], "x", "danger")
    assert unnamed[0]["properties"]["name"] == "위험구역 1" and unnamed[0]["id"] == "x:1"


def test_the_aeronautical_map_labels_become_a_name_a_floor_a_ceiling_and_a_note():
    """What the 항공정보도 layers really carry, as answered on 2026-09-09."""
    assert "LT_C_AISTRNC" not in VWORLD_LAYERS, "the service has no such layer"
    prohibited = {"prohibited": "", "prh_lbl_1": "RK P61A", "prh_lbl_2": "SFC", "prh_lbl_3": "10000ft AMSL", "prh_typ": "1", "prh_lbl_4": "원전 관련 임시 (금지)공역"}
    restricted = {"restricted": "<FNT name='TW Cen MT' size='9'>R1</FNT>", "res_lbl_1": "R1", "res_lbl_2": "6 000 AMSL", "res_lbl_3": "GND"}
    moa = {"moa_lbl_1": "MOA 4", "moa_lbl_2": "9 000 AMSL", "moa_lbl_3": "3 000 AGL"}
    tma = {"tma_lbl_1": "TMA GWANGJU", "tma_lbl_2": "AREA T29", "tma_lbl_3": "FL 225", "tma_lbl_4": "1 000 AGL GWANGJU APP"}
    control = {"ctr_lbl_1": "POHANG TCA AREA A"}
    assert limits_of(prohibited) == ("SFC", "10000ft AMSL"), "the ground label is the floor whichever slot it sits in"
    assert limits_of(restricted) == ("GND", "6 000 AMSL")
    assert limits_of(moa) == ("3 000 AGL", "9 000 AMSL"), "neither is the ground: the lower number is the floor"
    assert limits_of(control) == (None, None)
    out = normalise([{"type": "Feature", "geometry": SQUARE, "properties": p} for p in (prohibited, restricted, moa, tma, control)], "L", "other")
    assert [f["properties"]["name"] for f in out] == ["RK P61A", "R1", "MOA 4", "TMA GWANGJU", "POHANG TCA AREA A"], "styled markup is never a name"
    assert out[0]["properties"]["note"] == "원전 관련 임시 (금지)공역" and "note" not in out[1]["properties"]
    assert out[3]["properties"]["upper"] == "FL 225", "a flight level reads above a plain height"
    assert out[3]["properties"]["note"] == "AREA T29", "the label that is neither name nor limit"
    same = normalise([{"type": "Feature", "geometry": SQUARE, "properties": {"prh_lbl_1": "RK P73A", "prh_lbl_2": "GND", "prh_lbl_3": "UNL", "prh_lbl_4": "비행금지구역"}}], "L", "prohibited")
    assert "note" not in same[0]["properties"], "a note that only repeats the kind is dropped"
    assert (same[0]["properties"]["lower"], same[0]["properties"]["upper"]) == ("GND", "UNL")


def test_the_vworld_request_and_answer_shapes():
    params = vworld_request("k", "localhost", "LT_C_AISPRHC", (126.0, 37.0, 128.0, 38.0), page=2)
    assert params["geomFilter"] == "BOX(126.0,37.0,128.0,38.0)" and params["page"] == "2" and params["crs"] == "EPSG:4326"
    features, current, total = vworld_page({"response": {"status": "OK", "page": {"current": "1", "total": "3"},
                                                          "result": {"featureCollection": {"features": [feature("A")]}}}})
    assert len(features) == 1 and (current, total) == (1, 3)
    with pytest.raises(ValueError, match="INVALID_KEY"):
        vworld_page({"response": {"status": "ERROR", "error": {"code": "INVALID_KEY", "text": "등록되지 않은 인증키입니다."}}})
    assert wfs_request("serviceKey", "k", "zones")["serviceKey"] == "k"
    assert wfs_request("serviceKey", "k", "zones")["outputFormat"] == "application/json"


def vworld_transport(pages, log):
    """A V-World that answers `pages` per layer code: {code: [[features]...]} or an error code."""
    def handler(request):
        log.append(dict(request.url.params))
        assert "key" in request.url.params and request.url.params["domain"] == "localhost"
        code = request.url.params["data"]
        answer = pages.get(code)
        if isinstance(answer, str):
            return httpx.Response(200, json={"response": {"status": "ERROR", "error": {"code": answer, "text": "nope"}}})
        page = int(request.url.params["page"])
        return httpx.Response(200, json={"response": {"status": "OK", "page": {"current": page, "total": len(answer)},
                                                       "result": {"featureCollection": {"features": answer[page - 1]}}}})
    return httpx.MockTransport(handler)


def test_the_source_pages_through_every_layer_keeps_the_answer_a_day_and_reports_a_bad_layer(tmp_path):
    log = []
    pages = {"LT_C_AISPRHC": [[feature("P-73")], [feature("P-518")]], "LT_C_AISCTRC": [[feature("김포 CTR")]], "LT_C_AISNOPE": "INVALID_LAYER"}
    now = [1000.0]
    source = AirspaceSource({"provider": "vworld", "layers": {"LT_C_AISPRHC": "prohibited", "LT_C_AISCTRC": "control", "LT_C_AISNOPE": "other"}},
                            "secret-key", tmp_path / "airspace", transport=vworld_transport(pages, log), clock=lambda: now[0])
    assert source.status()["state"] == "idle"
    collection = asyncio.run(source.fetch())
    names = [f["properties"]["name"] for f in collection["features"]]
    assert names == ["P-73", "P-518", "김포 CTR"], "two pages of one layer, one of the next"
    assert [f["properties"]["kind"] for f in collection["features"]] == ["prohibited", "prohibited", "control"]
    status = source.status()
    assert status["state"] == "ready" and status["features"] == 3 and status["fetched_at"] == 1000.0
    assert status["problems"] == ["LT_C_AISNOPE: INVALID_LAYER: nope"], "the bad layer is a line, not a failure"
    assert "secret-key" not in json.dumps(status)
    requests = len(log)
    # Fresh: nothing is asked again. Stale: it is.
    asyncio.run(source.fetch())
    assert len(log) == requests
    now[0] += 90000
    asyncio.run(source.fetch())
    assert len(log) > requests
    # Kept in the workspace, so the next run starts with it.
    again = AirspaceSource({"provider": "vworld", "layers": {}}, "secret-key", tmp_path / "airspace", clock=lambda: now[0])
    assert again.status()["state"] == "ready" and again.status()["features"] == 3
    stored = (tmp_path / "airspace" / "airspace.geojson").read_text(encoding="utf-8")
    assert "secret-key" not in stored


def test_a_source_with_every_layer_failing_reports_an_error_and_keeps_what_it_had(tmp_path):
    source = AirspaceSource({"provider": "vworld", "layers": {"LT_C_AISPRHC": "prohibited"}}, "k", tmp_path,
                            transport=vworld_transport({"LT_C_AISPRHC": "INVALID_KEY"}, []))
    collection = asyncio.run(source.fetch())
    assert collection["features"] == []
    assert source.status()["state"] == "error" and "INVALID_KEY" in source.status()["detail"]


def test_a_wfs_provider_passes_the_key_as_the_named_parameter(tmp_path):
    seen = []
    def handler(request):
        seen.append(dict(request.url.params))
        return httpx.Response(200, json={"type": "FeatureCollection", "features": [feature("R-75", upper="1000 ft AGL")]})
    source = AirspaceSource({"provider": "wfs", "url": "https://example.test/wfs", "key_param": "serviceKey", "layers": {"zones": "restricted"}},
                            "portal-key", tmp_path, transport=httpx.MockTransport(handler))
    collection = asyncio.run(source.fetch())
    assert seen[0]["serviceKey"] == "portal-key" and seen[0]["typename"] == "zones"
    assert collection["features"][0]["properties"]["kind"] == "restricted"


def test_without_a_key_the_source_is_off_and_asks_nothing(tmp_path):
    source = AirspaceSource({"provider": "vworld"}, None, tmp_path, transport=httpx.MockTransport(lambda r: httpx.Response(500)))
    assert source.status()["state"] == "off"
    assert asyncio.run(source.fetch()) == {"type": "FeatureCollection", "features": []}


def test_the_routes_serve_the_collection_and_say_when_nothing_is_configured(tmp_path):
    app = FastAPI()
    app.include_router(create_airspace_router(None))
    with TestClient(app) as client:
        assert client.get("/api/airspace/status").json()["state"] == "unconfigured"
        body = client.get("/api/airspace").json()
        assert body["status"]["state"] == "unconfigured" and body["collection"]["features"] == []
    source = AirspaceSource({"provider": "vworld", "layers": {"LT_C_AISPRHC": "prohibited"}}, "k", tmp_path,
                            transport=vworld_transport({"LT_C_AISPRHC": [[feature("P-73")]]}, []))
    app = FastAPI()
    app.include_router(create_airspace_router(source))
    with TestClient(app) as client:
        body = client.get("/api/airspace").json()
        assert body["status"]["state"] == "ready" and body["collection"]["features"][0]["properties"]["name"] == "P-73"
        assert client.get("/api/airspace").headers["cache-control"] == "no-store"
