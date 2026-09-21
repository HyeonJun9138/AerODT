"""Known-error demonstration, independent truth oracle and legacy isolation."""
from copy import deepcopy
import math
import pytest
from digital_twin.simulation.physical_sensors import PhysicalSensors
from digital_twin.live_twin.sensor_calibration import calibrate_record,calibration_detail
from digital_twin.live_twin.uam_sensor_fusion import estimate
from communication.external.physical_uam import validate_packet
from project_support.tests.web_live.test_physical_uam import MODEL,state,packet,record
from project_support.tests.web_live.test_physical_console import saved


def demo(at=1000,latitude=37.55,heading=359):
    truth=state();truth.update(latitude_deg=latitude,heading_deg=heading)
    sampler=PhysicalSensors(dict(MODEL,sensor_profile='known_bias_v1'))
    p=packet(at);p['samples']=sampler.sample(truth,0,at,'cruise');p['sensors']=sampler.latest
    return truth,p


@pytest.mark.parametrize('latitude',[-80,0,37.55,80])
def test_known_bias_inversion_uses_observations_only_and_preserves_raw(latitude):
    truth,p=demo(latitude=latitude);validate_packet(p,1000.1);r=record(p);before=deepcopy(r)
    raw=p['sensors']['gnss']['values']
    assert (raw['latitude_deg']-latitude)*111320==pytest.approx(3,abs=1e-8)
    assert (raw['longitude_deg']-127)*111320*math.cos(math.radians(latitude))==pytest.approx(-2,abs=1e-8)
    assert raw['altitude_ellipsoid_m']==204
    fixed=calibrate_record(r)['aligned_sensors'];g=fixed['gnss']['values']
    assert g['latitude_deg']==pytest.approx(latitude,abs=1e-12)
    assert g['longitude_deg']==pytest.approx(127,abs=1e-12)
    assert g['altitude_ellipsoid_m']==200
    assert g['velocity_ned_mps']==list(truth['velocity_ned_mps'])
    assert fixed['ahrs']['values']['heading_deg']==359
    assert fixed['barometer']['values']['altitude_ellipsoid_m']==200
    assert fixed['gnss']['sample_time']==1000
    assert r==before
    assert calibrate_record(calibrate_record(r))==calibrate_record(r)


def test_calibrated_observation_feeds_real_twin_estimator_without_truth():
    truth,p=demo();r=record(p);twin=estimate(r,1000)
    assert twin.altitude_m==pytest.approx(truth['altitude_m'],abs=1e-5)
    assert twin.latitude_deg==pytest.approx(truth['latitude_deg'],abs=1e-10)
    assert twin.heading_deg==pytest.approx(359)
    detail=calibration_detail(r)
    assert detail['status']=='applied' and detail['sample_time']==1000
    assert detail['removed_position_bias_m']==pytest.approx(math.sqrt(29))
    assert detail['truth_error_m'] is None
    assert estimate(r,1003,twin).quality=='stale'


def test_profile_change_resets_only_the_sensor_estimation_continuity():
    r=record(packet());old=estimate(r,1000)
    _,p=demo(1000.2);new=estimate(record(p),1000.2,old)
    assert new.discontinuity and new.estimation.gnss_outliers==0
    assert new.continuity_id==old.continuity_id


def test_live_profile_change_keeps_sensor_clocks_and_regenerates_all_sensors():
    model=dict(MODEL);s=PhysicalSensors(model);s.sample(state(),0,1000,'cruise')
    oldseq=s.sequence.copy();model['sensor_profile']='known_bias_v1'
    s.sample(state(),.01,1000.01,'cruise')
    assert all(x.get('calibration_profile')=='known_bias_v1' for x in s.latest.values())
    assert all(s.sequence[k]>v for k,v in oldseq.items())
    model['sensor_profile']='stochastic';s.sample(state(),.02,1000.02,'cruise')
    assert all('calibration_profile' not in x for x in s.latest.values())


