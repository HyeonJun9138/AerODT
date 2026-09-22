import pytest
from digital_twin.simulation import manual_takeover as manual, manual_procedure as procedure
from project_support.tests.web_live.test_manual_takeover import day
from project_support.tests.web_live.test_scenario_engine import row


def assigned(*rows):
    engine=day(*rows);manual.hand_over(engine,'A1')
    a=engine.aircraft['A1']
    manual.place(engine,'A1',latitude=a.latitude,longitude=a.longitude,altitude=a.altitude,
                 airborne=False,speed_mps=0)
    return engine,a


def place(engine,a,point,airborne=False,speed=0):
    manual.place(engine,a.aircraft_id,latitude=point[0],longitude=point[1],altitude=point[2],
                 airborne=airborne,speed_mps=speed)


def test_early_request_does_not_grant_movement_and_exposes_actual_schedule():
    e,a=assigned(row('F1','A1','VP1','VP2','06:40:00'))
    e.time_s=6*3600+30*60
    result=manual.request(e,'A1','departure')
    assert result['state']=='hold' and result['wait_s']==600
    assert a.flight is None and not a.external['departed']
    g=manual.advisory(e,'A1')['procedure']
    assert g['timeline']['off_block_s']==6*3600+40*60
    assert not g['next']['enabled']
    assert [x['kind'] for x in e.events][-2:]==['pilot_request','psu_response']
    assert g['communications'][-1]['reason']==result['reason']


def test_movement_permission_is_not_takeoff_and_reports_do_not_fabricate_motion():
    e,a=assigned();assert manual.request(e,'A1','departure')['state']=='granted'
    assert manual.advisory(e,'A1')['procedure']['stage']=='지상 이동 허가'
    assert manual.request(e,'A1','report_airborne')['state']=='refused'
    assert manual.request(e,'A1','takeoff')['state']=='hold'
    assert 'takeoff_cleared_s' not in a.external
    point=procedure.pad_point(e,a.flight,'departure');place(e,a,point)
    e.time_s=e.psu.clearance('F1','departure').cleared_s
    assert manual.request(e,'A1','takeoff')['state']=='granted'
    assert not a.airborne
    place(e,a,(point[0],point[1],point[2]+25),True)
    assert manual.request(e,'A1','report_airborne')['state']=='accepted'
    assert manual.request(e,'A1','report_airborne')['state']=='accepted'
    assert len([x for x in e.events if x['kind']=='takeoff'])==1
    assert manual.advisory(e,'A1')['procedure']['next']['kind']=='arrival'


def test_manual_pilot_enables_arrival_request_only_when_its_trigger_is_reached():
    e,a=assigned();manual.request(e,'A1','departure')
    dep=procedure.pad_point(e,a.flight,'departure')
    place(e,a,(dep[0],dep[1],dep[2]+100),True)
    manual.request(e,'A1','report_airborne')
    far=manual.advisory(e,'A1')['procedure']
    assert far['next']=={'kind':'arrival','label':'접근 순번 요청','enabled':False}
    assert manual.request(e,'A1','arrival')['state']=='hold'
    assert a.clearance is None

    arrival=procedure.pad_point(e,a.flight,'arrival')
    place(e,a,(arrival[0]+900/111320,arrival[1],arrival[2]+80),True)
    ready=manual.advisory(e,'A1')['procedure']
    assert ready['stage']=='접근 순번 요청 가능' and ready['next']['enabled']
    manual.advisory(e,'A1')
    assert len([x for x in e.events if x['kind']=='pilot_arrival_request_ready'])==1
    assert manual.request(e,'A1','arrival')['state'] in ('granted','holding')


def test_manual_nav_receives_the_exact_eta_used_to_enable_arrival_request():
    e,a=assigned();manual.request(e,'A1','departure')
    dep=procedure.pad_point(e,a.flight,'departure')
    place(e,a,(dep[0],dep[1],dep[2]+100),True)
    manual.request(e,'A1','report_airborne')
    guidance=manual.advisory(e,'A1')['procedure']
    decision=e._pilot_arrival_request_decision(a)
    timeline=guidance['timeline']
    assert timeline['remaining_route_eta_s']==decision['remaining_s']
    assert timeline['arrival_request_lead_s']==decision['lead_s']
    assert timeline['arrival_request_due']==decision['due']
    assert guidance['next']['enabled']==decision['due']


