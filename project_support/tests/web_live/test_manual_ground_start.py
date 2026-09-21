import json
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from user_application.uam_mission.manual_flight import ManualFlight
from communication.web.manual_routes import create_manual_router
from communication.python.manual_runtime import ManualRuntime
from digital_twin.simulation import manual_takeover as manual
from test_manual_takeover import day
from test_manual_day_bridge import Day, Planning
from user_application.uam_mission.manual_surfaces import departure_surface, contact_decks

PLAN={'control_mode':'manual','legs':[{'path':[[127,37,80]]}],
      'totals':{'battery_start_pct':100},'vehicle':{'passengers':0,'capacity':4}}

@pytest.mark.parametrize('cached_height', [98.83935368787957, 60.0])
def test_departure_uses_contact_deck_not_cached_scenario_altitude(tmp_path, cached_height):
    plan={**PLAN, 'legs':[{'path':[[127,37,0,'deck:VP012']]}]}
    decks=[{'id':'VP012','height_m':80.,'outline':[[126.999,36.999],[127.001,36.999],[127.001,37.001],[126.999,37.001]]}]
    old_origin=[127,37,cached_height]
    old=ManualFlight(plan,old_origin,ManualRuntime(),tmp_path,decks=contact_decks(decks,old_origin))
    try:
        with pytest.raises(RuntimeError,match='지상 접촉'):old.initialize_grounded()
    finally:old.close()
    origin, native_decks=departure_surface(plan,cached_height,decks)
    assert origin == [127,37,80.]
    assert native_decks[0][1] == 0
    f=ManualFlight(plan,origin,ManualRuntime(),tmp_path,decks=native_decks)
    try:
        sample=f.initialize_grounded()
        assert not sample['airborne']
        assert sample['speed_mps'] == pytest.approx(0)
        assert sample['position']['altitude_m'] == pytest.approx(80,abs=.01)
    finally:f.close()

def test_departure_never_substitutes_another_deck_or_moves_gate_horizontally():
    plan={**PLAN,'legs':[{'path':[[127,37,0,'deck:VP012']]}]}
    deck={'id':'VP012','height_m':80.,'outline':[[128,38],[128.001,38],[128.001,38.001],[128,38.001]]}
    with pytest.raises(ValueError,match='내부'):departure_surface(plan,98,[deck])
    with pytest.raises(ValueError,match='준비'):departure_surface(plan,98,[])
    with pytest.raises(ValueError,match='준비'):departure_surface(plan,98,[{**deck,'id':'OTHER'}])
    with pytest.raises(ValueError,match='준비'):departure_surface(plan,98,[deck,deck])

class ContactRuntime:
    def __init__(self,*args): self.time=0.;self.calls=[];self.flying=False;self.never=False
    def surface(self,*args): pass
    def deck(self,*args): pass
    def close(self): pass
    def step(self,throttle,roll,pitch,wing,steps,yaw=0):
        self.calls.append((throttle,roll,pitch,wing,steps,yaw));self.time+=steps*.004
        grounded=len(self.calls)>1 and not self.flying and not self.never
        return [self.time,0,0,-5 if self.flying else 0,0,0,0,0,0,0,0,0,float(grounded)]

def test_unsettled_initial_contact_is_not_shared_as_takeoff_but_actual_lift_is(tmp_path):
    e=day();manual.hand_over(e,'A1');a=e.aircraft['A1'];runtime=ContactRuntime()
    f=ManualFlight(PLAN,[a.longitude,a.latitude,a.altitude],runtime,tmp_path)
    try:
        sample=f.initialize_grounded()
        assert not sample['airborne'] and len(runtime.calls)==2
        assert all(c[:4]==(0,0,0,False) for c in runtime.calls)
        def publish(s):
            p=s['position'];manual.place(e,'A1',latitude=p['latitude'],longitude=p['longitude'],
                altitude=p['altitude_m'],airborne=s['airborne'],speed_mps=s['speed_mps'])
            return manual.check(e,'A1')
        assert publish(sample)==[]
        assert 'observed_takeoff_s' not in a.external
        runtime.flying=True
        assert publish(f.step({'throttle':.5,'roll':0,'pitch':0,'flight_mode':'multirotor'},1))[0]['kind']=='departure_unauthorised'
        assert 'observed_takeoff_s' in a.external
    finally:
        f.close();e.close()
    events=[json.loads(x) for p in tmp_path.glob('logs/runs/*/events.jsonl') for x in p.read_text(encoding='utf-8').splitlines()]
    assert events[0]['event']=='manual_initialization_sample'
    assert any(x['event']=='manual_sample' and x['data']['sample']['airborne'] for x in events)

def test_missing_contact_fails_boundedly_without_faking_grounded(tmp_path):
    r=ContactRuntime();r.never=True;f=ManualFlight(PLAN,[127,37,80],r,tmp_path)
    try:
        with pytest.raises(RuntimeError,match='지상 접촉'):f.initialize_grounded()
        assert len(r.calls)==6 and f.observation['airborne']
    finally:f.close()

def test_socket_only_shares_and_announces_contact_confirmed_ready(monkeypatch,tmp_path):
    monkeypatch.setattr('communication.web.manual_routes.ManualRuntime',ContactRuntime)
    d=Day();app=FastAPI();app.include_router(create_manual_router(Planning(),tmp_path,scenario=d))
    with TestClient(app) as client:
        with client.websocket_connect('/api/simulation/manual') as ws:
            ws.send_json({'aircraft_id':'A1','altitude_m':80})
            ready=ws.receive_json()
            assert ready['type']=='ready' and not ready['sample']['airborne']
            assert len(d.poses)==1 and d.poses[0][1]['airborne'] is False
            ws.send_json({'type':'stop'})

def test_native_deck_contact_is_confirmed_before_ready(tmp_path):
    r=ManualRuntime();f=ManualFlight(PLAN,[127,37,80],r,tmp_path,
        decks=[([(-20,-20),(20,-20),(20,20),(-20,20)],0)])
    try:
        s=f.initialize_grounded()
        assert not s['airborne'] and s['speed_mps']==pytest.approx(0)
        assert s['position']['altitude_m']==pytest.approx(80,abs=.01)
        assert s['position']['latitude']==pytest.approx(37)
        assert s['position']['longitude']==pytest.approx(127)
    finally:f.close()
