"""Textured V-World tiles: bounded, same-origin, no arbitrary URL relay."""
import asyncio
import gzip
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from communication.external.vworld import VWorldClient
from project_support.tests.web_live.test_vworld import app_with
from project_support.tests.web_live.test_vworld_texture import make_tile


def test_3d_tiles_preserve_textures_and_relay_only_relative_references():
    seen = []
    document = {"asset": {"version": "0.0"}, "geometricError": 100,
                "root": {"boundingVolume": {"region": [2.21, .65, 2.22, .66, 0, 300]},
                         "geometricError": 20, "refine": "REPLACE",
                         "content": {"uri": "$S_1_from_tileset.json"},
                         "children": [{"content": {"uri": "B_0.b3dm"}, "geometricError": 0}]}}

    def handle(request):
        seen.append(request.url)
        if request.url.path.endswith(".json"):
            return httpx.Response(200, content=b"\xef\xbb\xbf" + json.dumps(document).encode())
        return httpx.Response(200, content=make_tile())

    client = VWorldClient("private-key", "https://dashboard.test", transport=httpx.MockTransport(handle))
    with TestClient(app_with(client)) as web:
        path = "/api/visualization/vworld/3d/Seoul/Jung-gu/tileset.json"
        result = web.get(path)
        assert result.status_code == 200
        body = result.json()
        assert body["root"]["content"]["uri"] == "/api/visualization/vworld/3d/Seoul/Jung-gu/$S_1_from_tileset.json?v=5"
        assert body["root"]["children"][0]["content"]["uri"].endswith("/Seoul/Jung-gu/B_0.b3dm?v=4")
        assert body["root"]["refine"] == "REPLACE", "LOD substitution must not become additive (z-fighting)"
        assert "private-key" not in result.text and "xdworld" not in result.text
        assert result.headers["cache-control"] == "private, max-age=3600"
        assert web.get(path).content == result.content and len(seen) == 1, "bounded in-memory cache"
        tile = web.get("/api/visualization/vworld/3d/Seoul/Jung-gu/B_0.b3dm")
        assert tile.content == make_tile()
        assert all(url.host == "xdworld.vworld.kr" for url in seen)
        assert all(str(url).startswith("https://xdworld.vworld.kr/TDServer/services/facility_LOD4/") for url in seen)


@pytest.mark.parametrize("path", ["https://evil.test/x.json", "../x.json", "Seoul/../x.json", "x.json?key=secret", "x%2f..%2fx.json", "x.exe", "x\\y.json"])
def test_3d_relay_refuses_paths_before_requesting(path):
    def handle(_):
        pytest.fail("an invalid path must never reach the network")
    client = VWorldClient("key", "domain", transport=httpx.MockTransport(handle))
    with pytest.raises(ValueError):
        asyncio.run(client.tiles3d(path))


def test_3d_relay_rejects_foreign_upstream_references_and_sanitises_errors():
    def handle(_):
        return httpx.Response(200, json={"asset": {"version": "1.0"}, "root": {"content": {"uri": "https://evil.test/key-secret.b3dm"}}})
    with TestClient(app_with(VWorldClient("key-secret", "domain", transport=httpx.MockTransport(handle)))) as web:
        response = web.get("/api/visualization/vworld/3d/tileset.json")
        assert response.status_code == 503 and "key-secret" not in response.text
        assert web.get("/api/visualization/vworld/3d/x.json", headers={"Origin": "https://elsewhere.test"}).status_code == 403
    with TestClient(app_with(None)) as web:
        assert web.get("/api/visualization/vworld/3d/tileset.json").status_code == 404


