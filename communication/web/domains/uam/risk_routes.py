"""Read-only risk forecasts and same-origin settings; no runtime/model imports."""
import math
import threading
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from communication.web.live_routes import same_origin


def create_risk_router(predict, read_settings, write_settings, describe_model, predict_injected=None):
    router=APIRouter();busy=threading.Lock()
    def response(value,status=200):return JSONResponse(value,status_code=status,headers={'Cache-Control':'no-store'})
    def config():return {'schema_version':1,'settings':read_settings(),'model':describe_model()}
    @router.get('/api/prediction/risk/config')
    async def read():return response(await run_in_threadpool(config))
    @router.put('/api/prediction/risk/config')
    async def write(request:Request):
        if not same_origin(request):return response({'message':'같은 화면에서만 설정을 변경할 수 있습니다.'},403)
        try:
            body=await request.json()
            if not isinstance(body,dict):raise ValueError('JSON 객체가 필요합니다.')
            await run_in_threadpool(write_settings,body)
        except (ValueError,TypeError) as error:return response({'message':str(error)},422)
        except OSError:return response({'message':'위험 예측 설정 저장 실패'},503)
        return response(await run_in_threadpool(config))
    @router.get('/api/prediction/risk')
    @router.post('/api/prediction/risk')
    async def forecast(request:Request):
        injected=None
        if request.method=='POST':
            if not same_origin(request):return response({'message':'같은 화면에서만 시험할 수 있습니다.'},403)
            if predict_injected is None:return response({'message':'주입 예측 연결이 없습니다.'},503)
            if len(await request.body())>65536:return response({'message':'시험 입력이 너무 큽니다.'},413)
            try:
                injected=await request.json()
                if not isinstance(injected,dict):raise ValueError()
            except ValueError:return response({'message':'시험 입력 형식 오류'},422)
        params=request.query_params;entity_id=params.get('entity_id','')
        if not entity_id or len(entity_id)>160:return response({'message':'비행체를 선택하세요.'},422)
        settings=read_settings();options={'enabled':settings.get('enabled',True)}
        try:
            for field,low,high in [('radius_m',500,10000),('horizon_s',5,15),('altitude_band_m',0,3000)]:
                value=params.get(field,settings.get(field))
                if field=='altitude_band_m' and value in ('all',None,0,'0'):options[field]=None;continue
                value=float(value)
                if not math.isfinite(value) or not low<=value<=high:raise ValueError(field)
                if field=='horizon_s' and value not in (5,10,15):raise ValueError(field)
                options[field]=value
        except (ValueError,TypeError):return response({'message':'반경·고도·시간 범위를 확인하세요.'},422)
        # No inference queue behind another viewer: clients retry on their next poll.
        if not busy.acquire(blocking=False):return response({'message':'주변 예측 계산 중입니다.'},503)
        try:
            value=await run_in_threadpool(predict_injected,entity_id,injected,**options) if injected is not None else await run_in_threadpool(predict,entity_id,**options)
            return response(value)
        except (ValueError,TypeError):return response({'message':'예측 입력을 확인할 수 없습니다.'},422)
        except Exception:return response({'message':'위험 예측 실행을 확인할 수 없습니다.'},503)
        finally:busy.release()
    return router
