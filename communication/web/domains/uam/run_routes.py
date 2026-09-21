"""Simulation runs over the wire: fly a plan, list what was flown, replay it.

The display asks for a run and reads its states back; it never computes them.
That is what keeps simulation mode and live mode the same shape downstream —
in both, the User Layer reads states the Data Layer holds.
"""
from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

_NO_STORE = {"Cache-Control": "no-store"}


def create_run_router(runs, replay_prediction=None):
    """`runs` exposes list(), get(id), plan(id), states(id, since, until),
    fly(body) and delete(id). fly raises ValueError('field: reason')."""
    router = APIRouter()

    def invalid(error):
        message = str(error)
        field, _, reason = message.partition(": ")
        return JSONResponse({"schema_version": 1, "error": "invalid_run",
                             "field": field if reason else None, "message": message},
                            status_code=422, headers=_NO_STORE)

    def unknown():
        return JSONResponse({"schema_version": 1, "error": "unknown_run"}, status_code=404, headers=_NO_STORE)

    @router.get("/api/simulation/runs")
    async def list_runs():
        return JSONResponse({"schema_version": 1, "runs": runs.list()}, headers=_NO_STORE)

    @router.post("/api/simulation/runs", status_code=201)
    async def fly(request: Request):
        try:
            body = await request.json()
        except ValueError:
            return invalid(ValueError("run: JSON object expected"))
        try:
            result = await run_in_threadpool(runs.fly, body)
            return JSONResponse({"schema_version": 1, **result}, status_code=201, headers=_NO_STORE)
        except BlockingIOError:
            return JSONResponse({"schema_version": 1, "error": "run_busy",
                                 "message": "다른 비행을 계산 중입니다. 완료 후 다시 실행해 주세요."},
                                status_code=409, headers=_NO_STORE)
        except ValueError as error:
            return invalid(error)

    @router.get("/api/simulation/runs/{run_id}")
    async def one(run_id: str):
        found = runs.get(run_id)
        if found is None:
            return unknown()
        return JSONResponse({"schema_version": 1, "run": found, "plan": runs.plan(run_id)}, headers=_NO_STORE)

    @router.get("/api/simulation/runs/{run_id}/states")
    async def states(run_id: str, since: float = Query(None), until: float = Query(None)):
        if runs.get(run_id) is None:
            return unknown()
        return JSONResponse({"schema_version": 1, "run_id": run_id,
                             "states": runs.states(run_id, since=since, until=until)}, headers=_NO_STORE)

    @router.get("/api/simulation/runs/{run_id}/prediction")
    async def prediction(run_id: str, seconds: float = Query(..., ge=0), epoch: int = Query(0, ge=0)):
        if replay_prediction is None:
            return JSONResponse({"error":"replay_prediction_unavailable"},status_code=503,headers=_NO_STORE)
        try:
            result = await run_in_threadpool(replay_prediction.predict, run_id, seconds, epoch)
        except ValueError as error:
            return invalid(error)
        return unknown() if result is None else JSONResponse(result,headers=_NO_STORE)

    @router.post("/api/simulation/runs/{run_id}/prediction")
    async def placed_prediction(run_id: str, request: Request):
        if replay_prediction is None:
            return JSONResponse({"error":"replay_prediction_unavailable"},status_code=503,headers=_NO_STORE)
        try:
            body=await request.json()
            if not isinstance(body,dict) or set(body)-{'seconds','epoch','heights'}:
                raise ValueError('prediction: invalid request')
            seconds=body.get('seconds')
            if not isinstance(seconds,(int,float)):
                raise ValueError('seconds: finite number required')
            result=await run_in_threadpool(replay_prediction.predict,run_id,seconds,body.get('epoch',0),body.get('heights'))
        except (ValueError,TypeError) as error:
            return invalid(error)
        return unknown() if result is None else JSONResponse(result,headers=_NO_STORE)

    @router.delete("/api/simulation/runs/{run_id}", status_code=204)
    async def remove(run_id: str):
        if not runs.delete(run_id):
            return unknown()
        return JSONResponse(None, status_code=204, headers=_NO_STORE)

    return router
