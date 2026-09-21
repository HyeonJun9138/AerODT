"""Native hover/escape/re-entry with the measured 84 m / 44 m geometry."""
import math
import pytest
from communication.python.native_pilot import NativePilotLibrary
from digital_twin.simulation.scenario_engine import Phase, Route, ScenarioEngine
from user_application.uam_mission.scenario_pilots import ScenarioPilots
from project_support.tests.web_live.test_scenario_engine import schedule_of,row,VERTIPORTS,NETWORK


@pytest.mark.parametrize('step',[.1,.2,1.0])
def test_short_final_eta_yield_moves_and_both_native_flights_finish(step):
    e=ScenarioEngine(schedule_of(row('FA','A','VP1','VP2','06:30:00'),
        row('FB','B','VP1','VP2','06:30:00',stand='G3',arrival_stand='G4')),
        vertiports=VERTIPORTS,network=NETWORK,elevation=lambda lon,lat:0,
        pilots=ScenarioPilots(NativePilotLibrary(),workers=1))
    base=e.route(e.flights['FA']); landing=base.phases[base.landing_index].points[-1]
    first=(landing[0],landing[1],landing[2]+124.5)
    second=(landing[0]+84/111320,landing[1],landing[2]+80.5)
    # A reproducible initial-condition fixture. All subsequent pose changes
    # are native integration; no test writes an in-flight runtime position.
    for a,point in zip(e.aircraft.values(),(first,second)):
        f=e.flights[a.flights[0]];route=e.route(f)
        phases=[Phase('takeoff','fixture takeoff',[(point[0],point[1],point[2]-30),point],30,2),
            Phase('descent','approach',[point,(landing[0],landing[1],landing[2]+30)],60,10),
            Phase('landing','land',[(landing[0],landing[1],landing[2]+30),landing],30,2),
            next(p for p in route.phases if p.stage=='gate_in')]
        a.flight=f;a.route=Route(f['flight_id']+'-pair',phases,route.arrival,route.departure)
        a.next_flight=1;a.phase='takeoff';a.index=0;a.pilot_active=True
        e.psu.leave_stand('VP1',a.stand,a.aircraft_id)
        e.pilots.start(a.aircraft_id,a.route,0)
        for _ in range(180):sample=e.pilots.advance(a.aircraft_id,.5,point)
        # The held runtime has not advanced its waypoint cursor; acquire the
        # initial hover waypoint normally before starting the traffic fixture.
        for _ in range(200):
            sample=e.pilots.advance(a.aircraft_id,.1)
            if sample['phase_index']>=1:break
        for _ in range(180):sample=e.pilots.advance(a.aircraft_id,.1,point)
        a.telemetry=sample;a.place(sample['latitude_deg'],sample['longitude_deg'],sample['altitude_m'],sample['heading_deg'])
        a.index=sample['phase_index'];a.phase='hold';a.speed_mps=sample['speed_mps']
        a.hold={'fix':point,'slot':None,'entered_s':e.time_s}
        a.clearance=e.psu.request_arrival(flight_id=f['flight_id'],vertiport='VP2',fato='F2',stand=f['arrival_stand'],
            earliest_s=e.time_s+100,now_s=e.time_s)
        a.clearance.approach_started_s=e.time_s+(0 if a.aircraft_id=='A' else 10)
        a.clearance.approach_s=e.time_s
        e._terminal.acquire(f,a.route,'arrival')
    minimum=math.inf;max_move=0;previous={};escaped=False
    try:
        assert e._remaining_native(e.aircraft['B'])<e.policy['psu']['final_guard_s']
        for _ in range(math.ceil(2000/step)):
            e.advance(e.time_s+step)
            for a in e.aircraft.values():
                assert not a.failed,e.problems
                pose=(a.latitude*111320,a.longitude*111320*math.cos(math.radians(37.5)),a.altitude)
                if a.airborne and a.aircraft_id in previous:max_move=max(max_move,math.dist(pose,previous[a.aircraft_id]))
                previous[a.aircraft_id]=pose
            a,b=e.aircraft.values()
            if a.airborne and b.airborne:
                h=math.hypot((a.latitude-b.latitude)*111320,(a.longitude-b.longitude)*111320*math.cos(math.radians(a.latitude)))
                minimum=min(minimum,math.hypot(h,a.altitude-b.altitude))
            escaped=escaped or any(v['kind'] in ('approach_separation','holding_assignment') for v in e.events)
            if all(a.completed for a in e.aircraft.values()):break
        assert escaped
        assert len([v for v in e.events if v['kind']=='approach_separation'])<=2
        assert not any(v['kind']=='approach_separation_stopped' for v in e.events)
        assert sum(a.completed for a in e.aircraft.values())==2,[(a.phase,a.instruction,a.hold) for a in e.aircraft.values()]
        assert minimum>80 and max_move<11*step,(minimum,max_move)
        assert not e._terminal.claims and not e._active_pads
        print(dict(completed=2,step_s=step,minimum_sampled_distance_m=minimum,maximum_step_m=max_move,seconds=e.time_s-e.opens_s))
    finally:e.close()
