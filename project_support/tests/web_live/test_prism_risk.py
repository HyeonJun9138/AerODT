"""PRISM's observation contract, bounded history and read-only future output."""
from dataclasses import replace
import math
from pathlib import Path
import importlib.util
import sys
import threading
import time

import numpy as np
import pytest

from digital_twin.contracts.live import Snapshot, TwinEntity


def entity(name='own', t=0., east=0., north=0., altitude=100., **changes):
    # Equator/prime meridian makes ECEF -> ENU exact and readable.
    e=TwinEntity(name,name,'uam',(6378237.,east,north),None,
        math.degrees(north/6378237.),math.degrees(east/6378237.),altitude,0.,t,
        None,t,None,'simulated','nominal','scenario','uam','uam')
    return replace(e,**changes)


def snapshot(t, entities=None, epoch=0):
    return Snapshot(1,int(t*100),t,tuple(entities or [entity(t=t),entity('a',t,100+t*10)]),(),epoch)


def history():
    from data.simulation.risk_history import RiskHistory
    return RiskHistory()


def test_history_preserves_missing_detection_and_epoch_without_interpolation():
    h=history()
    for n in range(20):
        t=n*.5; h.observe(snapshot(t,[entity(t=t)]+([] if n==10 else [entity('a',t,100+t*10)])))
    rows=h.window('a',9.5)
    assert len(rows)==20 and rows[10] is None
    assert rows[9].position_ecef_m[1]==145
    assert rows[11].position_ecef_m[1]==155
    h.observe(snapshot(0,epoch=1))
    assert sum(x is not None for x in h.window('a',0))==1


def test_history_deduplicates_observation_and_bounds_dense_input():
    from data.simulation.risk_history import RiskHistory
    h=RiskHistory(max_entities=2)
    for n in range(1001):h.observe(snapshot(n*.01))
    assert len(h.entries)<=2 and all(len(x.samples)<=20 for x in h.entries.values())
    e=entity('a',20,observation_time=20,derivation='observed',source='adsb')
    h.observe(snapshot(20,[e]));h.observe(snapshot(20.5,[replace(e,state_time=20.5)]))
    assert h.window('a',20.5)[-1] is None
    h.observe(snapshot(21,[replace(e,state_time=21,observation_time=21,continuity_id=1)]))
    assert sum(x is not None for x in h.window('a',21))==1


def test_extrapolated_track_without_an_observation_pose_is_not_a_detection():
    h=history()
    e=entity('a',20,observation_time=19.8,derivation='estimated',source='adsb')
    h.observe(snapshot(20,[e]))
    assert all(row is None for row in h.window('a',20))


def test_active_selection_keeps_history_when_world_exceeds_storage_capacity():
    from ai_pnp.risk_prediction import RiskPredictionRunner
    from data.simulation.risk_history import RiskHistory
    r=RiskPredictionRunner(model_factory=FixedModel,availability=lambda:True)
    r.history=RiskHistory(max_entities=2)
    for n in range(21):
        t=n*.5;s=snapshot(t,[entity(t=t),entity('a',t,100+t*10),entity('b',t,200+t*10)])
        r.observe(s);out=r.predict(s,'own')
    assert len(r.history.entries)<=2
    assert len([x for x in r.history.window('own',10) if x is not None])==20
    assert out['tracks'][0]['status']=='ready'


def test_priority_history_lease_expires_and_stays_bounded():
    from data.simulation.risk_history import RiskHistory
    clock=[100.];h=RiskHistory(max_entities=2,clock=lambda:clock[0])
    h.observe(snapshot(0));h.lease(['own','a'],epoch=0)
    h.observe(snapshot(.5,[entity(t=.5),entity('a',.5,100),entity('b',.5,200)]))
    assert 'own' in h.entries and len(h.entries)==2
    clock[0]+=15.1
    h.observe(snapshot(1,[entity(t=1),entity('a',1,100),entity('b',1,200)]))
    assert 'own' not in h.entries
    wide=RiskHistory(clock=lambda:clock[0]);wide.observe(snapshot(0))
    wide.lease([str(i) for i in range(200)],epoch=0)
    assert len(wide._leases)<=128


