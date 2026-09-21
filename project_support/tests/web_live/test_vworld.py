"""V-World relay: tiles and building cells through the dashboard, key kept server-side."""
import asyncio
import json

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from communication.external import vworld
from communication.external.vworld import VWorldClient, building_height, cell_bounds, cell_of, simplify_building
from communication.web.vworld_routes import create_vworld_router
from user_application.apps.web_dashboard.credentials import configure_vworld
from user_application.apps.web_dashboard.library_settings import DEFAULTS, PROVIDERS, describe_library, validate_settings

KEY = "secret-vworld-key"
OWS_EXCEPTION = ('<?xml version="1.0"?><ExceptionReport><Exception exceptionCode="FileNotFound">'
                 '<ExceptionText><![CDATA[서비스 제공영역이 아닙니다.]]></ExceptionText></Exception></ExceptionReport>')


def feature(identifier, ring, **properties):
    return {"type": "Feature", "id": identifier, "geometry": {"type": "MultiPolygon", "coordinates": [[ring]]},
            "properties": {"bld_nm": "", "grnd_flr": "0", "height": "0", **properties}}


def page(features, total):
    return {"response": {"status": "OK" if features else "NOT_FOUND", "record": {"total": str(total), "current": str(len(features))},
                         "result": {"featureCollection": {"type": "FeatureCollection", "features": features}}}}


SQUARE = [[126.9801, 37.5701], [126.9802, 37.5701], [126.9802, 37.5702], [126.9801, 37.5702], [126.9801, 37.5701]]


# ------------------------------------------------------------------ shaping

def test_a_building_is_extruded_from_its_height_else_its_floors_else_a_low_box():
    assert building_height({"height": "42.5", "grnd_flr": "3"}) == 42.5
    assert building_height({"height": "0", "grnd_flr": "5"}) == 16.5
    assert building_height({"height": "", "grnd_flr": ""}) == 3.0
    assert building_height({"height": "tall"}) == 3.0
    shaped = simplify_building(feature("LT_C_BLDGINFO.1", SQUARE, bld_nm=" 청사 ", grnd_flr="12", height="0"))
    assert shaped == {"id": "LT_C_BLDGINFO.1", "name": "청사", "height_m": 39.6, "floors": 12,
                      "rings": [{"outer": SQUARE, "holes": []}]}
    assert simplify_building({"type": "Feature", "geometry": {"type": "Point", "coordinates": [1, 2]}}) is None
    assert simplify_building(feature("x", SQUARE[:2])) is None, "a ring that is not a ring is dropped, not drawn"


def test_cells_are_a_fixed_grid_so_every_browser_asks_for_the_same_boxes():
    assert cell_of(126.9785, 37.5665) == (12697, 3756)
    assert cell_bounds(12697, 3756) == (126.97, 37.56, 126.98, 37.57)
    assert vworld.cell_covered(12697, 3756) and not vworld.cell_covered(13969, 3568), "Tokyo is outside the service area"


def test_the_clear_tile_is_a_valid_one_pixel_transparent_png():
    import struct
    import zlib
    png = vworld.TRANSPARENT_PNG
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    position, chunks = 8, {}
    while position < len(png):
        length, = struct.unpack(">I", png[position:position + 4])
        kind, data = png[position + 4:position + 8], png[position + 8:position + 8 + length]
        crc, = struct.unpack(">I", png[position + 8 + length:position + 12 + length])
        assert zlib.crc32(kind + data) & 0xFFFFFFFF == crc, f"{kind} checksum"
        chunks[kind] = data
        position += 12 + length
    assert struct.unpack(">IIBBBBB", chunks[b"IHDR"]) == (1, 1, 8, 6, 0, 0, 0), "1x1 RGBA"
    assert zlib.decompress(chunks[b"IDAT"]) == b"\x00\x00\x00\x00\x00", "one clear pixel"
    assert b"IEND" in chunks


# ------------------------------------------------------------------ client

