"""Bounded same-origin camera image/result wire contract; no model imports."""
import json
import threading
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from communication.web.live_routes import same_origin

MAX_BODY = 1024 * 1024 + 8192


def create_camera_detection_router(predict, describe, release):
    router = APIRouter()
    busy = threading.Lock()
    def response(value, status=200):
        return JSONResponse(value, status_code=status, headers={'Cache-Control': 'no-store'})

    @router.get('/api/camera/model')
    async def model(): return response(describe())

    @router.post('/api/camera/detect')
    async def detect(request: Request):
        if not same_origin(request): return response({'message': '같은 화면에서만 사용할 수 있습니다.'}, 403)
        if not busy.acquire(False): return response({'message': '탐지 처리 중입니다.'}, 503)
        try:
            raw = bytearray()
            async for chunk in request.stream():
                raw.extend(chunk)
                if len(raw) > MAX_BODY: return response({'message': '영상 데이터가 너무 큽니다.'}, 413)
            body = json.loads(raw)
            return response(await run_in_threadpool(predict, body))
        except (ValueError, TypeError, UnicodeError): return response({'message': '유효한 JPEG와 프레임 정보가 필요합니다.'}, 422)
        except Exception: return response({'message': '로컬 탐지 모델을 실행할 수 없습니다.'}, 503)
        finally: busy.release()

    @router.delete('/api/camera/session/{session_id}')
    async def end(session_id: str, request: Request):
        if not same_origin(request): return response({'message': '같은 화면에서만 사용할 수 있습니다.'}, 403)
        if len(session_id) > 96: return response({'message': '세션 식별자 오류'}, 422)
        await run_in_threadpool(release, session_id)
        return response({'released': True})
    return router
