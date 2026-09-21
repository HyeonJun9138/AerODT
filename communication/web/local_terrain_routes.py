"""Bounded, same-origin local terrain wire format; accepts no file paths."""
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response


def create_local_terrain_router(tiles):
    router = APIRouter()

    def forbidden(request):
        origin = request.headers.get('origin')
        return ((origin and origin != str(request.base_url).rstrip('/'))
                or request.headers.get('sec-fetch-site') == 'cross-site')

    @router.get('/api/visualization/terrain/local', include_in_schema=False)
    def metadata(request: Request):
        if forbidden(request):
            return JSONResponse({'error': 'Same-origin access required'}, 403)
        return JSONResponse(tiles.metadata() if tiles else {'schema_version': 1, 'enabled': False},
                            headers={'Cache-Control': 'no-store'})

    @router.get('/api/visualization/terrain/local/{level}/{x}/{y}', include_in_schema=False)
    def tile(request: Request, level: int, x: int, y: int):
        if forbidden(request):
            return Response(status_code=403)
        if tiles is None:
            return Response(status_code=404)
        try:
            result = tiles.tile(level, x, y)
        except ValueError:
            return Response(status_code=400)
        except (OSError, RuntimeError):
            return Response(status_code=503)
        if result is None:
            return Response(status_code=204)
        return Response(result, media_type='application/octet-stream',
                        headers={'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff'})
    return router
