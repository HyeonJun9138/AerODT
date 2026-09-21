import math
from communication.python.manual_runtime import ManualRuntime

def fly(m, seconds, **command):
    states=[m.step(steps=25, **command) for _ in range(round(seconds*10))]
    assert all(math.isfinite(v) for s in states for v in s)
    return states

def cruise(m):
    fly(m,5,throttle=.36)
    return fly(m,70,throttle=1,wing=True)[-1]

def test_neutral_cruise_holds_altitude_without_freezing_attitude_or_speed():
    m=ManualRuntime()
    try:
        start=cruise(m)
        states=fly(m,60,throttle=1,wing=True)
        assert max(abs(s[3]-start[3]) for s in states)<.15
        assert abs(states[-1][6])<.02
        assert 78<math.hypot(*states[-1][4:6])<81
        assert states[-1][1]-start[1]>3900
        assert -4<states[-1][8]<-1,'actual pitch trims; telemetry must not be forced to zero'
    finally:m.close()

def test_stick_override_and_release_capture_new_altitude_with_small_jitter():
    m=ManualRuntime()
    try:
        start=cruise(m)
        up=fly(m,10,throttle=1,pitch=.5,wing=True)[-1]
        assert up[3]<start[3]-20
        settled=fly(m,30,throttle=1,wing=True)[-1]
        assert abs(settled[3]-up[3])<4
        assert abs(settled[6])<.03
        for pitch in [.015,-.015,0]:
            s=fly(m,10,throttle=1,pitch=pitch,wing=True)[-1]
            assert abs(s[3]-settled[3])<.1
        down=fly(m,10,throttle=1,pitch=-.5,wing=True)[-1]
        assert down[3]>settled[3]+20
        held=fly(m,30,throttle=1,wing=True)[-1]
        assert abs(held[3]-down[3])<4
        assert abs(held[6])<.03
    finally:m.close()

def test_throttle_change_turn_and_multirotor_landing_release_hold():
    m=ManualRuntime()
    try:
        start=cruise(m)
        changed=fly(m,45,throttle=.6,wing=True)[-1]
        assert abs(changed[3]-start[3])<1
        assert abs(changed[6])<.05
        turn=fly(m,25,throttle=.6,roll=.4,yaw=.4,wing=True)[-1]
        assert abs(turn[7]-changed[7])>20
        assert abs(turn[3]-start[3])<2
        fly(m,12,throttle=.15)
        landed=fly(m,140,throttle=0)[-1]
        assert landed[12]==1 and abs(landed[3])<.01
    finally:m.close()
