import math
from pathlib import Path
from tempfile import TemporaryDirectory
import pytest
from communication.python.manual_runtime import ManualRuntime
from user_application.uam_mission.manual_flight import ManualFlight
from user_application.uam_mission.manual_autopilot import ManualAutopilot

COMMAND={'throttle':1,'roll':0,'pitch':0,'yaw':0,'flight_mode':'fixed_wing'}
PLAN={'legs':[{'stage':'cruise','kind':'air','speed_mps':55,'path':[[127,37,250],[127,37.06,250],[127.08,37.06,250]]}],
      'vehicle':{'passengers':4,'capacity':4},'totals':{'battery_start_pct':100}}

def test_native_auto_tracks_heading_altitude_speed_on_existing_runtime():
    m=ManualRuntime()
    try:
        for _ in range(100):s=m.step(.36)
        for _ in range(700):s=m.step(1,wing=True,steps=25)
        assert 78<math.hypot(*s[4:6])<81
        before=m.step(steps=0)
        m.guidance(True,35,s[3]-40,55)
        assert m.step(steps=0)==before,'engagement changes intent, never position/time'
        for _ in range(1100):s=m.step(1,wing=True,steps=25)
        assert abs(s[7]-35)<.5
        assert abs(s[3]-(before[3]-40))<.3
        assert abs(math.hypot(*s[4:6])-55)<.1
        assert .4<m.collective()<.8,'AP owns power even with manual lever at full'
        m.guidance(False)
        for _ in range(300):s=m.step(1,wing=True,steps=25)
        assert 78<math.hypot(*s[4:6])<81
    finally:m.close()

def test_full_manual_session_midflight_engage_turn_and_stick_override():
    with TemporaryDirectory() as directory:
        flight=ManualFlight(PLAN,[127,37,80],ManualRuntime(),Path(directory))
        try:
            for _ in range(100):flight.step({**COMMAND,'throttle':.36,'flight_mode':'multirotor'},12)
            for _ in range(450):sample=flight.step(COMMAND,25)
            before=sample['position'].copy();time=sample['time_s']
            reply=flight.autopilot_request(True)
            assert reply['accepted']
            assert reply['sample']['position']==before and reply['sample']['time_s']==time
            for _ in range(1700):sample=flight.step(COMMAND,25)
            assert sample['autopilot']['enabled']
            assert sample['autopilot']['waypoint']==3
            assert abs(sample['heading_deg']-90)<5
            assert abs(sample['position']['latitude']-37.06)<.0002
            assert abs(sample['position']['altitude_m']-250)<1
            assert abs(sample['speed_mps']-55)<.5
            sample=flight.step({**COMMAND,'roll':.5},25)
            assert not sample['autopilot']['enabled']
            assert '직접' in sample['autopilot']['message']
        finally:flight.close()

def sample(lat=37.025,lon=127):
    return {'position':{'latitude':lat,'longitude':lon,'altitude_m':250},'airborne':True,'tilt_deg':90,'speed_mps':55,'heading_deg':0}

def test_no_restart_at_departure_and_terminal_handover():
    a=ManualAutopilot(PLAN,[127,37,80]);a.engage(sample())
    goal=a.update(sample(),COMMAND)
    assert abs(goal[0])<1 and goal[2]==55
    end=sample(37.06,127.079);end['heading_deg']=90
    a.engage(end);assert a.update(end,COMMAND) is None
    assert not a.enabled and '접근' in a.reason

def test_ground_low_speed_invalid_route_and_manual_mode_rejected():
    for changes in [{'airborne':False},{'speed_mps':20},{'tilt_deg':50}]:
        with pytest.raises(ValueError):ManualAutopilot(PLAN,[127,37,80]).engage({**sample(),**changes})
    with pytest.raises(ValueError):ManualAutopilot({'legs':[]},[127,37,80]).engage(sample())
    a=ManualAutopilot(PLAN,[127,37,80]);a.engage(sample())
    assert a.update(sample(),{**COMMAND,'flight_mode':'multirotor'}) is None
