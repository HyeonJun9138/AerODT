import asyncio
import json
import sqlite3
import threading
import pytest
from data.ingestion.operational_audit import AuditJournal, AuditRecords
from communication.web.audit_routes import OperationalAuditMiddleware


def test_correlated_payloads_persist_redacted_and_reopen_after_restart(tmp_path):
    journal = AuditJournal(tmp_path/'run-a')
    payload = {'token':'never-store', 'nested':{'password':'secret'}, 'values':[1,2]}
    assert journal.record('source_received', payload=payload, correlation_id='request-a', scenario_id='day-a')
    payload['values'].append(3)
    journal.record('source_registered', correlation_id='request-a', scenario_id='day-a')
    journal.record('source_received', scenario_id='day-b')
    journal.flush()
    result = journal.query('day-a')
    assert len(result['rows']) == 2
    assert len({r['correlation_id'] for r in result['rows']}) == 1
    ref = result['rows'][-1]['payload_ref']
    journal.close()
    archive = AuditRecords(tmp_path)
    content = archive.payload('run-a', ref)['payload']
    assert content == {'token':'[redacted]','nested':{'password':'[redacted]'},'values':[1,2]}
    assert archive.query('run-a')['health']['complete']
    assert len(archive.list()) == 1
    with pytest.raises(ValueError):
        archive.query('../escape')


def test_concurrent_writers_have_exact_counts_and_cursor_pages(tmp_path):
    journal = AuditJournal(tmp_path/'parallel')
    threads=[threading.Thread(target=lambda:[journal.record('request', flight_id=str(i)) for i in range(40)]) for _ in range(4)]
    for thread in threads:thread.start()
    for thread in threads:thread.join()
    journal.flush()
    page = journal.query(limit=100)
    older = journal.query(before=page['next_before'], limit=100)
    assert len(page['rows']) == 100 and len(older['rows']) == 60
    assert page['counts']['request'] == 160
    assert not {r['id'] for r in page['rows']} & {r['id'] for r in older['rows']}
    journal.close()


def test_capture_limits_and_shutdown_rejection_are_visible(tmp_path):
    journal = AuditJournal(tmp_path/'bounds')
    journal.record('request', payload=['x']*10005)
    journal.flush()
    record=journal.query()['rows'][0]
    assert AuditRecords(tmp_path).payload('bounds',record['payload_ref'])['payload'][-1]['truncated_items']==5
    journal.close()
    assert journal.record('too-late') is False
    assert journal.health()['dropped']==1 and not journal.health()['complete']


def test_database_failure_is_reported_without_claiming_record_written(tmp_path):
    journal = AuditJournal(tmp_path/'failure')
    with sqlite3.connect(journal.path) as db:db.execute('DROP TABLE events')
    journal.record('request')
    journal.flush()
    assert journal.health()['written']==0
    assert journal.health()['write_failures']==1 and journal.health()['dropped']==1
    journal.close()


def test_http_request_and_actual_local_response_share_id_without_credentials():
    entries=[]
    async def application(scope, receive, send):
        await receive()
        await send({'type':'http.response.start','status':409,'headers':[]})
        await send({'type':'http.response.body','body':b'{"error":"stale_version"}'})
    async def receive():return {'type':'http.request','body':b'{"action":"proceed","token":"private"}'}
    async def send(message):pass
    middleware=OperationalAuditMiddleware(application,lambda kind,**detail:entries.append((kind,detail)))
    asyncio.run(middleware({'type':'http','method':'POST','path':'/api/operations/rehearsal/requests/a/decision',
                           'headers':[(b'authorization',b'private')],'query_string':b'token=private'}, receive, send))
    assert len(entries)==2 and entries[0][1]['correlation_id']==entries[1][1]['correlation_id']
    assert entries[1][1]['status']==409
    assert entries[1][1]['outcome']=='local_response_sent'
    assert 'headers' not in entries[1][1] and 'query_string' not in entries[1][1]


def test_send_failure_is_not_counted_as_success():
    entries=[]
    async def app(scope, receive, send):
        await send({'type':'http.response.start','status':200})
        await send({'type':'http.response.body','body':b'123'})
    async def receive():return {}
    async def send(message):
        if message['type']=='http.response.body':raise OSError('closed')
    middleware=OperationalAuditMiddleware(app,lambda kind,**detail:entries.append((kind,detail)))
    with pytest.raises(OSError):asyncio.run(middleware({'type':'http','method':'PUT','path':'/api/decisions'},receive,send))
    assert entries[-1][1]['outcome']=='transport_failed' and entries[-1][1]['locally_sent_bytes']==0


def test_raw_scenario_history_preserves_decisions_at_same_tick():
    from user_application.uam_mission.operations_analysis import build_report
    source={'meta':{'observed_s':100,'start_s':0}, 'plans':[dict(flight_id='F',aircraft_id='A',origin='V1',destination='V2',
             departure_fato='F1',arrival_fato='F1',off_block_s=0,touchdown_s=60)],
        'events':[
            dict(kind='off_block',time_s=1,flight_id='F',departure_fato='F1',arrival_fato='F2'),
            dict(kind='psu_decision',time_s=2,flight_id='F',node='allocate',outcome='selected'),
            dict(kind='psu_decision',time_s=2,flight_id='F',node='terminal_arrival',outcome='hold',reason='crossing',vertiport='V2',fato='F2'),
            dict(kind='psu_decision',time_s=12,flight_id='F',node='terminal_arrival',outcome='granted',vertiport='V2',fato='F2'),
            dict(kind='touchdown',time_s=70,flight_id='F',arrival_fato='F2'),
            dict(kind='psu_decision',time_s=80,flight_id='F',node='terminal_arrival',outcome='released',vertiport='V2',fato='F2')],
        'facilities':{'V1':'One','V2':'Two'},'active':{}}
    report=build_report(source)
    assert report['decisions']['total']==4
    assert report['decisions']['fato_reassignments']==1
    target=next(p for p in report['fatos'] if p['vertiport']=='V2' and p['fato']=='F2')
    assert target['landings']==1 and target['terminal_wait_s']==10 and target['protected_s']==68
    assert report['sorties'][0]['planned_arrival_fato']=='F1'
