import pytest
from data.simulation.manual_prediction_history import ManualPredictionHistory
from user_application.uam_mission.replay_prediction import ReplayPrediction
from ai_pnp.uam_prediction import UamPredictionRunner
from digital_twin.model_library import uam_prediction_catalog as catalog

PLAN={'vehicle':{'id':'MANUAL'},'aircraft':{'asset_id':'kp2a'},'legs':[
 {'stage':'cruise','speed_mps':20,'path':[[127,37,100],[127,37.1,100]]}]}

def sample(t):
 return dict(time_s=t,position=dict(longitude=127,latitude=37+t*.0001,altitude_m=150+t),
 heading_deg=0,pitch_deg=2,roll_deg=0,tilt_deg=0,rotor_radps=200,speed_mps=11,stage='cruise')

class MissingRuns:
 def get(self,run): return None

class Runner:
 def predict(self,entity,intent,windows,**kw):
  self.input=entity,intent,windows,kw
  return {'entity_id':entity.entity_id,'predictions':[]}

def setup():
 history=ManualPredictionHistory();history.open('manual',PLAN)
 for i in range(801):history.append('manual',sample(i*.05))
 runner=Runner()
 p=ReplayPrediction(MissingRuns(),runner,lambda:{'uam_prediction':True,'uam_prediction_model':catalog.COMPARISON_ID},manual_history=history)
 return history,runner,p

def test_manual_models_receive_real_past_observations_and_display_heights_only_change_reference():
 history,runner,p=setup()
 result=p.predict('manual',35,4,[300,300])
 entity,intent,windows,_=runner.input
 assert entity.altitude_m==185
 assert intent.waypoints[0].end[2]==300
 assert all(w['status']=='ready' for w in windows.values())
 assert all(max(r[0] for r in w['rows'])<=35 for w in windows.values())
 assert result['snapshot']['epoch']==4 and result['run_id']=='manual'
 assert '수동' in result['prediction']['input_quality']
 p.predict('manual',2,5)
 assert runner.input[2]['uam_route_mlp_short']['status']=='warming_up'

def test_history_is_bounded_isolated_and_removed_on_close():
 h=ManualPredictionHistory();h.open('a',PLAN);h.open('b',PLAN)
 for i in range(2000):h.append('a',sample(i*.05))
 h.append('a',sample(90))
 plan,rows=h.read('a',100)
 assert rows[0]['t']>=60 and rows[-1]['t']==pytest.approx(99.95)
 rows[-1]['altitude_m']=-999;plan['legs'].clear()
 assert h.read('a',100)[1][-1]['altitude_m']>0
 assert h.read('a',100)[0]['legs']
 assert h.read('b',100)[1]==[]
 h.close('a');assert h.read('a',100) is None

def test_existing_prediction_http_endpoint_accepts_manual_run_without_recorded_flight():
 from fastapi import FastAPI
 from fastapi.testclient import TestClient
 from communication.web.run_routes import create_run_router
 h,runner,p=setup();app=FastAPI();app.include_router(create_run_router(MissingRuns(),p))
 with TestClient(app) as client:
  answer=client.post('/api/simulation/runs/manual/prediction',json={'seconds':35,'epoch':2})
  assert answer.status_code==200 and answer.json()['run_id']=='manual'
  h.close('manual')
  assert client.post('/api/simulation/runs/manual/prediction',json={'seconds':35}).status_code==404

def test_manual_inference_produces_all_three_renderable_paths():
 class Model:
  def __init__(self,path):self.spec=next(s for s in catalog.MODELS if s['model_id']==path.name)
  def predict(self,rows,route,target_point_index):
   last=rows[-1]
   return {'times_s':[last['t']+(i+1)*self.spec['step_s'] for i in range(25)],
    'prediction_absolute_enu_m':[[last['x'],last['y']+i+1,last['z']] for i in range(25)]}
 h,_,p=setup();p.runner=UamPredictionRunner(model_factory=Model,availability=lambda _:True)
 result=p.predict('manual',35,3)['prediction']
 assert [item['horizon_seconds'] for item in result['predictions']]==[10,90,240]
 assert all(item['status']=='ready' and len(item['path']['points'])==26 for item in result['predictions'])
 assert all('수동' in item['path']['summary']['note'] for item in result['predictions'])

def test_socket_populates_prediction_history_and_cleans_it_up(monkeypatch,tmp_path):
 import time
 from fastapi import FastAPI
 from fastapi.testclient import TestClient
 from communication.web import manual_routes
 from communication.web.run_routes import create_run_router
 class Runtime:
  def __init__(self,yaw):self.t=0
  def step(self,throttle,roll,pitch,wing,steps,yaw=0):
   self.t+=steps*.004
   return [self.t,self.t,0,-1,1,0,0,0,0,0,0,200,int(self.t<=.004)]
  def close(self):pass
 monkeypatch.setattr(manual_routes,'ManualRuntime',Runtime)
 plan={**PLAN,'control_mode':'manual','totals':{'battery_start_pct':100},'vehicle':{'id':'M','passengers':0,'capacity':4}}
 class Plans:
  def get(self,key):return {'plan':plan}
 h=ManualPredictionHistory();runner=Runner()
 predictor=ReplayPrediction(MissingRuns(),runner,lambda:{'uam_prediction':True,'uam_prediction_model':catalog.COMPARISON_ID},manual_history=h)
 app=FastAPI();app.include_router(manual_routes.create_manual_router(Plans(),tmp_path,h));app.include_router(create_run_router(MissingRuns(),predictor))
 with TestClient(app) as client:
  with client.websocket_connect('/api/simulation/manual') as ws:
   ws.send_json({'plan_id':'one','altitude_m':100});ready=ws.receive_json()
   run=ready['run_id'];first=ready['sample']['time_s']
   assert h.read(run,first)[1][-1]['t']==first
   time.sleep(.02)
   ws.send_json({'sequence':1,'throttle':.3,'roll':0,'pitch':0,'flight_mode':'multirotor'})
   state=ws.receive_json();moment=state['sample']['time_s']
   assert moment>first
   response=client.post('/api/simulation/runs/'+run+'/prediction',json={'seconds':moment,'epoch':0})
   assert response.status_code==200 and response.json()['snapshot']['state_time']==moment
   ws.send_json({'type':'stop'})
  for _ in range(100):
   if h.read(run,moment) is None:break
   time.sleep(.005)
  assert h.read(run,moment) is None
