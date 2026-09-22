import copy
from types import SimpleNamespace
from digital_twin.simulation import fato_assignment, psu_sequencing as psu
from digital_twin.simulation.scenario_engine import ScenarioEngine
from digital_twin.simulation.terminal_reservations import TerminalReservations
from digital_twin.model_library import terminal_paths
from digital_twin.model_library.route_network import network as build_network
from project_support.tests.web_live.test_scenario_engine import vertiport, schedule_of, row, NODES, LINKS


def multi_engine():
    ports = [vertiport('VP1','출발',37.525,126.920, fatos=[{'role':'both'}]*4),
             vertiport('VP2','도착',37.478,126.941, fatos=[{'role':'both'}]*4)]
    links = copy.deepcopy(LINKS)
    for i in range(2,5):
        links.append(dict(LINKS[0], id=f'D{i}', **{'from':f'fato:VP1:F{i}'}))
    for i in (1,3,4):
        links.append(dict(LINKS[-1], id=f'A{i}', to=f'fato:VP2:F{i}'))
    network = build_network(NODES, links, ports)
    schedule = schedule_of(row('F1','A1','VP1','VP2','06:31:00'), vertiports=ports)
    engine = ScenarioEngine(schedule, vertiports=ports, network=network)
    return engine, dict(schedule['flights'][0])


def test_connected_four_shared_pads_have_executable_alternatives_and_distribute_load():
    engine, flight = multi_engine()
    options, rejected = fato_assignment.options(engine, flight)
    assert len(options) == 16 and not rejected
    for pad in ('F1','F2','F3'):
        engine.psu.pad('VP2', pad).hold(0, 100000, 'occupied-'+pad, psu.ARRIVAL)
    selected, route, why = fato_assignment.choose(options, engine.psu, 23460, [], lambda f,r: [])
    assert selected['arrival_fato'] == 'F4'
    assert route.arrival['fato'] == 'F4'
    assert flight['arrival_fato'] == 'F2'


def test_scenario_supplies_candidates_but_psu_selects_the_departure_plan():
    engine, flight = multi_engine()
    called = []
    decide = engine.psu.select_departure_plan
    def record(*args, **kwargs):
        called.append((args, kwargs))
        return decide(*args, **kwargs)
    engine.psu.select_departure_plan = record
    try:
        selected, route = engine._select_fatos(flight, 23460)
        assert called and selected['flight_id'] == flight['flight_id']
        assert route.departure['fato'] == selected['departure_fato']
    finally:
        engine.close()


def test_explicit_enroute_path_preserved_and_unconnected_new_endpoint_rejected():
    engine, flight = multi_engine()
    flight['route_path'] = ['fato:VP1:F1','WP1','WP2','fato:VP2:F2']
    from digital_twin.model_library import scheduled_route
    engine._supplied_routes[tuple(flight['route_path'])] = scheduled_route.resolve(
        engine._network, flight['route_path'], flight['route_path'][0], flight['route_path'][-1])
    engine._network['links'] = [l for l in engine._network['links'] if l['to'] != 'fato:VP2:F4']
    options, rejected = fato_assignment.options(engine, flight)
    assert options and all(f['arrival_fato'] != 'F4' for f,r in options)
    assert all(f['route_path'][1:-1] == ['WP1','WP2'] for f,r in options)
    assert any(r['arrival_fato'] == 'F4' for r in rejected)


def route(key, stage, points):
    return SimpleNamespace(key=key, phases=[SimpleNamespace(stage=stage, points=points)])


def test_remote_pad_crossings_serialize_and_actual_release_is_required():
    r1=route('a','descent',[(37,127,100),(37.02,127.02,100)])
    r2=route('b','climb',[(37,127.02,100),(37.02,127,100)])
    a=dict(flight_id='a',origin='VP0',destination='VP1',arrival_fato='F1',departure_fato='F1')
    b=dict(flight_id='b',origin='VP2',destination='VP3',arrival_fato='F4',departure_fato='F4')
    guard=TerminalReservations(120,45)
    assert not guard.acquire(a,r1,'arrival')
    assert guard.acquire(b,r2,'departure')[0]['flight_id']=='a'
    assert ('b','departure') not in guard.claims
    guard.release('a','arrival')
    assert not guard.acquire(b,r2,'departure')


def test_independent_volumes_can_operate_and_phase_boundary_does_not_release_volume():
    r1=route('a','climb',[(37,127,20),(37.01,127,300)])
    r2=route('b','descent',[(38,127,300),(38.01,127,20)])
    a=dict(flight_id='a',origin='VP1',destination='VP2',arrival_fato='F2',departure_fato='F1')
    b=dict(flight_id='b',origin='VP3',destination='VP4',arrival_fato='F2',departure_fato='F1')
    guard=TerminalReservations(120,45)
    assert not guard.acquire(a,r1,'departure')
    assert not guard.acquire(b,r2,'arrival')
    assert not terminal_paths.clear_of(r1,'departure',(37.01,127,300),120,45)
    assert terminal_paths.clear_of(r1,'departure',(37.02,127,300),120,45)


