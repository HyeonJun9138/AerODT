"""Same-origin access to the two fixed visualization endpoint adapters."""
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse


_MESSAGES = {'buildings': ('Buildings', 'Building'), 'terrain': ('Terrain', 'Terrain')}


def create_cesium_router(kind, fetch):
    configured_name, provider_name = _MESSAGES[kind]
    router = APIRouter()

    @router.get(f'/api/visualization/{kind}/endpoint', include_in_schema=False)
    async def endpoint(request: Request):
        headers = {'Cache-Control': 'no-store'}
        origin = request.headers.get('origin')
        if (origin and origin != str(request.base_url).rstrip('/')) or request.headers.get('sec-fetch-site') == 'cross-site':
            return JSONResponse({'error': 'Same-origin access required'}, 403, headers=headers)
        if fetch is None:
            return JSONResponse({'error': f'{configured_name} not configured'}, 404, headers=headers)
        try:
            return JSONResponse(await fetch(), headers=headers)
        except Exception:
            # Never return/log upstream URLs, response bodies, or credentials.
            return JSONResponse({'error': f'{provider_name} provider unavailable'}, 503, headers=headers)

    return router