def test_tiles_are_relayed_with_the_key_and_no_coverage_answers_none():
    seen = []

    def handle(request):
        seen.append(str(request.url))
        if "/13/3172/6985.jpeg" in request.url.path:
            return httpx.Response(200, content=b"\xff\xd8jpeg", headers={"content-type": "image/jpeg"})
        return httpx.Response(200, text=OWS_EXCEPTION, headers={"content-type": "application/xml;charset=UTF-8"})

    client = VWorldClient(KEY, "http://dashboard.test", transport=httpx.MockTransport(handle))
    assert asyncio.run(client.tile("Satellite", 13, 3172, 6985)) == (b"\xff\xd8jpeg", "image/jpeg")
    assert asyncio.run(client.tile("Satellite", 13, 3000, 7000)) is None
    assert seen[0] == f"https://api.vworld.kr/req/wmts/1.0.0/{KEY}/Satellite/13/3172/6985.jpeg"
    with pytest.raises(ValueError):
        asyncio.run(client.tile("gray", 13, 1, 1))
    with pytest.raises(ValueError):
        asyncio.run(client.tile("Base", 20, 1, 1))
    asyncio.run(client.aclose())


def test_a_cell_is_paged_shaped_and_remembered():
    calls = []

    def handle(request):
        params = dict(request.url.params)
        calls.append(params)
        assert params["key"] == KEY and params["domain"] == "http://dashboard.test" and params["data"] == "LT_C_BLDGINFO"
        assert params["geomFilter"] == "BOX(126.97,37.56,126.98,37.57)" and params["size"] == "1000"
        if params["page"] == "1":
            return httpx.Response(200, json=page([feature(f"b{i}", SQUARE, grnd_flr="2") for i in range(1000)], 1001))
        return httpx.Response(200, json=page([feature("last", SQUARE, height="80")], 1001))

    clock = [100.0]
    client = VWorldClient(KEY, "http://dashboard.test", transport=httpx.MockTransport(handle), clock=lambda: clock[0])

    async def run():
        first = await client.buildings(12697, 3756)
        again = await client.buildings(12697, 3756)
        return first, again

    first, again = asyncio.run(run())
    assert len(first["buildings"]) == 1001 and first["total"] == 1001 and first["truncated"] is False
    assert first["buildings"][-1]["height_m"] == 80.0 and first["buildings"][0]["height_m"] == 6.6
    assert first["bbox"] == [126.97, 37.56, 126.98, 37.57] and first["cell"] == [12697, 3756]
    assert len(calls) == 2, "two pages, then the cell is answered from memory"
    assert again is first
    clock[0] += 7 * 3600
    asyncio.run(client.buildings(12697, 3756))
    assert len(calls) == 4, "an old cell is asked for again"
    asyncio.run(client.aclose())


def test_an_empty_or_foreign_cell_makes_no_request_beyond_the_first_page():
    calls = []

    def handle(request):
        calls.append(1)
        return httpx.Response(200, json=page([], 0))

    client = VWorldClient(KEY, "d", transport=httpx.MockTransport(handle))
    assert asyncio.run(client.buildings(12500, 3600))["buildings"] == []
    assert len(calls) == 1
    assert asyncio.run(client.buildings(13969, 3568))["buildings"] == [], "Tokyo"
    assert len(calls) == 1, "outside the service area nothing is asked"
    asyncio.run(client.aclose())


def test_concurrent_requests_for_one_cell_share_one_fetch():
    calls = []

    def handle(request):
        calls.append(1)
        return httpx.Response(200, json=page([feature("b", SQUARE)], 1))

    client = VWorldClient(KEY, "d", transport=httpx.MockTransport(handle))

    async def run():
        return await asyncio.gather(*(client.buildings(12697, 3756) for _ in range(5)))

    results = asyncio.run(run())
    assert len(calls) == 1 and all(result["buildings"][0]["id"] == "b" for result in results)
    asyncio.run(client.aclose())


# ------------------------------------------------------------------ wire

def app_with(client):
    app = FastAPI()
    app.include_router(create_vworld_router(client))
    return app


