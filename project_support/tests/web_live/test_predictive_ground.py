"""PSU and deck cooperation preserves actual occupancy beneath future intent."""
import math
import pytest
from digital_twin.contracts.ground_operations import MovementAuthority
from digital_twin.model_library import ground_motion
from digital_twin.model_library.ground_routes import route_geometry
from digital_twin.simulation.psu_sequencing import StandTimeline, ARRIVAL
from digital_twin.simulation.scenario_engine import Phase, Route
from user_application.uam_mission.ground_control import VertiportGroundControl
from test_scenario_engine import engine_of, row


def test_future_reservation_keeps_actual_occupant_and_excludes_second_successor():
    stands=StandTimeline();stands.take('V','G','D')
    stands.reserve_future('V','G','A','D')
    assert stands.occupant('V','G')=='D'
    assert stands.reservation('V','G')=='A'
    assert not stands.free('V','G','A')
    with pytest.raises(ValueError):stands.reserve_future('V','G','B','D')
    with pytest.raises(ValueError):stands.reserve_future('V','G','A','someone_else')
    with pytest.raises(ValueError):stands.occupy_reserved('V','G','A','aircraftA')
    stands.release('V','G','D');assert stands.free('V','G','A')
    assert not stands.free('V','G','B')
    stands.occupy_reserved('V','G','A','aircraftA')
    assert stands.occupant('V','G')=='aircraftA' and stands.reservation('V','G') is None


def fixture():
    e=engine_of(row('A','A','VP1','VP2','06:30:00'),
                row('D','D','VP2','VP1','09:00:00',stand='G2'))
    e.ground_control=VertiportGroundControl();e.psu.tuning.reassign_stand=False
    a,d=e.aircraft['A'],e.aircraft['D'];e._maybe_depart(a,e.time_s)
    a.index=a.route.descent_index;a.phase='descent'
    a.place(*a.route.phases[a.index].at(0));a.clearance=e.psu.request_arrival(
        flight_id='A',vertiport='VP2',fato='F2',stand='G2',earliest_s=e.time_s+100,now_s=e.time_s)
    d.flight=e.flights['D']
    # A straight observed departure from its real gate into a separate northern
    # pad. Keep arrival geometry and authored stand unchanged.
    lat,lon,height=d.latitude,d.longitude,d.altitude
    path,profile,total,duration=ground_motion.prepare([(lat,lon),(lat-.002,lon)],4,0)
    taxi=Phase('gate_out','departure',[(n,v,height) for n,v in path],duration,4,{'ground_motion':profile})
    takeoff=Phase('takeoff','lift',[(lat-.002,lon,height),(lat-.002,lon,height+80)],40,2)
    d.route=Route('independent-departure',[taxi,takeoff],{},{'fato':'F1'})
    d.index=0;d.phase='gate_out';e._start_ground(d,e.time_s)
    d.ground['distance_m']=2;d.ground['ready_s']=profile['times_s'][0]
    d.elapsed=ground_motion.time_at_distance(profile,2);d.place(*taxi.at_fraction(2/total,d.elapsed));d.speed_mps=2
    d.ground['authority']=MovementAuthority(d.ground['length_m'],4,route_id=d.ground['route_id'])
    assert not e._terminal.acquire(d.flight,d.route,'departure')
    e._active_pads[('VP2','F1')]='D'
    # This isolated fixture models a spacious deck with independent pads.
    # The normal four-gate deck is deliberately treated as shared airspace.
    from copy import deepcopy
    e._vertiports['VP2']=deepcopy(e._vertiports['VP2'])
    next(p for p in e._layout('VP2')['fatos'] if p['id']=='F1')['center_m']=[-10,-243]
    return e,a,d


def test_moving_departure_allows_early_gate_reservation_without_claiming_occupancy():
    e,a,d=fixture()
    try:
        assert a.clearance.stand is None
        assert e._ensure_arrival_gate(a,e.time_s,clear_by_s=e.time_s+120)
        c=a.clearance
        assert c.stand=='G2' and c.gate_release_aircraft_id=='D'
        assert e.time_s<c.gate_available_s<=e.time_s+120
        assert e.psu._stands.occupant('VP2','G2')=='D'
        assert e.psu._stands.reservation('VP2','G2')=='A'
        assert a.flight['arrival_stand']=='G2' and not c.landing_staging
        e.psu.refresh_arrivals({'A':{'eta_s':e.time_s+100,'remaining_s':100,'approach_ready':True}},e.time_s)
        assert e.psu.begin_approach('A',e.time_s)
    finally:e.close()


@pytest.mark.parametrize('reason',['stopped','failed','uncommitted','short_authority','missing_authority','late','disabled'])
def test_unproven_departure_cannot_create_an_airborne_gate_promise(reason):
    e,a,d=fixture()
    try:
        deadline=e.time_s+120
        if reason=='stopped':d.speed_mps=0
        elif reason=='failed':d.failed=True
        elif reason=='uncommitted':e._terminal.release('D','departure')
        elif reason=='short_authority':d.ground['authority']=MovementAuthority(3,4,route_id=d.ground['route_id'])
        elif reason=='missing_authority':d.ground['authority']=None
        elif reason=='late':deadline=e.time_s+1
        else:e.policy['psu']['predictive_ground']=False
        assert not e._ensure_arrival_gate(a,e.time_s,clear_by_s=deadline)
        assert e.psu._stands.reservation('VP2','G2') is None
        assert e.psu._stands.occupant('VP2','G2')=='D'
    finally:e.close()


