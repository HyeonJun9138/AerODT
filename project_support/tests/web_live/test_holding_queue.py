from digital_twin.simulation.holding_queue import HoldingQueue,positions,relative,nearby

ANCHOR=(37.5,127.,330.)
INBOUND=(37.51,127.,330.)


def reserve(q,owner):
    return q.reserve(owner,'VP',positions(ANCHOR,INBOUND),ANCHOR,0,120,45,lambda p:True)


def test_bays_are_fixed_off_route_and_fill_upward_before_moving_farther_away():
    q=HoldingQueue()
    rows=[reserve(q,str(i)) for i in range(12)]
    assert len({r['target'] for r in rows})==12
    assert all(abs(relative(ANCHOR,r['target'])[1])>=239 for r in rows)
    assert [r['target'][2] for r in rows]==[330]*6+[450]*6
    for i,a in enumerate(rows):
        assert all(not nearby(a['target'],b['target'],120,45) for b in rows[i+1:])


def test_repeat_request_keeps_assignment_and_release_reuses_the_same_bay():
    q=HoldingQueue();a=reserve(q,'a');b=reserve(q,'b')
    assert reserve(q,'a') is a
    a['state']='returning'
    assert reserve(q,'c')['target']!=a['target']
    q.release('a')
    assert reserve(q,'d')['target']==a['target']


def test_other_entry_cannot_reserve_the_same_physical_bay():
    q=HoldingQueue();a=reserve(q,'a')
    assert q.reserve('b','OTHER',[('different',a['target'])],ANCHOR,1,120,45,lambda p:True) is None


def test_unknown_or_rejected_airspace_is_not_allocated():
    q=HoldingQueue()
    assert q.reserve('a','VP',positions(ANCHOR,INBOUND),ANCHOR,0,120,45,lambda p:False) is None


def test_transfer_cannot_cross_parked_or_moving_airborne_traffic():
    q=HoldingQueue();r=reserve(q,'a')
    middle=tuple((a+b)/2 for a,b in zip(ANCHOR,r['target']))
    assert not q.transfer_clear('a',ANCHOR,r['target'],[dict(owner='b',position=middle)],120,45,35)


def test_existing_close_pair_can_separate_laterally_but_not_cross_each_other():
    q=HoldingQueue();target=reserve(q,'a')['target']
    other=(ANCHOR[0]+10/111320,ANCHOR[1],ANCHOR[2])
    observations=[dict(owner='b',position=other)]
    assert q.transfer_clear('a',ANCHOR,target,observations,120,45,35)
    assert not q.transfer_clear('a',ANCHOR,(ANCHOR[0]+240/111320,ANCHOR[1],ANCHOR[2]),observations,120,45,35)


def test_moving_reservation_serializes_crossing_transfers():
    q=HoldingQueue();r=reserve(q,'b');r.update(state='moving',move_start=ANCHOR)
    start=(ANCHOR[0]-.003,ANCHOR[1]+.002,ANCHOR[2])
    end=(ANCHOR[0]+.003,ANCHOR[1]+.002,ANCHOR[2])
    assert not q.transfer_clear('a',start,end,[dict(owner='b',position=ANCHOR)],120,45,35)


def test_upper_bay_can_return_without_descending_through_lower_bay():
    q=HoldingQueue()
    rows=[reserve(q,str(i)) for i in range(7)]
    upper=rows[-1]
    assert q.transfer_clear('6',upper['target'],ANCHOR,
        [dict(owner='0',position=rows[0]['target'])],120,45,35)


def test_queue_forecast_cannot_toggle_the_physical_final_gate():
    from digital_twin.simulation.scenario_engine import ScenarioEngine
    from project_support.tests.web_live.test_scenario_engine import schedule_of,row,VERTIPORTS,NETWORK
    e=ScenarioEngine(schedule_of(row('F','A','VP1','VP2','06:30:00')),
        vertiports=VERTIPORTS,network=NETWORK,elevation=lambda lon,lat:0)
    try:
        a=e.aircraft['A'];a.flight=e.flights['F'];a.route=e.route(a.flight)
        a.index=a.route.landing_index-1
        a.latitude,a.longitude,a.altitude=a.route.phases[a.route.landing_index].points[0]
        a.telemetry={'segment_index':0}
        assert e._at_final_gate(a)
        direct=e._remaining_native(a)
        rejoin=(a.latitude,a.longitude,a.altitude)
        r=e.psu.waiting.reserve('F','VP2',[('L2-H1',(a.latitude+.003,a.longitude,a.altitude))],
            rejoin,e.time_s,120,45,lambda p:True)
        r['final_gate']=True
        assert e._remaining_native(a)>direct+20
        assert e._at_final_gate(a), 'forecast padding must not release a final hold'
        a.latitude+=.003
        assert e._at_final_gate(a), 'assigned final bay retains its final gate until rejoin'
        a.latitude=rejoin[0]
        e.psu.waiting.release('F')
        assert e._at_final_gate(a), 'release cannot flip the same observed final position'
    finally:e.close()


