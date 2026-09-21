"""Imagery reuse must save provider calls without creating a request/memory backlog."""
import asyncio

import httpx
import pytest
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from communication.external import vworld
from communication.external.vworld import VWorldClient
from communication.web.response_compression import TileAwareGZipMiddleware
from communication.web.vworld_routes import create_vworld_router


def image(content=b"image"):
    return httpx.Response(200, content=content, headers={"content-type": "image/jpeg;charset=UTF-8"})


def test_imagery_requests_share_fetch_and_revisit_cached_original_bytes():
    calls = []

    async def handle(request):
        calls.append(request.url.path)
        await asyncio.sleep(0)
        return image(b"original-photograph")

    async def run():
        client = VWorldClient("key", "domain", transport=httpx.MockTransport(handle))
        results = await asyncio.gather(*(client.tile("Satellite", 13, 3172, 6985) for _ in range(12)))
        assert len(calls) == 1
        assert all(result == (b"original-photograph", "image/jpeg") for result in results)
        assert await client.tile("Satellite", 13, 3172, 6985) == results[0]
        assert len(calls) == 1
        await client.tile("Hybrid", 13, 3172, 6985)
        assert len(calls) == 2, "layer variants do not collide"
        assert client.imagery_cache_bytes == 2 * len(b"original-photograph")
        await client.aclose()
        assert not client._imagery and client.imagery_cache_bytes == 0

    asyncio.run(run())


def test_imagery_lru_and_expiry_keep_a_real_byte_budget():
    calls, now = [], [100]

    def handle(request):
        calls.append(request.url.path)
        return image(b"1234")

    async def run():
        client = VWorldClient("key", "domain", transport=httpx.MockTransport(handle),
                              clock=lambda: now[0], imagery_cache_bytes=8)
        for column in (6985, 6986, 6985, 6987):
            await client.tile("Satellite", 13, 3172, column)
        assert len(calls) == 3 and client.imagery_cache_bytes == 8
        await client.tile("Satellite", 13, 3172, 6985)
        assert len(calls) == 3, "a hit moves the original tile to the MRU end"
        await client.tile("Satellite", 13, 3172, 6986)
        assert len(calls) == 4 and client.imagery_cache_bytes == 8
        now[0] += vworld.IMAGERY_CACHE_SECONDS
        await client.tile("Satellite", 13, 3172, 6986)
        assert len(calls) == 5 and client.imagery_cache_bytes == 8
        await client.aclose()

    asyncio.run(run())


def test_one_large_valid_image_is_served_without_retaining_it():
    calls = []

    def handle(request):
        calls.append(request.url.path)
        return image(b"12345678")

    async def run():
        client = VWorldClient("key", "domain", transport=httpx.MockTransport(handle), imagery_cache_bytes=4)
        for _ in range(2):
            assert await client.tile("Satellite", 13, 3172, 6985) == (b"12345678", "image/jpeg")
        assert len(calls) == 2 and not client._imagery and client.imagery_cache_bytes == 0
        await client.aclose()

    asyncio.run(run())


def test_empty_imagery_is_reused_with_bounded_entries_and_shorter_expiry(monkeypatch):
    monkeypatch.setattr(vworld, "IMAGERY_CACHE_ENTRIES", 3)
    calls, now = [], [100]

    def handle(request):
        calls.append(request.url.path)
        return httpx.Response(200, content=b"<ExceptionReport/>", headers={"content-type": "application/xml"})

    async def run():
        client = VWorldClient("key", "domain", transport=httpx.MockTransport(handle), clock=lambda: now[0])
        for column in (6985, 6985, 6986, 6987, 6988):
            assert await client.tile("Satellite", 13, 3172, column) is None
        assert len(calls) == 4 and len(client._imagery) == 3 and client.imagery_cache_bytes == 0
        now[0] += vworld.IMAGERY_EMPTY_SECONDS
        assert await client.tile("Satellite", 13, 3172, 6988) is None
        assert len(calls) == 5
        await client.aclose()

    asyncio.run(run())


