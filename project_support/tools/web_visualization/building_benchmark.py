"""Repeatable local tile-response benchmark; no network or credentials.

Pass an existing original V-World B3DM as --tile. Compares old per-response
gzip-9 with the new pre-encoded cache, including a saved-cache reopen. This is
NOT a Cesium FPS benchmark. The original mesh and near/overview photo limits
are identical in both paths.
"""
import argparse
import asyncio
import json
import statistics
import tempfile
import time
from pathlib import Path

import httpx
from fastapi import FastAPI
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import Response

from communication.external.vworld import VWorldClient, tile_payload
from communication.external.vworld_texture import modernize_b3dm
from communication.web.vworld_routes import create_vworld_router
from communication.web.response_compression import TileAwareGZipMiddleware
from data.ingestion.vworld_tiles import VWorldTileRecords


async def benchmark(tile):
    start = time.perf_counter()
    converted = await asyncio.to_thread(modernize_b3dm, tile, overview=True)
    conversion_ms = (time.perf_counter() - start) * 1000
    payload = await asyncio.to_thread(tile_payload, converted, 'application/octet-stream')
    old = FastAPI()
    old.add_middleware(GZipMiddleware, minimum_size=1000)

    @old.get('/tile')
    async def original():
        return Response(converted, media_type='application/octet-stream')

    client = VWorldClient(None, '', public_tiles_only=True)
    client._remember_tile(('a.b3dm', 'full'), payload)
    new = FastAPI()
    new.add_middleware(TileAwareGZipMiddleware)
    new.include_router(create_vworld_router(None, tiles_client=client))

    async def sample(app, path):
        elapsed, wire = [], 0
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://benchmark') as web:
            for _ in range(9):
                start = time.perf_counter()
                response = await web.get(path, headers={'Accept-Encoding': 'gzip'})
                elapsed.append((time.perf_counter() - start) * 1000)
                assert response.content == converted
                wire = int(response.headers['content-length'])
            fresh = await web.get(path, headers={'If-None-Match': payload.etag})
        return {'median_ms': statistics.median(elapsed), 'samples_ms': elapsed, 'wire_bytes': wire,
                'conditional_status': fresh.status_code, 'conditional_body_bytes': len(fresh.content)}

    before = await sample(old, '/tile')
    after = await sample(new, '/api/visualization/vworld/3d/a.b3dm')
    with tempfile.TemporaryDirectory() as directory:
        VWorldTileRecords(directory).put('v5:sample', payload.content)
        start = time.perf_counter()
        restored = VWorldTileRecords(directory).get('v5:sample')
        reopen_ms = (time.perf_counter() - start) * 1000
        assert restored[0] == payload.content
    await client.aclose()
    return {'conversion_ms': conversion_ms, 'raw_bytes': len(converted), 'cached_encoded_bytes': len(payload.content),
            'before': before, 'after': after, 'saved_reopen_ms': reopen_ms,
            'scope': 'Same local B3DM, same geometry/photos, nine warm ASGI requests including client decode; no GPU/FPS claim'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tile', required=True, type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    result = asyncio.run(benchmark(args.tile.read_bytes()))
    encoded = json.dumps(result, indent=2)
    if args.output:
        args.output.write_text(encoded + '\n', encoding='utf-8')
    print(encoded)
