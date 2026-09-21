import asyncio
from copy import deepcopy
import json
from types import SimpleNamespace
import time
import pytest
from communication.external.physical_operations import validate_operations,fetch_operations
from data.simulation.physical_operations import PhysicalOperationsRecords
from data.simulation.operations_records import OperationsRecords
from user_application.uam_mission.operations_analysis import build_report
from user_application.apps.web_dashboard.physical_operations import PhysicalOperations
from user_application.apps.web_dashboard.operating_context import OperatingContext,OperatingReports
from project_support.tests.web_live.test_operations_analysis import source


def journal(path=None):
    raw=source();raw['meta'].update(scenario_id='physical-test',source='physical',source_label='Physical 실시간 운항')
    raw['events']=[dict(e,event_sequence=i+1) for i,e in enumerate(raw['events'])]
    j=PhysicalOperationsRecords(path)
    j.begin('physical-test','process-1',900,{'environment':{'vertiports':[],'routes':{'nodes':[],'links':[]}},
        'policy':{},'profile':{},'rules':{'revision':'test'},'environment_revision':'env1',
        'analysis_base':{k:v for k,v in raw.items() if k not in ('meta','events','active')}})
    j.observe_events(raw['events']);j.observe({'status':{'scenario_id':'physical-test','loaded':True,'state':'playing'},
        'decks':{'V2':{'vertiport_id':'V2','standing':[],'holding':[{'aircraft_id':'A0'}]}},'aircraft':{},
        'vertiports':{'vertiports':[],'arrivals':[]},'pilots':{'aircraft':[]},'passengers':{'aircraft':[]}},
        {k:raw[k] for k in ('meta','active')},1000)
    return j,raw


def test_paged_bootstrap_retains_actuals_and_archives_after_disconnect(tmp_path):
    sender,raw=journal();receiver=PhysicalOperationsRecords(tmp_path);before=deepcopy(raw)
    while True:
        body=sender.envelope(receiver.run_id,len(receiver.events),limit=3)
        validate_operations(json.loads(json.dumps(body)))
        receiver.register(body,1000.1)
        if body['has_more']:assert receiver.analysis_input() is None
        else:break
    assert raw==before and receiver.analysis_input()==raw
    assert build_report(receiver.analysis_input())==build_report(raw)
    assert receiver.checkpoint()
    restored=OperationsRecords(tmp_path).read('physical-test')
    assert restored['events']==raw['events'] and len(restored['plans'])==8
    assert build_report(restored)['totals']['completed']==2
    assert sender.envelope(receiver.run_id,len(receiver.events))['configuration'] is None


@pytest.mark.parametrize('mutate',[
    lambda b:b.update(after=-1),lambda b:b.update(run_id='../escape'),
    lambda b:b['analysis']['meta'].update(scenario_id='wrong'),
    lambda b:b.update(has_more=True),lambda b:b.update(events=[]),
    lambda b:b.update(generated_at=float('nan')),
])
def test_protocol_rejects_mixed_epochs_invalid_pages_and_paths(mutate):
    sender,_=journal();body=sender.envelope();mutate(body)
    with pytest.raises(ValueError):validate_operations(body)


def test_history_rejects_gaps_and_late_source_restart():
    sender,_=journal();receiver=PhysicalOperationsRecords(None)
    receiver.register(sender.envelope(),1000)
    gap=sender.envelope(receiver.run_id,len(receiver.events));gap['after']+=1
    with pytest.raises(ValueError):receiver.register(gap,1001)
    late=sender.envelope();late.update(run_id='physical-old',source_started_at=800)
    assert not receiver.register(late,1002)
    assert receiver.run_id=='physical-test'


