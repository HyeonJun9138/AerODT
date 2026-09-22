from copy import deepcopy
from types import SimpleNamespace

import pytest

from digital_twin.simulation import arrival_allocation, psu_sequencing as psu
from project_support.tests.web_live.test_fato_assignment import multi_engine


@pytest.fixture
def setup():
    e,original=multi_engine()
    e.policy['psu']['assign_gate_after_touchdown']=False
    e._at_final_gate=lambda aircraft:False
    a=e.aircraft['A1'];a.flight=dict(original,arrival_fato='F1');a.route=e.route(a.flight)
    e._prepare_waiting_route(a,e.time_s)
    r=e.psu.waiting.reservations['F1'];r['state']='holding'
    a.index=a.route.descent_index;a.phase='hold';a.pilot_active=True
    a.latitude,a.longitude,a.altitude=r['target'];a.speed_mps=a.climb_mps=0
    a.clearance=e.psu.request_arrival(flight_id='F1',vertiport='VP2',fato='F1',stand='G2',
        earliest_s=e.time_s+200,now_s=e.time_s)
    calls=[]
    e.pilots=SimpleNamespace(library=SimpleNamespace(arrival_reassignment_capable=True),
        replace_arrival=lambda aircraft,route:calls.append((aircraft,route)) or True)
    e._remaining_native=lambda aircraft:200.
    e.psu.pad('VP2','F1').hold(e.time_s,900,'late-blocker',psu.ARRIVAL)
    yield e,a,calls
    e.pilots=None;e.close()


def test_free_connected_fato_and_gate_replace_both_reservations_not_the_pose(setup):
    e,a,calls=setup;original=deepcopy(e.flights['F1'])
    pose=(a.latitude,a.longitude,a.altitude);old_route=a.route
    sequence=a.clearance.sequence
    assert arrival_allocation.review(e,a,e.time_s)
    assert calls and a.clearance.fato==a.route.arrival['fato']==a.flight['arrival_fato']!='F1'
    assert a.clearance.stand==a.route.arrival['gate']
    assert e.psu._stands.reservation('VP2',a.clearance.stand)=='F1'
    assert all(slot[2]!='F1' for slot in e.psu.pad('VP2','F1').slots)
    assert (a.latitude,a.longitude,a.altitude)==pose and a.clearance.sequence==sequence
    assert a.route.phases[:a.route.descent_index]==old_route.phases[:old_route.descent_index]
    assert e.flights['F1']==original
    assert not arrival_allocation.review(e,a,e.time_s+1)


def test_monitor_retries_when_resources_become_free_not_just_once(setup):
    e,a,calls=setup
    e.psu._stands.reserved.clear();a.clearance.stand=None
    for stand in e._stands_of('VP2'):e.psu.take_stand('VP2',stand,'parked-'+stand)
    assert not arrival_allocation.review(e,a,e.time_s)
    assert not calls
    e.psu.leave_stand('VP2','G4','parked-G4')
    assert not arrival_allocation.review(e,a,e.time_s+1), 'bounded refresh avoids busy scanning'
    assert arrival_allocation.review(e,a,e.time_s+5)
    assert a.clearance.stand=='G4' and len(calls)==1


@pytest.mark.parametrize('result',[False,'exception'])
def test_native_rejection_rolls_back_new_slots_and_stand(setup,result):
    e,a,calls=setup
    before=(a.flight,a.route,deepcopy(a.clearance.as_dict()),deepcopy(e.psu._stands.reserved))
    slots={pad:list(e.psu.pad('VP2',pad).slots) for pad in ['F1','F2','F3','F4']}
    def reject(*args):
        if result=='exception':raise RuntimeError('native rejected')
        return False
    e.pilots.replace_arrival=reject
    assert not arrival_allocation.review(e,a,e.time_s)
    assert before==(a.flight,a.route,a.clearance.as_dict(),e.psu._stands.reserved)
    assert slots=={pad:e.psu.pad('VP2',pad).slots for pad in slots}


@pytest.mark.parametrize('blocked',['committed','final','failed','unsupported','traffic','egress','reserved_stands'])
def test_unsafe_or_unavailable_bundles_never_change_native_route(setup,blocked):
    e,a,calls=setup
    if blocked=='committed':a.clearance.approach_started_s=e.time_s
    elif blocked=='final':e._at_final_gate=lambda _:True
    elif blocked=='failed':a.failed=True
    elif blocked=='unsupported':e.pilots.library.arrival_reassignment_capable=False
    elif blocked=='traffic':e.psu.waiting.transfer_clear=lambda *args:False
    elif blocked=='egress':e._gate_path_blockers=lambda *args,**kwargs:['blocked']
    elif blocked=='reserved_stands':
        for stand in e._stands_of('VP2'):e.psu._stands.reserved[('VP2',stand)]='other'
    assert not arrival_allocation.review(e,a,e.time_s)
    assert not calls and a.clearance.fato=='F1'


