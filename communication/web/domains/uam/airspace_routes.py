"""The airspace collection and its status, same-origin, for the map."""
from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

_HEADERS = {"Cache-Control": "no-store"}


def create_airspace_router(source):
    """`source` is an AirspaceSource, or None when no credential was found:
    the map then learns it is unconfigured rather than getting an error."""
    router = APIRouter()

    @router.get("/api/airspace/status")
    async def status():
        if source is None:
            return JSONResponse({"state": "unconfigured", "detail": "인증키 없음", "features": 0, "problems": []}, headers=_HEADERS)
        return JSONResponse(source.status(), headers=_HEADERS)

    @router.get("/api/airspace")
    async def collection(refresh: bool = Query(False)):
        if source is None:
            return JSONResponse({"status": {"state": "unconfigured", "detail": "인증키 없음", "features": 0, "problems": []},
                                 "collection": {"type": "FeatureCollection", "features": []}}, headers=_HEADERS)
        try:
            features = await source.fetch(force=refresh)
        except Exception:
            # Never echo the provider's URL, body or the key.
            return JSONResponse({"status": {**source.status(), "state": "error", "detail": "공역 자료를 받지 못했습니다."},
                                 "collection": {"type": "FeatureCollection", "features": []}}, headers=_HEADERS)
        return JSONResponse({"status": source.status(), "collection": features}, headers=_HEADERS)

    return router
