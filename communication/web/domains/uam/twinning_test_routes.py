"""Dashboard control API for the isolated JSONL v1 TCP test receiver."""
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from communication.web.live_routes import same_origin


def create_twinning_test_router(session):
    router = APIRouter()

    @router.get('/api/twinning-test')
    async def status():
        return session.status()

    @router.get('/api/twinning-test/wire')
    async def wire(request: Request):
        # Local diagnostics only; never trust forwarded headers for this check.
        if request.client is None or request.client.host not in ('127.0.0.1', '::1'):
            return JSONResponse({'error': 'loopback_required'}, status_code=403)
        return JSONResponse({'wire': session.receiver.last_wire},
                            headers={'Cache-Control': 'no-store'})

    @router.get('/api/twinning-test/history')
    async def history():
        return session.history_payload()

    @router.post('/api/twinning-test/{action}')
    async def control(action: str, request: Request):
        if not same_origin(request):
            return JSONResponse({'error': 'same_origin_required'}, status_code=403)
        try:
            if action == 'start':
                if int(request.headers.get('content-length', '0')) > 4096:
                    raise ValueError('request_too_large')
                value = await request.json()
                if not isinstance(value, dict):
                    raise ValueError('invalid_configuration')
                return await session.start(value)
            if action == 'stop':
                raw = await request.body()
                if len(raw) > 4096:
                    raise ValueError('request_too_large')
                value = await request.json() if raw else {}
                if not isinstance(value, dict):
                    raise ValueError('invalid_configuration')
                return await session.stop(value.get('operation_id'))
            if action == 'calibrate':
                return session.calibrate()
            if action == 'select':
                # Which sender the single-pose views follow. Not a start, not a
                # stop: it changes nothing about what is being received.
                if int(request.headers.get('content-length', '0')) > 4096:
                    raise ValueError('request_too_large')
                value = await request.json()
                if not isinstance(value, dict):
                    raise ValueError('invalid_configuration')
                device = value.get('device_id')
                if device is not None and (not isinstance(device, str) or not 1 <= len(device) <= 64):
                    raise ValueError('invalid_device_id')
                return session.select(device)
            return JSONResponse({'error': 'unknown_action'}, status_code=404)
        except (ValueError, OSError) as error:
            return JSONResponse({'error': str(error)}, status_code=400)

    return router
