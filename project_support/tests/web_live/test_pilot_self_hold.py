"""Turning the pilot's own waiting off leaves PSU's holds as the only ones left.

An aircraft that keeps waiting is the commonest thing to have to explain, and
the engine reaches its answer by ORing four sources together - PSU permission,
the pilot's own traffic call, terminal reservations and stand egress. Whichever
of them is true first, the aircraft stops, and the screen says only that it is
waiting. This switch removes one of the four so the question can be answered by
elimination: turn it off, and any wait still standing is PSU's.
"""
from digital_twin.simulation import decision_policy
from user_application.uam_mission.traffic_awareness import TrafficAwareness


def approaching(sequence_a=2, sequence_b=1):
    """Two arrivals converging on one deck, close enough to call a conflict."""
    own = dict(aircraft_id='A', latitude_deg=37.0, longitude_deg=127.0, altitude_m=300,
               phase='descent', route_phase='descent', heading_deg=0, speed_mps=30,
               sequence=sequence_a, right_room_m=0)
    ahead = dict(own, aircraft_id='B', latitude_deg=37.0 + 60 / 111320, speed_mps=8,
                 sequence=sequence_b)
    return [own, ahead]


def test_the_follower_waits_for_the_leader_while_the_switch_is_on():
    # The behaviour the switch is turned off *from*: a following arrival stops
    # on its own because the aircraft ahead of it in the PSU order is slower.
    command = TrafficAwareness().commands(approaching(), decision_policy.defaults()['pilot'], 0)['A']
    assert command['action'] == 'yield'
    assert command['traffic_id'] == 'B'


def test_with_it_off_the_pilot_reports_the_traffic_and_does_not_stop():
    policy = dict(decision_policy.defaults()['pilot'], pilot_self_hold=False)
    command = TrafficAwareness().commands(approaching(), policy, 0)['A']
    # Every pilot-side wait in the engine is reached through one of these two.
    assert command['action'] not in ('yield', 'wait_clear')
    # It still saw the traffic and still says which aircraft, so the manoeuvre
    # that did not happen is visible in the record rather than silently gone.
    assert command['traffic_id'] == 'B'
    assert '조종사 자율 대기 꺼짐' in command['reason']


def test_an_aircraft_already_yielding_is_released_rather_than_pinned():
    # The branch that keeps a stopped follower yielding across ticks reads its
    # own previous answer. Left alone it would hold an aircraft there forever
    # after the switch was thrown - the one aircraft the operator is watching.
    rows = approaching()
    rows[0].update(phase='hold', speed_mps=0)
    awareness = TrafficAwareness()
    awareness.previous = {'A': {'action': 'yield', 'observed_s': 0}}
    on = awareness.commands(rows, decision_policy.defaults()['pilot'], 1)
    assert on['A']['action'] == 'yield'

    awareness = TrafficAwareness()
    awareness.previous = {'A': {'action': 'yield', 'observed_s': 0}}
    off = awareness.commands(rows, dict(decision_policy.defaults()['pilot'], pilot_self_hold=False), 1)
    assert off.get('A', {}).get('action') not in ('yield', 'wait_clear')


def test_avoidance_and_the_wait_are_separate_switches():
    # Not stopping is not the same as not looking. With self-hold off the pilot
    # still keeps its distance laterally and by speed; turning avoidance off is
    # the heavier act and still does what it did.
    cruising = [dict(aircraft_id='A', latitude_deg=37.0, longitude_deg=127.0, altitude_m=300,
                     phase='cruise', heading_deg=0, speed_mps=45, right_room_m=35),
                dict(aircraft_id='B', latitude_deg=37.0 + 400 / 111320, longitude_deg=127.0,
                     altitude_m=300, phase='cruise', heading_deg=0, speed_mps=20)]
    policy = dict(decision_policy.defaults()['pilot'], pilot_self_hold=False)
    assert TrafficAwareness().commands(cruising, policy, 0)['A']['action'] == 'avoid_right'
    silent = dict(policy, traffic_avoidance=False)
    assert TrafficAwareness().commands(cruising, silent, 0) == {}


def test_the_switch_is_on_the_pilot_chart_and_defaults_to_what_the_code_did():
    pilot = next(chart for chart in decision_policy.CHARTS if chart['id'] == 'pilot')
    entry = next(p for p in pilot['parameters'] if p['id'] == 'pilot_self_hold')
    assert entry['default'] is True, 'a diagnostic switch must not change the day by existing'
    assert entry['kind'] == 'toggle' and entry['scope'] == 'live'
    assert entry['node'] in {node['id'] for node in pilot['nodes']}
    assert decision_policy.validate({'pilot': {'pilot_self_hold': False}})['pilot']['pilot_self_hold'] is False
