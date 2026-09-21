"""Predicted release must improve flow without granting an occupied final pad."""
import math
from digital_twin.simulation.psu_sequencing import PsuSequencer, ARRIVAL
from user_application.uam_mission.traffic_awareness import TrafficAwareness, closest


def book(psu, name, eta, stand):
    return psu.request_arrival(flight_id=name, vertiport='V', fato='F', stand=stand,
                              earliest_s=eta, now_s=0)


def test_following_approach_starts_before_predecessor_touches_down():
    psu=PsuSequencer(stands=lambda _: ['G1','G2','G3'])
    first=book(psu,'A',200,'G1'); second=book(psu,'B',210,'G2')
    psu.refresh_arrivals({'A':{'eta_s':200,'remaining_s':200},'B':{'eta_s':210,'remaining_s':210}},0)
    assert psu.begin_approach('A',0)
    assert not psu.begin_approach('B',0)
    psu.refresh_arrivals({'A':{'eta_s':200,'remaining_s':100},'B':{'eta_s':310,'remaining_s':210}},100)
    assert psu.begin_approach('B',100)
    assert second.approach_started_s < first.eta_s
    assert first.sequence == 1 and second.sequence == 2
    slots=psu.pad('V','F').slots
    assert all(a[1]<=b[0] for a,b in zip(slots,slots[1:]))


def test_late_predecessor_moves_following_slot_and_early_release_recovers_it():
    psu=PsuSequencer(stands=lambda _: ['G1','G2'])
    a=book(psu,'A',200,'G1'); b=book(psu,'B',210,'G2')
    psu.refresh_arrivals({'A':{'eta_s':200,'remaining_s':200},'B':{'eta_s':210,'remaining_s':210}},0)
    psu.begin_approach('A',0)
    psu.refresh_arrivals({'A':{'eta_s':400,'remaining_s':300},'B':{'eta_s':310,'remaining_s':210}},100)
    delayed=b.cleared_s
    assert delayed>=a.cleared_s+psu.tuning.landing_separation_s
    psu.complete('A',ARRIVAL,110)
    psu.refresh_arrivals({'B':{'eta_s':320,'remaining_s':210}},110)
    assert b.cleared_s < delayed and b.sequence==2 and b.revision>=2


def test_departure_bookings_and_capacity_remain_protected():
    psu=PsuSequencer(stands=lambda _: ['G1','G2'])
    departure=psu.request_departure(flight_id='D',vertiport='V',fato='F',earliest_s=200,now_s=0)
    a=book(psu,'A',200,'G1'); b=book(psu,'B',200,'G2')
    psu.refresh_arrivals({'A':{'eta_s':200,'remaining_s':200},'B':{'eta_s':200,'remaining_s':200}},0)
    assert a.cleared_s >= departure.cleared_s+psu.tuning.mixed_separation_s
    assert not psu.begin_approach('A',0)
    assert psu.begin_approach('A',100,capacity=1)
    assert not psu.begin_approach('B',200,capacity=1)


def test_no_stand_means_no_speculative_pad_booking_or_approach():
    psu=PsuSequencer(stands=lambda _: ['G1'])
    psu.take_stand('V','G1','parked')
    c=book(psu,'A',200,'G1')
    psu.refresh_arrivals({'A':{'eta_s':200,'remaining_s':200}},0)
    assert c.stand is None and not psu.begin_approach('A',300)
    assert psu.pad('V','F').slots==[]
    psu.leave_stand('V','G1','parked')
    psu.refresh_arrivals({'A':{'eta_s':400,'remaining_s':100}},300)
    assert c.stand=='G1' and psu.begin_approach('A',300)


def plane(name,north,east,heading,alt=300,room=50,phase='cruise'):
    return dict(aircraft_id=name,latitude_deg=37+north/111320,
                longitude_deg=127+east/(111320*math.cos(math.radians(37))),
                altitude_m=alt,heading_deg=heading,speed_mps=35,ground_speed_mps=35,
                phase=phase,right_room_m=room)


