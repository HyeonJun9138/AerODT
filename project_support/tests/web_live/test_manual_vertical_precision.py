"""10% hover hold and 7..13% vertical-speed intent through real native physics."""
import math
import pytest
from communication.python.manual_runtime import ManualRuntime


def run(m, throttle, seconds, **axes):
    states=[m.step(throttle, steps=25, **axes) for _ in range(round(seconds*10))]
    assert all(math.isfinite(x) for s in states for x in s)
    return states


@pytest.mark.parametrize('throttle,speed',[(.07,-.6),(.08,-.386),(.09,-.171),(.11,.229),(.12,.514),(.13,.8)])
def test_fine_band_commands_graded_vertical_speed(throttle,speed):
    m=ManualRuntime()
    try:
        run(m,.13,30)
        run(m,.1,10)
        state=run(m,throttle,12)[-1]
        assert not state[12]
        assert abs(-state[6]-speed)<.06
    finally:m.close()


@pytest.mark.parametrize('previous',[.07,.13,.36])
def test_neutral_brakes_then_holds_without_freezing_motion(previous):
    m=ManualRuntime()
    try:
        run(m,.13,30)
        run(m,previous,5)
        before=m.step(previous,steps=0)
        first=m.step(.1,steps=1)
        assert abs(first[6]-before[6])<.05
        run(m,.1,40)
        samples=run(m,.1,30)
        assert max(s[3] for s in samples)-min(s[3] for s in samples)<.04
        assert abs(samples[-1][6])<.01
        assert samples[-1][12]==0
        # Small lever noise must not release captured altitude.
        for value in [.099,.101,.1]:
            state=run(m,value,8)[-1]
            assert abs(state[3]-samples[-1][3])<.04
    finally:m.close()


def test_ground_neutral_no_autolaunch_and_controlled_landing_no_relaunch():
    m=ManualRuntime()
    try:
        assert all(s[12] and abs(s[3])<.01 for s in run(m,.1,10))
        up=run(m,.13,10)[-1]
        assert 3 < -up[3] < 9
        run(m,.1,8)
        states=run(m,.07,35)
        assert max(s[6] for s in states)<.7
        assert states[-1][12] and abs(states[-1][3])<.01
        assert all(s[12] for s in run(m,.1,10))
        assert run(m,0,3)[-1][11]<.01
        assert not run(m,.13,5)[-1][12]
    finally:m.close()


def test_tilted_manual_hold_and_cutoff():
    m=ManualRuntime()
    try:
        run(m,.13,20)
        run(m,.1,10)
        samples=run(m,.1,20,roll=.5,pitch=.5)
        assert abs(samples[-1][6])<.03
        assert max(s[3] for s in samples)-min(s[3] for s in samples)<.15
        assert math.hypot(*samples[-1][4:6])>.1
        assert run(m,0,3)[-1][11]<.01
    finally:m.close()


def test_assisted_landing_on_elevated_deck():
    m=ManualRuntime()
    try:
        run(m,.13,30)
        m.deck([(-100,-100),(100,-100),(100,100),(-100,100)],-10)
        states=run(m,.07,50)
        assert states[-1][12] and abs(states[-1][3]+10)<.01
        assert max(s[6] for s in states)<.7
        assert all(s[12] for s in run(m,.1,10))
    finally:m.close()


def test_physics_tick_batching_does_not_change_vertical_response():
    a,b=ManualRuntime(),ManualRuntime()
    try:
        for throttle in [.13,.1,.07,.1,0]:
            for _ in range(50):
                sa=a.step(throttle,steps=25)
                for _ in range(25):sb=b.step(throttle,steps=1)
            assert sa==pytest.approx(sb,abs=1e-10)
    finally:a.close();b.close()
