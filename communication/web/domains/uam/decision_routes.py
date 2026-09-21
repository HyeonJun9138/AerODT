"""Wire for the decision charts: read them, move them, put them back.

Three calls, because there are three things an operator does with a rule: look
at it, change it, and undo the change. The charts themselves go over the wire
with the values, so the display never carries its own copy of the logic - a
drawing kept in the browser and a decision kept in the engine drift apart, and
the drawing is the one that starts lying.
"""
import asyncio
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from digital_twin.simulation import decision_policy


def create_decision_router(store, *, on_change=None):
    router = APIRouter()

    def answer():
        described = decision_policy.describe(store.read())
        # Whether what is on screen is what the day in progress is flying. A
        # running day keeps the rules it was loaded with, and saying so is the
        # difference between a control and a lie.
        described["applies_to"] = "다음 재생" if on_change is None else on_change()
        return JSONResponse(described, headers={"Cache-Control": "no-store"})

    @router.get("/api/decisions")
    async def read():
        return await asyncio.to_thread(answer)

    @router.put("/api/decisions")
    async def write(request: Request):
        try:
            body = await request.json()
        except ValueError as error:
            return JSONResponse({"error": "invalid", "message": str(error)}, status_code=422)
        if not isinstance(body, dict):
            return JSONResponse({"error": "invalid", "message": "객체가 아닙니다"}, status_code=422)
        values = decision_policy.validate(body.get("values", body))
        await asyncio.to_thread(store.write, values)
        return await asyncio.to_thread(answer)

    @router.post("/api/decisions/reset")
    async def reset():
        await asyncio.to_thread(store.clear)
        return await asyncio.to_thread(answer)

    return router
