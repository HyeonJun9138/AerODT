import asyncio
from copy import deepcopy
from datetime import datetime,timezone
import json
from pathlib import Path
import time
import pytest
from communication.python.native_pilot import NativePilotLibrary
from communication.external.physical_uam import validate_packet
from data.ingestion.physical_packets import PhysicalPackets
from data.ingestion.uam_sensor_records import UamSensorRecords
from digital_twin.simulation.decision_policy import validate
from digital_twin.simulation.scenario_engine import Phase,Route
from user_application.apps.physical_uam.fleet import PhysicalFleet
from user_application.apps.physical_uam.fleet_pilots import SensorScenarioPilots
from user_application.apps.physical_uam.fleet_plan import fleet_clock
from project_support.tests.web_live.test_scenario_engine import VERTIPORTS,NETWORK,row,schedule_of
from project_support.tests.web_live.test_physical_uam import packet
from project_support.tests.web_live.test_physical_console import saved,FakePilot

ROOT=Path(__file__).resolve().parents[3]

def test_fleet_clock_moves_whole_schedule_and_preserves_intervals():
    schedule={'date':'2026-10-10','window':{'start_s':23400}}
    now=datetime(2026,9,11,1,tzinfo=timezone.utc).timestamp()
    assert fleet_clock({'time_mode':'now'},schedule,now)['scenario_start']==now
    assert fleet_clock({'time_mode':'at','start_at':'2026-10-10T06:40:00'},schedule,now)['seek_s']==600
    assert fleet_clock({'time_mode':'at','start_at':'2026-10-10T06:29:00'},schedule,now)['wait_s']==60

def test_fleet_pages_are_bounded_ordered_and_can_filter_one_sensor_aircraft():
    store=PhysicalPackets()
    for i in range(1,801):store.append({'sequence':i,'aircraft_id':'A'+str(i%100)})
    first=store.read(1);assert len(first['packets'])==256 and first['has_more']
    second=store.read(first['packets'][-1]['sequence'])
    assert second['packets'][0]['sequence']==first['packets'][-1]['sequence']+1
    own=store.read(0,'A7');assert len(own['packets'])==8 and all(p['aircraft_id']=='A7' for p in own['packets'])
    assert len(store.read()['packets'])==256
    store.clear();assert store.read()['packets']==[]

def test_twin_keeps_all_one_hundred_aircraft():
    records=UamSensorRecords()
    for i in range(100):
        p=packet(1000,i+1);p['aircraft_id']='UAM'+str(i);records.register(p,1000.1)
    assert len(records.read())==100


def test_latest_delivery_does_not_replay_backlog_or_confuse_coalescing_with_loss():
    store=PhysicalPackets();records=UamSensorRecords()
    for i in range(1,11):
        p=packet(1000+i*.1,i);p['aircraft_id']='A'+str(i%2)
        if i!=3:store.append(p) # Actual transport loss is still counted.
        if i<=2:records.register(p,1001)
    raw=store.read(2);latest=store.read(2,latest_only=True)
    assert [p['sequence'] for p in latest['packets']]==[9,10]
    assert latest['coalesced_packets']==5 and not latest['has_more']
    assert all(p['samples']==[] for p in latest['packets'])
    assert any(p['samples'] for p in raw['packets'])
    before=records.missing
    for p in latest['packets']:records.register(p,1001.1)
    records.account_coalesced(latest['coalesced_packets'],before)
    assert records.counters()['missing_packets']==1
    assert records.counters()['coalesced_packets']==5
    assert all(p['sensors']['gnss']['sample_time']>=1000.9 for p in latest['packets'])


def test_report_history_is_bounded_by_time_even_with_slow_parked_reporting():
    records=UamSensorRecords()
    for i in range(61):records.register(packet(1000+i,i+1),1000+i+.1)
    history=records.past('physical:UAM0001')
    assert len(history)==41 and history[0]['packet']['sent_time']==1020
    assert all(not r['packet']['samples'] for r in history)
    assert records.read('physical:UAM0001')['packet']['samples']


