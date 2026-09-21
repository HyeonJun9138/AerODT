from dataclasses import replace
import math
import pytest

from ai_pnp.uam_features import feature_sample, local_position, local_to_ecef, route_points
from ai_pnp.uam_prediction import UamPredictionRunner
from digital_twin.contracts.live import TwinEntity
from digital_twin.contracts.prediction import PredictionWaypoint, UamPredictionIntent
from digital_twin.model_library.uam_prediction_catalog import MODELS


def inputs():
    point=(37.552,127.0,300.)
    entity=TwinEntity('scenario:A','A','uam',local_to_ecef((0,0,300)),(0,0,0),
        *point,90,1000,1000,1000,None,'simulated','nominal','scenario','asset_states','uam',
        pitch_deg=0,roll_deg=0,flight_phase='cruise')
    intent=UamPredictionIntent(entity.entity_id,1000,'F1','cruise',(
        PredictionWaypoint(point,(point[0],point[1]+.01,300),20,'cruise'),))
    return entity,intent


def test_training_projection_velocity_rates_and_active_target():
    e,i=inputs()
    row=feature_sample(e,i,12)
    assert row[:7]==pytest.approx((12,0,0,300,0,0,0))
    assert row[16]==20 and row[18]>800 and row[19]==pytest.approx(0)
    row2=feature_sample(replace(e,roll_deg=2,heading_deg=91),i,12.5,(1000,row))
    # Moment is absolute, elapsed is independent. Use entity timestamp for rates.
    row2=feature_sample(replace(e,state_time=1000.5,roll_deg=2,heading_deg=91),i,12.5,(1000,row))
    assert row2[10:13]==pytest.approx((4,0,2))
    assert local_position(37.553,127.001,300)==pytest.approx((111.32*math.cos(math.radians(37.552)),111.32,300))
    assert route_points(i)[0]['x']>800
    assert feature_sample(replace(e,velocity_ecef_mps=None),i,0) is None
    assert feature_sample(replace(e,heading_deg=300),i,0)[6]==-150
    # The delivered RNP convention is positive left, negative right.
    left=replace(e,latitude_deg=e.latitude_deg+.001)
    assert feature_sample(left,i,0)[17]==pytest.approx(111.32)


class Model:
    calls=0
    def __init__(self,path):self.horizon=next(m['horizon_s'] for m in MODELS if m['model_id']==path.name)
    def predict(self,rows,route,**kw):
        Model.calls+=1
        return {'times_s':[rows[-1]['t']+(n+1)*self.horizon/25 for n in range(25)],
                'prediction_absolute_enu_m':[[n+1,0,300] for n in range(25)]}


def windows():
    e,i=inputs();row=feature_sample(e,i,30)
    return {m['model_id']:{'status':'ready','rows':tuple(tuple([30-(24-n)*m['history_s']/24]+list(row[1:])) for n in range(25)),
        'history_seconds':m['history_s'],'available_history_seconds':30,'reason':''} for m in MODELS}


def test_three_real_horizons_same_base_no_cumulative_sum_and_partial_failure(tmp_path):
    e,i=inputs();w=windows();Model.calls=0
    runner=UamPredictionRunner(tmp_path,model_factory=Model,availability=lambda mid:True)
    result=runner.predict(e,i,w,epoch=3,context=('run','F1'),model_id='uam_route_mlp_comparison')
    assert result['kind']=='uam_prediction_comparison' and result['generated_at']==1000
    assert len(result['predictions'])==3 and Model.calls==3
    for p in result['predictions']:
        assert p['status']=='ready' and len(p['path']['points'])==26
        assert p['path']['reference_frame']=='ecef_m'
        assert p['path']['points'][0]==[1000,*e.position_ecef_m]
        assert p['path']['points'][-1][0]==1000+p['horizon_seconds']
        assert p['path']['points'][-1][1:]==pytest.approx(local_to_ecef((25,0,300)))
    runner.predict(e,i,w,epoch=3,context=('run','F1'),model_id='uam_route_mlp_comparison')
    assert Model.calls==3,'same paused instant reuses only future results'
    w[MODELS[1]['model_id']]={**w[MODELS[1]['model_id']],'status':'warming_up','rows':None}
    result=runner.predict(replace(e,state_time=1001),i,w,epoch=3,context=('run','F1'),model_id='uam_route_mlp_comparison')
    assert result['predictions'][1]['status']=='warming_up'
    assert result['predictions'][0]['status']=='ready'


