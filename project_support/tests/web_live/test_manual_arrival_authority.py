import pytest
from project_support.tests.web_live.test_manual_procedure import assigned, place
from digital_twin.simulation import manual_takeover as manual, manual_procedure as procedure


def airborne():
    e,a=assigned();manual.request(e,'A1','departure')
    p=procedure.pad_point(e,a.flight,'departure');place(e,a,(p[0],p[1],p[2]+100),True)
    manual.request(e,'A1','report_airborne');manual.request(e,'A1','arrival',eta_s=120)
    return e,a


def predict(e,a):
    e.psu.refresh_arrivals({a.flight['flight_id']:{'eta_s':e.time_s+120,'remaining_s':120,'approach_ready':True}},e.time_s)


def test_moving_touchdown_forecast_does_not_block_explicit_approach():
    e,a=airborne()
    for _ in range(3):
        e.time_s+=60;predict(e,a)
        g=manual.advisory(e,'A1')['procedure']
        assert g['next']=={'kind':'approach','label':'접근 허가 요청','enabled':True}
        assert '착륙 슬롯까지' not in g['reason']
    assert manual.request(e,'A1','landing')['state']=='hold'
    assert manual.request(e,'A1','approach')['state']=='granted'
    assert a.clearance.approach_started_s==e.time_s
    g=manual.advisory(e,'A1')['procedure']
    assert g['stage']=='접근 허가' and '최종 하강 금지' in g['text']
    assert g['next']['kind']=='landing' and not g['next']['enabled']


def test_final_request_uses_position_and_actual_resources_not_own_future_slot():
    e,a=airborne();predict(e,a);manual.request(e,'A1','approach')
    p=procedure.pad_point(e,a.flight,'arrival');place(e,a,(p[0],p[1],p[2]+15),True)
    predict(e,a)
    assert a.clearance.cleared_s>e.time_s
    assert manual.request(e,'A1','landing')['state']=='granted'
    assert manual.advisory(e,'A1')['procedure']['stage']=='착륙 허가'


@pytest.mark.parametrize('block',['queue','terminal','gate','pad','slot','observed','egress','stale'])
def test_conflicts_and_stale_pose_still_block_permissions(block):
    e,a=airborne();predict(e,a)
    if block=='queue':
        e._queue_return_clear=lambda a:False
        assert manual.request(e,'A1','approach')['state']=='hold';return
    manual.request(e,'A1','approach')
    p=procedure.pad_point(e,a.flight,'arrival');place(e,a,(p[0],p[1],p[2]+15),True)
    if block=='terminal':e._terminal.blockers=lambda *args:[{'flight_id':'OTHER'}]
    if block=='gate':e.psu._stands.by_stand[(a.clearance.vertiport,a.clearance.stand)]='OTHER'
    if block=='pad':e._active_pads[(a.clearance.vertiport,a.clearance.fato)]='OTHER'
    if block=='slot':e.psu.pad(a.clearance.vertiport,a.clearance.fato).hold(e.time_s,90,'OTHER','arrival')
    if block=='observed':e.psu.pad(a.clearance.vertiport,a.clearance.fato).observed.append((e.time_s-1,'OTHER','departure'))
    if block=='egress':
        e.ground_control=True
        e._gate_path_blockers=lambda *args,**kwargs:['TAXI']
    if block=='stale':a.external['pose_received']-=10
    assert manual.request(e,'A1','landing')['state']=='hold'
    assert not manual.advisory(e,'A1')['procedure']['next']['enabled']


def test_future_approach_is_a_real_wait_and_old_denial_does_not_linger():
    e,a=airborne();predict(e,a);a.clearance.approach_s=e.time_s+60
    assert manual.request(e,'A1','approach')['state']=='hold'
    assert not manual.advisory(e,'A1')['procedure']['next']['enabled']
    predict(e,a)
    g=manual.advisory(e,'A1')['procedure']
    assert g['next']['enabled'] and '60초' not in g['reason']


def test_hold_revokes_approach_and_landing_permissions():
    e,a=airborne();predict(e,a);manual.request(e,'A1','approach')
    manual.request(e,'A1','hold')
    assert a.clearance.approach_started_s is None
    assert 'landing_cleared_s' not in a.external
    assert manual.request(e,'A1','landing')['state']=='hold'


def test_predecessor_headway_and_actual_pad_release_are_not_bypassed():
    e,a=airborne();predict(e,a);c=a.clearance
    from copy import copy
    other=copy(c);other.flight_id='OTHER';other.approach_started_s=e.time_s-1
    other.cleared_s=e.time_s-1;other.stand='G_OTHER'
    e.psu._clearances[('OTHER','arrival')]=other
    g=manual.advisory(e,'A1')['procedure']
    assert not g['next']['enabled'] and '간격' in g['reason']
    assert manual.request(e,'A1','approach')['state']=='hold'
    e.time_s+=e.policy['psu']['approach_headway_s'];predict(e,a)
    assert manual.request(e,'A1','approach')['state']=='granted'
    p=procedure.pad_point(e,a.flight,'arrival');place(e,a,(p[0],p[1],p[2]+15),True)
    answer=manual.request(e,'A1','landing')
    assert answer['state']=='hold' and '선행 기체' in answer['reason']
    other.released_s=e.time_s
    assert manual.request(e,'A1','landing')['state']=='granted'


def test_final_permission_rechecks_new_conflict_and_never_fabricates_touchdown():
    e,a=airborne();predict(e,a);manual.request(e,'A1','approach')
    p=procedure.pad_point(e,a.flight,'arrival');place(e,a,(p[0],p[1],p[2]+15),True)
    manual.request(e,'A1','landing')
    e._active_pads[(a.clearance.vertiport,a.clearance.fato)]='OTHER'
    g=manual.advisory(e,'A1')['procedure']
    assert g['stage']=='착륙 허가 보류' and not g['next']['enabled']
    assert 'landing_cleared_s' not in a.external
    assert manual.request(e,'A1','report_landed')['state']=='refused'


def test_request_is_idempotent_and_does_not_move_the_aircraft():
    e,a=airborne();predict(e,a)
    pose=(a.latitude,a.longitude,a.altitude)
    assert manual.request(e,'A1','approach')['state']=='granted'
    started=a.clearance.approach_started_s
    e.time_s+=1
    assert manual.request(e,'A1','approach')['state']=='granted'
    assert a.clearance.approach_started_s==started
    assert (a.latitude,a.longitude,a.altitude)==pose


def test_approach_request_is_available_over_existing_http_endpoint():
    from project_support.tests.web_live.test_manual_assignment import loaded,client_of
    session,_=loaded();e,a=airborne();predict(e,a)
    session.engine=e
    client=client_of(session)
    response=client.post('/api/simulation/scenario/manual/A1/request',json={'kind':'approach'})
    assert response.status_code==200 and response.json()['state']=='granted'
    answer=client.get('/api/simulation/scenario/manual/A1').json()
    assert answer['procedure']['version']==2
    assert answer['procedure']['next']['kind']=='landing'