def test_legacy_noise_is_not_labeled_exact_and_unknown_calibration_is_rejected():
    r=record(packet());assert calibrate_record(r) is r
    assert calibration_detail(r)['status']=='stochastic'
    r['packet']['sensors']['gnss']['calibration_profile']='unknown_v2'
    with pytest.raises(ValueError):validate_packet(r['packet'],1000.1)
    assert estimate(r,1000) is None


def test_example_is_explicitly_synthetic_and_computes_its_error_from_reference():
    from user_application.apps.web_dashboard.calibration_example import example
    e=example()
    assert e['source']=='synthetic_example' and len(e['points'])==41
    assert e['max_reconstruction_error_m']<1e-7
    assert len({p['corrected']['latitude_deg'] for p in e['points']})==41
    assert len({p['corrected']['altitude_ellipsoid_m'] for p in e['points']})>30


def test_profile_control_is_local_validated_and_never_issues_flight_control():
    import asyncio,httpx
    from fastapi import FastAPI
    from communication.web.physical_publisher_routes import create_publisher_router
    from digital_twin.model_library.sensor_calibration import validate_profile
    calls=[]
    def apply(value):calls.append(validate_profile(value));return {'sensor_profile':value,'flight_restarted':False}
    def flight_control(*args):raise AssertionError('No flight control allowed')
    app=FastAPI();app.include_router(create_publisher_router(status=lambda:{},telemetry=lambda *a:{},plan=lambda:{},truth=lambda:{},control=flight_control,page=lambda:'',sensor_profile=apply))
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app,client=('127.0.0.1',1234)),base_url='http://localhost') as c:
            r=await c.put('/api/v1/sensor-profile',json={'profile':'known_bias_v1'})
            assert r.status_code==200 and r.json()['flight_restarted'] is False
            assert (await c.put('/api/v1/sensor-profile',json={'profile':'bad'})).status_code==422
            assert (await c.put('/api/v1/sensor-profile',content=b'x'*513)).status_code==422
            assert (await c.put('/api/v1/sensor-profile',json={'profile':'stochastic'},headers={'Origin':'https://elsewhere.example'})).status_code==403
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app,client=('192.0.2.5',1234)),base_url='http://localhost') as c:
            assert (await c.put('/api/v1/sensor-profile',json={'profile':'stochastic'})).status_code==403
    asyncio.run(run());assert calls==['known_bias_v1']


def test_profile_setter_keeps_execution_and_process_identity():
    from types import SimpleNamespace
    from user_application.apps.physical_uam.execution import PhysicalExecution
    execution=object.__new__(PhysicalExecution);execution.model=dict(MODEL);execution.logger=None
    current=SimpleNamespace(process_id='running',status={'status':'running'});execution.current=current
    execution.set_sensor_profile('known_bias_v1')
    assert execution.current is current and execution.process_id=='running'
    assert current.status=={'status':'running'}
    assert execution.model['sensor_profile']=='known_bias_v1'


def test_physical_app_persists_profile_for_next_start_without_starting_a_flight(tmp_path,monkeypatch,saved):
    import asyncio,httpx,json
    import user_application.apps.physical_uam.__main__ as app_module
    monkeypatch.setattr(app_module,'NativePilotLibrary',lambda:None)
    path=tmp_path/'flight.json';path.write_text(json.dumps(saved),encoding='utf-8')
    app=app_module.create_app(path,autostart=False,workspace=tmp_path/'workspace')
    prior=app.state.flight.current;process=app.state.flight.process_id
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app,client=('127.0.0.1',1234)),base_url='http://localhost') as c:
            assert (await c.get('/api/v1/status')).json()['sensor_profile']=='stochastic'
            assert (await c.put('/api/v1/sensor-profile',json={'profile':'known_bias_v1'})).status_code==200
            assert (await c.get('/api/v1/status')).json()['sensor_profile']=='known_bias_v1'
    asyncio.run(run())
    assert app.state.flight.current is prior and app.state.flight.process_id==process
    assert app.state.flight.commands.empty()
    reopened=app_module.create_app(path,autostart=False,workspace=tmp_path/'workspace')
    assert reopened.state.flight.model['sensor_profile']=='known_bias_v1'
