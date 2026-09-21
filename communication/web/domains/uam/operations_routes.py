"""V1 collaboration rehearsal wire. No flight/runtime control endpoints."""
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from typing import Optional
from communication.web.live_routes import same_origin


class Join(BaseModel):
    name: str = Field(default='운영자', max_length=32)
    role: str = Field(max_length=16)
    facility_id: Optional[str] = Field(default=None, max_length=128)


class Report(BaseModel):
    facility_id: str = Field(max_length=128)
    note: str = Field(min_length=1, max_length=240)


class Decision(BaseModel):
    version: int = Field(ge=1)
    action: str = Field(max_length=24)
    note: str = Field(default='', max_length=240)


def create_operations_router(room):
    router = APIRouter(prefix='/api/operations/rehearsal')

    def invoke(request, action):
        if not same_origin(request):
            return JSONResponse({'message': '같은 서버의 화면에서 요청해 주세요.'}, status_code=403)
        try:
            return JSONResponse(action(request.headers.get('x-aerodt-session')), headers={'Cache-Control': 'no-store'})
        except ValueError as error:
            return JSONResponse({'message': str(error)}, status_code=getattr(error, 'status', 422))

    @router.get('')
    async def snapshot(request: Request):
        return invoke(request, lambda token: room.snapshot(token))

    @router.post('/join')
    async def join(body: Join, request: Request):
        return invoke(request, lambda token: room.join(body.name, body.role, body.facility_id, token))

    @router.post('/leave')
    async def leave(request: Request):
        return invoke(request, lambda token: room.leave(token))

    @router.post('/examples')
    async def examples(request: Request):
        def seed(token):
            room.seed(token)
            return room.snapshot(token)
        return invoke(request, seed)

    @router.post('/reports')
    async def report(body: Report, request: Request):
        return invoke(request, lambda token: room.report(token, body.facility_id, body.note))

    @router.post('/requests/{request_id}/decision')
    async def decide(request_id: str, body: Decision, request: Request):
        return invoke(request, lambda token: room.decide(token, request_id, body.version, body.action, body.note))

    return router
