"""Usable ground capacity should not be stranded behind an unready request."""
import math
import pytest
from digital_twin.contracts.ground_operations import GroundObservation, MovementAuthority
from digital_twin.model_library import ground_motion
from digital_twin.model_library.ground_routes import route_geometry
from digital_twin.simulation.psu_sequencing import PsuSequencer, Tuning, ARRIVAL, DEPARTURE
from digital_twin.simulation.scenario_engine import Phase, Route
from test_scenario_engine import engine_of, row
from user_application.uam_mission.ground_control import VertiportGroundControl


def test_blocked_head_keeps_number_but_does_not_strand_ready_follower():
    psu=PsuSequencer(stands=lambda _:['G1','G2'])
    a=psu.request_arrival(flight_id='A',vertiport='V',fato='F',stand='G1',earliest_s=100,now_s=0)
    b=psu.request_arrival(flight_id='B',vertiport='V',fato='F',stand='G2',earliest_s=100,now_s=1)
    a.gate_reason='착륙 출구 확보 대기: ground'
    psu.refresh_arrivals({'A':dict(eta_s=200,remaining_s=100,approach_ready=False),
                         'B':dict(eta_s=200,remaining_s=100,approach_ready=True)},100)
    assert not psu.begin_approach('A',100)
    assert psu.begin_approach('B',100)
    assert [slot[2] for slot in psu.pad('V','F').slots]==['B']
    assert a.sequence==1 and b.sequence==2
    psu.refresh_arrivals({'A':dict(eta_s=210,remaining_s=100),
                         'B':dict(eta_s=200,remaining_s=90)},110)
    assert a.cleared_s>=b.cleared_s+psu.tuning.landing_separation_s


def test_only_uncommitted_unusable_gate_reservations_can_be_released():
    psu=PsuSequencer(stands=lambda _:['G1'])
    a=psu.request_arrival(flight_id='A',vertiport='V',fato='F',stand='G1',earliest_s=100,now_s=0)
    assert psu.release_uncommitted_stand('A')
    assert a.stand is None and psu._stands.free('V','G1')
    psu.reconsider_arrival('A',1)
    a.approach_s=1
    assert psu.begin_approach('A',1)
    assert not psu.release_uncommitted_stand('A')
    assert a.stand=='G1' and psu._stands.reservation('V','G1')=='A'


def test_fixed_gate_mode_rechecks_the_planned_gate_after_it_frees():
    psu=PsuSequencer(stands=lambda _:['G1','G2'],tuning=Tuning(reassign_stand=False))
    psu.take_stand('V','G1','parked')
    a=psu.request_arrival(flight_id='A',vertiport='V',fato='F',stand='G1',earliest_s=100,now_s=0)
    psu.reconsider_arrival('A',1)
    assert a.stand is None
    psu.leave_stand('V','G1','parked')
    psu.reconsider_arrival('A',2)
    assert a.stand=='G1'


def test_unstarted_departure_reclaims_an_earlier_slot_when_capacity_frees():
    psu=PsuSequencer(stands=lambda _:['G1'])
    a=psu.request_arrival(flight_id='A',vertiport='V',fato='F',stand='G1',earliest_s=100,now_s=0)
    d=psu.request_departure(flight_id='D',vertiport='V',fato='F',earliest_s=100,now_s=0)
    assert d.cleared_s>100
    psu.complete('A',ARRIVAL,50)
    assert psu.request_departure(flight_id='D',vertiport='V',fato='F',earliest_s=100,now_s=50) is d
    assert d.cleared_s==100
    assert len([s for s in psu.pad('V','F').slots if s[2]=='D'])==1


def taxi_fixture():
    e=engine_of(row('F','A','VP1','VP2','06:30:00'),
                row('B','B','VP1','VP2','06:30:00',stand='G3',arrival_stand='G4'))
    a,b=e.aircraft.values()
    for aircraft in (a,b):
        e._maybe_depart(aircraft,e.time_s)
    # A synthetic authored graph: the predecessor crosses the incoming taxi
    # corridor, then continues to a gate well clear of it.
    lat,lon=37.525,126.92
    points=[(lat-50/111320,lon),(lat+80/111320,lon)]
    path,profile,total,duration=ground_motion.prepare(points,4,0)
    phase=Phase('gate_in','taxi',[(n,v,10) for n,v in path],duration,4,{'ground_motion':profile})
    b.route=Route('B-taxi',[phase],{},{});b.index=0;b.phase='gate_in'
    e._start_ground(b,e.time_s)
    phase=b.route.phases[0];profile=phase.detail['ground_motion'];total=profile['distances_m'][-1]
    b.ground['distance_m']=50;b.ground['ready_s']=profile['times_s'][0]
    b.elapsed=ground_motion.time_at_distance(profile,50)
    b.place(*phase.at_fraction(50/total,b.elapsed));b.speed_mps=4
    b.ground['authority']=MovementAuthority(b.ground['length_m'],4,route_id=b.ground['route_id'])
    # Corridor perpendicular to B's observed route, through its current pose.
    n,v=e._ground_xy('VP2',(b.latitude,b.longitude))
    geometry=route_geometry(((n,v-50),(n,v+50)))
    return e,a,b,geometry