def test_shared_pad_actual_use_survives_early_physical_release():
    sequencer=psu.PsuSequencer()
    sequencer.request_departure(flight_id='a',vertiport='v',fato='f',earliest_s=0,now_s=0)
    sequencer.mark_used('a', psu.DEPARTURE, 50)
    sequencer.complete('a', psu.DEPARTURE, 60)
    assert sequencer.pad('v','f').earliest(60,psu.ARRIVAL,90)==125
    assert sequencer.pad('v','f').earliest(60,psu.DEPARTURE,60)==110


def test_assignment_freezes_after_departure_clearance_and_original_plan_is_unchanged():
    engine, original = multi_engine()
    flight, selected_route = engine._select_fatos(original, 23460)
    engine._assigned_plans[flight['flight_id']] = (flight, selected_route)
    engine.psu.pad('VP2', flight['arrival_fato']).hold(0,100000,'late-arrival',psu.ARRIVAL)
    again, route_again = engine._select_fatos(original, 23461)
    assert again is flight and route_again is selected_route
    assert engine.flights['F1'] == original


def test_allocation_counts_ground_entry_reservations_before_a_flight_is_active():
    engine, flight = multi_engine()
    engine.pilots = SimpleNamespace()
    try:
        aircraft = engine.aircraft[flight['aircraft_id']]
        first, first_route = engine._select_fatos(flight, 23460)
        assert engine._meter_arrival_entry(aircraft, first, first_route, 23460)
        assert aircraft.flight is None, 'entry reservations exist before native departure'
        following = dict(flight, flight_id='following')
        selected, _ = engine._select_fatos(following, 23460)
        assert selected['arrival_fato'] != first['arrival_fato'], 'use a free arrival queue rather than queue again'
        assert 'following' not in engine._entry_forecasts, 'candidate scoring must not reserve slots'
    finally:
        engine.pilots = None
        engine.close()


def test_assignment_candidate_wait_is_included_without_mutating_pad_slots():
    engine, flight = multi_engine()
    try:
        available, _ = fato_assignment.options(engine, flight)
        selected, _, why = fato_assignment.choose(available, engine.psu, 23460, [], lambda f,r: [],
            entry_wait=lambda f,r,t: 500 if f['arrival_fato'] != 'F4' else 0)
        assert selected['arrival_fato'] == 'F4'
        assert why['entry_wait_s'] == 0
        assert all(not engine.psu.pad('VP2',p).slots for p in ('F1','F2','F3','F4'))
    finally:
        engine.close()


def test_candidate_scoring_does_not_launch_native_forecast_for_every_pad_pair():
    engine, flight = multi_engine()
    calls=[]
    engine.pilots=SimpleNamespace(estimate_to_entry=lambda *args: calls.append(args) or 500,
                                 cached_entry_estimate=lambda *args: 500)
    try:
        engine._select_fatos(flight,23460)
        assert not calls, '16 candidate pairs must not start 16 synchronous physics forecasts'
    finally:
        engine.pilots=None
        engine.close()


def test_scenario_counts_committed_landings_before_consuming_departure_capacity():
    engine, _ = multi_engine()
    try:
        layout=engine._layout('VP2')
        for index,pad in enumerate(layout['fatos']):
            pad['role']='both'
            pad['center_m']=[index*100.,0.]
        engine._pending_departure_ids=lambda *_:('D1',)
        first=engine._arrival_departure_capacity('VP2','F1','A1',engine.time_s)
        assert first.granted and first.available_after==3 and first.required==2
        for flight_id,fato in [('L1','F1'),('L2','F2')]:
            c=engine.psu.request_arrival(flight_id=flight_id,vertiport='VP2',fato=fato,
                stand='G1',earliest_s=engine.time_s,now_s=engine.time_s,defer_stand=True)
            c.approach_started_s=engine.time_s
        second=engine._arrival_departure_capacity('VP2','F3','A3',engine.time_s)
        assert not second.granted
        assert second.available_before==2 and second.available_after==1
    finally:
        engine.close()


def test_departure_reserve_lookahead_detects_the_next_scheduled_flight():
    engine, _ = multi_engine()
    try:
        before=engine.time_s-60
        assert engine._pending_departure_ids('VP1',before)==('F1',)
        assert engine._pending_departure_ids('VP2',before)==()
        engine.policy['psu']['departure_reserve_lookahead_s']=30.
        assert engine._pending_departure_ids('VP1',before)==()
    finally:
        engine.close()


