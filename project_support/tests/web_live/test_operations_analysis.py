import copy
import csv
import io
import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from communication.web.analysis_routes import create_analysis_router
from data.simulation.operations_records import OperationsHistory, OperationsRecords, write_operations
from user_application.uam_mission.operations_analysis import build_report, select_sorties
from user_application.uam_mission.operations_reports import OperationsReports


def source():
    plans = [dict(flight_id=f'F{i}', aircraft_id=f'A{i%2}', origin='V1', destination='V2', seats=4,
                  passengers=3, off_block_s=3000+i*100, touchdown_s=3800+i*100) for i in range(8)]
    plans[7]['off_block_s'] = 9000
    plans[7]['touchdown_s'] = 10000
    def e(flight, kind, at, **kw):
        return dict(flight_id=f'F{flight}', kind=kind, time_s=at, **kw)
    events = [e(0,'off_block',3000),e(0,'hold',3500),e(0,'hold',3520),e(0,'hold_released',3700),
              e(0,'touchdown',4100,hold_s=200),e(0,'in_block',4200,hold_s=200),
              e(1,'off_block',3200),e(1,'touchdown',3850,hold_s=0),
              e(2,'off_block',3500),e(2,'hold',4700),
              e(3,'cancelled',3300),e(4,'off_block',3600),e(4,'pilot_failed',3650,reason='test'),
              e(5,'in_block',4900),e(7,'off_block',9000)]
    return {'schema_version':1,'meta':dict(scenario_id='day-1',date='2026-09-11',observed_s=5000,
            start_s=2900,planned_end_s=11000,state='playing',engine='native'),
            'plans':plans,'events':events+[events[0].copy()],
            'active':{'F2':{'hold_s':300,'phase':'hold'}},'facilities':{'V1':'강남','V2':'천호'}}


def test_plan_actual_and_future_are_distinct_and_queries_do_not_modify_inputs():
    data=source();before=copy.deepcopy(data);r=build_report(data);t=r['totals']
    assert data==before
    assert (t['planned'],t['departed'],t['completed'],t['due_departures'])==(8,4,2,7)
    assert (t['in_progress'],t['cancelled'],t['failed'],t['future'],t['overdue'])==(1,1,1,1,2)
    assert t['due_departure_pct']==57.1
    assert t['transported_passengers']==6 and t['departed_passengers']==12
    assert t['on_time_pct']==100 and t['arrival_delay']['mean_s']==150
    assert r['sorties'][1]['arrival_delta_s']==-50
    assert r['sorties'][5]['actual_arrival_s'] is None  # in-block is not touchdown


def test_hold_intervals_cross_hours_without_double_counting_relocated_holds():
    r=build_report(source());t=r['totals']
    assert t['hold_total_s']==500 and t['held_sorties']==2
    assert t['hold']['mean_s']==250 and t['hold']['p95_s']==295
    assert r['hourly'][0]['hold_aircraft_minutes']==1.67
    assert r['hourly'][1]['hold_aircraft_minutes']==6.67
    ports={p['id']:p for p in r['vertiports']}
    assert ports['V1']['movements']==4 and ports['V2']['movements']==2
    assert ports['V2']['passenger_movements']==6
    assert ports['V2']['peak_holding']==1
    assert ports['V2']['congestion_pct']==50
    assert select_sorties(r,hold_hour=0)['total']==1
    assert select_sorties(r,hold_hour=1)['total']==2


def test_missing_comparison_and_passenger_data_are_unknown():
    data=source();data['plans'][0]['touchdown_s']=None;data['plans'][1]['passengers']=None
    t=build_report(data)['totals']
    assert t['on_time_denominator']==1 and t['on_time_pct']==100
    assert t['transported_passengers'] is None and t['load_factor_pct'] is None
    data['plans']=[];data['events']=[]
    assert build_report(data)['totals']['on_time_pct'] is None


def test_explicit_zero_accumulator_is_not_replaced_with_an_event_estimate():
    data=source()
    for event in data['events']:
        if event['flight_id']=='F0' and 'hold_s' in event:event['hold_s']=0
    assert build_report(data)['sorties'][0]['hold_s']==0


def test_filters_page_clamp_and_chart_drilldowns():
    r=build_report(source())
    assert select_sorties(r,status='held')['total']==2
    assert select_sorties(r,query='천호')['total']==8
    assert select_sorties(r,aircraft='A0')['total']==4
    assert select_sorties(r,vertiport='missing')['total']==0
    assert select_sorties(r,delay_bin=0)['rows'][0]['flight_id']=='F1'
    assert select_sorties(r,hour=2)['rows'][0]['flight_id']=='F7'
    assert select_sorties(r,page=99,page_size=3)['page']==3
    assert 'events' not in select_sorties(r)['rows'][0]


def test_history_retains_events_when_inspection_ring_rolls_over():
    history=OperationsHistory();events=[{'time_s':i} for i in range(20)]
    history.observe(events);history.observe(events)
    assert len(history.events)==20
    del events[:5];events.extend([{'time_s':i} for i in range(20,25)])
    history.observe(events)
    assert [e['time_s'] for e in history.events]==list(range(25))
    events.extend([{'time_s':25}]);history.observe(events)
    assert len(history.events)==26