def test_history_never_uses_later_observation_from_same_half_second_slot():
    h=history();h.observe(snapshot(9.5));h.observe(snapshot(9.7));h.observe(snapshot(9.9))
    early=h.window('a',9.5)[-1];middle=h.window('a',9.8)[-1];latest=h.window('a',9.9)[-1]
    assert early is not None and early.time==9.5
    assert middle is not None and middle.time<=9.8
    assert latest.time==9.9
    assert all(row is None or row.time<=9.4 for row in h.window('a',9.4))


@pytest.mark.parametrize('which',['own','a'])
@pytest.mark.parametrize('invalid',[{'quality':'stale'},{'quality':'invalid'},{'valid_until':9.4}])
def test_current_invalid_state_blocks_prediction_even_with_ready_cached_history(which,invalid):
    r=runner_ready();s=snapshot(9.5)
    assert r.predict(s,'own')['status']=='ready'
    bad=replace(s,entities=tuple(replace(e,**invalid) if e.entity_id==which else e for e in s.entities))
    out=r.predict(bad,'own')
    if which=='own':assert out['status']=='unavailable'
    track=out['tracks'][0]
    assert track['status']=='unavailable' and track['prediction'] is None


def test_features_match_original_observation_only_even_with_gaps():
    from digital_twin.model_library.prism_2d.features import build_features
    ep=episode()
    sample=build_features(ep,19,0,{'max_agents':10})
    assert sample['x'].shape==(10,20,13)
    assert sample['x'][0,7,2]==0 and sample['x'][0,7,10]>.0
    assert sample['x'][0,8,5]==0
    root=Path('D:/PRISM/modelTraining')
    if not root.exists():pytest.skip('optional read-only PRISM source parity')
    oldpath=list(sys.path);saved={k:v for k,v in sys.modules.items() if k=='common' or k.startswith('common.')}
    try:
        sys.path.insert(0,str(root))
        for k in saved:sys.modules.pop(k,None)
        spec=importlib.util.spec_from_file_location('_prism_reference_dataset',root/'data/dataset.py')
        module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
        expected=module.build_sample({**ep,'gt_type':np.array([6,6,6])},19,0,{'max_agents':10},with_labels=False)
        for key in ('x','agent_mask','frame'):np.testing.assert_array_equal(sample[key],expected[key])
    finally:
        sys.path[:]=oldpath
        for k in list(sys.modules):
            if k=='common' or k.startswith('common.'):sys.modules.pop(k,None)
        sys.modules.update(saved)


def episode():
    t=np.arange(20,dtype=float)[:,None]
    pos=np.zeros((20,3,2));pos[:,:,0]=t*3+np.array([100,200,-200]);pos[:,:,1]=t*2
    det=np.ones((20,3),bool);det[7,0]=False;det[2:8,1]=False
    pos[~det]=np.nan
    cov=np.broadcast_to(np.array([[100.,20.],[20.,225.]]),(20,3,2,2)).copy();cov[~det]=np.nan
    return {'obs_detected':det,'obs_pos':pos,'obs_R':cov,'obs_track_age':np.broadcast_to(t+1,(20,3)),
            'own_pos':np.column_stack((np.arange(20),np.zeros(20)))}


class FixedModel:
    calls=0
    batch_size=0
    def __init__(self,path):pass
    def predict_batch(self,samples):
        type(self).calls+=1;type(self).batch_size=len(samples)
        return [{'mu':np.tile([10.,0.],(3,30,1)),
            'covariance':np.tile([[4.,1.],[1.,9.]],(3,30,1,1)),
            'weights':[.5,.3,.2],'type_probabilities':[0,0,0,1,0,0,0]} for _ in samples]


