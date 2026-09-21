import pytest
from project_support.tests.web_live.test_scenario_engine import engine_of, row


def day():
    return engine_of(row('F1', 'A1', 'VP1', 'VP2', '06:30:00'))


def test_whole_flight_consumes_energy_and_charges_only_after_arriving():
    engine = day()
    aircraft = engine.aircraft['A1']
    for _ in range(5000):
        engine.advance(engine.time_s+1)
        if aircraft.flight:
            assert engine._state(aircraft)['charging_connection'] is None
        if aircraft.completed:
            break
    assert aircraft.completed == 1
    arrival_soc = aircraft.battery_pct
    assert 0 < arrival_soc < 100
    assert aircraft.energy.charge_state == 'connecting'
    engine.advance(engine.time_s+20)
    assert aircraft.battery_pct <= arrival_soc
    assert engine._state(aircraft)['charging_connection'] is None
    engine.advance(engine.time_s+100)
    state = engine._state(aircraft)
    assert state['charging_connection']['charger_id']
    assert state['energy']['grid_kwh'] > state['energy']['charged_kwh'] > 0
    engine.advance(engine.time_s+3600)
    assert aircraft.battery_pct == pytest.approx(95)
    assert aircraft.energy.charge_state == 'complete'
    assert any(e['kind'] == 'battery_flight_end' for e in engine.events)
    assert sum(e['kind'] == 'charging_connected' for e in engine.events) == 1
    engine.reset()
    assert aircraft.battery_pct == 100
    assert aircraft.energy.used_kwh == 0


def test_depleted_battery_is_recorded_once_and_flight_still_completes():
    engine = day()
    aircraft = engine.aircraft['A1']
    aircraft.battery_pct = .01
    for _ in range(5000):
        engine.advance(engine.time_s+1)
        if aircraft.completed:
            break
    assert aircraft.completed == 1 and not aircraft.failed
    for kind in ('battery_low', 'battery_critical', 'battery_depleted'):
        assert sum(e['kind'] == kind for e in engine.events) == 1
    assert aircraft.energy.deficit_kwh > 0


def test_no_charger_means_no_invented_charge(monkeypatch):
    engine = day()
    a = engine.aircraft['A1']
    a.battery_pct = 40
    a.energy.parked_at = engine.time_s-60
    monkeypatch.setitem(engine._layout(a.vertiport), 'chargers', [])
    # Prevent departure, without treating low charge as a flight inhibitor.
    a.ready_s = engine.time_s+1000
    engine.advance(engine.time_s+60)
    assert a.battery_pct == 40
    assert a.energy.charge_state == 'unavailable'
    assert engine._state(a)['charging_connection'] is None


def test_live_contract_and_archive_carry_energy_and_shortfalls(tmp_path):
    from dataclasses import asdict
    from user_application.uam_mission.scenario_session import ScenarioSession
    from user_application.uam_mission.operations_analysis import capture, build_report
    from data.simulation.operations_records import write_operations, OperationsRecords
    engine = day()
    a = engine.aircraft['A1']
    a.battery_pct = .01
    while not a.completed:
        engine.advance(engine.time_s+1)
    engine.advance(engine.time_s+120)
    state = engine._state(a)
    # _entity only needs surface reference resolution from the engine.
    session = object.__new__(ScenarioSession)
    session.engine = engine
    entity = asdict(session._entity(state, engine.time_s))
    assert entity['charging_connection']['charger_id']
    source = capture(engine, engine.schedule, 'battery-day')
    write_operations(tmp_path/'battery-day', source)
    loaded = OperationsRecords(tmp_path).read('battery-day')
    assert loaded['energy_models']['4']['charge_efficiency'] == .92
    sortie = build_report(loaded)['sorties'][0]
    assert sortie['energy_deficit_kwh'] > 0
    assert sortie['battery_min_pct'] == 0
    assert 'battery_depleted' in sortie['battery_warnings']
    assert sortie['charge_grid_kwh'] > 0
    from user_application.uam_mission.scenario_session import ScenarioRecorder
    import csv
    recorder = ScenarioRecorder(tmp_path, 'battery-day')
    try:
        recorder.finish(engine, engine.schedule, analysis=source)
        with (tmp_path/'battery-day'/'flights.csv').open(encoding='utf-8-sig', newline='') as file:
            row = next(csv.DictReader(file))
        assert float(row['energy_deficit_kwh']) > 0
        assert float(row['battery_min_pct']) == 0
    finally:
        recorder.close()


