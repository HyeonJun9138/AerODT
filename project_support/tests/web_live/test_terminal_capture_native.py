"""Real native approach capture; do not validate only the requested velocity."""
import math
import pytest
from communication.python.native_pilot import NativePilotLibrary

@pytest.mark.parametrize('length,yaw,speed,hold,brake', [
    (100,0,10,False,.7),(500,0,10,False,.7),(2000,0,10,False,.7),
    (2000,90,20,False,.7),(500,-90,20,False,.7),(2000,45,10,True,.7),(2000,0,10,False,.2),(2000,0,10,False,3.0)])
def test_terminal_approach_brakes_before_hover_without_return_pass(length,yaw,speed,hold,brake):
    angle=math.radians(yaw);n,e=math.cos(angle),math.sin(angle)
    def point(x,z,v,wing,cap):
        return (x*n,x*e,z,v,wing,cap)
    target=3000+length
    tuning=[brake,.35,8,20,100,1,8,2.54,1.2,.6,1,1,8,23,26,speed,.7]
    p=NativePilotLibrary().create([point(0,-30,2,0,8),point(1000,-300,45,1,150),
        point(3000,-300,45,1,150),point(target,-30,speed,0,8),point(target,0,2,0,8)],yaw,yaw+90,tuning)
    samples=[];held=False
    try:
        for _ in range(9000):
            s=p.advance(.2)
            if int(s[14])==3:
                r=math.hypot(s[1]-target*n,s[2]-target*e)
                if hold and not held and 100<r<140:
                    at=(s[1],s[2],s[3])
                    for _ in range(100):p.advance(.2,at)
                    held=True
                    continue
                samples.append(s)
            if s[16]:break
        assert s[16], ('landing failed',length,yaw,speed,s)
        assert not hold or held
        close=[s for s in samples if math.hypot(s[1]-target*n,s[2]-target*e)<=10]
        assert close
        assert max(math.hypot(s[4],s[5]) for s in close)<2.5
        assert max(s[1]*n+s[2]*e-target for s in samples)<.6
        terminal=[s for s in samples if math.hypot(s[1]-target*n,s[2]-target*e)<=50]
        assert min(s[4]*n+s[5]*e for s in terminal)>-.25
        # All approach samples stay above the FATO hover target, allowing
        # centimetre-scale numerical settling rather than an early touchdown.
        assert max(s[3] for s in samples)<-29.5
    finally:p.close()

