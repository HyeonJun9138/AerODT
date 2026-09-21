"""Versioned wire adapter for the data library. Logic is injected by composition."""
from fastapi import APIRouter, Request
from starlette.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse


def create_library_router(library):
    """`library` exposes describe() and apply(body).

    apply raises ValueError('source.field: reason') for invalid input and
    returns the settings that are now in force. Nothing here decides policy.
    """
    router = APIRouter()

    def invalid(error):
        message = str(error)
        field, _, reason = message.partition(": ")
        return JSONResponse({"schema_version": 1, "error": "invalid_settings",
                             "field": field if reason else None, "message": message}, status_code=422)

    @router.get("/api/library/sources")
    async def describe_sources():
        return await run_in_threadpool(library.describe)

    @router.put("/api/library/sources")
    async def apply_sources(request: Request):
        try:
            body = await request.json()
        except ValueError:
            return invalid(ValueError("settings: JSON 객체여야 합니다"))
        try:
            return await run_in_threadpool(library.apply,body)
        except ValueError as error:
            return invalid(error)

    return router
