"""ABI 6 changes future intent on the same runtime, not a restarted flight."""
import math
import pytest
from communication.python.native_pilot import NativePilotLibrary


def test_native_suffix_update_preserves_state_and_lands_on_new_pad():
    library=NativePilotLibrary()
    assert library.arrival_reassignment_capable, 'build aerodt_uam_pilot ABI 6'
    points=[(0,0,-30,2,0,8),(500,0,-150,40,1,100),
            (1000,0,-150,40,1,100),(1500,0,-30,10,0,8),(1500,0,0,2,0,8)]
    p=library.create(points,0,0)
    try:
        for _ in range(2000):
            s=p.advance(.2)
            if int(s[14])==2:break
        assert int(s[14])==2
        handle=p.handle;before=p.advance(0)
        suffix=[(1500,150,-30,10,0,8),(1500,150,-10,2,0,8)]
        assert not p.replace_arrival(1,3,suffix,90)
        assert not p.replace_arrival(2,2,suffix,90)
        assert p.replace_arrival(2,3,suffix,90)
        assert p.handle==handle and p.advance(0)==before
        with pytest.raises(RuntimeError):p.replace_arrival(2,3,[(1500,0,-30,10,0,8),(1600,0,0,2,0,8)],0)
        refused_final=False
        for _ in range(9000):
            s=p.advance(.2)
            if int(s[14])>=3 and not refused_final:
                assert not p.replace_arrival(int(s[14]),3,points[3:],0)
                refused_final=True
            if s[16]:break
        assert s[16] and refused_final
        assert math.hypot(s[1]-1500,s[2]-150)<1
        assert abs(s[3]+10)<1, 'contact plane must follow the new elevated destination'
    finally:p.close()


def test_live_native_aircraft_rechecks_newly_blocked_pad_and_taxis_to_new_gate():
    from digital_twin.simulation import psu_sequencing as psu
    from digital_twin.simulation.scenario_engine import ScenarioEngine
    from project_support.tests.web_live.test_fato_assignment import multi_engine
    from user_application.uam_mission.scenario_pilots import ScenarioPilots
    from user_application.uam_mission.ground_control import VertiportGroundControl
    base,original=multi_engine()
    from project_support.tests.web_live.test_scenario_engine import schedule_of,row
    ports=list(base._vertiports.values())
    schedule=schedule_of(row('F1','A1','VP1','VP2','06:31:00'),vertiports=ports)
    e=ScenarioEngine(schedule,vertiports=ports,network=base._network,
        pilots=ScenarioPilots(NativePilotLibrary(),workers=1),ground_control=VertiportGroundControl(),
        policy={'psu':{'assign_gate_after_touchdown':False}})
    injected=False;changed=False;handle=None;chosen=None
    try:
        for _ in range(2400):
            e.advance(e.time_s+1)
            a=e.aircraft['A1']
            assert not a.failed,e.problems
            if a.clearance and a.clearance.approach_started_s is None and not injected:
                old_pad=a.clearance.fato;old_stand=a.clearance.stand
                assert old_stand
                # A late change after takeoff, not pre-departure allocation.
                e.psu.pad('VP2',old_pad).hold(e.time_s,1600,'late-pad-use',psu.ARRIVAL)
                e.psu.take_stand('VP2',old_stand,'new-ground-occupant')
                native=e.pilots.flights['A1'].native;handle=native.handle
                before=native.advance(0)
                e._arrival_reviews.setdefault('F1',{'routes':{}})['next_s']=e.time_s+5
                injected=True
            if injected and a.clearance and a.clearance.fato!=old_pad:
                assert a.clearance.stand!=old_stand
                if a.pilot_active:
                    native=e.pilots.flights['A1'].native
                    assert native.handle==handle
                    assert native.advance(0)[0]>=before[0], 'runtime clock did not restart'
                changed=True;chosen=(a.clearance.fato,a.clearance.stand)
            if a.completed:break
        assert injected and changed and a.completed==1,e.problems
        assert a.stand==chosen[1]
        touchdown=next(event for event in e.events if event['kind']=='touchdown')
        assert touchdown['arrival_fato']==chosen[0]
        assert e.psu._stands.occupant('VP2',old_stand)=='new-ground-occupant'
        assert not e._active_pads and not e._terminal.claims
        assert e.flights['F1']['arrival_fato']==original['arrival_fato']
    finally:e.close();base.close()
