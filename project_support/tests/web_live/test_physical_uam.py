import asyncio
from collections import Counter
from copy import deepcopy
import json
import math
from pathlib import Path
import pytest
from communication.external.physical_uam import validate_packet
from data.ingestion.uam_sensor_records import UamSensorRecords
from digital_twin.simulation.physical_sensors import PhysicalSensors,body_from_ned
from digital_twin.live_twin.uam_sensor_fusion import estimate,prediction_intent
from user_application.apps.web_dashboard.physical_input import PhysicalInput

ROOT=Path(__file__).resolve().parents[3]
MODEL=json.loads((ROOT/'digital_twin/model_library/packages/physical_uam_sensors/v1/model.json').read_text())

def state(**patch):
    return dict(latitude_deg=37.55,longitude_deg=127.,altitude_m=200.,heading_deg=0.,pitch_deg=0.,roll_deg=0.,
                velocity_ned_mps=(20.,0.,0.),tilt_deg=80.,rotor_radps=230.,grounded=False,route_target_index=0,**patch)

def packet(at=1000.,sequence=1):
    sensor=PhysicalSensors(MODEL);samples=sensor.sample(state(),0,at,'cruise')
    return dict(schema_version=1,message_type='aerodt.uam.sensor_packet',provenance='physical_emulation',
        process_id='p1',source_started_at=900.,sequence=sequence,sent_time=at,aircraft_id='UAM0001',name='UAM0001',
        mission_id='flight1',mission_started_at=950.,sensors=sensor.latest,samples=samples,
        intent={'phase':'cruise','target_index':0,'waypoints':[{'start':[37.55,127.,200.],
                'end':[37.6,127.,200.],'speed_mps':30.,'phase':'cruise'}],'policy':{}},route={'origin':'VP001','destination':'VP013'})

def record(p):
    return dict(packet=p,received_time=p['sent_time']+.1,continuity=1)


def test_ground_decision_is_carried_without_becoming_a_twin_control_command():
    p=packet()
    p['sensors']['vehicle']['values']['flight_phase']='gate_in'
    p['operations']={'ground_waiting':True,'instruction':{'action':'ground_wait','reason':'통과 대기'}}
    entity=estimate(record(p),1000.2)
    assert entity.ground_waiting and entity.ground_action=='ground_wait'
    assert entity.flight_phase=='gate_in'
    assert entity.provenance=='physical_emulation'


@pytest.mark.parametrize('operations',[[],{'instruction':[]},{'ground_waiting':'true'}])
def test_new_ground_operation_fields_are_validated_at_the_wire(operations):
    p=packet();p['operations']=operations
    with pytest.raises(ValueError):validate_packet(p,1000.1)

def test_sensor_rates_are_independent_and_reproducible():
    model=deepcopy(MODEL)
    for value in model.values():
        if isinstance(value,dict):value['dropout']=0
    a,b=PhysicalSensors(model),PhysicalSensors(model);counts=Counter()
    # Physics at 100 Hz supports all sample rates exactly.
    for i in range(100):
        first=a.sample(state(),i*.01,1000+i*.01,'cruise')
        assert first==b.sample(state(),i*.01,1000+i*.01,'cruise')
        counts.update(x['sensor_id'] for x in first)
    assert counts==dict(gnss=5,ahrs=20,barometer=20,imu=50,vehicle=10)
    assert a.latest['gnss']['values']['latitude_deg']!=37.55

def test_stationary_imu_reports_gravity_in_body_frame():
    samples=PhysicalSensors(MODEL).sample(state(),0,1000,'cruise')
    imu=next(x for x in samples if x['sensor_id']=='imu')['values']
    assert imu['specific_force_mps2'][2]==pytest.approx(-9.80665,abs=.2)
    assert max(abs(x) for x in imu['angular_rate_radps'])<.01
    assert body_from_ned((1,0,0),0,0,90)==pytest.approx((0,-1,0),abs=1e-6)

def test_gnss_outage_preserves_measurement_timestamp_not_freshens_it():
    sensor=PhysicalSensors(MODEL);sensor.sample(state(),0,1000,'cruise');sensor.gnss_outage_until=10
    for i in range(1,100):sensor.sample(state(),i*.02,1000+i*.02,'cruise')
    assert sensor.latest['gnss']['sample_time']==1000
    assert sensor.latest['ahrs']['sample_time']>1001

@pytest.mark.parametrize('mutate',[
    lambda p:p.update(schema_version=99),lambda p:p.update(sent_time=2000),
    lambda p:p['sensors']['gnss']['values'].update(latitude_deg=float('nan')),
    lambda p:p['sensors']['gnss']['values'].update(latitude_deg=95),
    lambda p:p['sensors']['gnss'].update(frame='ECEF'),
    lambda p:p['intent'].update(waypoints=[{}]*1001),
    lambda p:p['sensors']['gnss']['uncertainty'].update(position_variance_ned_m2=[-1,1,1]),
])
def test_wire_rejects_invalid_or_ambiguous_samples(mutate):
    p=packet();mutate(p)
    with pytest.raises((ValueError,KeyError)):validate_packet(p,1001)

