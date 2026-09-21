import copy
import math
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from user_application.uam_mission.manual_ground import ManualGround
from user_application.uam_mission.manual_surfaces import contact_decks


def fixture(count=3):
    frame={'longitude':127.,'latitude':37.,'heading_deg':0}
    layout={'frame':frame,'gates':[{'id':'G1','center_m':[0,0],'radius_m':6}],
            'boarding_points':[{'id':'B1','gate':'G1','center_m':[12,8],'size_m':[4,4]}],
            'chargers':[{'id':'C1','gate':'G1','center_m':[8,-4],'radius_m':1}],
            'platform':{'corners_m':[[-30,-30],[30,-30],[30,30],[-30,30]]}}
    plan={'arrival':{'vertiport':'VP1','name':'테스트','gate':'G1'},'vehicle':{'passengers':count,'capacity':4}}
    decks=[([(-40,-40),(40,-40),(40,40),(-40,40)],0)]
    ground=ManualGround(plan,[{'id':'VP1','layout':layout}],decks,[127,37,80])
    s={'position':{'longitude':127,'latitude':37,'altitude_m':80},'airborne':False,'speed_mps':0,'rotor_radps':0,'time_s':10,'heading_deg':0}
    cmd={'throttle':0,'pitch':0,'roll':0,'yaw':0}
    return ground,s,cmd


class ManualGroundTests(unittest.TestCase):
    def test_blocks_airborne_moving_rotors_wrong_gate_and_below_deck(self):
        for field,value in [('airborne',True),('speed_mps',.3),('rotor_radps',10)]:
            g,s,c=fixture();s[field]=value;self.assertFalse(g.request('disembark','a',s,c)['accepted'])
        for field,value in [('altitude_m',60),('longitude',127.002)]:
            g,s,c=fixture();s['position'][field]=value;self.assertFalse(g.request('disembark','a',s,c)['accepted'])
        for key in ['throttle','roll','pitch','yaw']:
            g,s,c=fixture();c[key]=.2;self.assertFalse(g.request('disembark','a',s,c)['accepted'])

    def test_stages_pause_idempotence_count_charger_and_release(self):
        g,s,c=fixture();before=copy.deepcopy(s)
        self.assertTrue(g.request('disembark','same',s,c)['accepted']);op=copy.deepcopy(g.operation)
        s['time_s']=11;self.assertTrue(g.request('disembark','same',s,c)['accepted']);self.assertEqual(g.operation,op)
        self.assertFalse(g.request('disembark','different',s,c)['accepted'])
        state=g.snapshot(s,c);self.assertEqual(state['phase'],'opening');self.assertEqual(state['door_open'],.5)
        self.assertEqual(state,g.snapshot(s,c),'no wall-clock motion while paused')
        self.assertEqual(len(op['walk']['release_s']),3)
        self.assertEqual(len(op['walk']['path_altitudes_m']),len(op['walk']['path']))
        self.assertFalse(g.request('release','early',s,c)['accepted'])
        s['time_s']=op['start_s']+op['crew_start_s']+.1;self.assertEqual(g.snapshot(s,c)['phase'],'awaiting_charge')
        self.assertTrue(g.request('charge','charge',s,c)['accepted']);op=g.operation
        self.assertEqual(g.snapshot(s,c)['phase'],'connecting')
        s['time_s']=op['start_s']+op['charge_at_s']+1;state=g.snapshot(s,c);self.assertEqual(state['phase'],'charging');self.assertEqual(state['passengers_remaining'],0)
        self.assertTrue(g.request('release','end',s,c)['accepted']);self.assertTrue(g.locked)
        s['time_s']+=4;self.assertEqual(g.snapshot(s,c)['phase'],'closing');self.assertTrue(g.locked)
        s['time_s']+=1;self.assertEqual(g.snapshot(s,c)['phase'],'released');self.assertFalse(g.locked)
        self.assertEqual(s['position'],before['position'],'procedure never moves aircraft')

    def test_zero_passengers_and_missing_facility(self):
        g,s,c=fixture(0);self.assertTrue(g.request('disembark','empty',s,c)['accepted']);self.assertIsNone(g.operation['walk'])
        g,s,c=fixture();g.records['VP1']['layout']['boarding_points']=[]
        self.assertFalse(g.request('disembark','no-path',s,c)['accepted']);self.assertIsNone(g.operation)