def test_archive_roundtrip_and_path_validation(tmp_path):
    records=OperationsRecords(tmp_path);write_operations(tmp_path/'day-1',source())
    assert records.list()[0]['id']=='day-1'
    assert records.read('day-1')['meta']['recorded'] is True
    for key in ['../x','x/y','C:\\x','a.b','']:
        with pytest.raises(ValueError):records.read(key)
    (tmp_path/'day-1'/'operations.json').write_text('{broken',encoding='utf8')
    assert records.list()==[]


def test_legacy_csv_does_not_invent_passengers_and_retains_terminal_facts(tmp_path):
    path=tmp_path/'legacy';path.mkdir()
    (path/'summary.json').write_text(json.dumps({'schedule':{'date':'2026-09-11','window':{'start_s':0,'end_s':9000}},'result':{'time_s':5000}}))
    (path/'flights.csv').write_text('flight_plan_id,aircraft_id,seats,origin,destination,planned_off_block,actual_off_block,planned_touchdown,actual_touchdown,hold_seconds\nF1,A1,4,V1,V2,00:01:00,00:01:10,00:02:00,00:03:00,30\nF2,A2,4,V1,V2,00:05:00,,00:10:00,,\n')
    (path/'events.jsonl').write_text('{"flight_id":"F2","kind":"cancelled","time_s":200}\n{partial')
    records=OperationsRecords(tmp_path);r=build_report(records.read('legacy'))
    assert r['totals']['completed']==1 and r['totals']['cancelled']==1
    assert r['totals']['transported_passengers'] is None and r['totals']['hold_total_s']==30
    assert records.list()[0]['legacy'] is True


@pytest.mark.parametrize('payload', [[], {'schema_version':1,'meta':[]},
    {'schema_version':1,'meta':{'scenario_id':'bad'},'plans':[],'events':[None]}])
def test_malformed_json_records_return_a_controlled_error(tmp_path,payload):
    path=tmp_path/'bad';path.mkdir();(path/'operations.json').write_text(json.dumps(payload))
    with pytest.raises(ValueError):OperationsRecords(tmp_path).read('bad')


class Session:
    def __init__(self):self.data=source();self.calls=0
    def analysis_stamp(self):return self.data['meta']['scenario_id']
    def analysis_input(self):self.calls+=1;return copy.deepcopy(self.data)


def test_cache_refresh_and_generation_change(tmp_path):
    session=Session();now=[0];reports=OperationsReports(session,OperationsRecords(tmp_path),clock=lambda:now[0])
    reports.summary();reports.sorties();assert session.calls==1
    now[0]=6;reports.summary();assert session.calls==2
    session.data['meta']['scenario_id']='day-2';reports.summary();assert session.calls==3


def test_csv_formula_neutralization_and_numeric_time_units(tmp_path):
    session=Session();session.data['plans'][0]['aircraft_id']='=1+1'
    reports=OperationsReports(session,OperationsRecords(tmp_path))
    text=reports.export();assert text.startswith('\ufeff')
    rows=list(csv.DictReader(io.StringIO(text.lstrip('\ufeff'))))
    assert rows[0]['aircraft_id']=="'=1+1" and rows[0]['actual_departure_s']=='3000.0'


def test_http_read_only_endpoints_validation_not_found_and_empty_current(tmp_path):
    session=Session();reports=OperationsReports(session,OperationsRecords(tmp_path));app=FastAPI();app.include_router(create_analysis_router(reports))
    with TestClient(app) as client:
        assert client.get('/api/simulation/analysis').json()['available'] is True
        assert 'sorties' not in client.get('/api/simulation/analysis').json()
        assert client.get('/api/simulation/analysis/sorties?status=held').json()['total']==2
        assert client.get('/api/simulation/analysis/sorties/F0').json()['row']['hold_s']==200
        assert client.get('/api/simulation/analysis/sorties/unknown').status_code==404
        assert client.get('/api/simulation/analysis?recording=../bad').status_code==404
        assert client.get('/api/simulation/analysis/sorties?page_size=101').status_code==422
        assert client.post('/api/simulation/analysis').status_code==405
        response=client.get('/api/simulation/analysis/export')
        assert response.status_code==200 and response.headers['cache-control']=='no-store'
    empty=OperationsReports(type('Empty',(),{'analysis_stamp':lambda _:None,'analysis_input':lambda _:None})(),OperationsRecords(tmp_path))
    assert empty.summary()=={'schema_version':1,'available':False}

def test_slow_report_ttl_starts_when_build_finishes(tmp_path):
    session=Session();now=[0.0]
    original=session.analysis_input
    def slow_input():
        now[0]+=8
        return original()
    session.analysis_input=slow_input
    reports=OperationsReports(session,OperationsRecords(tmp_path),clock=lambda:now[0])
    reports.summary();reports.sorties()
    assert session.calls==1
    now[0]+=5.1;reports.summary();assert session.calls==2


def test_clock_progress_does_not_invalidate_wall_time_cache(tmp_path):
    session=Session();now=[0.0];tick=[0]
    session.analysis_cache_key=lambda:(session.data['meta']['scenario_id'],'playing')
    session.analysis_stamp=lambda:(session.data['meta']['scenario_id'],'playing',tick[0])
    reports=OperationsReports(session,OperationsRecords(tmp_path),clock=lambda:now[0])
    reports.summary();tick[0]+=30;reports.sorties();assert session.calls==1
    session.data['meta']['scenario_id']='new-day';reports.summary();assert session.calls==2