def test_duplicates_late_samples_and_retired_process_do_not_move_twin_backwards():
    data=UamSensorRecords();p=packet();assert data.register(p,1000.1)
    assert not data.register(p,1000.2)
    p2=packet(1001,3);assert data.register(p2,1001.1);assert data.missing==1
    p3=packet(1000.5,4);assert not data.register(p3,1002)
    next_process=packet(1010,1);next_process.update(process_id='p2',source_started_at=1005,mission_started_at=1005)
    assert data.register(next_process,1010.1)
    assert not data.register(packet(1011,9),1011.1)

def test_state_extrapolation_stops_after_two_seconds_and_expires():
    r=record(packet());a=estimate(r,1000);b=estimate(r,1002,a);c=estimate(r,1005,b)
    assert a.quality=='valid' and c.quality=='stale'
    assert math.dist(a.position_ecef_m,b.position_ecef_m)==pytest.approx(40,abs=1)
    assert math.dist(b.position_ecef_m,c.position_ecef_m)<1e-6
    assert estimate(r,1031,c) is None

def test_mission_restart_marks_discontinuity_and_intent_is_separate():
    r=record(packet());a=estimate(r,1000);r['continuity']=2;r['packet']['mission_id']='flight2'
    b=estimate(r,1001,a);assert b.discontinuity and b.continuity_id!=a.continuity_id
    intent=prediction_intent(b,r);assert intent.mission_id=='flight2';assert len(intent.waypoints)==1

def test_covariance_weighted_altitude_rejects_barometer_outlier():
    r=record(packet());r['packet']['sensors']['gnss']['values']['altitude_ellipsoid_m']=200
    r['packet']['sensors']['barometer']['values']['altitude_ellipsoid_m']=202
    e=estimate(r,1000);assert 200<e.altitude_m<202
    r['packet']['sensors']['barometer']['values']['altitude_ellipsoid_m']=900
    assert estimate(r,1000).altitude_m==pytest.approx(200,abs=.001)

def test_clock_alignment_preserves_raw_sensor_time_and_corrects_navigation_age():
    r=record(packet());r['clock_offset_s']=.83
    entity=estimate(r,1001)
    assert entity.observation_time==pytest.approx(1000.83)
    assert r['packet']['sensors']['gnss']['sample_time']==1000
    assert entity.quality=='valid'
    assert estimate(r,1003).quality=='stale'

def test_live_input_switch_and_simulation_ownership():
    enabled=True;simulating=False
    feed=PhysicalInput('http://127.0.0.1:8770',lambda:enabled,lambda:simulating,{})
    feed.active=True;feed.records.register(packet(),1000.1)
    assert len(feed.entities(1001,()))==1
    enabled=False;assert feed.entities(1001,())==()
    enabled=True;simulating=True;assert feed.entities(1001,())==()

def test_received_track_never_connects_a_gnss_outage():
    feed=PhysicalInput('http://127.0.0.1',lambda:True,lambda:False,{})
    feed.active=True
    for sequence,at in enumerate((1000,1000.2,1000.4,1010,1010.2),1):
        p=packet(at,sequence);p['sensors']['gnss']['sequence']=sequence
        # Keep the new fix consistent with the fixture's 20 m/s north velocity.
        p['sensors']['gnss']['values']['latitude_deg']+=(at-1000)*20/111000
        feed.records.register(p,at+.1)
    track=feed.track('physical:UAM0001')
    assert len(track['points'])==2
    assert track['points'][0][3]==1010

def test_raw_records_are_copies_and_bounded():
    data=UamSensorRecords();p=packet();data.register(p,1000.1);p['sensors'].clear()
    assert data.read('physical:UAM0001')['packet']['sensors']
    for i in range(1,500):data.register(packet(1000+i*.1,i+1),1000+i*.1)
    assert len(data.history['physical:UAM0001'])==400

def test_publisher_control_protocol_and_origin_check():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from communication.web.physical_publisher_routes import create_publisher_router
    commands=[];app=FastAPI()
    def control(action):commands.append(action);return True
    app.include_router(create_publisher_router(status=lambda:{},telemetry=lambda a,p:{},plan=lambda:{},truth=lambda:{},control=control,page=lambda:''))
    with TestClient(app) as client:
        assert client.post('/api/v1/control',json={'action':'gnss_outage'}).status_code==200
        assert commands==['gnss_outage']
        assert client.post('/api/v1/control',json={'action':'restart'},headers={'origin':'https://foreign.example'}).status_code==403
        assert client.post('/api/v1/control',json={'action':'unknown'}).status_code==422
        assert client.post('/api/v1/control',content='invalid').status_code==422

def test_clock_probe_rejects_changed_source_generation():
    from communication.external.physical_uam import sample_clock
    import httpx,time
    class Client:
        async def get(self,*args,**kwargs):
            return httpx.Response(200,json={'process_id':'restarted','server_time':time.time()},request=httpx.Request('GET','http://localhost'))
    with pytest.raises(ValueError,match='generation'):
        asyncio.run(sample_clock(Client(),'http://localhost','old'))
