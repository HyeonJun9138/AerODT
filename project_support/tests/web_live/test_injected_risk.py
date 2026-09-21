import pytest
from test_prism_risk import snapshot, runner_ready


def payload(epoch=0):
    return {'epoch':epoch,'tracks':[{'entity_id':'intruder:test:drone:1','kind':'drone',
        'samples':[[t,6378237.,100+t,0.] for t in (8.5,9.,9.5)]}]}


def test_short_injected_track_predicts_and_keeps_original_world_unchanged():
    runner=runner_ready(); world=snapshot(9.5)
    result=runner.predict_injected(world,'own',payload())
    track=next(t for t in result['tracks'] if t['entity_id']=='intruder:test:drone:1')
    assert track['prediction'] is not None
    assert 'injected_test_state' in result['provenance']['input_basis']
    assert not any(e.entity_id.startswith('intruder:') for e in world.entities)
    normal=runner.predict(world,'own')
    assert not any(t['entity_id'].startswith('intruder:') for t in normal['tracks'])


@pytest.mark.parametrize('change',[lambda p:p.update(epoch=4),
    lambda p:p['tracks'][0].update(entity_id='own'),
    lambda p:p['tracks'][0].update(samples=[[99,6378237,0,0]]),
    lambda p:p['tracks'][0].update(samples=[[9,0,0,0]]),
    lambda p:p['tracks'][0].update(samples=[[9,6378237,0,0],[8,6378237,0,0]])])
def test_rejects_invalid_epoch_identity_position_and_time(change):
    runner=runner_ready(); p=payload();change(p)
    with pytest.raises(ValueError):runner.predict_injected(snapshot(9.5),'own',p)


def test_two_slots_wait_and_missing_samples_are_not_filled():
    runner=runner_ready(); p=payload();p['tracks'][0]['samples'].pop(1)
    result=runner.predict_injected(snapshot(9.5),'own',p)
    track=next(t for t in result['tracks'] if t['entity_id'].startswith('intruder:'))
    assert track['prediction'] is None
    assert '3' in track['reason']


def test_short_network_delay_does_not_require_a_report_in_exact_server_slot():
    runner=runner_ready();runner.observe(snapshot(10.))
    result=runner.predict_injected(snapshot(10.),'own',payload())
    track=next(t for t in result['tracks'] if t['entity_id'].startswith('intruder:'))
    assert track['prediction'] is not None


def test_post_route_connects_injection_and_rejects_cross_origin_and_oversized_body():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from communication.web.risk_routes import create_risk_router
    runner=runner_ready();world=snapshot(9.5);app=FastAPI()
    app.include_router(create_risk_router(lambda own,**kw:runner.predict(world,own,**kw),
        lambda:{'radius_m':3000,'horizon_s':15,'altitude_band_m':150},lambda _:None,lambda:{},
        predict_injected=lambda own,body,**kw:runner.predict_injected(world,own,body,**kw)))
    with TestClient(app) as c:
        url='/api/prediction/risk?entity_id=own'
        result=c.post(url,json=payload())
        assert result.status_code==200
        assert result.json()['tracks'][-1]['prediction'] is not None
        assert c.post(url,json=payload(),headers={'Origin':'https://evil.example'}).status_code==403
        assert c.post(url,content=b'x'*65537).status_code==413
        assert c.post(url,json=payload(3)).status_code==422
        assert not any(t['entity_id'].startswith('intruder:') for t in c.get(url).json()['tracks'])
