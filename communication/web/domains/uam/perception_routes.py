"""Camera-perceived objects from a viewer, handed to the risk picture. Wire only."""
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from communication.web.live_routes import same_origin

MAX_BODY = 64 * 1024


def create_perception_router(report, current):
    router = APIRouter()

    def response(value, status=200):
        return JSONResponse(value, status_code=status, headers={'Cache-Control': 'no-store'})

    @router.post('/api/perception/observations')
    async def observations(request: Request):
        if not same_origin(request):
            return response({'message': '같은 화면에서만 사용할 수 있습니다.'}, 403)
        raw = await request.body()
        if len(raw) > MAX_BODY:
            return response({'message': '인식 보고가 너무 큽니다.'}, 413)
        try:
            body = await request.json()
        except ValueError:
            return response({'message': 'JSON 본문이 필요합니다.'}, 422)
        try:
            kept = report(body)
        except (ValueError, TypeError) as error:
            return response({'message': str(error) or '인식 보고를 확인할 수 없습니다.'}, 422)
        return response({'accepted': len(kept)})

    @router.get('/api/perception/observations')
    async def listing():
        items = current()
        return response({'objects': [{k: v for k, v in item.items() if k != 'seen_at'} for item in items]})

    return router