def test_each_model_error_is_isolated_and_individual_selection_is_preserved(tmp_path):
    e,i=inputs()
    class Broken(Model):
        def predict(self,*args,**kw):
            if self.horizon==90:raise ValueError('bad model')
            return super().predict(*args,**kw)
    runner=UamPredictionRunner(tmp_path,model_factory=Broken,availability=lambda mid:True)
    out=runner.predict(e,i,windows(),epoch=0,context='run',model_id='uam_route_mlp_comparison')
    assert [p['status'] for p in out['predictions']]==['ready','unavailable','ready']
    out=runner.predict(e,i,windows(),epoch=0,context='run',model_id='uam_route_mlp_long')
    assert len(out['predictions'])==1 and out['predictions'][0]['horizon_seconds']==240


def test_http_comparison_uses_threadpool_captures_current_intent_and_drops_stale(tmp_path,monkeypatch):
    import threading
    from fastapi.testclient import TestClient
    from user_application.apps.web_dashboard.application import create_app
    e,i=inputs()
    app=create_app({'workspace_directory':str(tmp_path),'cache_directory':str(tmp_path)},sources=[])
    capture={'entity':e,'intent':i,'windows':windows(),'context':('run','F1')}
    monkeypatch.setattr(app.state.scenario_session,'learned_prediction_input',lambda eid:capture)
    valid=[True]
    monkeypatch.setattr(app.state.scenario_session,'prediction_context_matches',lambda _:valid[0])
    calls=[]
    def compute(self,*args,**kwargs):
        calls.append(threading.current_thread().name)
        return {'kind':'uam_prediction_comparison','epoch':0,'predictions':[{'status':'ready'}]}
    monkeypatch.setattr(UamPredictionRunner,'predict',compute)
    app.state.world.replace([e],1000,[])
    client=TestClient(app)
    assert client.put('/api/library/sources',json={'sources':{'uam_prediction':{'model':'uam_route_mlp_comparison'}}}).status_code==200
    response=client.get('/api/live/trajectory/scenario:A')
    assert response.status_code==200 and response.json()['kind']=='uam_prediction_comparison'
    assert calls and 'AnyIO' in calls[0]
    valid[0]=False
    assert client.get('/api/live/trajectory/scenario:A').status_code==404


def test_installed_ensemble_output_is_accepted_by_actual_browser_contract():
    import json
    import subprocess
    from digital_twin.model_library import uam_prediction_catalog as catalog
    if not all(m['ready'] for m in catalog.describe_models()):
        pytest.skip('verified delivered package is not installed')
    e,i=inputs()
    result=UamPredictionRunner().predict(e,i,windows(),epoch=0,context='qa',model_id='uam_route_mlp_comparison')
    assert [p['status'] for p in result['predictions']]==['ready']*3
    # The exact Python envelope must pass the production JS reader, not a hand-written fixture.
    script="""
      import {checkedComparison} from './digital_twin/visualization/web/uam_prediction_comparison.js';
      let text='';for await(const chunk of process.stdin)text+=chunk;
      const path=JSON.parse(text),out=checkedComparison(path,path.entity_id,p=>p.length===26&&p.every(row=>row.length===4&&row.every(Number.isFinite)));
      process.stdout.write(JSON.stringify(out?.predictions.map(p=>p.status)));
    """
    proc=subprocess.run(['node','--input-type=module','-e',script],input=json.dumps(result),
                        text=True,encoding='utf-8',capture_output=True,check=True)
    assert json.loads(proc.stdout)==['ready']*3
