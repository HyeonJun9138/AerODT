"""Ordered C/G guidance through the actual native controller and physics."""
import math
import pytest
from communication.python.native_pilot import NativePilotLibrary


def points(side=1, speed=10):
    return [(0,0,-30,2,0,8),(1000,0,-300,45,1,150),(3000,0,-300,45,1,150),
            (3100,0,-150,speed,0,60),(3100,side*100,-30,speed,0,60),
            (3100,side*100,0,2,0,8)]


@pytest.mark.parametrize('side,speed', [(1,10),(-1,4)])
def test_short_high_corner_descends_before_handoff_and_lands(side,speed):
    profile=points(side,10)
    frozen=tuple(profile)
    p=NativePilotLibrary().create(profile,0,90,[.7,.35,8,20,100,1,8,2.54,1.2,.6,1,1,8,23,26,speed,.7])
    entered={};samples=[];reverse=0
    try:
        for _ in range(35000):
            s=p.advance(.02)
            idx=int(s[14])
            entered.setdefault(idx,s)
            if idx in (3,4):
                samples.append(s)
                reverse += max(0,-(s[4] if idx==3 else side*s[5]))*.02
            if s[16]:break
        assert s[16] and s[13], s
        assert -entered[4][3] < 175, ('unserved descent before short corner', entered[4])
        assert max(v[6] for v in samples)<2.8
        assert reverse<5, ('actual reverse distance',reverse)
        assert math.hypot(s[1]-3100,s[2]-side*100)<.3
        assert tuple(profile)==frozen
    finally:p.close()


def test_hold_release_on_next_approach_leg_does_not_fly_back_to_old_entry():
    route = [(0,0,-30,2,0,8), (1000,0,-300,30,1,60),
             (1600,0,-150,10,0,1), (1800,0,-30,10,0,60), (1800,0,0,2,0,8)]
    pilot = NativePilotLibrary().create(route, 0, 0)
    try:
        for _ in range(2500):
            sample = pilot.advance(.2)
            if int(sample[14]) == 1 and sample[1] > 650:
                break
        assert int(sample[14]) == 1 and sample[1] > 650
        hold = (1150,20,-290)
        for _ in range(3000):
            sample = pilot.advance(.2, hold)
            assert int(sample[14]) == 1, 'clearance hold must retain the ordered waypoint'
            if math.hypot(sample[1]-hold[0],sample[2]-hold[1]) < 2 and abs(sample[3]-hold[2]) < 2 and math.hypot(sample[4],sample[5]) < .2:
                break
        assert math.hypot(sample[1]-hold[0],sample[2]-hold[1]) < 2
        released_x = sample[1]
        trace = [pilot.advance(.2) for _ in range(50)]
        assert int(trace[0][14]) == 2, 'join the immediate approach leg on release'
        assert min(s[1] for s in trace) >= released_x-2, 'no return toward the old 1000 m WP'
        assert trace[-1][1] > released_x+5, 'actual physics continues forwards'
        assert max(s[6] for s in trace) < 2.8, 'descent rate remains bounded'
    finally:
        pilot.close()


def test_landing_yaw_capability_changes_intent_without_resetting_physics():
    p=NativePilotLibrary().create(points(),0,0)
    try:
        before=p.advance(2)
        assert hasattr(p,'set_landing_yaw'), 'ABI must expose checked landing yaw update'
        assert p.set_landing_yaw(90)
        after=p.advance(0)
        assert after==before
        status=p.guidance_status()
        assert status['available'] and status['landing_yaw_mutable']
        with pytest.raises(ValueError):p.set_landing_yaw(float('nan'))
        for _ in range(3000):
            s=p.advance(.2)
            if int(s[14])==5:break
        assert int(s[14])==5
        assert not p.set_landing_yaw(-90)
        assert not p.guidance_status()['landing_yaw_mutable']
        for _ in range(1000):
            s=p.advance(.2)
            if s[13] and not s[16]:
                assert p.guidance_status()['reason']=='vertical_landing'
            if s[16]:break
        assert s[13] and s[16]
        assert abs(math.remainder(s[7]-90,360))<2
    finally:p.close()


def test_abi4_remains_usable_but_reports_unsupported_new_capabilities():
    from pathlib import Path
    old=Path(__file__).resolve().parents[3]/"project_support/build/aerodt/windows-release/bin/aerodt_uam_pilot.dll"
    if not old.is_file():
        pytest.skip("No preserved ABI 4 library on this host")
    library=NativePilotLibrary(old)
    if library.abi != 4:
        pytest.skip("Installed library no longer ABI 4")
    p=library.create(points(),0,0)
    try:
        assert len(p.advance(.02))==17
        assert p.guidance_status()=={"available":False,"reason":"unsupported",
                                     "waypoint_index":None,"landing_yaw_mutable":None}
        with pytest.raises(RuntimeError,match="ABI 5"):
            p.set_landing_yaw(90)
    finally:p.close()