def test_grounded_fato_uses_horizontal_position_not_an_unrelated_altitude_datum():
    e,a=assigned();assert manual.request(e,'A1','departure')['state']=='granted'
    point=procedure.pad_point(e,a.flight,'departure')
    # The manual native contact deck can be ellipsoid-referenced while the
    # scenario layout height is local. Ground contact and horizontal FATO
    # position are authoritative; the 64 m datum offset is not physical height.
    place(e,a,(point[0],point[1],point[2]+64),airborne=False,speed=0)
    guidance=manual.advisory(e,'A1')['procedure']
    assert guidance['next']=={'kind':'takeoff','label':'FATO 도착 · 이륙 요청','enabled':True}
    assert guidance['reason']==''
    e.time_s=e.psu.clearance('F1','departure').cleared_s
    assert manual.request(e,'A1','takeoff')['state']=='granted'


def test_fato_guidance_distinguishes_position_motion_and_contact():
    e,a=assigned();manual.request(e,'A1','departure')
    point=procedure.pad_point(e,a.flight,'departure')
    place(e,a,(point[0]+20/111320,point[1],point[2]+64),speed=0)
    assert '20.0 m' in manual.advisory(e,'A1')['procedure']['reason']
    place(e,a,(point[0],point[1],point[2]+64),speed=1.2)
    assert '1.2 m/s' in manual.advisory(e,'A1')['procedure']['reason']
    place(e,a,(point[0],point[1],point[2]+64),airborne=True,speed=0)
    assert '접지 상태' in procedure.departure_stop_reason(e,a,a.flight)


def test_takeoff_reservation_waits_and_rechecks_other_pad_occupants():
    e,a=assigned();manual.request(e,'A1','departure')
    place(e,a,procedure.pad_point(e,a.flight,'departure'))
    c=e.psu.clearance('F1','departure')
    e.psu.pad(c.vertiport,c.fato).hold(e.time_s,60,'OTHER','departure')
    assert manual.request(e,'A1','takeoff')['state']=='hold'
    e.time_s=c.cleared_s
    original=e._departure_blockers;e._departure_blockers=lambda *args:[{'flight_id':'OTHER'}]
    assert manual.request(e,'A1','takeoff')['state']=='hold'
    assert 'takeoff_cleared_s' not in a.external
    e._departure_blockers=original


def test_arrival_slot_is_not_landing_permission_and_gate_report_uses_observation():
    e,a=assigned();manual.request(e,'A1','departure')
    dep=procedure.pad_point(e,a.flight,'departure');place(e,a,(dep[0],dep[1],dep[2]+100),True)
    e.policy['pilot']['arrival_request_lead_s']=1800
    manual.request(e,'A1','report_airborne')
    answer=manual.request(e,'A1','arrival',eta_s=120)
    assert answer['state']=='granted'
    assert manual.request(e,'A1','landing')['state']=='hold'
    assert manual.request(e,'A1','report_landed')['state']=='refused'
    e.time_s=a.clearance.cleared_s
    assert manual.request(e,'A1','landing')['state']=='hold'  # a slot alone is not authority
    e.psu.refresh_arrivals({'F1':{'eta_s':e.time_s+120,'remaining_s':120,'approach_ready':True}},e.time_s)
    assert manual.request(e,'A1','approach')['state']=='granted'
    arr=procedure.pad_point(e,a.flight,'arrival');place(e,a,(arr[0],arr[1],arr[2]+15),True)
    assert manual.request(e,'A1','landing')['state']=='granted'
    arr=procedure.pad_point(e,a.flight,'arrival');place(e,a,arr)
    assert manual.request(e,'A1','report_landed')['state']=='accepted'
    assert manual.request(e,'A1','report_gate')['state']=='refused'
    gate=e._stand_place(a.flight['destination'],a.clearance.stand);place(e,a,gate)
    before=(a.latitude,a.longitude,a.altitude)
    assert manual.request(e,'A1','report_gate')['state']=='accepted'
    assert (a.latitude,a.longitude,a.altitude)==before
    assert a.completed==1 and a.external['completed']
    assert manual.advisory(e,'A1')['procedure']['stage']=='도착 완료'
    manual.request(e,'A1','report_gate');assert a.completed==1
    assert any(x['kind']=='in_block' for x in e.events)


def test_stale_pose_prevents_new_permission_and_cannot_fake_a_report():
    e,a=assigned();manual.request(e,'A1','departure');a.external['pose_received']-=10
    assert not manual.advisory(e,'A1')['procedure']['next']['enabled']
    assert manual.request(e,'A1','takeoff')['state']=='hold'