def runner_ready(model=FixedModel):
    from ai_pnp.risk_prediction import RiskPredictionRunner
    r=RiskPredictionRunner(model_factory=model,availability=lambda:True)
    for n in range(20):r.observe(snapshot(n*.5))
    return r


def test_runner_ready_rotates_covariance_and_caches_without_runtime_mutation():
    FixedModel.calls=0;r=runner_ready();s=snapshot(9.5)
    result=r.predict(s,'own');assert result['status']=='ready'
    a=result['tracks'][0];p=a['prediction']['branches'][0]['points'][0]
    assert p['t_s']==.5 and p['east_m']==pytest.approx(205,abs=.001)
    assert p['north_m']==pytest.approx(0,abs=.001)
    assert (p['cov_ee'],p['cov_nn'],p['cov_en'])==pytest.approx((4,9,1),abs=.001)
    assert 'experimental' in str(result['provenance'])
    result['tracks'].clear();again=r.predict(s,'own')
    assert len(again['tracks'])==1 and FixedModel.calls==1
    assert s.entities[1].position_ecef_m[1]==195
    assert result['ownship']['continuity_id']==s.entities[0].continuity_id
    assert again['tracks'][0]['continuity_id']==s.entities[1].continuity_id


def test_northbound_frame_covariance_is_rotated_to_enu():
    from ai_pnp.risk_prediction import RiskPredictionRunner
    r=RiskPredictionRunner(model_factory=FixedModel,availability=lambda:True)
    for n in range(20):
        s=snapshot(n*.5,[entity(t=n*.5),entity('a',n*.5,100,n*5)])
        r.observe(s)
    p=r.predict(s,'own')['tracks'][0]['prediction']['branches'][0]['points'][0]
    assert (p['east_m'],p['north_m'])==pytest.approx((100,105),abs=.001)
    assert (p['cov_ee'],p['cov_nn'],p['cov_en'])==pytest.approx((9,4,-1),abs=.001)


def test_disabled_missing_model_history_stale_and_epoch_never_fake_predictions():
    from ai_pnp.risk_prediction import RiskPredictionRunner
    r=RiskPredictionRunner(availability=lambda:False)
    out=r.predict(snapshot(0),'own');assert out['status']=='unavailable'
    out=r.predict(snapshot(0),'own',enabled=False);assert out['status']=='disabled' and len(out['tracks'])==1
    r=runner_ready();out=r.predict(snapshot(20),'own');assert out['status']=='warming_up'
    r.observe(snapshot(0,epoch=2));assert r.predict(snapshot(0,epoch=2),'own')['status']=='warming_up'


def test_batch_limit_altitude_outside_and_unknown_are_visible():
    from ai_pnp.risk_prediction import RiskPredictionRunner
    r=RiskPredictionRunner(model_factory=FixedModel,availability=lambda:True)
    for n in range(20):
        t=n*.5;s=snapshot(t,[entity(t=t)]+[entity(str(i),t,100+i*10,altitude=None if i==19 else 100+i*30) for i in range(20)])
        r.observe(s)
    result=r.predict(s,'own',altitude_band_m=150)
    assert len(result['tracks'])==20 and FixedModel.batch_size==16
    assert result['tracks'][-1]['relative_altitude_m'] is None
    assert any(x['relative_altitude_m'] and x['relative_altitude_m']>150 for x in result['tracks'])


def test_catalog_and_real_artifact_safe_smoke():
    from digital_twin.model_library.prism_2d import catalog
    spec=catalog.describe_model();assert spec['model_id']=='prism_2d_v1'
    assert spec['installed'] and spec['source_run'].endswith('full5x_s6')
    torch=pytest.importorskip('torch')
    from ai_pnp.prism_model import PrismModel
    from digital_twin.model_library.prism_2d.features import build_features
    model=PrismModel(catalog.DEFAULT_PACKAGE)
    out=model.predict_batch([build_features(episode(),19,0,{'max_agents':10})])[0]
    assert out['mu'].shape==(3,30,2) and np.isfinite(out['mu']).all()
    assert sum(out['weights'])==pytest.approx(1.,abs=1e-6)
    assert np.linalg.eigvalsh(out['covariance']).min()>0


