"""Physical-side HTTP protocol. All execution is injected by application."""
from fastapi import APIRouter,Request
from fastapi.responses import HTMLResponse,JSONResponse
from communication.web.live_routes import same_origin


def create_publisher_router(*,status,telemetry,plan,truth,control,page,operations=None,sensor_profile=None):
    router=APIRouter()
    @router.get('/api/v1/status')
    async def read_status():return JSONResponse(status(),headers={'Cache-Control':'no-store'})
    @router.put('/api/v1/sensor-profile')
    async def set_sensor_profile(request:Request):
        if not request.client or request.client.host not in ('127.0.0.1','::1') or not same_origin(request):
            return JSONResponse({'error':'local_only'},403)
        if sensor_profile is None:return JSONResponse({'error':'unavailable'},503)
        try:
            import json
            raw=bytearray()
            async for part in request.stream():
                raw.extend(part)
                if len(raw)>512:raise ValueError('설정이 너무 큽니다.')
            value=json.loads(raw)
            if not isinstance(value,dict):raise ValueError('센서 오차 규칙을 선택해 주세요.')
            return sensor_profile(value.get('profile'))
        except (ValueError,TypeError) as error:return JSONResponse({'error':'invalid','message':str(error)},422)
    @router.get('/api/v1/operations')
    async def read_operations(run_id:str='',after:int=0):
        if after<0 or len(run_id)>100:return JSONResponse({'error':'invalid operations cursor'},422)
        try:value=operations(run_id,after) if operations else {'schema_version':1,'available':False}
        except ValueError:return JSONResponse({'error':'invalid operations cursor'},422)
        return JSONResponse(value,headers={'Cache-Control':'no-store'})
    @router.get('/api/v1/telemetry')
    async def read_telemetry(after:int=0,process:str='',aircraft_id:str='',delivery:str='ordered',shard:int=0,shards:int=1):
        if delivery not in ('ordered','latest'):return JSONResponse({'error':'invalid delivery'},422)
        if not 1<=shards<=4 or not 0<=shard<shards or (shards>1 and delivery!='latest'):
            return JSONResponse({'error':'invalid telemetry shard'},422)
        value=(telemetry(after,process,aircraft_id or None,delivery,shard,shards) if shards>1 else
               telemetry(after,process,aircraft_id or None,delivery) if delivery=='latest' else
               telemetry(after,process,aircraft_id) if aircraft_id else telemetry(after,process))
        return JSONResponse(value,headers={'Cache-Control':'no-store'})
    @router.get('/api/v1/flight-plan')
    async def read_plan():return plan()
    @router.get('/api/v1/truth')
    async def read_truth():return truth()
    @router.post('/api/v1/control')
    async def action(request:Request):
        if not same_origin(request):return JSONResponse({'error':'origin'},403)
        try:
            body=await request.json()
            if not isinstance(body,dict):raise ValueError()
            command=body.get('action')
            if command not in ('restart','gnss_outage','pause','resume','stop'):raise ValueError()
            if not control(command):return JSONResponse({'error':'busy'},429)
        except (ValueError,TypeError):return JSONResponse({'error':'invalid action'},422)
        return {'accepted':command}
    @router.get('/',response_class=HTMLResponse)
    async def index():return page()
    return router
