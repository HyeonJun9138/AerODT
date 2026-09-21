"""Observed ground occupancy and execution, not visual collision masking."""
import math

import pytest

from digital_twin.model_library import ground_motion
from digital_twin.model_library import flight_plan
from digital_twin.simulation.psu_sequencing import PsuSequencer
from test_scenario_engine import engine_of, row
from digital_twin.simulation.scenario_engine import Phase, Route
from user_application.uam_mission.ground_control import VertiportGroundControl


def test_departure_does_not_release_a_gate_before_the_aircraft_moves():
    engine = engine_of(row('D', 'A', 'VP1', 'VP2', '06:30:00'))
    aircraft = engine.aircraft['A']
    position = aircraft.latitude, aircraft.longitude
    engine._maybe_depart(aircraft, engine.time_s)
    assert (aircraft.latitude, aircraft.longitude) == position
    assert engine.psu._stands.occupant('VP1', 'G1') == 'A'
    assert not any(e['kind'] == 'off_block' for e in engine.events)


def test_an_arrival_reservation_is_not_a_physically_occupied_gate():
    psu = PsuSequencer(stands=lambda _: ['G1', 'G2'])
    clearance = psu.request_arrival(flight_id='IN', vertiport='V', fato='F',
                                  stand='G1', earliest_s=100, now_s=0)
    assert clearance.stand == 'G1'
    assert psu._stands.occupant('V', 'G1') is None
    assert psu._stands.reservation('V', 'G1') == 'IN'
    assert not psu._stands.free('V', 'G1', 'OTHER')


def test_gate_retarget_keeps_the_boarding_and_updates_the_alighting_walk():
    engine = engine_of(row('D', 'A', 'VP1', 'VP2', '06:30:00', arrival_stand='G2'))
    aircraft = engine.aircraft['A']
    engine._maybe_depart(aircraft, engine.time_s)
    previous = aircraft.route
    expected = engine.route(dict(aircraft.flight, arrival_stand='G3'))
    engine._retarget_arrival_gate(aircraft, 'G3')
    assert aircraft.route.boarding == previous.boarding
    assert aircraft.route.alighting == expected.alighting
    assert aircraft.route.phases[-1].points[-1] == expected.phases[-1].points[-1]
    assert aircraft.flight['arrival_stand'] == 'G2'


def test_stand_occupant_cannot_be_silently_overwritten():
    psu = PsuSequencer(stands=lambda _: ['G1'])
    psu.take_stand('V', 'G1', 'A')
    with pytest.raises(ValueError, match='점유'):
        psu.take_stand('V', 'G1', 'B')
    assert psu._stands.occupant('V', 'G1') == 'A'


def test_controlled_taxi_stops_at_permission_limit_and_resumes_without_a_jump():
    _, profile, total, _ = ground_motion.prepare([(37,127),(37.001,127)],4,8)
    distance = speed = 0.0
    for _ in range(600):
        previous = distance, speed
        distance, speed = ground_motion.advance(profile, distance, speed, 30, 4, .1)
        assert previous[0] <= distance <= 30 + 1e-7
        assert abs(speed-previous[1]) <= ground_motion.ACCEL_MPS2*.1+1e-6
        assert distance-previous[0] <= 4*.1+1e-7
    assert distance == pytest.approx(30, abs=.001)
    assert speed == pytest.approx(0, abs=.001)
    distance, speed = ground_motion.advance(profile, distance, speed, total, 4, .1)
    assert 30 < distance < 30.01 and 0 < speed <= .060001
    for _ in range(1500):
        distance, speed = ground_motion.advance(profile, distance, speed, total, 4, .1)
    assert distance == pytest.approx(total, abs=.001)
    assert speed == pytest.approx(0, abs=.001)


def test_controlled_taxi_uses_curvature_speed_and_the_same_spatial_heading():
    _, profile, total, _ = ground_motion.prepare([(37,127),(37.0003,127),(37.0003,127.0004)],4,8)
    distance = speed = 0.0
    heading = ground_motion.heading_at(profile, 0, 1000)
    for _ in range(5000):
        distance, speed = ground_motion.advance(profile, distance, speed, total, 4, .02)
        current = ground_motion.heading_at(profile, distance/total, 1000)
        assert abs(ground_motion.turn_delta(heading,current))/.02 <= ground_motion.YAW_RATE_DPS+.05
        heading = current
    assert distance == pytest.approx(total, abs=.001)