def test_arrival_bay_is_in_native_route_before_takeoff_without_mutating_source_or_pose():
    import copy
    from digital_twin.simulation.scenario_engine import ScenarioEngine
    from project_support.tests.web_live.test_scenario_engine import schedule_of,row,VERTIPORTS,NETWORK
    e=ScenarioEngine(schedule_of(row('F','A','VP1','VP2','06:30:00')),
        vertiports=VERTIPORTS,network=NETWORK,elevation=lambda lon,lat:0)
    try:
        a=e.aircraft['A'];a.flight=e.flights['F'];a.route=e.route(a.flight)
        source=a.route;points=copy.deepcopy([p.points for p in source.phases]);plan=copy.deepcopy(a.flight)
        pose=(a.latitude,a.longitude,a.altitude)
        assert e._prepare_waiting_route(a,e.time_s)
        r=e.psu.waiting.reservations['F'];d=a.route.descent_index
        assert r['state']=='enroute'
        assert a.route.phases[d-1].points[-1]==r['target']
        assert a.route.phases[d].points[:2]==[r['target'],r['rejoin']]
        assert [p.points for p in source.phases]==points and a.flight==plan
        assert (a.latitude,a.longitude,a.altitude)==pose
    finally:e.close()


def test_mature_ground_admission_is_not_requeued_due_to_tick_rounding():
    from digital_twin.simulation.scenario_engine import ScenarioEngine
    from project_support.tests.web_live.test_scenario_engine import schedule_of,row,VERTIPORTS,NETWORK
    e=ScenarioEngine(schedule_of(row('F','A','VP1','VP2','06:30:00'),
        row('G','B','VP1','VP2','06:30:00',stand='G3',arrival_stand='G4')),
        vertiports=VERTIPORTS,network=NETWORK,elevation=lambda lon,lat:0)
    try:
        a,b=e.aircraft.values();f,g=e.flights.values();first,second=e.route(f),e.route(g)
        assert e._meter_arrival_entry(a,f,first,e.time_s)
        assert not e._meter_arrival_entry(b,g,second,e.time_s)
        booking=dict(e._entry_forecasts['G'])
        assert e._meter_arrival_entry(b,g,second,booking['departure_s']+.8)
        assert e._entry_forecasts['G']==booking
        e.reset()
        assert e._entry_forecasts=={} and not e.psu.waiting.reservations
    finally:e.close()


def test_bay_cannot_obstruct_another_reserved_return_leg():
    from digital_twin.simulation.holding_queue import HoldingQueue
    q=HoldingQueue();anchor=(37.,127.,300.)
    q.reserve('A','P',[('A',(37.003,127.,300.))],anchor,0,120,45,lambda p:True)
    r=q.reserve('B','P',[('blocked',(37.0015,127.,300.)),
                         ('upper',(37.0015,127.,420.))],(37.0015,127.003,300.),0,120,45,lambda p:True)
    assert r and r['slot']=='upper'


def test_queue_bay_is_not_part_of_committed_terminal_authority():
    from digital_twin.simulation.scenario_engine import ScenarioEngine
    from digital_twin.model_library import terminal_paths
    from project_support.tests.web_live.test_scenario_engine import schedule_of,row,VERTIPORTS,NETWORK
    e=ScenarioEngine(schedule_of(row('F','A','VP1','VP2','06:30:00')),
        vertiports=VERTIPORTS,network=NETWORK,elevation=lambda lon,lat:0)
    try:
        a=e.aircraft['A'];a.flight=e.flights['F'];a.route=e.route(a.flight)
        assert e._prepare_waiting_route(a,e.time_s)
        r=e.psu.waiting.reservations['F'];actual=a.route
        authority=e._arrival_authority_route(actual)
        assert authority.phases[authority.descent_index].points[0]==r['rejoin']
        assert actual.phases[actual.descent_index].points[0]==r['target']
        assert terminal_paths.clear_of(authority,'arrival',r['target'],120,45)
    finally:e.close()


# The operator watched an aircraft released from its bay fly back to the
# corridor's end before starting its approach. The bay is laid out around that
# entry, but the approach is flown from the bay straight to the descent.
def test_the_approach_from_a_bay_goes_straight_to_the_descent_not_back_to_the_entry():
    from digital_twin.simulation.scenario_engine import ScenarioEngine
    from project_support.tests.web_live.test_scenario_engine import schedule_of,row,VERTIPORTS,NETWORK
    e=ScenarioEngine(schedule_of(row('F','A','VP1','VP2','06:30:00')),
        vertiports=VERTIPORTS,network=NETWORK,elevation=lambda lon,lat:0)
    try:
        a=e.aircraft['A'];a.flight=e.flights['F'];a.route=e.route(a.flight)
        d=a.route.descent_index;entry=a.route.phases[d].points[0];following=a.route.phases[d].points[1]
        assert e._prepare_waiting_route(a,e.time_s)
        r=e.psu.waiting.reservations['F'];phase=a.route.phases[d]
        assert phase.points[0]==r['target'] and phase.points[1]==following, 'bay, then the descent itself'
        assert entry not in phase.points, 'the entry is not flown again'
        assert r['rejoin']==following and r['direct']
        assert phase.detail['psu_rejoin']==entry, 'the entry stays the anchor the bays are placed around'
        assert e._queue_anchor(a)==entry
        authority=e._arrival_authority_route(a.route)
        assert authority.phases[d].points[0]==following and r['target'] not in authority.phases[d].points
    finally:e.close()
