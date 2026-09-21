"""Prepared intent is independent of physics, mutable editors and replay."""
import copy
import json
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from communication.web.plan_routes import create_plan_router
from communication.web.run_routes import create_run_router
from data.simulation.flight_plans import FlightPlans
from data.simulation.flight_runs import FlightRuns
from user_application.uam_mission.flight_planning import FlightPlanning
from user_application.uam_mission.flight_execution import FlightExecution
from project_support.tests.web_live.test_flight_plan import NETWORK, VERTIPORTS

REQUEST = {'from_vertiport': 'VP1', 'to_vertiport': 'VP2', 'passengers': 3}


def setup(tmp_path, engine='kinematic', native=None, kinematic=None):
    records, network = copy.deepcopy(VERTIPORTS), copy.deepcopy(NETWORK)
    shelf = FlightPlans(tmp_path / 'plans')
    planning = FlightPlanning(vertiports=lambda: records, network=lambda: network, plans=shelf)
    runs = FlightRuns(tmp_path / 'runs')
    execution = FlightExecution(planning=planning, runs=runs, root='.', engine=engine,
                                native=native, kinematic=kinematic)
    app = FastAPI()
    app.include_router(create_plan_router(planning))
    app.include_router(create_run_router(execution))
    return TestClient(app), planning, execution, shelf, records, network


def test_preparing_does_not_execute_and_readback_survives_restart(tmp_path):
    def forbidden(*args, **kwargs):
        pytest.fail('planning must not run physics')
    http, planning, execution, shelf, _, _ = setup(tmp_path, native=forbidden, kinematic=forbidden)
    made = http.post('/api/simulation/plans', json=REQUEST)
    assert made.status_code == 201
    document = made.json()
    assert execution.list() == [] and not (tmp_path / 'runs').exists()
    assert FlightPlans(shelf.directory).get(document['plan_id']) == document
    assert http.get('/api/simulation/plans/' + document['plan_id']).json() == document
    document['plan']['vehicle']['passengers'] = 999
    assert planning.get(document['plan_id'])['plan']['vehicle']['passengers'] == 3


def test_execution_uses_frozen_intent_not_the_current_editor(tmp_path):
    http, planning, execution, _, records, network = setup(tmp_path)
    prepared = planning.prepare(REQUEST)
    records.clear(); network.clear()
    response = http.post('/api/simulation/runs', json={'plan_id': prepared['plan_id'], 'rate_hz': 2})
    assert response.status_code == 201
    result = response.json()
    assert result['plan']['departure'] == prepared['plan']['departure']
    provenance = result['run']['summary']['execution']
    assert provenance['plan_id'] == prepared['plan_id']
    assert provenance['plan_sha256'] == prepared['content_sha256']
    assert provenance['mode'] == 'batch_precleared' and not provenance['live_commands_supported']
    assert execution.plan(result['run']['run_id'])['execution'] == provenance
    assert planning.get(prepared['plan_id']) == prepared


def test_retiming_and_engine_mutation_do_not_overwrite_the_prepared_plan(tmp_path):
    def native(plan, rate, **kwargs):
        plan['totals']['duration_s'] = 99
        return {'plan': plan, 'states': [], 'summary': {'engine': 'test-native'}}
    _, planning, execution, _, _, _ = setup(tmp_path, engine='native', native=native)
    before = planning.prepare(REQUEST)
    result = execution.fly({'plan_id': before['plan_id']})
    assert result['plan']['totals']['duration_s'] == 99
    assert planning.get(before['plan_id']) == before


@pytest.mark.parametrize('body,field', [
    ([], 'run'), (None, 'run'),
    ({'plan_id': '../outside'}, 'plan_id'),
    ({'plan_id': None}, 'plan_id'),
    ({'execution_mode': 'interactive'}, 'execution_mode'),
    ({'commands': [{'type': 'hold'}]}, 'execution_mode'),
])
def test_invalid_or_unsupported_execution_fails_before_physics(tmp_path, body, field):
    def forbidden(*args, **kwargs):
        pytest.fail('invalid request reached physics')
    http, *_ = setup(tmp_path, native=forbidden, kinematic=forbidden)
    answer = http.post('/api/simulation/runs', json=body)
    assert answer.status_code == 422 and answer.json()['field'] == field


def test_cannot_override_prepared_parameters_or_submit_a_fake_clearance(tmp_path):
    http, planning, *_ = setup(tmp_path)
    prepared = planning.prepare(REQUEST)
    for extra in ({'passengers': 1}, {'visual_asset_id': 'joby_s4'}, {'takeoff_clearance': True}):
        answer = http.post('/api/simulation/runs', json={'plan_id': prepared['plan_id'], **extra})
        assert answer.status_code == 422 and answer.json()['field'] == 'plan_id'


