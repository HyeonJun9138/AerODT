"""Physical telemetry through acquisition, authoritative World and public APIs."""
import time
from fastapi.testclient import TestClient
from user_application.apps.web_dashboard.application import create_app
from project_support.tests.web_live.test_physical_uam import packet


def test_injected_sources_do_not_collect_real_physical_data(tmp_path):
    app=create_app({'workspace_directory':str(tmp_path)},sources=[])
    assert app.state.physical_input.url==''


def test_receiving_toggle_and_future_horizon_are_independent_of_navigation_validity(monkeypatch,tmp_path):
    import user_application.apps.web_dashboard.physical_input as acquisition
    sequence=0
    async def fetch(*args,**kwargs):
        nonlocal sequence
        sequence+=1
        return {'schema_version':1,'packets':[packet(time.time(),sequence)]}
    monkeypatch.setattr(acquisition,'fetch_packets',fetch)
    app=create_app({'physical_uam_url':'http://127.0.0.1:9999','tick_seconds':.05,
                    'workspace_directory':str(tmp_path),'cache_directory':str(tmp_path/'cache')},sources=[])
    with TestClient(app) as client:
        def wait_entities(wanted):
            for _ in range(60):
                current=client.get('/api/live/snapshot').json()
                if len(current['entities'])==wanted:return current
                time.sleep(.05)
            raise AssertionError('Physical state did not settle')
        current=wait_entities(1);entity=current['entities'][0]
        assert entity['source']=='physical_uam' and entity['provenance']=='physical_emulation'
        assert entity['valid_until']-entity['observation_time']==2
        result=client.get('/api/live/trajectory/physical:UAM0001')
        assert result.status_code==200
        assert result.json()['summary']['seconds']==60
        assert app.state.world.snapshot().entities[0].valid_until is not None
        detail=client.get('/api/live/uam/physical:UAM0001').json()
        assert set(detail['sensors'])=={'gnss','ahrs','barometer','imu','vehicle'}
        assert 'ground_truth' not in str(detail)
        assert client.put('/api/library/sources',json={'sources':{'uam':{'enabled':False}}}).status_code==200
        wait_entities(0)
        assert client.get('/api/live/trajectory/physical:UAM0001').status_code==404
        assert client.put('/api/library/sources',json={'sources':{'uam':{'enabled':True}}}).status_code==200
        assert wait_entities(1)['entities'][0]['quality']=='valid'
