"""Isolated native integration: no socket, running dashboard or user scenario."""
import math
import pytest
from communication.python.native_pilot import NativePilotLibrary
from user_application.uam_mission.scenario_pilots import ScenarioPilots
from digital_twin.simulation.scenario_engine import ScenarioEngine
from project_support.tests.web_live.test_fato_assignment import multi_engine
from project_support.tests.web_live.test_scenario_engine import schedule_of, row


def test_four_shared_fatos_complete_native_flights_with_frozen_routes_and_observed_release():
    base, _ = multi_engine()
    ports=list(base._vertiports.values())
    schedule=schedule_of(*[row(f'F{i}',f'A{i}','VP1','VP2','06:31:00',stand=f'G{i}',arrival_stand=f'G{i}')
                           for i in range(1,5)], vertiports=ports)
    try:
        library=NativePilotLibrary()
    except (OSError,RuntimeError):
        pytest.skip('Native pilot library unavailable')
    engine=ScenarioEngine(schedule,vertiports=ports,network=base._network,pilots=ScenarioPilots(library,workers=2))
    assigned, previous = {}, {}
    minimum = math.inf
    try:
        for _ in range(3000):
            engine.advance(engine.time_s+2)
            airborne=[]
            # A pad changes in flight only by an explicit PSU reassignment,
            # which the day records; it never drifts silently.
            reassigned={e['flight_id'] for e in engine.events if e['kind']=='arrival_reassigned'}
            for a in engine.aircraft.values():
                assert not a.failed, engine.problems
                if a.flight:
                    pair=(a.flight['departure_fato'],a.flight['arrival_fato'])
                    assigned.setdefault(a.flight['flight_id'],pair)
                    if a.flight['flight_id'] in reassigned:assigned[a.flight['flight_id']]=pair
                    assert assigned[a.flight['flight_id']]==pair
                if a.airborne:
                    airborne.append(a)
                    pose=(a.latitude*111320,a.longitude*111320*math.cos(math.radians(37.5)),a.altitude)
                    if a.aircraft_id in previous:
                        assert math.dist(previous[a.aircraft_id],pose)<200, 'native pose jumped'
                    previous[a.aircraft_id]=pose
                else:
                    previous.pop(a.aircraft_id,None)
            for i,a in enumerate(airborne):
                for b in airborne[i+1:]:
                    horizontal=math.hypot((a.latitude-b.latitude)*111320,
                        (a.longitude-b.longitude)*111320*math.cos(math.radians(a.latitude)))
                    minimum=min(minimum,math.hypot(horizontal,a.altitude-b.altitude))
            if all(a.completed for a in engine.aircraft.values()):break
        assert sum(a.completed for a in engine.aircraft.values())==4
        assert not engine._terminal.claims and not engine._active_pads
        assert minimum>30, ('observed close pair',minimum)
        assert len([e for e in engine.events if e['kind']=='takeoff'])==4
        assert len([e for e in engine.events if e['kind']=='touchdown'])==4
        assert any(e.get('outcome')=='hold' and e.get('blockers') for e in engine.events)
        assert len({p[1] for p in assigned.values()})>1, assigned
        print({'completed':4,'simulated_s':round(engine.time_s-engine.opens_s,1),
               'minimum_sampled_airborne_distance_m':round(minimum,1),'assignments':assigned,
               'decisions':sum(e['kind']=='psu_decision' for e in engine.events)})
    finally:
        engine.close()
