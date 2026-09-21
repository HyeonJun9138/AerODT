"""Same-origin relay for V-World tiles and building cells. The API key stays on
the server; the browser only ever names a layer, a tile or a cell."""
import asyncio
import gzip

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

from communication.external.vworld import TILE_LAYERS, TILE_LEVELS, TRANSPARENT_PNG

TILE_CACHE = "public, max-age=86400"
CELL_CACHE = "private, max-age=3600"
NO_STORE = {"Cache-Control": "no-store"}


def _cross_origin(request):
    origin = request.headers.get("origin")
    return (origin and origin != str(request.base_url).rstrip("/")) or request.headers.get("sec-fetch-site") == "cross-site"


def accepts_gzip(header):
    qualities = {}
    for item in header.lower().split(','):
        coding, *parameters = item.strip().split(';')
        quality = 1.0
        for parameter in parameters:
            if parameter.strip().startswith('q='):
                try:
                    quality = float(parameter.strip()[2:])
                except ValueError:
                    quality = 0
        qualities[coding] = quality
    return qualities.get('gzip', qualities.get('*', 0)) > 0


def create_vworld_router(client, *, tiles_client=None):
    """`client` is a VWorldClient or None when no key is configured."""
    router = APIRouter()
    tiles_client = tiles_client or client

    @router.get("/api/visualization/vworld/tiles/{layer}/{level}/{row}/{column}.{extension}", include_in_schema=False)
    async def tile(request: Request, layer: str, level: int, row: int, column: int, extension: str):
        if _cross_origin(request):
            return JSONResponse({"error": "Same-origin access required"}, 403, headers=NO_STORE)
        if client is None:
            return JSONResponse({"error": "V-World not configured"}, 404, headers=NO_STORE)
        if TILE_LAYERS.get(layer) != extension or not (TILE_LEVELS[0] <= level <= TILE_LEVELS[1]):
            return JSONResponse({"error": "Unknown tile"}, 404, headers=NO_STORE)
        try:
            answer = await client.tile(layer, level, row, column)
        except ValueError:
            return JSONResponse({"error": "Unknown tile"}, 404, headers=NO_STORE)
        except Exception:
            # Never relay upstream URLs, bodies or the key.
            return JSONResponse({"error": "Tile provider unavailable"}, 503, headers=NO_STORE)
        if answer is None:
            # Outside the service area: a clear tile lets the world imagery show through.
            return Response(TRANSPARENT_PNG, media_type="image/png", headers={"Cache-Control": TILE_CACHE})
        content, kind = answer
        return Response(content, media_type=kind, headers={"Cache-Control": TILE_CACHE})

    @router.get("/api/visualization/vworld/buildings/{column}/{row}", include_in_schema=False)
    async def buildings(request: Request, column: int, row: int):
        if _cross_origin(request):
            return JSONResponse({"error": "Same-origin access required"}, 403, headers=NO_STORE)
        if client is None:
            return JSONResponse({"error": "V-World not configured"}, 404, headers=NO_STORE)
        try:
            cell = await client.buildings(column, row)
        except Exception:
            return JSONResponse({"error": "Building provider unavailable"}, 503, headers=NO_STORE)
        return JSONResponse({"schema_version": 1, **cell}, headers={"Cache-Control": CELL_CACHE})

    @router.get("/api/visualization/vworld/3d/{path:path}", include_in_schema=False)
    async def tiles3d(request: Request, path: str, texture: str = "full"):
        if _cross_origin(request):
            return JSONResponse({"error": "Same-origin access required"}, 403, headers=NO_STORE)
        if tiles_client is None:
            return JSONResponse({"error": "V-World not configured"}, 404, headers=NO_STORE)
        try:
            payload = await tiles_client.tiles3d_payload(path, texture=texture)
        except ValueError:
            return JSONResponse({"error": "Unknown 3D tile"}, 404, headers=NO_STORE)
        except Exception:
            return JSONResponse({"error": "3D tile provider unavailable"}, 503, headers=NO_STORE)
        headers = {"Cache-Control": CELL_CACHE, "X-Content-Type-Options": "nosniff",
                   "Vary": "Accept-Encoding", "ETag": payload.etag}
        tags = [tag.strip().removeprefix('W/') for tag in request.headers.get('if-none-match', '').split(',')]
        if '*' in tags or payload.etag.removeprefix('W/') in tags:
            return Response(status_code=304, headers=headers)
        content = payload.content
        if accepts_gzip(request.headers.get('accept-encoding', '')):
            headers['Content-Encoding'] = 'gzip'  # Middleware must not recompress.
        else:
            content = await asyncio.to_thread(gzip.decompress, content)
        return Response(content, media_type=payload.kind, headers=headers)

    return router
