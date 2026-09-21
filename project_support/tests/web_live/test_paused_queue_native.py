"""Native regression for two paused returns sharing the observed Magok entry."""
import math

import pytest

from digital_twin.simulation.scenario_engine import Phase, Route
from digital_twin.simulation.holding_queue import relative
from communication.python.native_pilot import NativePilotLibrary
from user_application.uam_mission.scenario_pilots import FlightPilot
from test_paused_queue_claims import magok_pair


@pytest.mark.parametrize('reverse', [False, True])
def test_native_stopped_returns_resume_in_proximity_order_without_an_observed_infringement(reverse):
    try:
        lib = NativePilotLibrary()
    except (OSError, RuntimeError):
        pytest.skip('native pilot library unavailable')
    q, initial, rejoin = magok_pair()
    pilots, observations = {}, []
    def observation(key,s):
        v=s['velocity_ned_mps']
        return dict(owner=key,position=(s['latitude_deg'],s['longitude_deg'],s['altitude_m']),velocity=(v[0],v[1],-v[2]))
    try:
        if reverse: initial.reverse()
        for o in initial:
            key=o['owner'];stop=o['position'];origin=(*stop[:2],stop[2]-30)
            away=(rejoin[0],rejoin[1]+.02,rejoin[2]);ground=(*away[:2],away[2]-30)
            route=Route(key,[Phase('takeoff','up',[origin,stop],30,8),
                Phase('descent','merge',[stop,rejoin,away],200,8),
                Phase('landing','land',[away,ground],30,1.2)],{}, {})
            p=FlightPilot(lib,route,0);pilots[key]=p
            for _ in range(600):
                s=p.advance(.25)
                if s['guidance']['waypoint_index']>=1:break
            else:raise AssertionError('initial ascent did not complete')
            for _ in range(160):s=p.advance(.25,stop)
            observations.append(observation(key,s))
        resumed=[];passed=[];nearest=math.inf;minimum_normalized=math.inf
        for step in range(2400):
            commands={}
            for o in observations:
                key=o['owner'];r=q.reservations.get(key)
                if r is None:commands[key]=None;continue
                delta=relative(o['position'],rejoin)
                if math.hypot(*delta[:2])<8 and abs(delta[2])<3 and math.hypot(*o['velocity'][:2])<1:
                    q.release(key);passed.append([key,step*.25]);commands[key]=None;continue
                clear=q.transfer_clear(key,o['position'],rejoin,observations,120,45,35)
                if clear:
                    if r.pop('return_hold',None) is not None:resumed.append([key,step*.25])
                    command=rejoin
                else:command=r.setdefault('return_hold',o['position'])
                r['movement_target']=command;commands[key]=command
            observations=[observation(o['owner'],pilots[o['owner']].advance(.25,commands[o['owner']])) for o in observations]
            gap=relative(observations[0]['position'],observations[1]['position']);horizontal=math.hypot(*gap[:2]);vertical=abs(gap[2])
            minimum_normalized=min(minimum_normalized,max(horizontal/120,vertical/45))
            if vertical<45:nearest=min(nearest,horizontal)
            if len(passed)==2:break
        assert [key for key,_ in passed] == ['B','A']
        assert [key for key,_ in resumed] == ['B','A']
        assert step*.25 < 300
        assert minimum_normalized > 1., 'observed pair entered the protected volume'
    finally:
        for p in pilots.values():p.close()