def test_stop_during_whole_schedule_seek_closes_engine_before_single_mode(saved):
    from user_application.apps.physical_uam.execution import PhysicalExecution
    class Console:
        dem=None
        def env(self,_):return VERTIPORTS,NETWORK
    model=json.loads((ROOT/'digital_twin/model_library/packages/physical_uam_sensors/v1/model.json').read_text())
    prepared={'schedule':schedule_of(row('F1','A1','VP1','VP2','06:30:00')),'environment':{},'profile':{},'policy':validate({}),
        'settings':{'scope':'fleet','time_mode':'at','start_at':'2026-01-02T06:40:00','terrain':'flat','flat_height_m':0,'seed':42,'repeat':False}}
    prepared['schedule']['date']='2026-01-02'
    async def run():
        execution=PhysicalExecution(NativePilotLibrary(),PhysicalPackets(),model,saved,Console(),pilot_factory=FakePilot)
        task=asyncio.create_task(execution.run())
        async def until(check):
            # Cold native/route initialization is allowed time on the test host;
            # the assertion is cancellation ownership, not startup throughput.
            for _ in range(2000):
                if check():return
                await asyncio.sleep(.005)
            raise AssertionError(execution.status)
        try:
            execution.command('start',prepared)
            await until(lambda:isinstance(execution.current,PhysicalFleet) and execution.current.engine is not None)
            old=execution.current;old_process=old.process_id
            execution.command('stop');await until(lambda:execution.status['status']=='stopped')
            assert not old.engine.pilots.flights and old.engine.pilots._pool is None
            assert execution.packets.read()['packets']==[]
            execution.command('start',{'saved':saved,'settings':{'scope':'single','time_mode':'now','seed':42,'repeat':False}})
            await until(lambda:execution.status['status']=='running')
            assert execution.status['scope']=='single' and execution.process_id!=old_process
            assert execution.status['flight']['aircraft_id']=='UAM1'
        finally:task.cancel();await asyncio.gather(task,return_exceptions=True)
    asyncio.run(run())

def test_sensor_observer_reads_independent_native_substeps():
    pilots=SensorScenarioPilots(NativePilotLibrary(),workers=1)
    route=Route('sensor-test',[Phase('takeoff','takeoff',[(37,127,20),(37,127,60)],20,2),
        Phase('cruise','cruise',[(37,127,60),(37.005,127,60)],30,20),
        Phase('landing','landing',[(37.005,127,60),(37.005,127,20)],30,2)],{}, {})
    try:
        pilots.start('A',route,0);pilots.start('B',route,0)
        pilots.advance('A',.1);samples=pilots.drain()['A'][0]
        assert len(samples)==5 and samples[-1][1]['physics_time_s']==pytest.approx(.1,abs=.01)
        assert pilots.flights['B'].advance(0)['physics_time_s']==0
    finally:pilots.close()

def test_shared_fleet_runs_ground_psu_and_per_aircraft_sensors_without_touching_schedule():
    schedule=schedule_of(row('F1','A1','VP1','VP2','06:30:00'),row('F2','A2','VP1','VP2','06:30:00'))
    original=deepcopy(schedule)
    class Console:
        dem=None
        def env(self,_):return VERTIPORTS,NETWORK
    model=json.loads((ROOT/'digital_twin/model_library/packages/physical_uam_sensors/v1/model.json').read_text())
    prepared={'schedule':schedule,'environment':{},'profile':{},'policy':validate({}),
        'settings':{'scope':'fleet','time_mode':'plan','terrain':'flat','flat_height_m':0,'seed':42,'repeat':False}}
    async def run():
        f=PhysicalFleet(NativePilotLibrary(),PhysicalPackets(),model,Console())
        try:
            await f.begin(prepared)
            # Departure preparation can precede the first resource request.
            # Observe actual scheduling progress instead of assuming a request
            # exists one second after constructing the fleet.
            for _ in range(600):
                await f.step(.1)
                if f.engine.summary()['psu']['requests']>0:break
            f.update_overview()
            assert len(f.engine.aircraft)==len(f.samplers)==2
            assert f.engine.summary()['psu']['requests']>0
            assert f.engine.pilots.mode=='native-fastphysics-simpleflight'
            assert any(e['kind']=='psu_decision' for e in f.engine.events)
            from user_application.apps.physical_uam.operations import capture_frame
            from user_application.uam_mission.operations_analysis import build_report
            capture_frame(f);body=f.operation_records.envelope()
            assert set(body['frame']['aircraft'])=={'A1','A2'}
            assert body['frame']['status']['psu']==f.engine.summary()['psu']
            assert body['configuration']['policy']==f.engine.policy
            assert body['frame']['aircraft']['A1']['state']==f.engine._state(f.engine.aircraft['A1'])
            assert build_report(f.operation_records.analysis_input())['totals']['planned']==2
            emitted=[json.loads(json.dumps(p)) for _,p in f.pending]
            assert {p['aircraft_id'] for p in emitted}=={'A1','A2'}
            assert len({p['sequence'] for p in emitted})==len(emitted)
            for p in emitted:validate_packet(p,max(time.time(),p['sent_time']))
            assert f.samplers['A1'].gnss_bias!=f.samplers['A2'].gnss_bias
            at=f.engine.time_s;f.command('pause');await f.apply_commands();assert f.paused
            f.command('resume');await f.apply_commands();assert f.engine.time_s==at and not f.paused
        finally:
            if f.engine:f.engine.close()
    asyncio.run(run());assert schedule==original
