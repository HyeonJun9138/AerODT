"""Tactical intent must change actual native motion and return to the route."""
import math
import pytest
from communication.python.native_pilot import NativePilotLibrary


def test_native_right_offset_and_return_preserve_altitude_and_landing():
    library=NativePilotLibrary()
    assert library.traffic_capable, 'Build ABI 4 before validating tactical guidance'
    points=[(0,0,-30,2,0,8),(1000,0,-150,35,1,150),
            (10000,0,-150,35,1,150),(11000,0,-30,10,0,150),(11000,0,0,2,0,8)]
    pilot=library.create(points,0,0)
    diverted=[];rejoined=[];armed=False;released=False
    try:
        for _ in range(1500):
            s=pilot.advance(1)
            if s[14]==2 and s[1]>2000 and not armed:
                pilot.traffic(35,1);armed=True
            if armed and not released and 3000<s[1]<5000:
                diverted.append(s)
            if armed and s[1]>5000 and not released:
                pilot.traffic(0,1);released=True
            if released and 6500<s[1]<8000:
                rejoined.append(s)
            if s[16]:break
        assert diverted and max(r[2] for r in diverted)>20
        assert rejoined and max(abs(r[2]) for r in rejoined)<8
        assert max(abs(r[3]+150) for r in diverted+rejoined)<3
        assert s[16] and s[13] and math.dist(s[1:4],(11000,0,0))<.5
    finally:pilot.close()


def test_invalid_traffic_intent_is_rejected_without_touching_physics():
    pilot=NativePilotLibrary().create([(0,0,-30,2,0,8),(0,0,0,2,0,8)],0,0)
    try:
        for right,speed in [(float('nan'),1),(-1,1),(100,1),(10,.2)]:
            with pytest.raises(ValueError):pilot.traffic(right,speed)
    finally:pilot.close()
