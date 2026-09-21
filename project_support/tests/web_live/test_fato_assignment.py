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