def test_impossible_taxi_permission_is_not_hidden_by_clamping_position():
    _, profile, _, _ = ground_motion.prepare([(37,127),(37.001,127)],4,8)
    with pytest.raises(ValueError, match='braking'):
        ground_motion.advance(profile, 20, 4, 21, 4, .1)


def crossing_engine():
    engine = engine_of(row('FA','A','VP1','VP2','06:30:00',stand='G1'),
                       row('FB','B','VP1','VP2','06:30:00',stand='G2'))
    engine.ground_control = VertiportGroundControl()
    for aircraft in engine.aircraft.values():
        engine._maybe_depart(aircraft,engine.time_s)
    for aircraft, ends in zip(engine.aircraft.values(), [((-50,0),(50,0)),((0,-50),(0,50))]):
        ll = [(37.525+n/111194.92664455874,126.920+e/(111194.92664455874*math.cos(math.radians(37.525)))) for n,e in ends]
        points, profile, _, duration = ground_motion.prepare(ll,4,0)
        path = [(lat,lon,20) for lat,lon in points]
        phase = Phase('gate_out','택시',path,duration,4,{'ground_motion':profile})
        air = Phase('takeoff','이륙',[path[-1],(*path[-1][:2],100)],200,0)
        aircraft.route = Route(aircraft.route.key,[phase,air],aircraft.route.arrival,aircraft.route.departure)
        aircraft.place(*path[0], profile['headings_deg'][0])
    return engine


def test_fleet_ground_crossing_yields_then_resumes_with_swept_separation():
    engine = crossing_engine()
    previous = None
    seen_wait = set()
    for _ in range(1400):
        engine.advance(engine.time_s+.1)
        a,b = engine.aircraft.values()
        positions = [engine._ground_xy('VP1',(x.latitude,x.longitude)) for x in (a,b)]
        assert math.dist(*positions) >= 14-1e-5
        if previous:
            # Closest relative approach during the interval, not just endpoints.
            r = tuple(previous[0][i]-previous[1][i] for i in (0,1))
            d = tuple((positions[0][i]-positions[1][i])-r[i] for i in (0,1))
            t = max(0,min(1,-sum(r[i]*d[i] for i in (0,1))/max(1e-12,sum(x*x for x in d))))
            assert math.hypot(*(r[i]+t*d[i] for i in (0,1))) >= 14-1e-5
        previous=positions
        seen_wait.update(x.aircraft_id for x in (a,b) if x.instruction.get('action')=='ground_wait')
        if a.phase==b.phase=='takeoff': break
    assert seen_wait
    assert a.phase==b.phase=='takeoff'
    assert not a.failed and not b.failed


def test_ground_start_hold_keeps_occupancy_and_does_not_count_as_travel():
    engine = engine_of(row('D','A','VP1','VP2','06:30:00'))
    engine.ground_control = VertiportGroundControl()
    engine.advance(engine.time_s+10)
    a=engine.aircraft['A']
    assert engine.psu._stands.occupant('VP1','G1')=='A'
    assert a.departed_s is None
    assert a.speed_mps==0


def test_nose_in_aircraft_without_pushback_turns_slowly_before_departure_taxi():
    engine=engine_of(row('D','A','VP1','VP2','06:30:00'))
    engine.ground_control=VertiportGroundControl();engine._configure_ground_routes()
    a=engine.aircraft['A'];engine._maybe_depart(a,engine.time_s)
    route_heading=a.route.phases[0].detail['ground_motion']['headings_deg'][0]
    parked_heading=(route_heading+180)%360
    a.heading=parked_heading
    # Reproduce a stand where the swept pushback path does not fit. This was
    # the fallback that reused the outward cached heading and snapped 180°.
    engine._pushback_fits=lambda *args:False
    engine._start_ground(a,engine.time_s)
    profile=a.route.phases[0].detail['ground_motion']
    alignment=profile['heading_alignment']
    assert alignment['from_deg']==pytest.approx(parked_heading)
    assert alignment['duration_s']>=27
    first=ground_motion.heading_at(profile,0,0)
    after_one=ground_motion.heading_at(profile,0,1)
    assert first==pytest.approx(parked_heading)
    assert abs(ground_motion.turn_delta(first,after_one))<1, \
        'one second must begin a bounded turn, not finish the 180-degree turn'
    assert ground_motion.at(profile,1)==(0,0), 'the airframe turns while stopped before rolling'
    engine.close()