def test_automatic_arrival_prediction_holds_before_consuming_departure_capacity():
    engine, flight = multi_engine()
    try:
        aircraft=engine.aircraft['A1'];aircraft.flight=flight;aircraft.route=engine.route(flight)
        aircraft.index=aircraft.route.descent_index;aircraft.phase='descent'
        aircraft.place(*aircraft.route.phases[aircraft.index].points[0])
        aircraft.clearance=engine.psu.request_arrival(
            flight_id='F1',vertiport='VP2',fato=aircraft.route.arrival['fato'],stand='G2',
            earliest_s=engine.time_s+60,now_s=engine.time_s,defer_stand=True)
        engine._arrival_departure_capacity=lambda *args:SimpleNamespace(
            granted=False,reason='이륙 FATO 보호 대기 · 1/2개만 유지')
        engine._refresh_predictions(engine.time_s)
        assert aircraft.clearance.approach_s is None
        assert aircraft.clearance.state==psu.HOLDING
        assert aircraft.clearance.reason.startswith('이륙 FATO 보호 대기')
    finally:
        engine.close()


def test_ground_observations_are_walked_once_while_nothing_moves(monkeypatch):
    from digital_twin.simulation import scenario_engine as module
    engine, flight = multi_engine()
    made = []
    original = module.GroundObservation
    class Counting(original):
        def __init__(self, *values, **named):
            made.append(values[0])
            super().__init__(*values, **named)
    monkeypatch.setattr(module, 'GroundObservation', Counting)
    read = lambda items: [(o.aircraft_id, o.vertiport_id, o.point_m, o.radius_m) for o in items]
    first = engine._ground_observations()
    walked = len(made)
    assert walked == len(first) == len(engine.aircraft)
    second = engine._ground_observations()
    assert read(second) == read(first) and second is not first and len(made) == walked
    # Anything that moves is seen: the fleet is walked again and the answer follows it.
    moved = next(iter(engine.aircraft.values()))
    moved.latitude += 1e-4
    third = engine._ground_observations()
    assert len(made) == walked * 2
    assert read(third) != read(first)
    assert [o for o in third if o.aircraft_id == moved.aircraft_id][0].point_m != \
        [o for o in first if o.aircraft_id == moved.aircraft_id][0].point_m
    assert read(engine._ground_observations()) == read(third) and len(made) == walked * 2


def test_network_link_pairs_are_kept_between_option_reviews():
    engine, flight = multi_engine()
    first, _ = fato_assignment.options(engine, flight)
    pairs = engine._network_link_pairs
    assert pairs == {(r['from'], r['to']) for r in engine._network['links']}
    second, _ = fato_assignment.options(engine, flight)
    assert engine._network_link_pairs is pairs
    assert [(f['departure_fato'], f['arrival_fato']) for f, _ in first] == \
        [(f['departure_fato'], f['arrival_fato']) for f, _ in second]

def test_departure_options_are_reviewed_again_only_when_the_deck_changes(monkeypatch):
    from project_support.tests.web_live.test_scenario_engine import engine_of, row
    from user_application.uam_mission.ground_control import VertiportGroundControl
    from digital_twin.contracts.ground_operations import GroundRequest
    engine = engine_of(row('F1', 'A1', 'VP1', 'VP2', '06:30:00'))
    engine.ground_control = VertiportGroundControl()
    aircraft = engine.aircraft['A1']
    flight = dict(engine.flights[aircraft.flights[0]], departure_stand=aircraft.stand)
    reviews = []
    original = fato_assignment.options
    monkeypatch.setattr(fato_assignment, 'options', lambda e, f: (reviews.append(f['flight_id']), original(e, f))[1])
    first = engine._departure_options(flight, True)
    assert reviews == ['F1'] and first[0]
    # The same deck, the same claims: the review stands.
    assert engine._departure_options(flight, True) is first and reviews == ['F1']
    # A claim taken on this deck is a new review.
    proposal = first[0][0][0]['_departure_ground_route']
    request = GroundRequest(aircraft_id='OTHER', flight_id='FX', vertiport_id='VP1', route_id=proposal['route_id'],
                            path_m=tuple(engine._ground_xy('VP1', point) for point in proposal['points']),
                            distance_m=0., speed_mps=0., max_speed_mps=4., radius_m=7., requested_s=0.)
    engine.ground_control.authorize([request], engine._ground_observations(), engine.time_s)
    second = engine._departure_options(flight, True)
    assert reviews == ['F1', 'F1'] and second is not first
    assert engine._departure_options(flight, True) is second and reviews == ['F1', 'F1']
    # An aircraft moving on this deck is a new review; one moving elsewhere is not.
    aircraft.latitude += 1e-5
    engine._departure_options(flight, True)
    assert reviews == ['F1', 'F1', 'F1']
    other = engine.aircraft.get('A2')
    if other is not None and other.vertiport != 'VP1':
        other.latitude += 1e-5
        engine._departure_options(flight, True)
        assert reviews == ['F1', 'F1', 'F1']
    # Without a ground controller the options are kept as they always were.
    engine.ground_control = None
    kept = engine._departure_options(flight, False)
    assert engine._departure_options(flight, False) is kept and reviews == ['F1', 'F1', 'F1']
