import math
import time
import unittest
from tempfile import TemporaryDirectory
from pathlib import Path
from fastapi import FastAPI
from fastapi.testclient import TestClient
from communication.python.manual_runtime import ManualRuntime
from communication.web.manual_routes import create_manual_router,validate_command

class ManualFlightTests(unittest.TestCase):
 def test_native_takeoff_direction_and_both_transitions(self):
  m=ManualRuntime()
  try:
   for _ in range(100):s=m.step(.36)
   self.assertLess(s[3],-15)
   for _ in range(500):s=m.step(.5,0,0,True)
   self.assertGreater(s[1],100);self.assertGreater(s[10],80)
   for _ in range(150):s=m.step(.2,0,0,False)
   self.assertLess(s[10],1);self.assertTrue(all(math.isfinite(x) for x in s))
  finally:m.close()
 def test_ground_taxi_braking_yaw_and_landing(self):
  for yaw in (-1,1):
   m=ManualRuntime()
   try:
    for _ in range(100):s=m.step(0,0,-1,yaw=yaw)
    self.assertGreater(s[1],2);self.assertGreater(s[7]*yaw,20);self.assertAlmostEqual(s[3],0)
    self.assertLessEqual(math.hypot(s[4],s[5]),3.001)
    for _ in range(100):s=m.step(0)
    self.assertLess(math.hypot(*s[4:7]),.01)
    for _ in range(100):s=m.step(.36)
    self.assertLess(s[3],-15)
    for _ in range(120):s=m.step(.2,.5,-.5,yaw=yaw)
    self.assertLess(abs(s[8]),7);self.assertLess(abs(s[9]),8)
    for _ in range(1000):s=m.step(0)
    self.assertAlmostEqual(s[3],0);self.assertLess(math.hypot(*s[4:7]),.01)
    self.assertAlmostEqual(s[8],0);self.assertAlmostEqual(s[9],0)
   finally:m.close()
 def test_ground_strafe_does_not_bank(self):
  m=ManualRuntime()
  try:
   for _ in range(80):s=m.step(0,1,0)
   self.assertGreater(s[2],2);self.assertAlmostEqual(s[3],0);self.assertAlmostEqual(s[9],0)
   for _ in range(160):s=m.step(0,-1,1)
   self.assertLess(s[1],-2);self.assertLessEqual(math.hypot(s[4],s[5]),3.001)
  finally:m.close()
 def test_bad_commands(self):
  for value in [float('nan'),float('inf'),True,-.1,1.1]:
   with self.assertRaises(ValueError):validate_command({'throttle':value,'roll':0,'pitch':0,'flight_mode':'multirotor'})
 def test_socket_steps_records_and_rejects_repeated_sequence(self):
  plan={'control_mode':'manual','legs':[{'path':[[127,37,30]]}],'totals':{'battery_start_pct':10},'vehicle':{'passengers':0,'capacity':4}}
  class Plans:
   def get(self,key):return {'plan':plan} if key=='test' else None
  with TemporaryDirectory() as directory:
   app=FastAPI();app.include_router(create_manual_router(Plans(),directory))
   with TestClient(app) as client:
    with client.websocket_connect('/api/simulation/manual') as ws:
     ws.send_json({'plan_id':'test','altitude_m':80});ready=ws.receive_json();self.assertEqual(ready['type'],'ready')
     ws.send_json({'type':'keepalive'});self.assertEqual(ws.receive_json()['type'],'alive')
     time.sleep(.05);cmd={'sequence':1,'throttle':.36,'roll':0,'pitch':0,'flight_mode':'multirotor'};ws.send_json(cmd);state=ws.receive_json();self.assertGreater(state['sample']['time_s'],0)
     ws.send_json(cmd);self.assertEqual(ws.receive_json()['type'],'error')
   logs=list(Path(directory).glob('logs/runs/*/events.jsonl'));self.assertEqual(len(logs),1);self.assertIn('battery_low',logs[0].read_text(encoding='utf-8'))
if __name__=='__main__':unittest.main()