def test_inference_is_single_flight_for_simultaneous_same_snapshot():
    class SlowModel(FixedModel):
        calls=0
        def predict_batch(self,samples):time.sleep(.05);return super().predict_batch(samples)
    r=runner_ready(SlowModel);results=[]
    workers=[threading.Thread(target=lambda:results.append(r.predict(snapshot(9.5),'own'))) for _ in range(4)]
    for t in workers:t.start()
    for t in workers:t.join()
    assert len(results)==4 and SlowModel.calls==1


def test_bad_batch_never_leaves_partial_ready_prediction():
    class BadModel(FixedModel):
        def predict_batch(self,samples):
            out=super().predict_batch(samples);out[-1]['mu'][0,0,0]=math.nan;return out
    from ai_pnp.risk_prediction import RiskPredictionRunner
    r=RiskPredictionRunner(model_factory=BadModel,availability=lambda:True)
    for n in range(20):
        t=n*.5;s=snapshot(t,[entity(t=t),entity('a',t,100+t),entity('b',t,200+t)]);r.observe(s)
    out=r.predict(s,'own')
    assert out['status']=='unavailable'
    assert all(t['prediction'] is None for t in out['tracks'])


def test_unknown_altitude_heading_never_emit_nan_json():
    import json
    r=runner_ready()
    s=snapshot(9.5,[entity(t=9.5,heading_deg=math.nan),entity('a',9.5,195,altitude=math.nan)])
    out=r.predict(s,'own')
    assert out['ownship']['heading_deg'] is None
    assert out['tracks'][0]['altitude_m'] is None
    json.dumps(out,allow_nan=False)


def test_clock_rollback_same_epoch_does_not_reuse_old_future_cache():
    r=runner_ready();s=snapshot(9.5)
    assert r.predict(s,'own')['status']=='ready'
    r.observe(snapshot(0));r.observe(s)
    assert r.predict(s,'own')['status']=='warming_up'


def test_ported_network_equals_original_with_actual_weights():
    torch=pytest.importorskip('torch')
    root=Path('D:/PRISM/modelTraining')
    if not root.exists():pytest.skip('optional read-only PRISM source parity')
    from ai_pnp.prism_model import PrismModel
    from digital_twin.model_library.prism_2d import catalog
    from digital_twin.model_library.prism_2d.features import build_features
    oldpath=list(sys.path);saved={k:v for k,v in sys.modules.items() if k=='common' or k.startswith('common.')}
    try:
        sys.path.insert(0,str(root))
        for k in saved:sys.modules.pop(k,None)
        spec=importlib.util.spec_from_file_location('_prism_reference_network',root/'model/network.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        checkpoint=torch.load(catalog.DEFAULT_PACKAGE/'model.pt',map_location='cpu',weights_only=True)
        original=module.PrismPredictor(checkpoint['model_cfg']).eval();original.load_state_dict(checkpoint['model'])
        port=PrismModel(catalog.DEFAULT_PACKAGE)
        sample=build_features(episode(),19,0,{'max_agents':10})
        x=torch.from_numpy(sample['x'][None]);mask=torch.from_numpy(sample['agent_mask'][None])
        with torch.inference_mode():
            expected=original(x,mask);actual=port.model(x,mask)
        for key in expected:torch.testing.assert_close(actual[key],expected[key],rtol=0,atol=0)
    finally:
        sys.path[:]=oldpath
        for k in list(sys.modules):
            if k=='common' or k.startswith('common.'):sys.modules.pop(k,None)
        sys.modules.update(saved)