def test_predictive_exit_requires_observed_motion_and_authority_beyond_the_crossing():
    e,a,b,g=taxi_fixture()
    try:
        assert e._taxi_clears_before('B',g,14,e.time_s,e.time_s+100)
        assert not e._taxi_clears_before('B',g,14,e.time_s,e.time_s+1)
        b.speed_mps=0
        assert not e._taxi_clears_before('B',g,14,e.time_s,e.time_s+100)
        b.speed_mps=4
        b.ground['authority']=MovementAuthority(55,4,route_id=b.ground['route_id'])
        assert not e._taxi_clears_before('B',g,14,e.time_s,e.time_s+100)
    finally:e.close()


def test_predictive_exit_never_assumes_a_parked_endpoint_will_disappear():
    e,a,b,g=taxi_fixture()
    try:
        end=b.ground['path_m'][-1]
        g=route_geometry(((end[0],end[1]-50),(end[0],end[1]+50)))
        assert not e._taxi_clears_before('B',g,14,e.time_s,e.time_s+1000)
    finally:e.close()


def test_early_approach_forecast_does_not_remove_the_final_observed_exit_check():
    e,a,b,g=taxi_fixture()
    try:
        e.psu.tuning.reassign_stand=False
        lat,lon=b.latitude,b.longitude
        scale=111320*math.cos(math.radians(lat))
        exit_phase=Phase('gate_in','arrival exit',[(lat,lon-50/scale,10),(lat,lon+50/scale,10)],50,4)
        phases=[exit_phase if p.stage=='gate_in' else p for p in a.route.phases]
        a.route=Route(a.route.key,phases,a.route.arrival,a.route.departure)
        a.index=a.route.descent_index;a.phase='descent'
        a.clearance=e.psu.request_arrival(flight_id='F',vertiport='VP2',fato='F2',stand='G2',earliest_s=e.time_s+120,now_s=e.time_s)
        observed=tuple(e._ground_observations())
        assert e._ensure_arrival_gate(a,e.time_s,observed,clear_by_s=e.time_s+120)
        a.telemetry={'guidance':{'landing_yaw_mutable':False}}
        assert not e._ensure_arrival_gate(a,e.time_s,observed)
        assert a.clearance.stand=='G2'
        assert e.psu._stands.occupant('VP2','G2') is None
    finally:e.close()


def test_waiting_taxi_obstacle_can_trigger_a_reachable_alternative_gate():
    e=engine_of(row('F','A','VP1','VP2','06:30:00'),
                row('B','B','VP2','VP1','09:00:00',stand='G2'))
    a,b=e.aircraft.values();e._maybe_depart(a,e.time_s)
    e.psu.leave_stand('VP2','G2','B')
    a.clearance=e.psu.request_arrival(flight_id='F',vertiport='VP2',fato='F2',stand='G2',earliest_s=100,now_s=0)
    assert a.clearance.stand=='G2'
    # Still an observed obstruction near G2, but labelled as stopped taxi
    # instead of parked. Its label must not prevent reassignment to G3/G4.
    b.flight=e.flights['B'];b.phase='gate_out';b.speed_mps=0
    assert e._ensure_arrival_gate(a,e.time_s)
    assert a.clearance.stand!='G2'
    assert a.flight['arrival_stand']=='G2'
    assert not e._gate_path_blockers(a,a.route.phases[-1])


def test_waiting_ready_arrival_prevents_new_conflicting_departures_but_blocked_exit_does_not():
    e=engine_of(row('F','A','VP1','VP2','06:30:00'),
                row('D','D','VP2','VP1','09:00:00',stand='G4'))
    # Exercise strict crossing arbitration, not the optional separated-FATO assumptions.
    e._terminal.assume_mixed_separated=False
    e._terminal.assume_distinct_fatos_separated=False
    a=e.aircraft['A'];e._maybe_depart(a,e.time_s)
    a.index=a.route.descent_index;a.phase='hold';a.hold_seconds=120
    a.clearance=e.psu.request_arrival(flight_id='F',vertiport='VP2',fato='F2',stand='G2',earliest_s=e.time_s+100,now_s=e.time_s-120)
    a.clearance.approach_s=e.time_s
    flight=e.flights['D']
    end=a.route.phases[a.route.landing_index].points[-1]
    route=Route('departure-conflict',[Phase('takeoff','lift',[end,(end[0],end[1],end[2]+30)],30,1)],{}, {})
    assert any(b['reason']=='waiting_arrival_priority' for b in e._departure_blockers(flight,route))
    a.clearance.approach_s=None
    assert not any(b['reason']=='waiting_arrival_priority' for b in e._departure_blockers(flight,route))
