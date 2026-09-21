import pytest
from user_application.uam_mission.replay_prediction import ReplayPrediction

class Runs:
    def get(self, run): return {'run_id':run} if run=='one' else None
    def plan(self, run): return {'vehicle':{'id':'A'},'aircraft':{'asset_id':'kp2a'},'legs':[{'stage':'cruise','speed_mps':20,'path':[[127,37,100,"msl"],[127,37.1,100,"msl"]]}]}
    def states(self, run, since=None, until=None):
        self.until=until
        return [dict(t=i/2,leg=0,f=i/100,latitude=37+i*.00001,longitude=127,altitude_m=100,heading_deg=0,pitch_deg=0,roll_deg=0,tilt_deg=90,speed_mps=20,stage='cruise') for i in range(121) if (since is None or i/2>=since) and i/2<=until]
class Runner:
    def predict(self,entity,intent,windows,**kw):
        self.input=(entity,intent,windows,kw)
        return {'entity_id':entity.entity_id,'predictions':[]}

def test_replay_prediction_only_reads_past_and_rewind_does_not_reuse_future():
    runs,runner=Runs(),Runner()
    p=ReplayPrediction(runs,runner,lambda:{'uam_prediction':True,'uam_prediction_model':'uam_route_mlp_short'})
    result=p.predict('one',35,7)
    e,intent,windows,_=runner.input
    assert runs.until==35 and e.state_time==35
    assert windows['uam_route_mlp_short']['status']=='ready'
    assert max(row[0] for row in windows['uam_route_mlp_short']['rows'])<=35
    assert result['snapshot']['epoch']==7
    p.predict('one',2,8)
    assert runner.input[2]['uam_route_mlp_short']['status']=='warming_up'
    assert runner.input[3]['epoch']==8

def test_disabled_missing_and_invalid_inputs():
    runner=Runner();p=ReplayPrediction(Runs(),runner,lambda:{'uam_prediction':False})
    assert p.predict('one',10,1)['prediction'] is None
    assert not hasattr(runner,'input')
    assert p.predict('missing',10,1) is None
    for t in [-1,float('nan'),float('inf')]:
        with pytest.raises(ValueError):p.predict('one',t,1)


def test_known_terrain_heights_are_applied_without_changing_route_or_reading_future():
    runner=Runner();p=ReplayPrediction(Runs(),runner,lambda:{'uam_prediction':True,'uam_prediction_model':'uam_route_mlp_short'})
    p.predict('one',35,1,[140,140])
    e,intent,windows,_=runner.input
    assert e.altitude_m==140
    assert intent.waypoints[0].end==(37.1,127,140)
    assert max(r[0] for r in windows['uam_route_mlp_short']['rows'])<=35
    with pytest.raises(ValueError):p.predict('one',35,1,[float('nan'),140])

def test_all_three_models_use_input_history_cadence_not_future_output_step():
    runner=Runner();p=ReplayPrediction(Runs(),runner,lambda:{'uam_prediction':True,'uam_prediction_model':'uam_route_mlp_comparison'})
    p.predict('one',35,1)
    assert all(w['status']=='ready' for w in runner.input[2].values())

def test_prediction_http_contract_missing_disabled_and_bad_cursor():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from communication.web.run_routes import create_run_router
    p=ReplayPrediction(Runs(),Runner(),lambda:{'uam_prediction':False})
    app=FastAPI();app.include_router(create_run_router(Runs(),p));client=TestClient(app)
    assert client.get('/api/simulation/runs/missing/prediction?seconds=2').status_code==404
    assert client.get('/api/simulation/runs/one/prediction?seconds=-2').status_code==422
    assert client.post('/api/simulation/runs/one/prediction',json={'seconds':2,'epoch':1,'heights':[120,120]}).status_code==200
    assert client.post('/api/simulation/runs/one/prediction',json={'seconds':2,'epoch':-1}).status_code==422
    assert client.post('/api/simulation/runs/one/prediction',json={'seconds':2,'heights':[120]}).status_code==422