def test_stand_reservation_transfer_is_atomic_and_retains_the_planned_gate():
    psu=PsuSequencer(stands=lambda _:['G1','G2','G3'])
    c=psu.request_arrival(flight_id='F',vertiport='V',fato='F2',stand='G1',earliest_s=100,now_s=0)
    psu.take_stand('V','G2','BLOCK')
    with pytest.raises(ValueError):
        psu.assign_arrival_stand('F','G2',5,'점유 재확인')
    assert c.stand=='G1' and psu._stands.reservation('V','G1')=='F'
    psu.assign_arrival_stand('F','G3',6,'도착 경로 확보')
    assert c.stand=='G3' and c.planned_stand=='G1' and c.gate_revision==1
    assert psu._stands.reservation('V','G1') is None
    assert psu._stands.reservation('V','G3')=='F'
    psu._stands.occupy_reserved('V','G3','F','A')
    assert psu._stands.occupant('V','G3')=='A'
    assert psu._stands.reservation('V','G3') is None


def test_reserved_gate_cannot_be_consumed_by_another_flight():
    psu=PsuSequencer(stands=lambda _:['G1'])
    psu._stands.reserve('V','G1','F')
    with pytest.raises(ValueError):
        psu._stands.occupy_reserved('V','G1','OTHER','A')
    assert psu._stands.occupant('V','G1') is None
    assert psu._stands.reservation('V','G1')=='F'


def test_gate_retarget_during_motion_defers_instead_of_moving_to_the_new_path():
    engine=engine_of(row('F','A','VP1','VP2','06:30:00'))
    a=engine.aircraft['A'];engine._maybe_depart(a,engine.time_s)
    a.index=len(a.route.phases)-1;a.phase='gate_in';a.speed_mps=2
    old=a.route
    assert engine._retarget_arrival_gate(a,'G3') is False
    assert a.route is old


def test_reassigned_taxi_joins_the_authored_graph_at_the_actual_stopped_point():
    engine=engine_of(row('F','A','VP1','VP2','06:30:00'))
    layout=engine._layout('VP2')
    taxi=flight_plan.taxi_path(layout,'F2','G2')
    actual=tuple((taxi['points'][0][i]+taxi['points'][1][i])/2 for i in (0,1))
    replacement=flight_plan.taxi_path_from_position(layout,actual,'G3')
    assert replacement['points'][0]==actual
    assert replacement['points'][-1]==engine._stand_place('VP2','G3')[:2]
    assert 'G3'==replacement['nodes'][-1]
    assert replacement['distance_m']>0
    with pytest.raises(ValueError):
        flight_plan.taxi_path_from_position(layout,(0,0),'G3')


def test_invalid_gate_reassignment_does_not_partially_replace_the_route():
    engine=engine_of(row('F','A','VP1','VP2','06:30:00'))
    a=engine.aircraft['A'];engine._maybe_depart(a,engine.time_s)
    c=engine.psu.request_arrival(flight_id='F',vertiport='VP2',fato='F2',stand='G2',earliest_s=100,now_s=0)
    a.clearance=c
    engine.psu.take_stand('VP2','G3','BLOCK')
    previous=a.route
    with pytest.raises(ValueError):engine._retarget_arrival_gate(a,'G3')
    assert a.route is previous and c.stand=='G2'
    assert engine.psu._stands.reservation('VP2','G2')=='F'


