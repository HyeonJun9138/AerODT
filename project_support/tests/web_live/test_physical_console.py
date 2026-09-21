import asyncio
from copy import deepcopy
from datetime import datetime,timezone
import json
from pathlib import Path
import pytest

from data.ingestion.physical_packets import PhysicalPackets
from user_application.apps.physical_uam.console import playback_clock,validate_saved,PhysicalConsole
from user_application.apps.physical_uam.flight import PhysicalFlight
from communication.external.physical_uam import validate_packet

ROOT=Path(__file__).resolve().parents[3]

@pytest.fixture
def saved():
    return {'schema_version':1,'flight':{'flight_id':'FPL1','aircraft_id':'UAM1','origin':'VP001','destination':'VP002','date':'2026-09-11','lift_off_s':36000},
        'pilot_policy':{},'departure':{},'arrival':{},'heading_deg':0.,'phases':[
        {'stage':'takeoff','label':'takeoff','points':[[37,127,20],[37,127,60]],'duration_s':20,'speed_mps':2},
        {'stage':'cruise','label':'cruise','points':[[37,127,60],[37.01,127,60]],'duration_s':30,'speed_mps':20},
        {'stage':'landing','label':'landing','points':[[37.01,127,60],[37.01,127,20]],'duration_s':30,'speed_mps':2}]}

def test_current_and_plan_clocks_share_no_false_sensor_epoch(saved):
    now=datetime(2026,9,11,8,tzinfo=timezone.utc).timestamp()
    a=playback_clock({'time_mode':'now'},saved['flight'],now)
    b=playback_clock({'time_mode':'plan'},saved['flight'],now)
    assert a['scenario_start']==now and a['seek_s']==0
    assert b['scenario_start']==datetime(2026,9,11,1,tzinfo=timezone.utc).timestamp()
    assert b['wait_s']==b['seek_s']==0

def test_plan_time_seek_and_wait_are_explicit_kst(saved):
    a=playback_clock({'time_mode':'at','start_at':'2026-09-11T10:02:00'},saved['flight'],0)
    b=playback_clock({'time_mode':'at','start_at':'2026-09-11T09:59:00'},saved['flight'],0)
    assert a['seek_s']==120 and a['wait_s']==0
    assert b['seek_s']==0 and b['wait_s']==60
    with pytest.raises(ValueError):playback_clock({'time_mode':'at','start_at':'2026-12-01T10:00'},saved['flight'],0)

@pytest.mark.parametrize('value',[float('nan'),float('inf'),100000])
def test_invalid_geometry_is_rejected_before_execution(saved,value):
    saved['phases'][0]['points'][0][2]=value
    with pytest.raises(ValueError):validate_saved(saved)

def test_import_failure_keeps_last_valid_plan(tmp_path,saved):
    c=PhysicalConsole(tmp_path,saved);before=c.describe()['plans']
    with pytest.raises(ValueError):c.import_file(b'broken,file\n1,2','bad.csv','plan')
    assert c.describe()['plans']==before
    altered=deepcopy(saved);altered['flight']['aircraft_id']='OTHER1'
    result=c.import_file(json.dumps(altered).encode(),'new.json','plan')
    assert c.catalog(result['plan_id'])['flights'][0]['aircraft_id']=='OTHER1'

class FakePilot:
    def __init__(self,*args):self.elapsed=0.;self.prediction_points=();self.origin=(37,127,20);self.closed=False
    def advance(self,dt):
        assert not self.closed;self.elapsed+=dt
        return {'latitude_deg':37,'longitude_deg':127,'altitude_m':20+self.elapsed,
            'velocity_ned_mps':[0,0,-1],'heading_deg':0,'pitch_deg':0,'roll_deg':0,'tilt_deg':0,'rotor_radps':100,
            'phase_index':0,'route_target_index':0,'physics_time_s':self.elapsed,'done':False,'grounded':self.elapsed==0}
    def close(self):self.closed=True

def test_seek_pause_resume_keep_measurements_current_and_clear_continuity(monkeypatch,saved):
    model=json.loads((ROOT/'digital_twin/model_library/packages/physical_uam_sensors/v1/model.json').read_text())
    wall=[datetime(2026,9,11,8,tzinfo=timezone.utc).timestamp()];mono=[100.]
    import user_application.apps.physical_uam.flight as module
    monkeypatch.setattr(module.time,'time',lambda:wall[0]);monkeypatch.setattr(module.time,'monotonic',lambda:mono[0])
    async def exercise():
        packets=PhysicalPackets();f=PhysicalFlight(None,packets,model,validate_saved(saved),pilot_factory=FakePilot)
        prepared={'saved':validate_saved(saved),'settings':{'seed':42,'repeat':False,'time_mode':'at','start_at':'2026-09-11T10:02:00'}}
        await f.begin(prepared);old_id=f.status['mission_id']
        assert f.flight_elapsed==120
        mono[0]+=.2;wall[0]+=.2;await f.tick();mono[0]+=.2;wall[0]+=.2;await f.tick()
        p=packets.read()['packets'][-1];assert p['flight_elapsed_s']>=120
        assert p['plan_time']<p['sent_time']-3600
        assert abs(wall[0]-p['sent_time'])<1
        validate_packet(p,wall[0])
        f.command('pause');await f.apply_commands();at=f.pilot.elapsed
        assert f.status['status']=='paused'
        mono[0]+=20;wall[0]+=20
        f.command('resume');await f.apply_commands();assert f.pilot.elapsed==at
        assert f.status['mission_id']!=old_id
        mono[0]+=.1;wall[0]+=.1;await f.tick()
        assert 0<f.pilot.elapsed-at<.2
        f.command('stop');await f.apply_commands();assert f.pilot is None and f.status['status']=='stopped'
    asyncio.run(exercise())

def test_console_preview_cannot_cross_origin(tmp_path):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from communication.web.physical_console_routes import create_console_router
    class Console:
        def prepare(self,body):raise AssertionError('must not execute')
    app=FastAPI();app.include_router(create_console_router(Console(),None,tmp_path))
    with TestClient(app) as client:
        r=client.post('/api/v1/console/start',json={},headers={'origin':'https://foreign.invalid'})
        assert r.status_code==422

def test_elapsed_metadata_validation_remains_backwards_compatible():
    from project_support.tests.web_live.test_physical_uam import packet
    p=packet();validate_packet(p,1000.1)
    p['flight_elapsed_s']=120;validate_packet(p,1000.1)
    p['flight_elapsed_s']=float('nan')
    with pytest.raises(ValueError):validate_packet(p,1000.1)
