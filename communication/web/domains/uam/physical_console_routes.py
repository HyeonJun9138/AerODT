"""Physical console controls; the application validates and executes plans."""
import asyncio
import json
from urllib.parse import unquote
from fastapi import APIRouter,Request
from fastapi.responses import JSONResponse,FileResponse
from communication.web.live_routes import same_origin


def create_console_router(console,launch,assets,connection=None,operations=None):
    router=APIRouter();headers={'Cache-Control':'no-store'}
    def invalid(error):return JSONResponse({'error':'invalid','message':str(error)},422,headers=headers)
    async def body(request):
        if not same_origin(request):raise ValueError('같은 Physical 콘솔에서 요청해 주세요.')
        raw=bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw)>32*1024*1024:raise ValueError('파일은 32 MB 이하여야 합니다.')
        return bytes(raw)
    @router.get('/console.js')
    async def script():return FileResponse(assets/'console.js',media_type='text/javascript',headers=headers)
    @router.get('/console_stream.js')
    async def stream_script():return FileResponse(assets/'console_stream.js',media_type='text/javascript',headers=headers)
    @router.get('/console.css')
    async def style():return FileResponse(assets/'console.css',media_type='text/css',headers=headers)
    @router.get('/console_connection.js')
    async def connection_script():return FileResponse(assets/'console_connection.js',media_type='text/javascript',headers=headers)
    @router.get('/console_fleet.js')
    async def fleet_script():return FileResponse(assets/'console_fleet.js',media_type='text/javascript',headers=headers)
    @router.get('/api/v1/console/operations')
    async def fleet_operations():return JSONResponse(operations() if operations else {},headers=headers)
    @router.get('/api/v1/console/connection')
    async def describe_connection(request:Request):
        if not request.client or request.client.host not in ('127.0.0.1','::1'):
            return JSONResponse({'error':'local_only'},403)
        return JSONResponse(connection.describe(),headers=headers)
    @router.post('/api/v1/console/connection/{action}')
    async def change_connection(action:str,request:Request):
        if not request.client or request.client.host not in ('127.0.0.1','::1'):
            return JSONResponse({'error':'local_only'},403)
        try:
            value=json.loads(await body(request))
            if connection.lock.locked():return JSONResponse({'message':'이전 연결 작업을 처리 중입니다.'},409)
            if action=='connect':return await connection.connect(value)
            if action=='disconnect':return await connection.disconnect()
            if action=='suspend':return await connection.suspend()
            if action=='check':
                async with connection.lock:return await connection.diagnose()
            raise ValueError('알 수 없는 연결 요청입니다.')
        except (ValueError,KeyError,TypeError) as error:return invalid(error)
    @router.get('/api/v1/console')
    async def describe():return JSONResponse(await asyncio.to_thread(console.describe),headers=headers)
    @router.get('/api/v1/console/catalog/{identifier}')
    async def catalog(identifier:str):
        try:return JSONResponse(await asyncio.to_thread(console.catalog,identifier),headers=headers)
        except (ValueError,KeyError,TypeError) as error:return invalid(error)
    @router.post('/api/v1/console/import')
    async def import_file(request:Request,kind:str='plan'):
        try:return await asyncio.to_thread(console.import_file,await body(request),unquote(request.headers.get('x-aerodt-filename','imported')),kind)
        except (ValueError,KeyError,TypeError) as error:return invalid(error)
    @router.post('/api/v1/console/preview')
    async def preview(request:Request):
        try:return await asyncio.to_thread(getattr(console,'preview',console.prepare),json.loads(await body(request)))
        except (ValueError,KeyError,TypeError) as error:return invalid(error)
    @router.post('/api/v1/console/start')
    async def start(request:Request):
        try:
            prepared=await asyncio.to_thread(console.prepare,json.loads(await body(request)))
            if not launch(prepared):return JSONResponse({'error':'busy','message':'이전 명령을 처리 중입니다.'},429)
            return {'accepted':'start','settings':prepared['settings']}
        except (ValueError,KeyError,TypeError) as error:return invalid(error)
    return router
