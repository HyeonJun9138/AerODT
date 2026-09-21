"""Wire for generating a day of flights from the multi-flight setup.

Three requests, because the run takes long enough that one would time out: start
it, ask how it is going, and take the file it made. The generator itself decides
everything; this only relays.
"""
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, PlainTextResponse


def create_plan_generation_router(generator):
    """`generator` exposes start(request), status(), csv().

    `start` raises the generator's own error carrying the field that stopped it;
    a run already going is one of those, and answers 409 rather than 422 because
    nothing is wrong with the request.
    """
    router = APIRouter()

    @router.post("/api/simulation/plans/multi", status_code=202)
    async def start(request: Request):
        try:
            body = await request.json()
        except ValueError:
            return JSONResponse({"schema_version": 1, "error": "invalid_request",
                                 "field": "body", "message": "JSON 본문이 필요합니다"}, status_code=422)
        try:
            state = generator.start(body)
        except ValueError as error:
            field = getattr(error, "field", "")
            busy = field == "state"
            return JSONResponse({"schema_version": 1, "error": "busy" if busy else "invalid_request",
                                 "field": field or None, "message": str(error)},
                                status_code=409 if busy else 422)
        return {"schema_version": 1, **state}

    # The single-flight planner already answers `GET /api/simulation/plans/{id}`
    # and is registered first, so this asks under its own name rather than
    # being read as a plan called "multi".
    @router.get("/api/simulation/plans/multi/status")
    async def status():
        return JSONResponse({"schema_version": 1, **generator.status()},
                            headers={"Cache-Control": "no-store"})

    @router.get("/api/simulation/plans/multi/file")
    async def file():
        text = generator.csv()
        if not text:
            return JSONResponse({"schema_version": 1, "error": "not_found",
                                 "message": "아직 만들어진 비행계획이 없습니다"}, status_code=404)
        return PlainTextResponse(text, media_type="text/csv; charset=utf-8", headers={
            "Content-Disposition": 'attachment; filename="generated-flight-plan.csv"'})

    return router