def test_failed_forecast_retracts_entry_without_releasing_actual_occupancy():
    e,a,d=fixture()
    try:
        assert e._ensure_arrival_gate(a,e.time_s,clear_by_s=e.time_s+120)
        d.speed_mps=0
        assert not e._ensure_arrival_gate(a,e.time_s+1,clear_by_s=e.time_s+120)
        e.psu.refresh_arrivals({'A':{'eta_s':e.time_s+100,'remaining_s':99,'approach_ready':False}},e.time_s+1)
        assert not e.psu.begin_approach('A',e.time_s+1)
        assert a.clearance.gate_available_s is None
        assert e.psu._stands.occupant('VP2','G2')=='D'
    finally:e.close()


def test_final_can_land_on_independent_clear_fato_while_gate_departure_continues():
    e,a,d=fixture()
    try:
        assert e._ensure_arrival_gate(a,e.time_s,clear_by_s=e.time_s+120)
        assert e._ensure_arrival_gate(a,e.time_s)
        assert a.clearance.landing_staging
        assert e.psu._stands.occupant('VP2','G2')=='D'
    finally:e.close()


@pytest.mark.parametrize('blocker',['same_pad','crossing_taxi','occupied_pad','no_staging'])
def test_staging_never_blocks_its_departure_or_uses_an_occupied_pad(blocker):
    e,a,d=fixture()
    try:
        assert e._ensure_arrival_gate(a,e.time_s,clear_by_s=e.time_s+120)
        if blocker=='same_pad':d.route.departure['fato']='F2'
        elif blocker=='occupied_pad':e._active_pads[('VP2','F2')]='someone'
        elif blocker=='no_staging':e.policy['psu']['landing_staging_wait_s']=0
        else:
            landing=a.route.phases[a.route.landing_index].points[-1]
            d.route.phases[0].points.append(landing)
        assert not e._ensure_arrival_gate(a,e.time_s)
        assert not a.clearance.landing_staging
    finally:e.close()


def test_free_gate_is_preferred_to_forecast_and_forecast_clears_after_observed_release():
    e,a,d=fixture()
    try:
        assert e._ensure_arrival_gate(a,e.time_s,clear_by_s=e.time_s+120)
        d.ground['distance_m']=70;profile=d.route.phases[0].detail['ground_motion']
        d.place(*d.route.phases[0].at_fraction(70/profile['distances_m'][-1]));e._observe_ground_departure(d,e.time_s+30)
        assert e.psu._stands.occupant('VP2','G2') is None
        assert e._ensure_arrival_gate(a,e.time_s+30)
        assert a.clearance.gate_release_aircraft_id is None
        assert e.psu._stands.reservation('VP2','G2')=='A'
    finally:e.close()


def entry_fixture():
    e,a,d=fixture()
    landing=a.route.phases[a.route.landing_index].points[-1];n,v,h=landing
    start=(n+.02,v,h+80);near=(n,v,h+30)
    phases=[Phase('descent','initial',[start,near],150,15),Phase('landing','vertical',[near,landing],30,1)]
    a.route=Route(('long-inbound','G2'),phases,{'fato':'F2','gate':'G2'},{});a.index=0;a.place(*phases[0].at(0));a.speed_mps=15
    departure=Route('shared-departure',[Phase('takeoff','lift',[landing,(n,v,h+80)],40,2)],{}, {'fato':'F2'})
    e._terminal.release('D','departure');d.flight=dict(d.flight,departure_fato='F2');d.route=departure
    assert not e._terminal.acquire(d.flight,departure,'departure')
    return e,a,d


def test_initial_approach_reserves_disjoint_prefix_while_departure_retains_shared_final():
    e,a,d=entry_fixture()
    # This regression exercises strict mixed-route reservation, not the optional research assumption.
    e._terminal.assume_mixed_separated=False
    try:
        assert e._terminal.blockers(a.flight,a.route,'arrival')
        prefix=e._arrival_entry_route(a,200)
        assert prefix is not None
        assert not e._terminal.acquire(a.flight,prefix,'arrival')
        assert ('D','departure') in e._terminal.claims
        assert ('A','arrival') in e._terminal.claims
        assert e._terminal.blockers(a.flight,a.route,'arrival')
        assert e._arrival_entry_route(a,40) is None
        e._terminal.release('D','departure')
        assert not e._terminal.acquire(a.flight,a.route,'arrival')
    finally:e.close()


def test_initial_approach_cannot_continue_inside_final_braking_envelope_even_with_bad_eta():
    e,a,d=entry_fixture()
    try:
        a.place(*a.route.phases[-1].points[0]);a.speed_mps=20
        assert e._arrival_entry_route(a,300) is None
    finally:e.close()
