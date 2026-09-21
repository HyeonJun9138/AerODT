import math
from communication.python.manual_runtime import ManualRuntime

def run(m, throttle, seconds=2, **axes):
    return [m.step(throttle, steps=25, **axes) for _ in range(round(seconds*10))]

def test_low_collective_spins_real_rotors_without_lifting_or_moving():
    m=ManualRuntime()
    try:
        previous=0
        for throttle in [.01,.02,.05,.09,.10,.101]:
            s=run(m,throttle)[-1]
            assert s[11]>previous
            assert s[12]==1 and abs(s[3])<.01
            assert math.hypot(*s[4:6])<.01
            previous=s[11]
        assert run(m,0)[-1][11]<.01
    finally:m.close()

def test_rotor_speed_is_continuous_across_ground_assist_boundary():
    m=ManualRuntime()
    try:
        low=run(m,.099)[-1]
        samples=run(m,.101)
        assert all(abs(s[11]-low[11])<3 for s in samples)
        assert samples[-1][11]>low[11]
    finally:m.close()

def test_taxi_with_spinning_rotors_stays_bounded_and_can_lift_off():
    m=ManualRuntime()
    try:
        taxi=run(m,.05,8,pitch=-1)[-1]
        assert 2.98<math.hypot(*taxi[4:6])<3.01
        assert taxi[12]==1 and taxi[11]>0
        up=run(m,.36,8)[-1]
        assert up[12]==0 and up[3]<-5
    finally:m.close()