def test_gate_is_revalidated_after_an_unexpected_physical_occupant():
    engine=engine_of(row('F','A','VP1','VP2','06:30:00'))
    a=engine.aircraft['A'];engine._maybe_depart(a,engine.time_s)
    a.clearance=engine.psu.request_arrival(flight_id='F',vertiport='VP2',fato='F2',stand='G2',earliest_s=100,now_s=0)
    engine.psu.take_stand('VP2','G2','BLOCK')
    assert engine._ensure_arrival_gate(a,engine.time_s)
    assert a.clearance.stand!='G2'
    assert a.flight['arrival_stand']=='G2'
    assert engine.psu._stands.reservation('VP2','G2') is None
    assert engine.psu._stands.occupant('VP2','G2')=='BLOCK'


def test_an_occupied_fato_exit_prevents_arrival_entry_even_with_a_free_gate():
    engine=engine_of(row('F','A','VP1','VP2','06:30:00'),
                     row('B','B','VP2','VP1','09:00:00',stand='G4'))
    a,b=engine.aircraft.values();engine._maybe_depart(a,engine.time_s)
    a.clearance=engine.psu.request_arrival(flight_id='F',vertiport='VP2',fato='F2',stand='G2',earliest_s=100,now_s=0)
    b.place(*a.route.phases[a.route.landing_index].points[-1])
    assert engine._ensure_arrival_gate(a,engine.time_s) is False
    assert a.clearance.gate_reason=='착륙 출구 확보 대기: B'


def test_a_revalidated_gate_reacquires_a_missing_reservation_and_clears_stale_wait():
    engine=engine_of(row('F','A','VP1','VP2','06:30:00'))
    a=engine.aircraft['A'];engine._maybe_depart(a,engine.time_s)
    a.clearance=engine.psu.request_arrival(flight_id='F',vertiport='VP2',fato='F2',stand='G2',earliest_s=100,now_s=0)
    engine.psu._stands.unreserve('VP2','G2','F')
    a.clearance.gate_reason='착륙 출구 확보 대기: B'
    assert engine._ensure_arrival_gate(a,engine.time_s)
    assert engine.psu._stands.reservation('VP2','G2')=='F'
    assert '대기' not in a.clearance.gate_reason


def test_subsequent_gate_reassignment_reports_the_actual_previous_gate():
    engine=engine_of(row('F','A','VP1','VP2','06:30:00'))
    a=engine.aircraft['A'];engine._maybe_depart(a,engine.time_s)
    a.clearance=engine.psu.request_arrival(flight_id='F',vertiport='VP2',fato='F2',stand='G2',earliest_s=100,now_s=0)
    engine._retarget_arrival_gate(a,'G3')
    engine._retarget_arrival_gate(a,'G4')
    assert 'G3 → G4' in a.clearance.gate_reason
    assert a.flight['arrival_stand']=='G2'


def test_early_arrival_gate_change_keeps_departure_taxi_progress_and_claim():
    engine=engine_of(row('F','A','VP1','VP2','06:30:00'))
    engine.ground_control=VertiportGroundControl();engine._configure_ground_routes()
    a=engine.aircraft['A'];engine._maybe_depart(a,engine.time_s)
    engine._start_ground(a,engine.time_s)
    phase=a.route.phases[0];profile=phase.detail['ground_motion'];ground=a.ground
    ground['distance_m']=5.;ground['ready_s']=profile['times_s'][0]
    a.elapsed=ground_motion.time_at_distance(profile,5.)
    a.place(*phase.at_fraction(5./profile['distances_m'][-1],a.elapsed))
    engine._ground_permissions(engine.time_s)
    claim=engine.ground_control._claims['A']
    a.clearance=engine.psu.request_arrival(flight_id='F',vertiport='VP2',fato='F2',stand='G2',earliest_s=100,now_s=0)
    engine._retarget_arrival_gate(a,'G3')
    assert a.phase=='gate_out' and a.route.phases[0] is phase
    assert a.ground is ground and ground['distance_m']==5.
    assert engine.ground_control._claims['A'] is claim
    engine._ground_permissions(engine.time_s+1)
    assert a.ground['authority'].route_id==ground['route_id']
    engine.close()


