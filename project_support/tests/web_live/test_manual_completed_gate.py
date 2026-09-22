from project_support.tests.web_live.test_manual_arrival_authority import predict
from project_support.tests.web_live.test_manual_procedure import assigned, place
from project_support.tests.web_live.test_scenario_engine import row
from digital_twin.simulation import manual_takeover as manual, manual_procedure as procedure
from user_application.uam_mission.manual_ground import ManualGround


def test_reassigned_gate_survives_completion_poll_and_turnaround_sync():
    e,a=assigned(row('F1','A1','VP1','VP2','06:30:00',arrival_stand='G1'))
    manual.request(e,'A1','departure')
    dep=procedure.pad_point(e,a.flight,'departure');place(e,a,(dep[0],dep[1],dep[2]+100),True)
    e.policy['pilot']['arrival_request_lead_s']=1800
    manual.request(e,'A1','report_airborne');manual.request(e,'A1','arrival',eta_s=120)
    flight=dict(a.flight)
    assert flight['arrival_stand']=='G1'
    assert e._retarget_arrival_gate(a,'G2')
    predict(e,a);assert manual.request(e,'A1','approach')['state']=='granted'
    p=procedure.pad_point(e,a.flight,'arrival');place(e,a,(p[0],p[1],p[2]+15),True)
    assert manual.request(e,'A1','landing')['state']=='granted'
    place(e,a,p);assert manual.request(e,'A1','report_landed')['state']=='accepted'
    gate=e._stand_place(flight['destination'],'G2');place(e,a,gate)
    ground=ManualGround({'arrival':{'vertiport':flight['destination'],'gate':'G2'}})
    ground.sync_psu(manual.advisory(e,'A1'))
    assert manual.request(e,'A1','report_gate')['state']=='accepted'
    assert a.clearance is None and a.stand=='G2'
    assert a.unloading is None, 'gate report must not start automatic disembark'
    assert a.energy.parked_at is None and a.energy.charge_state=='disconnected'
    from digital_twin.simulation import scenario_energy
    before=a.battery_pct
    scenario_energy.advance(e,a,e.time_s+3600,3600)
    assert a.battery_pct==before and a.energy.connection is None
    assert a.energy.charge_power_kw==0
    pose=(a.latitude,a.longitude,a.altitude)
    for _ in range(3):
        advice=manual.advisory(e,'A1');p=advice['procedure']
        assert advice['arrival']['stand']==p['arrival_gate']=='G2'
        assert p['stage']=='도착 완료' and 'G2' in p['reason']
        assert '계획 출발' not in p['reason']
        ground.sync_psu(advice)
        assert ground.plan['arrival']['gate']=='G2' and ground.psu['reported']
        assert ground.notice is None
        manual.request(e,'A1','report_gate')
    assert a.completed==1 and (a.latitude,a.longitude,a.altitude)==pose
    assert e.flights[flight['flight_id']]['arrival_stand']=='G1'

    # Historical clearance absent: use observed completed stand, never original plan.
    e.psu._clearances.pop((flight['flight_id'],'arrival'))
    assert manual.advisory(e,'A1')['procedure']['arrival_gate']=='G2'


def test_gate_report_uses_ground_contact_not_the_unrelated_vertical_datum():
    e,a=assigned(row('F1','A1','VP1','VP2','06:30:00',arrival_stand='G1'))
    manual.request(e,'A1','departure')
    dep=procedure.pad_point(e,a.flight,'departure');place(e,a,(dep[0],dep[1],dep[2]+100),True)
    e.policy['pilot']['arrival_request_lead_s']=1800
    manual.request(e,'A1','report_airborne');manual.request(e,'A1','arrival',eta_s=120)
    predict(e,a);assert manual.request(e,'A1','approach')['state']=='granted'
    pad=procedure.pad_point(e,a.flight,'arrival');place(e,a,(pad[0],pad[1],pad[2]+15),True)
    assert manual.request(e,'A1','landing')['state']=='granted'
    place(e,a,pad);assert manual.request(e,'A1','report_landed')['state']=='accepted'
    gate=e._stand_place('VP2',a.clearance.stand)

    place(e,a,(gate[0]+10/111320,gate[1],gate[2]+64),speed=0)
    waiting=manual.advisory(e,'A1')['procedure']
    assert not waiting['next']['enabled'] and '10.0 m' in waiting['reason']

    # The rendered contact deck can be ellipsoid-referenced while the layout
    # height is local. A 64 m datum difference is not 64 m above the gate.
    place(e,a,(gate[0],gate[1],gate[2]+64),speed=0)
    ready=manual.advisory(e,'A1')['procedure']
    assert ready['next']=={'kind':'report_gate','label':'GATE 도착 보고','enabled':True}
    assert ready['reason']==''
    assert manual.request(e,'A1','report_gate')['state']=='accepted'