def test_native_flight_is_not_stopped_by_empty_battery():
    from communication.python.native_pilot import NativePilotLibrary
    from user_application.uam_mission.scenario_pilots import ScenarioPilots
    from digital_twin.simulation.scenario_engine import ScenarioEngine
    from project_support.tests.web_live.test_scenario_engine import VERTIPORTS, NETWORK, schedule_of
    try:
        library = NativePilotLibrary()
    except (OSError, RuntimeError):
        pytest.skip('Native pilot not built')
    engine = ScenarioEngine(schedule_of(row('F1','A1','VP1','VP2','06:30:00')),
                            vertiports=VERTIPORTS, network=NETWORK, pilots=ScenarioPilots(library))
    try:
        a = engine.aircraft['A1']
        a.battery_pct = 0
        for _ in range(4000):
            engine.advance(engine.time_s+1)
            if a.completed or a.failed:
                break
        assert a.completed == 1 and not a.failed
        assert a.energy.deficit_kwh > 0
        assert sum(e['kind'] == 'battery_depleted' for e in engine.events) == 1
    finally:
        engine.close()


def test_next_departure_unplugs_and_never_resets_to_full():
    from project_support.tests.web_live.test_scenario_engine import LINKS, NODES, VERTIPORTS
    from digital_twin.model_library.route_network import network
    reverse = [dict(LINKS[0], id='R1', **{'from':'fato:VP2:F1','to':'WP2'}),
               dict(LINKS[1], id='R2', **{'from':'WP2','to':'WP1'}),
               dict(LINKS[2], id='R3', **{'from':'WP1','to':'fato:VP1:F2'})]
    engine = engine_of(row('F1','A1','VP1','VP2','06:30:00'),
                       row('F2','A1','VP2','VP1','06:50:00',stand='G2',arrival_stand='G1'),
                       network=network(NODES,LINKS+reverse,VERTIPORTS))
    a = engine.aircraft['A1']
    a.battery_pct = 30
    for _ in range(5000):
        engine.advance(engine.time_s+1)
        if a.flight and a.flight['flight_id'] == 'F2':
            break
    assert a.flight['flight_id'] == 'F2'
    assert a.energy.connection is None
    assert a.energy.charge_state == 'disconnected'
    assert a.battery_pct < 99
    assert a.energy.used_kwh > 0
    assert any(e['kind']=='charging_disconnected' and e['flight_id']=='F1' for e in engine.events)


def test_charging_cannot_reconnect_while_aircraft_is_off_its_reserved_stand():
    engine=day()
    a=engine.aircraft['A1']
    a.battery_pct=30
    a.energy.parked_at=engine.time_s-100
    a.latitude+=.01
    a.ready_s=engine.time_s+1000
    engine.advance(engine.time_s+10)
    assert a.battery_pct==30
    assert a.energy.connection is None


def test_finished_charge_does_not_keep_emitting_idle_samples_or_plan_taxi(monkeypatch):
    engine=day()
    a=engine.aircraft['A1']
    while not a.completed:
        engine.advance(engine.time_s+1)
    def no_taxi(*args):
        raise AssertionError('energy ticks must not plan a taxi route')
    monkeypatch.setattr(engine, '_stand_place', no_taxi)
    engine.advance(engine.time_s+3600)
    assert a.energy.charge_state == 'complete'
    count=len(engine.events)
    engine.advance(engine.time_s+3600)
    assert len(engine.events)==count
