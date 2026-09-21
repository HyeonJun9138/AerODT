import math
from communication.python.manual_runtime import ManualRuntime

def test_full_stick_reaches_three_and_diagonal_stays_bounded():
    for roll,pitch in ((0,-1),(1,0),(1,-1)):
        m=ManualRuntime()
        try:
            for _ in range(130):s=m.step(roll=roll,pitch=pitch)
            assert 2.98 <= math.hypot(s[4],s[5]) <= 3.001
            assert s[12] == 1
            for _ in range(130):s=m.step()
            assert math.hypot(s[4],s[5]) < .01
        finally:m.close()