def test_airborne_holding_away_from_final_is_not_a_violation():
    e,a=assigned();manual.request(e,'A1','departure')
    manual.request_arrival(e,'A1');a.clearance.state='holding'
    place(e,a,(a.latitude+.01,a.longitude,250),True)
    assert not any(x['kind']=='hold_ignored' for x in manual.check(e,'A1'))


def test_explicit_ground_stop_overrides_prior_movement_permission():
    e,a=assigned();manual.request(e,'A1','departure')
    a.instruction={'action':'ground_wait','reason':'교차 지상 경로 점유'}
    g=manual.advisory(e,'A1')['procedure']
    assert g['stage']=='지상 대기' and not g['next']['enabled']
    assert g['reason']=='교차 지상 경로 점유'


def test_turnaround_uses_reassigned_gate_and_waits_for_accepted_gate_report():
    from copy import deepcopy
    from project_support.tests.web_live.test_manual_ground import fixture
    g,s,command=fixture();original=deepcopy(g.plan)
    g.records['VP1']['layout']['gates'].append({'id':'G2','center_m':[15,0],'radius_m':6})
    p={'destination':'VP1','arrival_gate':'G2','arrival_fato':'F2','reports':{}}
    g.sync_psu({'procedure':p})
    assert g.plan['arrival']['gate']=='G2' and original['arrival']['gate']=='G1'
    assert not g.eligibility(s,command)[0]
    p['reports']['report_gate']=10;g.sync_psu({'procedure':p})
    assert 'G2' in g.eligibility(s,command)[1]
    s['position']['longitude']+=15/(111320*__import__('math').cos(__import__('math').radians(37)))
    assert g.eligibility(s,command)[0]
    g.sync_psu(None);assert not g.eligibility(s,command)[0]


def test_http_clock_resume_is_not_recorded_as_a_pilot_psu_exchange():
    from project_support.tests.web_live.test_manual_assignment import loaded,client_of
    session,_=loaded();client=client_of(session)
    assignment=client.post('/api/simulation/scenario/manual/assign',json={'vertiport':'VP1'}).json()
    target='/api/simulation/scenario/manual/'+assignment['aircraft_id']
    result=client.post(target+'/request',json={'kind':'resume_day'})
    assert result.status_code==200 and result.json()['state']=='accepted'
    assert result.json()['message_type']=='simulation_clock_command_result'
    advice=client.get(target).json();assert advice['clock']['state']=='playing'
    assert not any(item['kind']=='resume_day' for item in advice['procedure']['communications'])
    assert any(event['kind']=='simulation_clock_resumed' for event in session.engine.events)
    a=session.engine.aircraft[assignment['aircraft_id']]
    session.place_manual(a.aircraft_id,latitude=a.latitude,longitude=a.longitude,altitude=a.altitude,airborne=False,speed_mps=0)
    # A pose is posted to the day, not written into it: the tick that owns the
    # fleet applies it, which is what lets a cockpit send twenty a second
    # without waiting behind a tick walking every aircraft. The server ticks
    # at about 10 Hz, so a request arriving after one sees it; this harness
    # has no heartbeat, so it ticks the day itself.
    session.tick()
    result=client.post(target+'/request',json={'kind':'report_airborne'})
    assert result.status_code==200 and result.json()['state']=='refused'
    assert client.get(target).json()['procedure']['communications'][-1]['kind']=='report_airborne'


def test_initial_priority_does_not_invite_request_before_its_actual_time():
    e,a=assigned(row('F1','A1','VP1','VP2','06:37:06'))
    e.time_s=6*3600+31*60+7
    a.external['initial_priority_until_s']=6*3600+39*60+6
    g=manual.advisory(e,'A1')['procedure']
    assert g['stage']=='출발 시각 대기'
    assert g['text']=='출발 요청까지 5분 59초 · GATE 대기'
    assert g['next']['label']=='출발 요청 대기 · 5분 59초'
    assert not g['next']['enabled']
    assert '06:37:06' in g['reason']
    assert '재생 후' not in g['text']
    e.time_s=procedure.earliest_departure(e,a,e.flights['F1'])
    g=manual.advisory(e,'A1')['procedure']
    assert g['next']['enabled']
    assert g['next']['label']=='출발 준비 · 이동 요청'
    assert g['stage']!='출발 시각 대기'