def test_routes_relay_tiles_and_cells_and_never_the_key():
    def handle(request):
        if "/wmts/" in request.url.path:
            if "/3172/6985" in request.url.path:
                return httpx.Response(200, content=b"png-bytes", headers={"content-type": "image/png"})
            return httpx.Response(200, text=OWS_EXCEPTION, headers={"content-type": "application/xml"})
        return httpx.Response(200, json=page([feature("b1", SQUARE, grnd_flr="4")], 1))

    client = VWorldClient(KEY, "d", transport=httpx.MockTransport(handle))
    with TestClient(app_with(client)) as web:
        tile = web.get("/api/visualization/vworld/tiles/Base/13/3172/6985.png")
        assert tile.status_code == 200 and tile.content == b"png-bytes" and tile.headers["content-type"] == "image/png"
        assert tile.headers["cache-control"] == "public, max-age=86400"
        blank = web.get("/api/visualization/vworld/tiles/Base/13/1/1.png")
        assert blank.status_code == 200 and blank.headers["content-type"] == "image/png" and blank.content.startswith(b"\x89PNG")
        assert web.get("/api/visualization/vworld/tiles/Base/13/1/1.jpeg").status_code == 404, "the extension is the layer's own"
        assert web.get("/api/visualization/vworld/tiles/gray/13/1/1.png").status_code == 404
        assert web.get("/api/visualization/vworld/tiles/Base/20/1/1.png").status_code == 404
        cell = web.get("/api/visualization/vworld/buildings/12697/3756")
        assert cell.status_code == 200 and cell.headers["cache-control"] == "private, max-age=3600"
        body = cell.json()
        assert body["schema_version"] == 1 and body["buildings"][0]["height_m"] == 13.2 and body["cell"] == [12697, 3756]
        assert KEY not in cell.text and KEY not in tile.headers.get("content-type", "")
        assert web.get("/api/visualization/vworld/buildings/1/1", headers={"Origin": "https://evil.example"}).status_code == 403


def test_routes_answer_not_configured_and_sanitise_failures():
    with TestClient(app_with(None)) as web:
        assert web.get("/api/visualization/vworld/tiles/Base/13/1/1.png").status_code == 404
        assert web.get("/api/visualization/vworld/buildings/1/1").status_code == 404

    def handle(request):
        return httpx.Response(500, text=f"upstream said {KEY}")

    client = VWorldClient(KEY, "d", transport=httpx.MockTransport(handle))
    with TestClient(app_with(client)) as web:
        tile = web.get("/api/visualization/vworld/tiles/Base/13/3172/6985.png")
        assert tile.status_code == 503 and KEY not in tile.text
        cell = web.get("/api/visualization/vworld/buildings/12697/3756")
        assert cell.status_code == 503 and KEY not in cell.text


# ------------------------------------------------------------------ credentials and settings

def test_the_key_comes_from_the_profile_file_and_stays_out_of_config(tmp_path):
    path = tmp_path / "vworld.json"
    path.write_text(json.dumps({"apiKey": " key-value "}), encoding="utf-8")
    env = {}
    configure_vworld(path, env)
    assert env["AERODT_VWORLD_API_KEY"] == "key-value"
    path.write_text('{"apiKey": ""}', encoding="utf-8")
    with pytest.raises(ValueError) as error:
        configure_vworld(path, {})
    assert "apiKey" in str(error.value)
    env = {"AERODT_VWORLD_API_KEY": "given"}
    configure_vworld(tmp_path / "absent.json", env)
    assert env["AERODT_VWORLD_API_KEY"] == "given"


def test_the_operator_chooses_the_provider_and_the_world_wide_ones_stay_default():
    assert DEFAULTS["buildings"]["provider"] == "osm" and DEFAULTS["imagery"]["provider"] == "world_imagery"
    settings = validate_settings({"sources": {"buildings": {"provider": "vworld"}, "imagery": {"provider": "vworld_hybrid"}}})
    assert settings["sources"]["buildings"] == {"enabled": True, "provider": "vworld", "quality": "balanced",
                                                "opacity": 0.9, "distance": "auto",
                                                "tint": "neutral", "brightness": 1.0}
    assert settings["sources"]["imagery"] == {"provider": "vworld_hybrid"}
    with pytest.raises(ValueError) as error:
        validate_settings({"sources": {"imagery": {"provider": "google"}}})
    assert str(error.value).startswith("imagery.provider:")
    described = describe_library(settings["sources"])
    buildings = next(source for source in described["sources"] if source["id"] == "buildings")
    imagery = next(source for source in described["sources"] if source["id"] == "imagery")
    assert buildings["provider"].startswith("브이월드") and imagery["provider"].startswith("브이월드")
    assert [choice["id"] for choice in imagery["fields"][0]["choices"]] == [item["id"] for item in PROVIDERS["imagery"]]
    terrain = next(source for source in described["sources"] if source["id"] == "terrain")
    assert "DEM" in terrain["note"], "the note says why terrain has no V-World choice"