def test_failed_or_oversized_imagery_is_not_cached_and_retry_cools_down(monkeypatch):
    monkeypatch.setattr(vworld, "MAX_IMAGERY_BYTES", 4)
    calls, now = [], [100]

    def handle(request):
        calls.append(request.url.path)
        if len(calls) == 1:
            return httpx.Response(503, text="key must stay private")
        return image(b"large" if len(calls) == 2 else b"ok")

    async def run():
        client = VWorldClient("key", "domain", transport=httpx.MockTransport(handle), clock=lambda: now[0])
        for expected_calls in (1, 2):
            for _ in range(3):
                with pytest.raises(RuntimeError, match="^tile provider unavailable$"):
                    await client.tile("Satellite", 13, 3172, 6985)
            assert len(calls) == expected_calls and client.imagery_cache_bytes == 0
            now[0] += vworld.IMAGERY_RETRY_SECONDS
        assert await client.tile("Satellite", 13, 3172, 6985) == (b"ok", "image/jpeg")
        assert len(calls) == 3 and not client._imagery_retry
        await client.aclose()

    asyncio.run(run())


def test_cancelled_viewer_does_not_abort_shared_imagery():
    async def run():
        entered, release = asyncio.Event(), asyncio.Event()
        calls = []

        async def handle(request):
            calls.append(request.url.path)
            entered.set()
            await release.wait()
            return image()

        client = VWorldClient("key", "domain", transport=httpx.MockTransport(handle))
        first = asyncio.create_task(client.tile("Satellite", 13, 3172, 6985))
        await entered.wait()
        other = asyncio.create_task(client.tile("Satellite", 13, 3172, 6985))
        await asyncio.sleep(0)
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        release.set()
        assert await other == (b"image", "image/jpeg")
        assert len(calls) == 1
        await client.aclose()

    asyncio.run(run())


def test_imagery_limits_active_and_queued_requests_and_close_cancels_both():
    async def run():
        release, slots_full = asyncio.Event(), asyncio.Event()
        active, peak = 0, 0

        async def handle(_):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            if active == 8:
                slots_full.set()
            try:
                await release.wait()
                return image()
            finally:
                active -= 1

        client = VWorldClient("key", "domain", transport=httpx.MockTransport(handle))
        callers = [asyncio.create_task(client.tile("Satellite", 13, 3172, 6985 + index)) for index in range(64)]
        await slots_full.wait()
        assert len(client._imagery_pending) == 64 and peak == 8
        with pytest.raises(RuntimeError, match="busy"):
            await client.tile("Satellite", 13, 3172, 7050)
        await client.aclose()
        results = await asyncio.gather(*callers, return_exceptions=True)
        assert all(isinstance(result, asyncio.CancelledError) for result in results)
        assert not client._imagery_pending and not client._imagery_retry and active == 0

    asyncio.run(run())


def test_imagery_route_reuses_bytes_without_recompressing_but_json_still_compresses():
    calls = []
    photo = bytes(range(256)) * 16

    def handle(request):
        calls.append(request.url.path)
        return image(photo)

    client = VWorldClient("private-key", "domain", transport=httpx.MockTransport(handle))
    app = FastAPI()
    app.include_router(create_vworld_router(client))
    app.add_middleware(TileAwareGZipMiddleware)

    @app.get("/ordinary-json")
    def ordinary():
        return JSONResponse({"value": "long-json" * 1000})

    with TestClient(app) as web:
        for _ in range(2):
            response = web.get("/api/visualization/vworld/tiles/Satellite/13/3172/6985.jpeg",
                               headers={"Accept-Encoding": "gzip"})
            assert response.content == photo
            assert response.headers["content-type"] == "image/jpeg"
            assert response.headers["cache-control"] == "public, max-age=86400"
            assert "content-encoding" not in response.headers
        assert len(calls) == 1
        assert web.get("/ordinary-json", headers={"Accept-Encoding": "gzip"}).headers["content-encoding"] == "gzip"
        rejected = web.get("/api/visualization/vworld/tiles/Satellite/13/3172/6985.jpeg",
                           headers={"Origin": "https://other.invalid"})
        assert rejected.status_code == 403 and len(calls) == 1, "origin check still precedes cache hit"
    asyncio.run(client.aclose())
