"""Digital-side telemetry and validated, persisted sensor-alignment settings."""
import re
from fastapi import APIRouter,Request
from fastapi.responses import JSONResponse
from communication.web.live_routes import same_origin


def create_physical_uam_router(feed):
    router=APIRouter()
    @router.get('/api/live/uam')
    async def status():return JSONResponse(feed.describe(),headers={'Cache-Control':'no-store'})
    @router.get('/api/live/uam/calibration-example')
    async def calibration_example():return JSONResponse(feed.calibration_example(),headers={'Cache-Control':'no-store'})
    @router.get('/api/live/uam/alignment')
    async def alignment():return JSONResponse(feed.alignment_status(),headers={'Cache-Control':'no-store'})
    @router.put('/api/live/uam/alignment')
    async def configure_alignment(request:Request):
        if not same_origin(request):return JSONResponse({'error':'same_origin_required'},403)
        try:
            import json
            raw=bytearray()
            async for part in request.stream():
                raw.extend(part)
                if len(raw)>4096:raise ValueError('설정이 너무 큽니다.')
            return feed.configure_alignment(json.loads(raw))
        except (ValueError,TypeError) as error:return JSONResponse({'error':'invalid','message':str(error)},422)
    @router.put('/api/live/uam/source')
    async def source(request:Request):
        # Only the authenticated SSH forward or this Twin's local console may administer the source.
        if not request.client or request.client.host not in ('127.0.0.1','::1') or not same_origin(request):
            return JSONResponse({'error':'local_only'},403)
        try:
            raw=bytearray()
            async for chunk in request.stream():
                raw.extend(chunk)
                if len(raw)>2048:raise ValueError('설정이 너무 큽니다.')
            import json
            value=json.loads(raw)
            url=value.get('source_url','') if isinstance(value,dict) else ''
            match=re.fullmatch(r'http://127\.0\.0\.1:([0-9]{1,5})',url)
            if not match or not 1024<=int(match[1])<=65535:raise ValueError('SSH 터널의 loopback 센서 API 주소를 입력해 주세요.')
            return feed.set_source(url)
        except (ValueError,TypeError) as error:return JSONResponse({'error':'invalid','message':str(error)},422)
    @router.get('/api/live/uam/{entity_id}')
    async def detail(entity_id:str):
        result=feed.detail(entity_id)
        return JSONResponse(result if result else {'error':'not_found'},status_code=200 if result else 404,headers={'Cache-Control':'no-store'})
    @router.get('/api/live/uam/{entity_id}/track')
    async def track(entity_id:str):
        result=feed.track(entity_id)
        return JSONResponse(result if result else {'error':'not_found'},status_code=200 if result else 404,headers={'Cache-Control':'no-store'})
    return router
