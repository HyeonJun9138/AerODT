import math
import pytest
from communication.python.manual_runtime import ManualRuntime

def fly(m,seconds,**command):
    states=[m.step(steps=25,**command) for _ in range(round(seconds*10))]
    assert all(math.isfinite(v) for s in states for v in s)
    return states[-1]

@pytest.mark.parametrize('pitch',[-1,1])
def test_multirotor_full_stick_moves_faster_and_returns_to_level(pitch):
    m=ManualRuntime()
    try:
        fly(m,30,throttle=.36)
        moved=fly(m,30,throttle=1,pitch=pitch)
        assert 9 < math.hypot(*moved[4:6]) < 13
        assert 18 < abs(moved[8]) < 22
        assert moved[8]*pitch>0 and moved[4]*pitch<0
        assert moved[10]<.1 and not moved[12]
        released=fly(m,20,throttle=.36)
        assert abs(released[8])<.1
        assert math.hypot(*released[4:6])<1
    finally:m.close()

@pytest.mark.parametrize('pitch',[-.1,.1])
def test_small_multirotor_input_preserves_precision(pitch):
    m=ManualRuntime()
    try:
        fly(m,10,throttle=.36)
        s=fly(m,15,throttle=.36,pitch=pitch)
        assert .55 < abs(s[8]) < .62
        assert math.hypot(*s[4:6])<.5
    finally:m.close()