def test_deck_summary_keeps_a_departing_aircrafts_observed_stand_until_clear():
    from test_scenario_session import make,CSV
    session,_=make();session.load(CSV)
    engine=session.engine;a=engine.aircraft['A1']
    engine._maybe_depart(a,engine.flights['F1']['off_block_s'])
    assert a.phase=='gate_out'
    assert engine.psu._stands.occupant('VP1','G1')=='A1'
    detail=session.vertiport('VP1')
    summary=next(p for p in session.vertiport_summary()['vertiports'] if p['vertiport_id']=='VP1')
    assert summary['stands_taken']==sorted(detail['stands'])
    assert 'G1' in summary['stands_taken']
    session.clear()


def test_rehearsal_waits_for_an_observed_free_gate_then_lands_and_alights():
    engine=engine_of(row('F','A','VP1','VP2','06:30:00'),
        *(row('B'+str(i),'B'+str(i),'VP2','VP1','09:00:00',stand='G'+str(i)) for i in range(1,5)))
    engine.ground_control=VertiportGroundControl();engine._configure_ground_routes()
    a=engine.aircraft['A']
    for _ in range(700):engine.advance(engine.time_s+1)
    assert not any(e['kind']=='touchdown' and e['aircraft_id']=='A' for e in engine.events)
    assert a.phase=='hold' and '대기' in a.instruction['clearance_reason']
    engine.psu.leave_stand('VP2','G3','B3')
    engine.aircraft['B3'].place(37.,126.,20.)  # Observed relocated obstacle in fixture.
    for _ in range(600):
        engine.advance(engine.time_s+1)
        if a.completed:break
    assert a.completed==1 and a.stand=='G3' and not a.failed
    assert a.unloading['schedule'] is not None
    assert engine.flights['F']['arrival_stand']=='G2'
    engine.close()


@pytest.mark.parametrize('error',[OSError('native IO failure'),RuntimeError('native execution failure')])
def test_failed_yaw_call_does_not_partially_commit_a_gate_change(error):
    class Pilots:
        def set_landing_yaw(self,*args):raise error
        def close(self):pass
    engine=engine_of(row('F','A','VP1','VP2','06:30:00'))
    a=engine.aircraft['A'];engine._maybe_depart(a,engine.time_s)
    a.clearance=engine.psu.request_arrival(flight_id='F',vertiport='VP2',fato='F2',stand='G2',earliest_s=100,now_s=0)
    engine.pilots=Pilots();a.pilot_active=True
    previous=a.route;pose=(a.latitude,a.longitude,a.altitude,a.heading)
    with pytest.raises(type(error)):engine._retarget_arrival_gate(a,'G3')
    assert a.route is previous and a.clearance.stand=='G2' and a.gate_revision==0
    assert engine.psu._stands.reservation('VP2','G2')=='F'
    assert engine.psu._stands.reservation('VP2','G3') is None
    assert (a.latitude,a.longitude,a.altitude,a.heading)==pose


def test_old_pilot_capability_uses_explicit_ground_alignment_without_calling_missing_abi():
    from types import SimpleNamespace
    class Pilots:
        library=SimpleNamespace(terminal_guidance_capable=False)
        def set_landing_yaw(self,*args):raise AssertionError('unsupported ABI must not be invoked')
        def close(self):pass
    engine=engine_of(row('F','A','VP1','VP2','06:30:00'))
    a=engine.aircraft['A'];engine._maybe_depart(a,engine.time_s)
    a.clearance=engine.psu.request_arrival(flight_id='F',vertiport='VP2',fato='F2',stand='G2',earliest_s=100,now_s=0)
    engine.pilots=Pilots();a.pilot_active=True
    pose=(a.latitude,a.longitude,a.altitude,a.heading)
    assert engine._retarget_arrival_gate(a,'G3')
    assert a.route.arrival['gate']==a.clearance.stand=='G3'
    assert engine.psu._stands.reservation('VP2','G3')=='F'
    assert engine.psu._stands.reservation('VP2','G2') is None
    assert '접지 후 지상 정렬' in a.clearance.gate_reason
    assert (a.latitude,a.longitude,a.altitude,a.heading)==pose
    engine.close()