def test_gate_report_waits_for_a_complete_stop_and_says_why():
    e,a=assigned(row('F1','A1','VP1','VP2','06:30:00',arrival_stand='G1'))
    manual.request(e,'A1','departure')
    dep=procedure.pad_point(e,a.flight,'departure');place(e,a,(dep[0],dep[1],dep[2]+100),True)
    e.policy['pilot']['arrival_request_lead_s']=1800
    manual.request(e,'A1','report_airborne');manual.request(e,'A1','arrival',eta_s=120)
    predict(e,a);manual.request(e,'A1','approach')
    pad=procedure.pad_point(e,a.flight,'arrival');place(e,a,(pad[0],pad[1],pad[2]+15),True)
    manual.request(e,'A1','landing');place(e,a,pad);manual.request(e,'A1','report_landed')
    gate=e._stand_place('VP2',a.clearance.stand);place(e,a,gate,speed=.4)
    guidance=manual.advisory(e,'A1')['procedure']
    assert not guidance['next']['enabled']
    assert '완전히 정지' in guidance['reason'] and '0.4 m/s' in guidance['reason']


def test_completed_manual_aircraft_announces_and_accepts_its_next_scheduled_flight():
    e,a=assigned(
        row('F1','A1','VP1','VP2','06:30:00',arrival_stand='G2'),
        row('F2','A1','VP2','VP1','07:20:00',stand='G2',arrival_stand='G1'))
    manual.request(e,'A1','departure')
    dep=procedure.pad_point(e,a.flight,'departure');place(e,a,(dep[0],dep[1],dep[2]+100),True)
    e.policy['pilot']['arrival_request_lead_s']=1800
    manual.request(e,'A1','report_airborne');manual.request(e,'A1','arrival',eta_s=120)
    predict(e,a);assert manual.request(e,'A1','approach')['state']=='granted'
    pad=procedure.pad_point(e,a.flight,'arrival');place(e,a,(pad[0],pad[1],pad[2]+15),True)
    assert manual.request(e,'A1','landing')['state']=='granted'
    place(e,a,pad);assert manual.request(e,'A1','report_landed')['state']=='accepted'
    gate=e._stand_place('VP2',a.clearance.stand);place(e,a,gate)
    assert manual.request(e,'A1','report_gate')['state']=='accepted'

    advice=manual.advisory(e,'A1');upcoming=advice['next_flight']
    assert advice['completed'] and upcoming['flight_id']=='F2'
    assert upcoming['origin']=='VP2' and upcoming['destination']=='VP1'
    assert upcoming['target_soc_pct']>0 and advice['remaining_flights']==1

    ground=ManualGround({'arrival':{'vertiport':'VP2','gate':'G2'}})
    ground.sync_psu(advice)
    state=ground.snapshot(None,{})
    assert state['next_flight']['flight_id']=='F2' and state['flight_completed']

    assignment=manual.continue_flight(e,'A1',battery_pct=upcoming['target_soc_pct'])
    assert assignment['flight']['flight_id']=='F2'
    assert not a.external.get('completed') and not a.external['departed']
    fresh=manual.advisory(e,'A1')
    assert fresh['flight_id']=='F2' and fresh['next_flight'] is None and not fresh['completed']