def test_level_g_leg_prepares_speed_for_a_short_steep_successor_without_lowering_altitude():
    route=[(0,0,-30,2,0,8),(1000,0,-300,45,1,150),(3000,0,-300,45,1,150),
           (3300,0,-300,10,0,60),(3350,0,-30,10,0,60),(3350,0,0,2,0,8)]
    p=NativePilotLibrary().create(route,0,90)
    level=[]
    try:
        for _ in range(30000):
            s=p.advance(.02)
            if int(s[14])==3:level.append(s)
            if int(s[14])==4:break
        assert int(s[14])==4
        assert math.hypot(s[4],s[5])<2.0, 'next G descent requires upstream speed preparation'
        assert all(abs(v[3]+300)<2 for v in level), 'no unplanned lowering of a level leg'
    finally:p.close()


@pytest.mark.parametrize('side,speed,held,deck',[(1,10,False,0),(-1,4,True,40),(1,10,True,80)])
def test_ordered_s_approach_preserves_height_after_hold_and_precise_raised_deck(side,speed,held,deck):
    route=[(0,0,-30,2,0,8),(1000,0,-300,45,1,150),(3000,0,-300,45,1,150),
           (3100,0,-220,10,0,60),(3100,side*100,-150,10,0,60),
           (3200,side*100,-deck-30,10,0,60),(3200,side*100,-deck,2,0,8)]
    p=NativePilotLibrary().create(route,0,90,[.7,.35,8,20,100,1,8,2.54,1.2,.6,1,1,8,23,26,speed,.7])
    last=0;reverse=0.;did_hold=False;max_down=0.;max_speed=0.;start={}
    try:
        for _ in range(45000):
            s=p.advance(.02);idx=int(s[14]);start.setdefault(idx,s[0])
            assert idx>=last
            last=idx
            if idx in (3,4,5):
                max_down=max(max_down,s[6])
                reverse+=max(0.,-(side*s[5] if idx==4 else s[4]))*.02
                if s[0]-start[idx]>20:max_speed=max(max_speed,math.hypot(s[4],s[5]))
            if held and idx==4 and not did_hold:
                at=s[1:4];before=s
                for _ in range(500):s=p.advance(.02,at)
                assert p.guidance_status()['reason']=='clearance_hold'
                assert int(s[14])==idx
                did_hold=True
                resumed=p.advance(.02)
                assert resumed[3]>=s[3]-.01, 'hold release must not jump or reset altitude'
            if s[16]:break
        assert not held or did_hold
        assert s[13] and s[16],s
        assert math.dist(s[1:4],route[-1][:3])<.3
        assert max_down<2.8
        assert reverse<5,reverse
        assert max_speed<speed+.5, (speed,max_speed)
    finally:p.close()


@pytest.mark.parametrize('angle', [135,-135,170,-170])
@pytest.mark.parametrize('speed', [4,10])
def test_short_sharp_g_preview_and_handoff_are_geometrically_compatible(angle,speed):
    radians=math.radians(angle)
    end=(3025+25*math.cos(radians),25*math.sin(radians))
    route=[(0,0,-30,2,0,8),(1000,0,-300,45,1,150),(3000,0,-300,45,1,150),
           (3025,0,-150,10,0,60),(*end,-30,10,0,60),(*end,0,2,0,8)]
    p=NativePilotLibrary().create(route,0,90,[.7,.35,8,20,100,1,8,2.54,1.2,.6,1,1,8,23,26,speed,.7])
    reverse=0.;maximum_down=0.;previous_idx=0;handoff=None
    try:
        for _ in range(30000):
            s=p.advance(.02);idx=int(s[14])
            assert idx>=previous_idx
            previous_idx=idx
            if idx==4 and handoff is None:handoff=s
            if idx in (3,4):
                projected=s[4] if idx==3 else s[4]*math.cos(radians)+s[5]*math.sin(radians)
                reverse+=max(0.,-projected)*.02
                maximum_down=max(maximum_down,s[6])
            if s[16]:break
        assert s[16] and s[13], ('stuck on short sharp G',angle,speed,s)
        assert handoff is not None and -handoff[3]<175
        assert reverse<5, ('unnecessary physical reverse travel',angle,speed,reverse)
        assert maximum_down<2.8
        assert math.dist(s[1:4],route[-1][:3])<.3
    finally:p.close()
