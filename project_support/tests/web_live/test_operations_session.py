from test_scenario_session import make, CSV
from data.simulation.operations_records import OperationsRecords
from user_application.uam_mission.operations_reports import OperationsReports


def test_analysis_reads_do_not_tick_and_reset_archives_pre_reset_state(tmp_path):
    session,clock=make(tmp_path);session.load(CSV);session.play();clock.tick(120);session.tick()
    before=session.engine.time_s;identifier=session.scenario_id
    reports=OperationsReports(session,OperationsRecords(tmp_path));report=reports.summary()
    assert session.engine.time_s==before
    assert report['totals']['planned']==3
    copied=session.analysis_input();copied['plans'][0]['passengers']=999
    assert session.schedule['flights'][0]['passengers']!=999
    session.reset()
    source=OperationsRecords(tmp_path).read(identifier)
    assert source['meta']['observed_s']==before
    assert source['events'] and source['meta']['state']=='finished'
    assert reports.summary()['meta']['scenario_id']!=identifier
    assert reports.summary()['totals']['departed']==0
    session.close()


def test_stop_persists_passenger_plan_and_observed_actuals(tmp_path):
    session,clock=make(tmp_path);session.load(CSV);session.play();clock.tick(120);session.tick();session.stop()
    records=OperationsRecords(tmp_path);source=records.read(session.scenario_id)
    assert [r['passengers'] for r in source['plans']]==[2,6,3]
    assert records.list()[0]['scenario_id']==session.scenario_id
    session.close()


def test_full_application_mounts_analysis_routes_without_starting_a_day(tmp_path):
    from fastapi.testclient import TestClient
    from user_application.apps.web_dashboard.application import create_app
    app=create_app({'workspace_directory':str(tmp_path),'cache_directory':str(tmp_path),'tick_seconds':1},sources=[])
    with TestClient(app) as client:
        assert client.get('/api/simulation/analysis').json()['available'] is False
        assert client.get('/api/simulation/analysis/records').json()['records']==[]
        assert app.state.scenario_session.state=='idle'
        assert client.get('/static/operations_analysis.js').status_code==200
        assert 'mode-analysis' in client.get('/').text