def _mixed_observation_order(order):
    class ObservingPilots:
        mode='test-command-observer'
        def advance(self,aircraft_id,seconds,hold=None):
            a=e.aircraft[aircraft_id]
            return dict(latitude_deg=a.latitude,longitude_deg=a.longitude,altitude_m=a.altitude,
                heading_deg=a.heading,speed_mps=0,climb_mps=0,phase_index=a.index,
                phase_elapsed=a.elapsed+seconds,done=False,
                guidance={'available':True,'reason':'final_alignment','landing_yaw_mutable':False})
        def close(self):pass
    e=engine_of(row('F','A','VP1','VP2','06:30:00',arrival_stand='G1'),
        row('K','B','VP1','VP2','06:30:00',stand='G2',arrival_stand='G4'))
    e.ground_control=VertiportGroundControl();e._configure_ground_routes()
    for a in e.aircraft.values():
        e._maybe_depart(a,e.time_s)
        a.clearance=e.psu.request_arrival(flight_id=a.flight['flight_id'],vertiport='VP2',fato='F2',
            stand=a.flight['arrival_stand'],earliest_s=e.time_s,now_s=e.time_s)
    a,b=e.aircraft.values()
    a.index=a.route.landing_index;a.phase='landing';a.pilot_active=True
    a.place(*a.route.phases[a.index].points[0],0)
    a.clearance.approach_started_s=e.time_s-60
    a.telemetry={'guidance':{'available':True,'reason':'final_alignment','landing_yaw_mutable':False}}
    b.index=len(b.route.phases)-1;b.phase='gate_in';b.place(*b.route.phases[-1].points[0],180)
    e._start_ground(b,e.time_s)
    phase=b.route.phases[-1];profile=phase.detail['ground_motion'];ground=b.ground
    path=[e._ground_xy('VP2',p) for p in a.route.phases[-1].points]
    def cross_distance(p):
        values=[]
        for x,y in zip(path,path[1:]):
            v=(y[0]-x[0],y[1]-x[1]);q=(p[0]-x[0],p[1]-x[1])
            t=max(0,min(1,sum(z*w for z,w in zip(q,v))/max(1e-12,sum(z*z for z in v))))
            values.append(math.hypot(*(q[i]-t*v[i] for i in (0,1))))
        return min(values)
    total=profile['distances_m'][-1]
    distance=min((i*total/10000 for i in range(10001)),
        key=lambda d:abs(cross_distance(e._ground_xy('VP2',phase.at_fraction(d/total)))-13.9))
    ground['distance_m']=distance;ground['ready_s']=profile['times_s'][0]
    b.elapsed=ground_motion.time_at_distance(profile,distance)
    b.place(*phase.at_fraction(distance/total,b.elapsed));b.speed_mps=ground_motion.at(profile,b.elapsed)[1]
    e.aircraft={name:e.aircraft[name] for name in order};e.pilots=ObservingPilots()
    e._step(e.time_s+1,1)
    result=dict(a.instruction)
    assert not a.failed and not b.failed
    e.close();return result


def test_native_exit_permission_uses_the_same_observation_regardless_of_iteration_order():
    ab,ba=_mixed_observation_order('AB'),_mixed_observation_order('BA')
    assert ab['clearance']==ba['clearance']=='hold'
    assert ab['clearance_reason']==ba['clearance_reason']


def test_nose_in_departure_uses_pushback_path_in_ground_permissions():
    e=engine_of(row('D','A','VP1','VP2','06:30:00'))
    try:
        a=e.aircraft['A'];e._maybe_depart(a,e.time_s)
        phase=a.route.phases[0]
        a.heading=(phase.at_fraction(0)[3]+180)%360
        # Isolate integration from site clearance, which is checked separately.
        e._pushback_fits=lambda *args:True
        e._start_ground(a,e.time_s)
        p=a.route.phases[0].detail['ground_motion']
        assert p['pushback_end_m']>0
        assert a.ground['path_m']==tuple(e._ground_xy('VP1',x) for x in a.route.phases[0].points)
        assert abs(ground_motion.turn_delta(p['headings_deg'][0],a.heading))<1e-6
    finally:e.close()


def test_pushback_rejects_path_outside_platform():
    e=engine_of(row('D','A','VP1','VP2','06:30:00'))
    try:
        a=e.aircraft['A']
        assert not e._pushback_fits(a,[(0,0),(0,.001)],'VP1')
    finally:e.close()