def test_the_app_reports_whether_the_chosen_provider_can_be_served(tmp_path, monkeypatch):
    from user_application.apps.web_dashboard.application import create_app
    monkeypatch.delenv("AERODT_VWORLD_API_KEY", raising=False)
    config = {"workspace_directory": str(tmp_path), "cache_directory": str(tmp_path / "cache"),
              "celestrak_enabled": False, "opensky_enabled": False, "tick_seconds": 10, "vworld_enabled": True}
    with TestClient(create_app(config, sources=[])) as web:
        assert web.get("/api/visualization/vworld/tiles/Base/13/1/1.png").status_code == 404, "no key, no relay"
        web.put("/api/library/sources", json={"sources": {"buildings": {"provider": "vworld"}}})
        state = {item["id"]: item for item in web.get("/api/library/sources").json()["state"]}
        assert state["buildings"]["status"] == "unavailable" and "vworld.json" in state["buildings"]["message"]
        assert state["imagery"]["status"] == "ready"
    monkeypatch.setenv("AERODT_VWORLD_API_KEY", KEY)
    with TestClient(create_app(config, sources=[])) as web:
        state = {item["id"]: item for item in web.get("/api/library/sources").json()["state"]}
        assert state["buildings"]["status"] == "ready" and "브이월드" in state["buildings"]["message"]
        assert web.get("/api/visualization/vworld/tiles/gray/13/1/1.png").status_code == 404, "the relay is up; only the layer is unknown"


def test_hybrid_buildings_are_a_separate_choice_and_preserve_display_preferences():
    chosen = {"provider": "vworld_hybrid", "quality": "wide", "distance": "metro",
              "opacity": .65, "tint": "sand", "brightness": 1.2}
    settings = validate_settings({"sources": {"buildings": chosen}})
    assert settings["sources"]["buildings"] == {"enabled": True, **chosen}
    assert settings["sources"]["imagery"]["provider"] == "world_imagery"
    buildings = next(source for source in describe_library(settings["sources"])["sources"]
                     if source["id"] == "buildings")
    choices = next(field["choices"] for field in buildings["fields"] if field["name"] == "provider")
    assert {item["id"] for item in choices} == {"osm", "vworld", "vworld_3d", "vworld_hybrid"}
    assert "혼합" in buildings["provider"]
    assert "키" in next(item["note"] for item in choices if item["id"] == "vworld_hybrid")


@pytest.mark.parametrize("key, enabled, ready", [(None, True, False), (KEY, True, True), (KEY, False, False)])
def test_hybrid_status_explains_public_near_tiles_and_keyed_far_buildings(tmp_path, monkeypatch, key, enabled, ready):
    from user_application.apps.web_dashboard.application import create_app
    if key:
        monkeypatch.setenv("AERODT_VWORLD_API_KEY", key)
    else:
        monkeypatch.delenv("AERODT_VWORLD_API_KEY", raising=False)
    config = {"workspace_directory": str(tmp_path), "cache_directory": str(tmp_path / "cache"),
              "celestrak_enabled": False, "opensky_enabled": False, "tick_seconds": 10,
              "vworld_enabled": enabled}
    with TestClient(create_app(config, sources=[])) as web:
        applied = web.put("/api/library/sources", json={"sources": {"buildings": {"provider": "vworld_hybrid"}}})
        assert applied.status_code == 200
        state = next(item for item in applied.json()["state"] if item["id"] == "buildings")
        assert state["status"] == ("ready" if ready else "unavailable")
        assert "근거리 공개 실사 3D" in state["message"] and "원거리 단순 건물" in state["message"]
        assert ("vworld.json" in state["message"]) is not ready
        assert KEY not in applied.text
        pure_3d = web.put("/api/library/sources", json={"sources": {"buildings": {"provider": "vworld_3d"}}})
        assert next(item for item in pure_3d.json()["state"] if item["id"] == "buildings")["status"] == "ready"
