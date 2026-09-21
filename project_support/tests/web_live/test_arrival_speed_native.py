from communication.python.native_pilot import NativePilotLibrary
def test_slowdown_is_effective_when_actual_speed_is_below_the_route_speed():
    pilot=NativePilotLibrary().create([(0,0,-30,2,0,8),(1000,0,-150,60,1,150),
        (12000,0,-150,60,1,150),(13000,0,-30,10,0,150),(13000,0,0,2,0,8)],0,0)
    try:
        for _ in range(700):
            s=pilot.advance(1)
            if s[14]==2 and s[1]>2500:break
        before=(s[4]**2+s[5]**2)**.5
        pilot.traffic(0,.75)
        for _ in range(45):s=pilot.advance(1)
        after=(s[4]**2+s[5]**2)**.5
        assert after<before-5,(before,after)
        assert not s[16]
    finally:pilot.close()