def test_legacy_fly_also_preserves_intent_and_runs_have_distinct_pilots(tmp_path):
    def quick(plan, *args, **kwargs):
        return {'states': [], 'summary': {'engine': 'test'}}
    _, planning, execution, *_ = setup(tmp_path, kinematic=quick)
    first = execution.fly(REQUEST)
    a = first['plan']['execution']
    second = execution.fly({'plan_id': a['plan_id']})
    b = second['plan']['execution']
    assert a['plan_id'] == b['plan_id']
    assert a['pilot_id'] != b['pilot_id'] and a['vehicle_instance_id'] != b['vehicle_instance_id']
    assert planning.get(a['plan_id'])['plan']['vehicle']['passengers'] == 3


def test_auto_fallback_discloses_failure_and_explicit_native_does_not_fallback(tmp_path):
    def unavailable(*args, **kwargs):
        raise ValueError('engine: unavailable')
    _, planning, execution, *_ = setup(tmp_path, engine='auto', native=unavailable)
    prepared = planning.prepare(REQUEST)
    result = execution.fly({'plan_id': prepared['plan_id'], 'rate_hz': 2})
    assert result['run']['summary']['engine_note'] == 'engine: unavailable'
    execution.engine = 'native'
    with pytest.raises(ValueError, match='unavailable'):
        execution.fly({'plan_id': prepared['plan_id']})
    assert len(execution.list()) == 1


def test_damaged_and_traversal_plans_are_not_executed(tmp_path):
    http, planning, _, shelf, *_ = setup(tmp_path)
    document = planning.prepare(REQUEST)
    file = shelf.directory / (document['plan_id'] + '.json')
    document['plan']['vehicle']['passengers'] = 400
    file.write_text(json.dumps(document), encoding='utf-8')
    assert shelf.get(document['plan_id']) is None
    assert http.get('/api/simulation/plans/' + document['plan_id']).status_code == 404
    assert http.post('/api/simulation/runs', json={'plan_id': document['plan_id']}).status_code == 422
    for value in ('../secrets', 'plan-x', 'C:\\secrets', '', [], None):
        assert shelf.get(value) is None


def test_parallel_preparation_has_no_shared_mutable_state(tmp_path):
    _, planning, execution, *_ = setup(tmp_path)
    with ThreadPoolExecutor(max_workers=4) as pool:
        documents = list(pool.map(lambda count: planning.prepare(dict(REQUEST, passengers=count)), range(4)))
    assert len({d['plan_id'] for d in documents}) == 4
    assert [planning.get(d['plan_id'])['plan']['vehicle']['passengers'] for d in documents] == list(range(4))
    assert execution.list() == []


def test_invalid_plan_body_and_preview_remain_separate(tmp_path):
    http, _, _, shelf, *_ = setup(tmp_path)
    for body in ([], None, 'bad'):
        assert http.post('/api/simulation/plans', json=body).status_code == 422
    assert http.post('/api/simulation/plans/preview', json=REQUEST).status_code == 200
    assert not shelf.directory.exists()


def test_batch_computation_does_not_block_reads_and_a_second_job_is_refused(tmp_path):
    entered, release = threading.Event(), threading.Event()
    def paused(plan, *args, **kwargs):
        entered.set()
        assert release.wait(5), 'test must release the engine'
        return {'states': [], 'summary': {'engine': 'fixture'}}
    http, planning, execution, *_ = setup(tmp_path, kinematic=paused)
    prepared = planning.prepare(REQUEST)
    with http, ThreadPoolExecutor(max_workers=2) as pool:
        running = pool.submit(http.post, '/api/simulation/runs', json={'plan_id': prepared['plan_id']})
        try:
            assert entered.wait(3)
            assert http.get('/api/simulation/runs').status_code == 200
            assert http.get('/api/simulation/plans/' + prepared['plan_id']).status_code == 200
            answer = http.post('/api/simulation/runs', json={'plan_id': prepared['plan_id']})
            assert answer.status_code == 409 and answer.json()['error'] == 'run_busy'
        finally:
            release.set()
        assert running.result(timeout=3).status_code == 201
    assert len(execution.list()) == 1
    # Successful completion releases the calculation slot.
    execution.fly({'plan_id': prepared['plan_id']})
    assert len(execution.list()) == 2