def test_reporting_uses_physical_actuals_and_source_toggle_restores_simulation(tmp_path):
    p=SimpleNamespace(url='http://source',generation=0,clock_offset=0,clock_process='process-1',enabled=lambda:True,simulation_showing=lambda:False)
    physical=PhysicalOperations(p,tmp_path/'physical');sender,raw=journal()
    body=sender.envelope();body['generated_at']=time.time();physical.records.register(body,time.time());physical.state='ready'
    local=source();local['meta']['scenario_id']='simulation-local';local['plans']=local['plans'][:1];local['events']=[]
    scenario=SimpleNamespace(analysis_input=lambda:local,analysis_stamp=lambda:('sim',1),status=lambda:{'loaded':True})
    store=SimpleNamespace(read=lambda:{})
    ctx=OperatingContext(scenario,physical,lambda:[],lambda:{'nodes':[],'links':[]},lambda:{'revision':'local'},store,store)
    reports=OperatingReports(ctx,OperationsRecords(tmp_path/'sim'),OperationsRecords(tmp_path/'physical'))
    assert reports.summary()['totals']['completed']==2
    assert reports.summary()['meta']['source']=='physical'
    assert reports.sortie('F0')['row']['actual_arrival_s']==4100
    assert 'F0' in reports.export()
    assert ctx.read('decks','V2')['holding'][0]['aircraft_id']=='A0'
    assert ctx.status()['policy_match'] and ctx.status()['profile_match']
    assert ctx.environment()['source']=='physical' and ctx.environment()['vertiports']==[]
    physical.records.checkpoint()
    assert reports.records_list()['records'][0]['id']=='physical:physical-test'
    p.simulation_showing=lambda:True
    assert reports.summary()['meta']['scenario_id']=='simulation-local'
    assert reports.summary('physical')['totals']['completed']==2
    assert reports.summary('physical:physical-test')['totals']['completed']==2
    assert ctx.environment()['revision']=='local'


def test_pending_physical_source_keeps_saved_environment_visible(tmp_path):
    p=SimpleNamespace(url='http://source',generation=0,clock_offset=0,clock_process=None,enabled=lambda:True,simulation_showing=lambda:False)
    physical=PhysicalOperations(p,tmp_path/'physical')
    scenario=SimpleNamespace(status=lambda:{'loaded':False})
    ports=[{'id':'VP001','name':'Saved'}]
    network={'nodes':[{'id':'WP001'}],'links':[]}
    store=SimpleNamespace(read=lambda:{})
    ctx=OperatingContext(scenario,physical,lambda:ports,lambda:network,lambda:{'revision':'local-7'},store,store)

    assert physical.selected
    assert ctx.environment_stamp()=={'revision':'local-7'}
    assert ctx.environment()['source']=='scenario'
    assert ctx.environment()['vertiports']==ports
    assert ctx.environment()['network']==network


def test_stale_operational_frame_is_not_freshened_by_http_poll(tmp_path):
    p=SimpleNamespace(url='http://source',generation=0,clock_offset=0,enabled=lambda:True,simulation_showing=lambda:False)
    op=PhysicalOperations(p,tmp_path);sender,_=journal()
    op.records.register(sender.envelope(),time.time());op.state='ready'
    assert op.status()['stale'] and op.status()['age_s']>4


def test_event_cursor_does_not_run_ahead_of_observed_operational_frame():
    sender,raw=journal();count=len(raw['events'])
    sender.observe_events([dict(raw['events'][-1],event_sequence=count+1)])
    assert sender.envelope()['event_count']==count
    assert len(sender.analysis_input()['events'])==count
    sender.observe(sender.frame,sender.header,1001)
    assert sender.envelope()['event_count']==count+1


def test_operations_http_and_read_views_have_no_mutation_endpoints(tmp_path):
    import httpx
    from fastapi import FastAPI
    from communication.web.physical_publisher_routes import create_publisher_router
    sender,_=journal();app=FastAPI();app.include_router(create_publisher_router(status=lambda:{},telemetry=lambda *_:{},plan=lambda:{},truth=lambda:{},control=lambda *_:True,page=lambda:'',operations=sender.envelope))
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as c:
            body=await fetch_operations(c,'http://test')
            assert body['run_id']=='physical-test' and len(body['events'])==16
            assert (await c.post('/api/v1/operations',json={'action':'clear'})).status_code==405
            assert (await c.get('/api/v1/operations?after=-1')).status_code==422
    asyncio.run(run())