def test_empty_spatial_indexes_do_not_become_invisible_overview_lod():
    region = {"region": [2.21, .65, 2.22, .66, 0, 300]}
    document = {"asset": {"version": "0.0"}, "root": {
        "geometricError": 322, "refine": "ADD", "boundingVolume": region,
        "children": [{"geometricError": 80, "children": [
            {"geometricError": 40, "refine": "REPLACE", "content": {"uri": "B_0.b3dm"},
             "children": [{"geometricError": 0, "content": {"uri": "B_1.b3dm"}}]}]}]}}
    client = VWorldClient(None, "", public_tiles_only=True)
    result = json.loads(client._relay_document(document, "Seoul/test/tileset.json"))
    root = result["root"]
    assert root["geometricError"] == 4096 and root["refine"] == "ADD", "inherited refinement semantics must not change"
    assert root["boundingVolume"] == region
    empty = root["children"][0]
    assert empty["geometricError"] == 4096
    model = empty["children"][0]
    assert model["geometricError"] == 40 and model["refine"] == "REPLACE"
    assert model["content"]["uri"].endswith("?v=4&texture=overview")
    assert "texture=" not in model["children"][0]["content"]["uri"], "near leaves retain detailed facade photos"
    assert model["children"][0]["geometricError"] == 0
    # At 20 km / 1000 px the old empty SSE=4 stopped at an absent model;
    # the structural node now traverses, but the real coarse SSE=2 can stop.
    assert 80 * 1000 / 20000 < 10 < empty["geometricError"] * 1000 / 20000
    assert model["geometricError"] * 1000 / 20000 < 10


def test_additive_landmarks_and_external_json_do_not_lose_their_full_photos():
    client = VWorldClient(None, "", public_tiles_only=True)
    doc = {"asset": {"version": "0.0"}, "root": {"refine": "ADD", "content": {"uri": "landmark.b3dm"},
           "children": [{"refine": "REPLACE", "content": {"uri": "nested.json"}, "children": [{"content": {"uri": "leaf.b3dm"}}]}]}}
    result = client._relay_document(doc, "Seoul/tileset.json").decode()
    assert "texture=overview" not in result


def test_coverage_hint_uses_only_real_mesh_regions_and_preserves_source_metadata():
    outer = [2.21, .65, 2.22, .66, 0, 300]
    actual = [2.214, .654, 2.21404, .65404, 20, 100]
    tile = {"boundingVolume": {"region": outer}, "refine": "REPLACE",
            "extras": {"sourceTag": "keep"}, "content": {"uri": "overview.b3dm", "boundingVolume": {"region": actual}},
            "children": [{"content": {"url": "leaf.b3dm"}, "boundingVolume": {"region": actual}},
                         {"content": {"uri": "nested.json"}, "boundingVolume": {"region": outer}},
                         {"boundingVolume": {"region": outer}}]}
    client = VWorldClient(None, "", public_tiles_only=True)
    result = json.loads(client._relay_document({"asset": {"version": "1.0"}, "root": tile}, "Seoul/tileset.json"))["root"]
    assert result["extras"] == {"sourceTag": "keep", "aerodtCoverageRegion": actual}
    assert result["boundingVolume"]["region"] == outer
    assert result["content"]["boundingVolume"]["region"] == actual
    assert result["children"][0]["extras"]["aerodtCoverageRegion"] == actual
    assert "extras" not in result["children"][1] and "extras" not in result["children"][2]
    assert result["content"]["uri"].endswith("?v=4&texture=overview")
    assert result["children"][1]["content"]["uri"].endswith("?v=5")


@pytest.mark.parametrize("region", [None, [2.21, .65], [2.22, .65, 2.21, .66, 0, 100],
    [2.21, .65, 2.22, .66, 100, 0], [2.21, .65, 2.22, 2, 0, 100],
    [2.21, .65, float("nan"), .66, 0, 100], [2.21, .65, 2.22, .66, 0, float("inf")],
    [2.21, .65, 2.22, .66, False, 100], ["2.21", .65, 2.22, .66, 0, 100]])
def test_invalid_mesh_regions_do_not_hide_fallback_buildings(region):
    tile = {"content": {"uri": "leaf.b3dm"}, "boundingVolume": {"region": region}}
    VWorldClient._annotate_coverage(tile)
    assert "extras" not in tile


def test_coverage_hint_falls_back_to_tile_region_without_replacing_existing_extras():
    region = [2.214, .654, 2.21404, .65404, 20, 100]
    tile = {"content": {"uri": "leaf.b3dm", "boundingVolume": {"region": []}},
            "boundingVolume": {"region": region}, "extras": ["provider-owned"]}
    VWorldClient._annotate_coverage(tile)
    assert tile["extras"] == ["provider-owned"]
    tile["extras"] = {"source": 2}
    VWorldClient._annotate_coverage(tile)
    assert tile["extras"] == {"source": 2, "aerodtCoverageRegion": region}


