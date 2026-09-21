import copy,json,math
import pytest
from data.simulation.proximity_records import ProximityRecords

def state(id,lon=127,alt=100,**kwargs):
    return dict(aircraft_id=id,flight_id='F'+id,latitude_deg=37,longitude_deg=lon,
        altitude_m=alt,phase='cruise',airborne=True,hold_seconds=0,**kwargs)

def test_observed_minima_have_independent_times_and_preserve_inputs(tmp_path):
    r=ProximityRecords(tmp_path,'s',{'psu':{'terminal_horizontal_m':30}})
    a,b=state('A'),state('B',127.001,120)
    before=copy.deepcopy([a,b]);r.observe(10,[b,a]);assert [a,b]==before
    b['longitude_deg']=127.0005;b['altitude_m']=150;b['phase']='hold';b['hold_seconds']=4
    r.observe(12,[a,b]);r.observe(12,[a,b]);r.close()
    report=json.loads((r.directory/'proximity.json').read_text())
    p=report['pairs'][0]
    assert p['aircraft_ids']==['A','B']
    assert p['minimum_horizontal']['time_s']==12
    assert p['minimum_vertical']['time_s']==10
    assert p['minimum_3d']['time_s']==12
    assert p['minimum_3d']['phases']==['cruise','hold']
    assert report['samples']==2 and report['max_sample_gap_s']==2
    assert report['flight_waits']['FB']['reported_hold_seconds']==4
    assert report['continuous_minimum_guaranteed'] is False
    assert report['policy']['psu']['terminal_horizontal_m']==30

def test_invalid_samples_ground_pairs_and_backward_clock_do_not_create_encounters(tmp_path):
    r=ProximityRecords(tmp_path,'s',{})
    a,b=state('A'),state('B');a['airborne']=b['airborne']=False
    r.observe(2,[a,b]);a['airborne']=True;b['latitude_deg']=math.nan
    r.observe(3,[a,b]);r.observe(1,[state('A'),state('B')]);r.close()
    report=json.loads((r.directory/'proximity.json').read_text())
    assert not report['pairs'] and report['samples']==2
    assert report['invalid_states']==1

def test_exact_touchdown_hold_total_is_retained(tmp_path):
    r=ProximityRecords(tmp_path,'s',{})
    r.observe(1,[state('A')])
    r.event({'kind':'touchdown','flight_id':'FA','aircraft_id':'A','time_s':2,'hold_s':17})
    r.close()
    assert json.loads((r.directory/'proximity.json').read_text())['flight_waits']['FA']['reported_hold_seconds']==17

def test_scenario_recorder_links_separate_log_without_writing_before_play(tmp_path):
    from user_application.uam_mission.scenario_session import ScenarioRecorder
    r=ScenarioRecorder(tmp_path/'scenarios','s',workspace=tmp_path,policy={'psu':{'terminal_horizontal_m':30}})
    assert not (tmp_path/'logs').exists()
    a=state('A');a.update(heading_deg=0,speed_mps=10,holding=False)
    r.track(5,[a])
    info=r.manifest()['proximity']
    r.close()
    p=tmp_path/info['path']
    assert p.is_file() and p.is_relative_to(tmp_path/'logs/runs')
    assert json.loads(p.read_text())['samples']==1


def test_periodic_checkpoint_is_detached_and_does_not_block_observation(tmp_path, monkeypatch):
    import threading, time
    r=ProximityRecords(tmp_path,'s',{})
    entered, release=threading.Event(),threading.Event()
    captured=[]
    original=r._write_checkpoint
    def slow(content):
        captured.append(content)
        entered.set()
        assert release.wait(3)
        original(content)
    monkeypatch.setattr(r,'_write_checkpoint',slow)
    try:
        r._last_flush=-float('inf')
        started=time.perf_counter();r.observe(1,[state('A'),state('B',127.001)])
        assert time.perf_counter()-started < .2
        assert entered.wait(1)
        r._last_flush=-float('inf')
        r.observe(2,[state('A'),state('B',127.0005)])
        assert len(captured)==1, 'a slow writer must not grow a queue'
        assert captured[0]['samples']==1
        assert captured[0]['pairs'][0]['samples']==1
        assert captured[0]['pairs'][0]['minimum_3d']['time_s']==1
        assert captured[0]['flight_waits']['FB']['last_observed_s']==1
    finally:
        release.set();r.close()
    report=json.loads((r.directory/'proximity.json').read_text())
    assert report['samples']==2 and report['pairs'][0]['samples']==2
    assert report['pairs'][0]['minimum_3d']['time_s']==2


def test_failed_checkpoint_is_not_silently_discarded_and_close_can_retry(tmp_path, monkeypatch):
    r=ProximityRecords(tmp_path,'s',{}); original=r._write_checkpoint
    def fail(content): raise OSError('disk full')
    monkeypatch.setattr(r,'_write_checkpoint',fail);r._last_flush=-float('inf')
    r.observe(1,[state('A'),state('B')])
    with pytest.raises(OSError,match='disk full'):r.flush()
    monkeypatch.setattr(r,'_write_checkpoint',original)
    r.close()
    assert json.loads((r.directory/'proximity.json').read_text())['samples']==1
