from fastapi import FastAPI
from fastapi.testclient import TestClient
from communication.web.risk_routes import create_risk_router

def test_risk_routes_bound_parameters_and_protect_writes():
    calls=[];settings={'enabled':True,'model':'prism_2d_v1','radius_m':3000,'altitude_band_m':150,'horizon_s':15}
    def write(body):settings.update(body);return settings
    app=FastAPI();app.include_router(create_risk_router(lambda eid,**opts:calls.append((eid,opts)) or {'schema_version':1,'tracks':[]},lambda:settings,write,lambda:{'model_id':'prism_2d_v1'}))
    with TestClient(app) as c:
        assert c.get('/api/prediction/risk?entity_id=a&radius_m=10001').status_code==422
        assert c.get('/api/prediction/risk?entity_id=a&radius_m=nan').status_code==422
        assert c.get('/api/prediction/risk?entity_id=a&altitude_band_m=all').status_code==200
        assert calls[-1][1]['altitude_band_m'] is None
        assert c.get('/api/prediction/risk/config').json()['settings']['radius_m']==3000
        assert c.put('/api/prediction/risk/config',json={'enabled':False},headers={'Origin':'https://evil.example'}).status_code==403
        assert c.put('/api/prediction/risk/config',json={'enabled':False}).status_code==200
        assert settings['enabled'] is False
        assert c.put('/api/prediction/risk/config',json=[]).status_code==422

def test_model_description_never_runs_on_request_event_loop_thread():
    import threading
    request_threads=[];model_threads=[]
    app=FastAPI()
    @app.middleware('http')
    async def record(request,call_next):request_threads.append(threading.get_ident());return await call_next(request)
    def describe():model_threads.append(threading.get_ident());return {}
    app.include_router(create_risk_router(lambda *_: {},lambda:{},lambda _: {},describe))
    with TestClient(app) as c:assert c.get('/api/prediction/risk/config').status_code==200
    assert model_threads[0]!=request_threads[0]