def test_texture_variants_share_the_byte_budget_but_not_cached_results_or_credentials():
    seen = []
    def handle(request):
        seen.append(str(request.url))
        assert not request.url.query, "display texture hint and credentials never reach the public origin"
        return httpx.Response(200, content=make_tile())
    client = VWorldClient(None, "", public_tiles_only=True, transport=httpx.MockTransport(handle), tiles_cache_bytes=len(make_tile()) + 1)
    with TestClient(app_with(client)) as web:
        url = "/api/visualization/vworld/3d/a.b3dm"
        assert web.get(url + "?texture=unlimited").status_code == 404
        assert web.get("/api/visualization/vworld/3d/a.json?texture=overview").status_code == 404
        assert not seen
        assert web.get(url).status_code == 200
        assert web.get(url + "?texture=overview").status_code == 200
        assert web.get(url + "?texture=overview").status_code == 200
        assert len(seen) == 2
        assert client.tiles_cache_bytes <= client._tiles_budget
        assert web.get(url).status_code == 200 and len(seen) == 3, "same LRU evicts across both texture variants"


def test_3d_cache_has_a_byte_budget_and_concurrent_clients_share_a_request():
    seen = []
    async def handle(request):
        seen.append(request.url.path)
        await asyncio.sleep(.001)
        return httpx.Response(200, content=make_tile())
    budget = len(make_tile()) + 1
    client = VWorldClient("key", "domain", transport=httpx.MockTransport(handle), tiles_cache_bytes=budget)
    async def run():
        await asyncio.gather(*(client.tiles3d("one.b3dm") for _ in range(5)))
        assert len(seen) == 1
        await client.tiles3d("two.b3dm")
        assert client.tiles_cache_bytes <= budget
        await client.tiles3d("one.b3dm")
        assert len(seen) == 3, "the old tile was evicted, not an unbounded cache"
        await client.aclose()
    asyncio.run(run())


def test_public_textured_tiles_do_not_enable_keyed_imagery_or_footprints():
    client = VWorldClient(None, "", public_tiles_only=True, transport=httpx.MockTransport(lambda _: httpx.Response(200, content=make_tile())))
    async def run():
        assert (await client.tiles3d("a.b3dm"))[0] == make_tile()
        with pytest.raises(ValueError):
            await client.tile("Base", 13, 1, 1)
        with pytest.raises(ValueError):
            await client.buildings(12697, 3756)
        await client.aclose()
    asyncio.run(run())


def test_failed_tiles_back_off_and_cancelled_waiters_do_not_leak_inflight_tasks():
    calls = []
    clock = [0]
    async def handle(_):
        calls.append(1)
        await asyncio.sleep(.01)
        return httpx.Response(500, text="upstream-private")
    client = VWorldClient(None, "", public_tiles_only=True, transport=httpx.MockTransport(handle), clock=lambda: clock[0])
    async def run():
        waiting = asyncio.create_task(client.tiles3d("a.b3dm"))
        await asyncio.sleep(.001)
        waiting.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiting
        await asyncio.sleep(.03)
        assert not client._tiles_pending
        with pytest.raises(RuntimeError):
            await client.tiles3d("a.b3dm")
        assert len(calls) == 1
        clock[0] = 61
        with pytest.raises(RuntimeError):
            await client.tiles3d("a.b3dm")
        assert len(calls) == 2
        await client.aclose()
    asyncio.run(run())


def test_cancelled_footprint_requests_do_not_keep_finished_cells_outside_the_lru_forever():
    async def handle(_):
        await asyncio.sleep(.01)
        return httpx.Response(200, json={"response": {"status": "NOT_FOUND"}})
    client = VWorldClient("key", "domain", transport=httpx.MockTransport(handle))
    async def run():
        waiting = asyncio.create_task(client.buildings(12697, 3756))
        await asyncio.sleep(.001)
        waiting.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiting
        await asyncio.sleep(.03)
        assert not client._pending
        assert len(client._cells) == 1
        await client.aclose()
    asyncio.run(run())