def test_head_on_traffic_commands_right_in_both_aircraft_frames():
    rows=[plane('A',0,0,0),plane('B',1400,0,180)]
    commands=TrafficAwareness().commands(rows,{},0)
    assert commands['A']['action']=='avoid_right'
    assert commands['B']['action']=='avoid_right'
    assert commands['A']['right_m']==commands['B']['right_m']==35
    assert 19<commands['A']['cpa_s']<21


def test_different_altitude_and_diverging_traffic_do_not_manoeuvre():
    rows=[plane('A',0,0,0),plane('B',1400,0,180,alt=600)]
    assert TrafficAwareness().commands(rows,{},0)=={}
    rows=[plane('A',0,0,180),plane('B',1400,0,0)]
    assert TrafficAwareness().commands(rows,{},0)=={}


def test_corridor_boundary_and_release_hysteresis():
    awareness=TrafficAwareness()
    rows=[plane('A',0,0,0,room=7),plane('B',1400,0,180)]
    assert awareness.commands(rows,{},0)['A']['right_m']==7
    one=awareness.commands(rows[:1],{},3)
    assert one['A']['action']=='recover'
    assert awareness.commands(rows[:1],{},9)=={}
    rows[0]['right_room_m']=0
    assert awareness.commands(rows,{},10)['A']['right_m']==0


def test_following_approach_yields_and_leader_continues():
    a=plane('A',0,0,0,phase='descent');b=plane('B',100,0,0,phase='descent')
    a['speed_mps']=a['ground_speed_mps']=10
    b['speed_mps']=b['ground_speed_mps']=5
    commands=TrafficAwareness().commands([a,b],{},0)
    assert commands['A']['action']=='yield'
    assert commands['B']['action']=='monitor'


def test_braked_follower_keeps_yield_until_traffic_has_cleared():
    awareness=TrafficAwareness()
    a=plane('A',0,0,0,phase='descent'); b=plane('B',80,0,0,phase='descent')
    assert awareness.commands([a,b],{},0)['A']['action']=='yield'
    a.update(phase='hold', speed_mps=0, ground_speed_mps=0)
    assert awareness.commands([a,b],{},1)['A']['action']=='yield'
    assert awareness.commands([a],{},3)['A']['action']=='yield'
    assert awareness.commands([a],{},10)=={}


def test_imminent_committed_arrival_keeps_departure_at_stand_until_pad_clears():
    from test_scenario_engine import engine_of, row
    engine=engine_of(row('D','A','VP1','VP2','06:30:00'))
    engine.pilots=object()  # Only dispatch is exercised, no synthetic flight motion.
    now=engine.time_s
    incoming=engine.psu.request_arrival(flight_id='IN',vertiport='VP1',fato='F1',
        stand='G3',earliest_s=now+30,now_s=now)
    incoming.approach_started_s=now-60; incoming.eta_s=now+30
    engine._maybe_depart(engine.aircraft['A'],now)
    assert engine.aircraft['A'].phase=='parked'
    assert engine.psu._stands.occupant('VP1','G1')=='A'
    engine.psu.complete('IN',ARRIVAL,now+60)
    engine._maybe_depart(engine.aircraft['A'],now+60)
    assert engine.aircraft['A'].phase=='gate_out'


def test_stand_freed_during_prediction_retargets_the_actual_taxi_route():
    from test_scenario_engine import engine_of, row
    engine=engine_of(row('D','A','VP1','VP2','06:30:00',arrival_stand='G2'))
    a=engine.aircraft['A']; engine._maybe_depart(a,engine.time_s)
    engine.pilots=object(); a.phase='descent'; a.index=a.route.descent_index
    for stand in ('G1','G2','G3','G4'):engine.psu.take_stand('VP2',stand,stand)
    engine._ask_psu(a,engine.time_s)
    assert a.clearance.stand is None
    old_end=a.route.phases[-1].points[-1]
    engine.psu.leave_stand('VP2','G3','G3')
    engine._refresh_predictions(engine.time_s+1)
    assert a.clearance.stand=='G3'
    assert a.route.phases[-1].points[-1]!=old_end
    expected=engine.route(dict(a.flight,arrival_stand='G3'))
    assert a.route.phases[-1].points[-1]==expected.phases[-1].points[-1]