class NativeGroundIntegrationTests(unittest.TestCase):
    def test_native_motion_locked_and_passengers_remain_zero_after_release(self):
        from communication.python.manual_runtime import ManualRuntime
        from user_application.uam_mission.manual_flight import ManualFlight
        g,s,zero=fixture(2);zero['flight_mode']='multirotor'
        plan={**g.plan,'totals':{'battery_start_pct':70}}
        with TemporaryDirectory() as directory:
            session=ManualFlight(plan,g.origin,ManualRuntime(),Path(directory),g.decks,records=list(g.records.values()))
            try:
                first=session.step(zero,25)
                self.assertTrue(session.ground_request('disembark','start')['accepted'])
                injected={'throttle':1,'roll':1,'pitch':1,'yaw':1,'flight_mode':'fixed_wing'}
                for _ in range(1500):
                    state=session.step(injected,25)
                    if state['ground_handling']['phase']=='awaiting_charge':
                        before_charge=session.battery
                        waiting=session.step(injected,25)
                        self.assertLessEqual(session.battery,before_charge)
                        self.assertIsNone(waiting['ground_handling']['crew_path'])
                        self.assertTrue(session.ground_request('charge','charge')['accepted'])
                    if state['ground_handling']['phase']=='charging':break
                self.assertEqual(state['ground_handling']['phase'],'charging')
                battery=session.battery
                state=session.step(injected,25)
                self.assertGreater(session.battery,battery)
                self.assertEqual(state['position'],first['position'])
                self.assertFalse(state['airborne']);self.assertEqual(state['passengers'],0)
                self.assertEqual(session.command['throttle'],0)
                self.assertTrue(session.ground_request('release','release')['accepted'])
                for _ in range(52):state=session.step(zero,25)
                self.assertEqual(state['ground_handling']['phase'],'released')
                self.assertEqual(state['passengers'],0)
                state=session.step(zero,25);self.assertEqual(state['passengers'],0)
            finally:session.close()

    def test_socket_ground_ack_pause_resume_and_duplicate(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from communication.web.manual_routes import create_manual_router
        g,s,zero=fixture();plan={**g.plan,'control_mode':'manual','legs':[{'path':[[127,37,80]]}],'totals':{'battery_start_pct':70}}
        class Plans:
            def get(self,key):return {'plan':plan}
            def ground_layouts(self):return list(g.records.values())
        with TemporaryDirectory() as directory:
            app=FastAPI();app.include_router(create_manual_router(Plans(),directory))
            with TestClient(app) as client,client.websocket_connect('/api/simulation/manual') as ws:
                ws.send_json({'plan_id':'test','altitude_m':80,'contact_decks':[{'height_m':80,'outline':[[126.999,36.999],[127.001,36.999],[127.001,37.001],[126.999,37.001]]}]})
                caps=ws.receive_json()['capabilities']
                self.assertIn('ground_handling_v1',caps);self.assertIn('ground_handling_v2',caps)
                ws.send_json({'type':'pause'});self.assertEqual(ws.receive_json()['type'],'paused')
                ws.send_json({'type':'ground','action':'disembark','request_id':'paused'});self.assertFalse(ws.receive_json()['accepted'])
                ws.send_json({'type':'resume'});self.assertEqual(ws.receive_json()['type'],'resumed')
                command={'type':'ground','action':'disembark','request_id':'begin'}
                ws.send_json(command);reply=ws.receive_json();self.assertTrue(reply['accepted']);self.assertEqual(reply['sample']['ground_handling']['phase'],'opening')
                ws.send_json(command);again=ws.receive_json();self.assertTrue(again['accepted']);self.assertEqual(again['sample']['ground_handling']['start_s'],reply['sample']['ground_handling']['start_s'])
                ws.send_json({'type':'stop'})



class TurnaroundRepeatTests(unittest.TestCase):
    """A finished turnaround must not be the last one of the flight."""

    def complete_one(self, g, s, c):
        self.assertTrue(g.request('disembark', 'first', s, c)['accepted'])
        op = g.operation
        s['time_s'] = op['start_s'] + op['alighting_end_s'] + 1
        self.assertEqual(g.snapshot(s,c)['phase'],'awaiting_charge')
        self.assertTrue(g.request('charge', 'charge-'+str(op['start_s']), s, c)['accepted'])
        s['time_s'] = op['start_s'] + op['charge_at_s'] + 1
        self.assertEqual(g.snapshot(s, c)['phase'], 'charging')
        self.assertTrue(g.request('release', 'go', s, c)['accepted'])
        s['time_s'] = g.operation['release_s'] + 6
        self.assertEqual(g.snapshot(s, c)['phase'], 'released')
        self.assertFalse(g.locked)

    def test_a_second_turnaround_can_be_started_and_charges_again(self):
        # The refusal used to test only whether an operation had ever been made,
        # so after one turnaround every later request was refused; `locked` was
        # false by then, so ManualFlight never ran its charging step again and
        # the pilot could neither disembark nor charge for the rest of the
        # session. Reported as "it will not start charging".
        g, s, c = fixture()
        self.complete_one(g, s, c)
        second = g.request('disembark', 'second', s, c)
        self.assertTrue(second['accepted'], second['message'])
        self.assertTrue(g.locked, 'the second turnaround must lock again so charging runs')
        op = g.operation
        s['time_s'] = op['start_s'] + op['alighting_end_s'] + 1
        self.assertEqual(g.snapshot(s,c)['phase'],'awaiting_charge')
        self.assertTrue(g.request('charge', 'charge-'+str(op['start_s']), s, c)['accepted'])
        s['time_s'] = op['start_s'] + op['charge_at_s'] + 1
        self.assertEqual(g.snapshot(s, c)['phase'], 'charging')

    def test_a_running_turnaround_is_still_refused_a_second_one(self):
        g, s, c = fixture()
        self.assertTrue(g.request('disembark', 'one', s, c)['accepted'])
        s['time_s'] = g.operation['start_s'] + 1
        again = g.request('disembark', 'two', s, c)
        self.assertFalse(again['accepted'])
        self.assertIn('이미', again['message'])

    def test_native_session_keeps_pose_and_battery_when_arming_the_next_plan(self):
        from communication.python.manual_runtime import ManualRuntime
        from user_application.uam_mission.manual_flight import ManualFlight
        g,s,c=fixture(2);c['flight_mode']='multirotor'
        first={**g.plan,'control_mode':'manual','legs':[{'path':[[127,37,80]]}],
               'totals':{'battery_start_pct':91},'vehicle':{'passengers':2,'capacity':4}}
        second={**first,'arrival':{'vertiport':'VP1','name':'테스트','gate':'G1'},
                'vehicle':{'passengers':3,'capacity':4}}
        with TemporaryDirectory() as directory:
            flight=ManualFlight(first,g.origin,ManualRuntime(),Path(directory),g.decks,
                                records=list(g.records.values()))
            try:
                flight.step(c,25);self.complete_one(flight.ground,flight.observation,c)
                # The helper advanced its own sample; make the connection-owned
                # observation carry the same completed procedure state.
                flight.observation['time_s']=flight.ground.operation['release_s']+6
                before=(dict(flight.observation['position']),flight.battery)
                sample=flight.continue_plan(second,{'flight_id':'F2','completed':False,
                    'procedure':{'destination':'VP1','arrival_gate':'G1','reports':{}},
                    'remaining_flights':1})
                self.assertEqual(sample['position'],before[0]);self.assertEqual(flight.battery,before[1])
                self.assertEqual(sample['passengers'],3);self.assertEqual(sample['stage_label'],'다음 비행 출발 준비')
            finally:flight.close()


class StrayedAircraftTests(unittest.TestCase):
    """A procedure is anchored to the pose it began at, so it ends with it."""

    def fly_away(self, s, metres):
        s['position']['longitude'] += metres / (111320 * math.cos(math.radians(37.)))

    def test_leaving_the_stand_ends_the_procedure_and_says_why(self):
        # Before this, the phases ran on a timer alone: flown away
        # mid-turnaround the passengers went on walking to an empty stand, the
        # crew went on carrying a cable to a socket no longer beside anything,
        # and the battery went on charging hundreds of metres from it - with
        # nothing said to the pilot.
        g, s, c = fixture()
        self.assertTrue(g.request('disembark', 'go', s, c)['accepted'])
        op = g.operation
        s['time_s'] = op['start_s'] + 1
        self.assertEqual(g.snapshot(s, c)['phase'], 'opening')
        self.fly_away(s, 300)
        s['time_s'] = op['start_s'] + 2
        state = g.snapshot(s, c)
        self.assertEqual(state['phase'], 'idle')
        self.assertFalse(state['locked'], 'the aircraft is not held by a procedure it has left')
        self.assertIn('GATE', state['reason'])
        # And it does not quietly reach the charging phase afterwards.
        s['time_s'] = op['start_s'] + op['charge_at_s'] + 1
        self.assertNotEqual(g.snapshot(s, c)['phase'], 'charging')

    def test_the_stand_can_be_used_again_after_coming_back(self):
        g, s, c = fixture()
        self.assertTrue(g.request('disembark', 'go', s, c)['accepted'])
        s['time_s'] = g.operation['start_s'] + 1
        self.fly_away(s, 300)
        s['time_s'] += 1
        g.snapshot(s, c)
        self.fly_away(s, -300)
        s['time_s'] += 1
        retry = g.request('disembark', 'back', s, c)
        self.assertTrue(retry['accepted'], retry['message'])

    def test_pose_jitter_on_the_stand_does_not_end_a_procedure(self):
        g, s, c = fixture()
        self.assertTrue(g.request('disembark', 'go', s, c)['accepted'])
        op = g.operation
        for step in (0.5, 1.0, 2.0, 3.0):
            self.fly_away(s, step)
            s['time_s'] = op['start_s'] + 1
            self.assertEqual(g.snapshot(s, c)['phase'], 'opening',
                             'a metre or two of settling is not leaving the stand')
            self.fly_away(s, -step)

    def test_the_reason_does_not_stay_on_the_readout_for_ever(self):
        from user_application.uam_mission.manual_ground import NOTICE_SECONDS
        g, s, c = fixture()
        self.assertTrue(g.request('disembark', 'go', s, c)['accepted'])
        s['time_s'] = g.operation['start_s'] + 1
        self.fly_away(s, 300)
        s['time_s'] += 1
        stopped = s['time_s']
        self.assertIn('GATE', g.snapshot(s, c)['reason'])
        s['time_s'] = stopped + NOTICE_SECONDS + 1
        later = g.snapshot(s, c)['reason']
        self.assertNotIn('GATE를 벗어나', later or '')




class StandReassignmentTests(unittest.TestCase):
    """A stand that moves under the pilot has to say so."""

    def advice(self, gate):
        return {'procedure': {'destination': 'VP1', 'arrival_gate': gate,
                              'reports': {'report_gate': {}}}}

    def test_a_changed_stand_is_announced_on_the_cockpit_readout(self):
        # PSU can re-sequence the stand at any moment and this used to rewrite
        # the plan without a word. The refusal a pilot then met named the new
        # stand, but nothing said it had changed, so flying to the stand they
        # were briefed on read as the aircraft being wrong.
        g, s, c = fixture()
        self.assertEqual(g.plan['arrival']['gate'], 'G1')
        g.sync_psu(self.advice('G2'))
        self.assertEqual(g.plan['arrival']['gate'], 'G2', 'the assignment still follows PSU')
        note = g.snapshot(s, c)['reason']
        self.assertIn('G1', note)
        self.assertIn('G2', note)

    def test_the_same_stand_repeated_says_nothing(self):
        g, s, c = fixture()
        for _ in range(5):
            g.sync_psu(self.advice('G1'))
        note = g.snapshot(s, c)['reason'] or ''
        self.assertNotIn('STAND', note, 'an unchanged assignment is not news')

    def test_a_running_procedure_is_not_re_pointed_underneath_itself(self):
        g, s, c = fixture()
        self.assertTrue(g.request('disembark', 'go', s, c)['accepted'])
        g.sync_psu(self.advice('G2'))
        self.assertEqual(g.plan['arrival']['gate'], 'G1',
                         'the stand is pinned once the passengers are walking')





class ExplicitChargingTests(unittest.TestCase):
    def test_indefinite_wait_has_open_door_but_no_crew_and_can_close_without_charging(self):
        g,s,c=fixture()
        self.assertFalse(g.request('charge','no-door',s,c)['accepted'])
        self.assertTrue(g.request('disembark','open',s,c)['accepted'])
        self.assertFalse(g.request('charge','too-early',s,c)['accepted'])
        s['time_s']+=3600
        state=g.snapshot(s,c)
        self.assertEqual(state['phase'],'awaiting_charge')
        self.assertEqual(state['door_open'],1)
        self.assertIsNone(state['crew_path'])
        self.assertEqual(state['passengers_remaining'],0)
        self.assertTrue(g.request('release','close',s,c)['accepted'])
        self.assertEqual(g.snapshot(s,c)['phase'],'closing')
        s['time_s']+=2
        self.assertEqual(g.snapshot(s,c)['phase'],'released')

    def test_charge_requires_safe_contact_and_is_idempotent(self):
        for field,value in [('airborne',True),('speed_mps',1),('rotor_radps',10)]:
            g,s,c=fixture();g.request('disembark','open',s,c);s['time_s']+=3600
            s[field]=value
            self.assertFalse(g.request('charge','unsafe',s,c)['accepted'])
        g,s,c=fixture();g.request('disembark','open',s,c);s['time_s']+=3600
        c['throttle']=.2
        self.assertFalse(g.request('charge','throttle',s,c)['accepted'])
        c['throttle']=0;s['position']['altitude_m']=60
        self.assertFalse(g.request('charge','under-deck',s,c)['accepted'])
        s['position']['altitude_m']=80
        self.assertTrue(g.request('charge','charge',s,c)['accepted'])
        op=copy.deepcopy(g.operation)
        s['time_s']+=1
        self.assertTrue(g.request('charge','charge',s,c)['accepted'])
        self.assertEqual(g.operation,op)
        self.assertFalse(g.request('charge','twice',s,c)['accepted'])
        self.assertEqual(g.snapshot(s,c)['phase'],'connecting')
        self.assertIsNotNone(g.snapshot(s,c)['crew_path'])

    def test_missing_charger_finishes_disembark_without_charge(self):
        g,s,c=fixture();g.records['VP1']['layout']['chargers']=[]
        g.request('disembark','open',s,c);s['time_s']+=3600
        self.assertEqual(g.snapshot(s,c)['phase'],'complete')
        self.assertFalse(g.request('charge','absent',s,c)['accepted'])
        self.assertTrue(g.request('release','close',s,c)['accepted'])

if __name__=='__main__':unittest.main()