def test_only_landing_capable_pads_and_explicit_connected_terminal_branches_are_used(setup):
    from digital_twin.model_library import scheduled_route
    e,a,calls=setup
    path=['fato:VP1:F1','WP1','WP2','fato:VP2:F1']
    a.flight['route_path']=path
    e._supplied_routes[tuple(path)]=scheduled_route.resolve(e._network,path,path[0],path[-1])
    for pad in e._layout('VP2')['fatos']:
        if pad['id']=='F2':pad['role']='takeoff'
    e._network['links']=[link for link in e._network['links'] if link['to']!='fato:VP2:F3']
    assert arrival_allocation.review(e,a,e.time_s)
    assert a.clearance.fato=='F4'
    assert a.flight['route_path'][1:-1]==path[1:-1]


def test_busy_actual_pads_are_not_treated_as_free_empty_timelines(setup):
    e,a,calls=setup
    for pad in ['F1','F2','F3','F4']:e._active_pads[('VP2',pad)]='actual-'+pad
    assert not arrival_allocation.review(e,a,e.time_s)
    assert not calls


def test_small_estimated_gain_keeps_current_bundle_to_avoid_flapping(setup):
    e,a,calls=setup
    e.psu.pad('VP2','F1').release('late-blocker')
    e._retarget_arrival_gate(a,'G1')
    assert not arrival_allocation.review(e,a,e.time_s)
    assert not calls


def test_fato_specific_blocked_exit_can_choose_another_pad_to_the_same_free_gate(setup):
    e,a,calls=setup
    initial=tuple(a.route.phases[a.route.landing_index].points[-1])
    e._gate_path_blockers=lambda aircraft,phase,*args,**kwargs: ['blocked'] if tuple(phase.points[0])==initial else []
    assert arrival_allocation.review(e,a,e.time_s)
    assert a.clearance.fato!='F1'


def test_psu_transaction_retains_number_and_does_not_bypass_committed_clearance():
    s=psu.PsuSequencer(stands=lambda _:['G1','G2'])
    c=s.request_arrival(flight_id='f',vertiport='v',fato='F1',stand='G1',earliest_s=100,now_s=0)
    c.approach_started_s=1
    assert not s.reassign_arrival('f','F2','G2',100,2,lambda:pytest.fail('must not apply'))
    assert c.fato=='F1' and s._stands.reservation('v','G1')=='f'


def test_monitor_keeps_running_after_a_successful_reassignment(setup):
    e,a,calls=setup
    sequence=a.clearance.sequence
    assert arrival_allocation.review(e,a,e.time_s)
    first=a.clearance.fato
    e.psu.pad('VP2',first).hold(e.time_s,900,'another-late-blocker',psu.ARRIVAL)
    assert arrival_allocation.review(e,a,e.time_s+5)
    assert a.clearance.fato not in ('F1',first) and len(calls)==2
    assert a.clearance.sequence==sequence
    assert all(slot[2]!='F1' for slot in e.psu.pad('VP2',first).slots)


def test_traffic_check_is_per_pad_not_per_gate_but_refreshes_every_review(setup):
    e,a,calls=setup
    seen=[]
    e._terminal.blockers=lambda f,r,k:seen.append((f['arrival_fato'],r)) or []
    e.pilots.replace_arrival=lambda *args:False
    assert not arrival_allocation.review(e,a,e.time_s)
    assert len(seen)==4, 'the four gates on each pad share one airborne branch'
    assert not arrival_allocation.review(e,a,e.time_s+1)
    assert len(seen)==4
    e.psu.waiting.transfer_clear=lambda *args:False
    assert not arrival_allocation.review(e,a,e.time_s+5)
    assert len(seen)==8, 'traffic must be read again, never cached between reviews'
    assert a.clearance.fato=='F1'


def test_two_arrivals_cannot_claim_the_same_free_gate_in_one_decision_batch():
    s=psu.PsuSequencer(stands=lambda _:['G1','G2','G3'])
    a=s.request_arrival(flight_id='a',vertiport='v',fato='F1',stand='G1',earliest_s=100,now_s=0)
    b=s.request_arrival(flight_id='b',vertiport='v',fato='F2',stand='G2',earliest_s=100,now_s=0)
    assert s.reassign_arrival('a','F3','G3',100,5,lambda:True)
    with pytest.raises(ValueError):
        s.reassign_arrival('b','F4','G3',100,5,lambda:pytest.fail('reservation must fail before native'))
    assert a.stand=='G3' and b.stand=='G2' and b.fato=='F2'
    assert s._stands.reservation('v','G3')=='a'


def test_unchanged_periodic_reviews_do_not_flood_the_operations_log(setup):
    e,a,calls=setup
    e.psu.pad('VP2','F1').release('late-blocker')
    e._retarget_arrival_gate(a,'G1')
    for seconds in range(0,60,5):
        assert not arrival_allocation.review(e,a,e.time_s+seconds)
    events=[event for event in e.events if event.get('node')=='arrival_allocate']
    assert len(events)==1 and events[0]['chart_node']=='allocate'
