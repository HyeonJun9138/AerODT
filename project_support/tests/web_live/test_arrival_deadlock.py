"""Congested approaches must keep separate waiting goals and make progress."""
from test_predictive_operations import plane
from test_scenario_engine import engine_of,row
from user_application.uam_mission.traffic_awareness import TrafficAwareness
from digital_twin.simulation.scenario_engine import HOLD_SLOTS,HOLD_TIERS

def test_same_lane_follower_slows_without_both_aircraft_shifting_right():
    rows=[plane('A',0,0,0),plane('B',80,0,0)]
    commands=TrafficAwareness().commands(rows,{},0)
    assert commands['A']['action']=='slow'
    assert commands['B']['action']=='monitor'
    assert commands['A']['right_m']==commands['B']['right_m']==0

def test_lane_return_does_not_cut_through_traffic_when_the_threat_bearing_changes():
    awareness=TrafficAwareness();rows=[plane('A',0,0,0),plane('B',80,0,0)]
    awareness.previous={'A':{'action':'avoid_right','right_m':35,'observed_s':0}}
    assert awareness.commands(rows,{},1)['A']['right_m']==35

def test_same_arrival_pad_protects_the_departure_column():
    engine=engine_of(row('D','A','VP1','VP2','06:30:00'));engine.pilots=object()
    c=engine.psu.request_arrival(flight_id='IN',vertiport='VP1',fato='F1',stand='G3',earliest_s=engine.time_s+30,now_s=engine.time_s)
    c.approach_started_s=engine.time_s-60;c.eta_s=engine.time_s+30
    engine._maybe_depart(engine.aircraft['A'],engine.time_s)
    assert engine.aircraft['A'].phase=='parked'

def arrival(name,north,sequence,started=None,phase='descent'):
    return dict(plane(name,north,0,0,phase=phase),destination='V',arrival_fato='F',
        sequence=sequence,approach_started_s=started,route_phase='descent',speed_mps=0,
        ground_speed_mps=0)

def test_psu_leader_never_waits_for_a_later_arrival_facing_it():
    awareness=TrafficAwareness()
    first=arrival('A',0,1,10,phase='hold');later=arrival('B',1,2)
    awareness.previous={'A':{'action':'yield','observed_s':20}}
    commands=awareness.commands([first,later],{},21)
    assert commands['A']['action']!='yield'
    assert commands['B']['action']=='yield'

def test_overlapping_stationary_arrivals_have_an_acyclic_yield_order():
    awareness=TrafficAwareness();rows=[arrival('A',0,1,10,'hold'),arrival('B',.1,2,None,'hold'),arrival('C',.2,3,None,'hold')]
    awareness.previous={r['aircraft_id']:{'action':'yield','observed_s':0} for r in rows}
    commands=awareness.commands(rows,{},1)
    assert commands['A']['action']!='yield'
    for row in rows[1:]:
        command=commands[row['aircraft_id']]
        assert command['action']=='yield'
        assert next(r for r in rows if r['aircraft_id']==command['traffic_id'])['sequence']<row['sequence']

def test_nonfinal_traffic_hold_leaves_the_shared_approach_for_a_reserved_fix():
    engine=engine_of(row('A','A','VP1','VP2','06:30:00'))
    a=engine.aircraft['A'];engine._maybe_depart(a,engine.time_s);a.index=a.route.descent_index;a.phase='descent'
    point=a.route.phases[a.index].points[0];a.place(*point)
    class Pilots:
        def start(self,*args):pass
        def advance(self,identifier,step,target):
            self.target=target
            return dict(latitude_deg=point[0],longitude_deg=point[1],altitude_m=point[2],heading_deg=0,
                speed_mps=0,phase_index=a.index,phase_elapsed=0,done=False)
    pilots=Pilots();engine.pilots=pilots
    engine._remaining_native=lambda _:200
    engine._ask_psu(a,engine.time_s);a.clearance.approach_s=engine.time_s
    a.instruction={'action':'yield'};engine._fly_native(a,engine.time_s,0.2)
    assert pilots.target!=point
    assert a.hold['slot'] is not None

def test_full_holding_pattern_does_not_reuse_somebody_elses_waiting_position():
    engine=engine_of(row('A','A','VP1','VP2','06:30:00'));entry=(37.48,126.94,320)
    positions=[];engine._holds['VP2']={}
    for i in range(HOLD_SLOTS*HOLD_TIERS+3):
        fix,slot=engine._holding_fix('VP2',entry)
        assert fix not in positions
        positions.append(fix);engine._holds['VP2'][str(i)]={'fix':fix,'slot':slot}
