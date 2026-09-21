"""Real ASGI composition with a local fixture provider and temporary workspace."""
import time
from fastapi.testclient import TestClient
from data.ingestion.operational_audit import AuditRecords
from user_application.apps.web_dashboard.application import create_app, SourceBinding


def test_ingestion_http_websocket_and_archived_payloads_are_connected(tmp_path):
    async def fetch():
        return [dict(id='one',latitude=37,longitude=127,altitude_m=100,
                     observed_at=time.time(),token='provider-secret')]
    app=create_app({'workspace_directory':str(tmp_path),'cache_directory':str(tmp_path),'tick_seconds':.02},
                   sources=[SourceBinding('fixture','aircraft_v1',fetch,60,provenance='fixture')])
    with TestClient(app) as client:
        for _ in range(100):
            audit=client.get('/api/simulation/analysis/flows').json()
            if audit.get('counts',{}).get('source_registered'):break
            time.sleep(.02)
        assert audit['counts']['source_registered']==1
        correlation={r['correlation_id'] for r in audit['rows'] if r['kind'].startswith('source_')}
        assert len(correlation)==1
        source=next(r for r in audit['rows'] if r['kind']=='source_received')
        payload=client.get('/api/simulation/analysis/flow-payload/'+source['payload_ref']).json()
        assert payload['payload'][0]['token']=='[redacted]'
        response=client.post('/api/operations/rehearsal/join',json={'name':'Audit test','role':'psu'})
        assert response.status_code==200 and response.headers['x-aerodt-trace']
        secret=response.json()['token']
        with client.websocket_connect('/ws/live') as socket:
            assert socket.receive_json()['schema_version']==1
        assert client.get('/api/live/snapshot').status_code==200
    archive=AuditRecords(tmp_path/'logs/runs')
    run=archive.list()[0]['id']; rows=archive.query(run,limit=200)
    stream=next(r for r in rows['rows'] if r['kind']=='stream_delivery')
    assert stream['locally_sent']>=1 and stream['remote_acknowledged'] is None
    assert rows['health']['complete'] and rows['health']['closed']
    response=next(r for r in rows['rows'] if r.get('path','').endswith('/join') and r['kind']=='http_result')
    stored=archive.payload(run,response['payload_ref'])
    assert secret not in str(stored) and stored['payload']['response']['token']=='[redacted]'
