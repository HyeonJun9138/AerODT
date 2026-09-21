"""Flight intent: options, transient preview and immutable prepared plans."""
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse


def create_plan_router(plans):
    """`plans` exposes options(), build(body), prepare(body), get(id).
    Planning raises
    ValueError('field: reason') for anything it cannot plan."""
    router = APIRouter()

    def invalid(error):
        message = str(error)
        field, _, reason = message.partition(": ")
        return JSONResponse({"schema_version": 1, "error": "invalid_plan",
                             "field": field if reason else None, "message": message}, status_code=422)

    @router.get("/api/simulation/plans/options")
    async def plan_options():
        return {"schema_version": 1, **plans.options()}

    @router.post("/api/simulation/plans/preview")
    async def plan_preview(request: Request):
        try:
            body = await request.json()
        except ValueError:
            return invalid(ValueError("plan: JSON object expected"))
        try:
            return {"schema_version": 1, "plan": plans.build(body)}
        except ValueError as error:
            return invalid(error)

    @router.post("/api/simulation/plans", status_code=201)
    async def prepare(request: Request):
        try:
            body = await request.json()
            return JSONResponse(plans.prepare(body), status_code=201,
                                headers={"Cache-Control": "no-store"})
        except ValueError as error:
            return invalid(error)

    @router.get("/api/simulation/plans/{plan_id}")
    async def prepared(plan_id: str):
        found = plans.get(plan_id)
        return JSONResponse(found if found is not None else
                            {"schema_version": 1, "error": "unknown_plan"},
                            status_code=200 if found is not None else 404,
                            headers={"Cache-Control": "no-store"})

    return router
