from types import SimpleNamespace as NS
from dataclasses import replace
import threading
import pytest
from ai_pnp.uam_features import local_position, local_to_ecef
from digital_twin.contracts.live import TwinEntity
from user_application.uam_mission.scenario_session import ScenarioSession
from communication.web.manual_routes import _share
from digital_twin.simulation import manual_takeover


def fixture():
    points=((37.,127.,100.),(37.001,127.,100.),(37.002,127.,100.),(37.003,127.,100.))
    phase=NS(stage='cruise',speed_mps=20.,points=points,duration_s=20.,distance_m=333.,marks=(0.,111.,222.,333.))
    a=NS(aircraft_id='A',external={'flight_id':'F'},route=NS(phases=[phase]),pilot_active=False,telemetry={},index=0,elapsed=0.,hold=None)
    e=TwinEntity('scenario:A','A','uam',local_to_ecef(local_position(37.0015,127.,100.)),None,37.0015,127.,100.,0.,100.,100.,100.,None,'simulated','nominal','scenario','manual','kp2a',flight_phase='manual')
    s=ScenarioSession.__new__(ScenarioSession);s._lock=threading.RLock();s.control_open=True;s._manual_prediction_references={};s._prediction_generation=0;s.scenario_id='day'
    s.engine=NS(aircraft={'A':a},pilots=None,_state=lambda a:{'phase':'manual','holding':False,'flight_id':'F','speed_mps':20})
    s.epoch_time=lambda:100.;s.current=e;s._entity=lambda state,epoch:s.current
    return s,a,points


def test_assigned_manual_prediction_skips_passed_wp_despite_frozen_automatic_clock():
    s,a,points=fixture();_,intent=s.prediction_input('scenario:A')
    assert intent.waypoints[0].end==points[2]
    assert intent.waypoints[-1].end==points[3]
    assert (a.index,a.elapsed)==(0,0.)


def test_progress_does_not_rewind_and_new_assignment_resets_reference():
    s,a,points=fixture();s.prediction_input('scenario:A')
    s.current=replace(s.current,latitude_deg=37.0005)
    assert s.prediction_input('scenario:A')[1].waypoints[0].end==points[2]
    a.external={'flight_id':'new'}
    assert s.prediction_input('scenario:A')[1].waypoints[0].end==points[1]


def test_new_wp_invalidates_inflight_prediction_even_with_same_leg_index():
    s,a,points=fixture();e,intent=s.prediction_input('scenario:A');captured={'entity':e,'intent':intent,'context':s._prediction_context(e,intent)}
    s.current=replace(e,latitude_deg=37.0025,state_time=101.)
    assert not s.prediction_context_matches(captured)


def test_share_carries_native_attitude_and_velocity_and_place_validates_channels(monkeypatch):
    captured={}
    class Day:
        def place_manual(self,id,**pose):captured.update(pose);return True
    sample={'position':{'latitude':37.,'longitude':127.,'altitude_m':100.},'airborne':True,'pitch_deg':7.,'roll_deg':-8.,'tilt_deg':25.,'rotor_radps':350.,'velocity_ned_mps':[20.,3.,-2.],'control_surface_deg':[1.,2.,3.,4.]}
    assert _share(Day(),'A',sample,.06)
    assert captured['telemetry']['velocity_ned_mps']==[20.,3.,-2.]
    class Aircraft:
        external={'flight_id':'F'};airborne=True;telemetry={};speed_mps=0.
        def place(self,*args):pass
        def remember(self,*args):pass
    a=Aircraft();engine=NS(aircraft={'A':a},time_s=0)
    monkeypatch.setattr(manual_takeover,'_flight_of',lambda *args:{})
    monkeypatch.setattr(manual_takeover.manual_procedure,'observe',lambda *args:None)
    assert manual_takeover.place(engine,'A',**captured)
    assert a.telemetry['roll_deg']==-8.
    assert a.telemetry['velocity_ned_mps']==(20.,3.,-2.)
    manual_takeover.place(engine,'A',latitude=37,longitude=127,altitude=100,telemetry={'roll_deg':float('nan'),'velocity_ned_mps':[1,float('inf'),0],'route_target_index':900})
    assert a.telemetry['roll_deg']==-8 and a.telemetry['velocity_ned_mps']==(20.,3.,-2.)
    assert 'route_target_index' not in a.telemetry