def test_http_reuses_precompressed_payload_and_honours_encoding_and_etag(monkeypatch):
    from communication.external import vworld
    tile = make_tile(binary=b'a' * 4096)
    packed = []
    original = vworld.tile_payload
    def pack(*args, **kwargs):
        packed.append(1)
        return original(*args, **kwargs)
    monkeypatch.setattr(vworld, 'tile_payload', pack)
    client = VWorldClient(None, '', public_tiles_only=True,
                         transport=httpx.MockTransport(lambda _: httpx.Response(200, content=tile)))
    from communication.web.response_compression import TileAwareGZipMiddleware
    app = app_with(client)
    app.add_middleware(TileAwareGZipMiddleware)
    with TestClient(app) as web:
        url = '/api/visualization/vworld/3d/a.b3dm'
        first = web.get(url, headers={'Accept-Encoding': 'gzip'})
        assert first.content == tile and first.headers['content-encoding'] == 'gzip'
        assert first.headers['vary'] == 'Accept-Encoding'
        assert web.get(url).headers['etag'] == first.headers['etag']
        fresh = web.get(url, headers={'If-None-Match': first.headers['etag']})
        assert fresh.status_code == 304 and fresh.content == b''
        identity = web.get(url, headers={'Accept-Encoding': 'gzip;q=0, identity;q=1'})
        assert identity.content == first.content and 'content-encoding' not in identity.headers
        wildcard = web.get(url, headers={'Accept-Encoding': '*;q=1, gzip;q=0'})
        assert wildcard.content == first.content and 'content-encoding' not in wildcard.headers
        assert len(packed) == 1, 'cache hits and 304s must not recompress megabytes on the event loop'
        assert client.tiles_cache_bytes == len(gzip.compress(tile, compresslevel=1, mtime=0))
        blocked = web.get(url, headers={'Origin': 'https://other.test', 'If-None-Match': '*'})
        assert blocked.status_code == 403, 'validators cannot bypass same-origin access'


@pytest.mark.parametrize('header, accepted', [('', False), ('gzip', True), ('br, gzip;q=0.5', True),
    ('*;q=1,gzip;q=0', False), ('*;q=0.5', True), ('gzip;q=bad', False)])
def test_gzip_negotiation(header, accepted):
    from communication.web.vworld_routes import accepts_gzip
    assert accepts_gzip(header) is accepted


def test_saved_compressed_tiles_survive_client_restart_without_an_upstream_request(tmp_path):
    from data.ingestion.vworld_tiles import VWorldTileRecords
    seen = []
    def request(_):
        seen.append(1)
        return httpx.Response(200, content=make_tile())
    async def run():
        first = VWorldClient(None, '', public_tiles_only=True, transport=httpx.MockTransport(request),
                             tile_records=VWorldTileRecords(tmp_path))
        payload = await first.tiles3d_payload('a.b3dm')
        await first.aclose()
        second = VWorldClient(None, '', public_tiles_only=True, transport=httpx.MockTransport(request),
                              tile_records=VWorldTileRecords(tmp_path))
        restored = await second.tiles3d_payload('a.b3dm')
        assert payload == restored and len(seen) == 1
        assert await second.tiles3d('a.b3dm') == (make_tile(), 'application/octet-stream')
        await second.aclose()
    asyncio.run(run())


def test_coverage_metadata_refreshes_saved_json_without_discarding_saved_meshes(tmp_path):
    from communication.external.vworld import TILE_METADATA_VERSION, TILE_REPRESENTATION_VERSION
    from data.ingestion.vworld_tiles import VWorldTileRecords
    records = VWorldTileRecords(tmp_path)
    region = [2.214, .654, 2.21404, .65404, 20, 100]
    document = {"asset": {"version": "1.0"}, "root": {
        "content": {"uri": "leaf.b3dm"}, "boundingVolume": {"region": region}}}
    records.put(f"{TILE_REPRESENTATION_VERSION}:tileset.json:full", gzip.compress(json.dumps(document).encode()))
    records.put(f"{TILE_REPRESENTATION_VERSION}:leaf.b3dm:full", gzip.compress(make_tile()))
    seen = []
    def request(request):
        seen.append(request.url.path)
        assert request.url.path.endswith("tileset.json"), "the converted mesh remains in the existing cache"
        return httpx.Response(200, json=document)
    async def run():
        client = VWorldClient(None, "", public_tiles_only=True, tile_records=records,
                              transport=httpx.MockTransport(request))
        content, _ = await client.tiles3d("tileset.json")
        assert json.loads(content)["root"]["extras"]["aerodtCoverageRegion"] == region
        assert (await client.tiles3d("leaf.b3dm"))[0] == make_tile()
        assert len(seen) == 1 and records.get(f"{TILE_METADATA_VERSION}:tileset.json:full") is not None
        await client.aclose()
    asyncio.run(run())
