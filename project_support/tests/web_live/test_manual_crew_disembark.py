"""조종사가 기체에서 내려 데크에 서는 것.

Charging is the one moment it is safe: the passengers are off, the cable is on,
and the stick has been dead for the whole procedure (`locked`). Everything here
is about the two ways that can go wrong — leaving before it is safe, and the
aircraft being released with nobody in the seat.
"""
import unittest

from project_support.tests.web_live.test_manual_ground import fixture


def to_charging(ground, sample, command):
    """Run the procedure as a pilot does, up to the cable being on."""
    assert ground.request('disembark', 'd', sample, command)['accepted']
    sample['time_s'] = 10 + ground.operation['alighting_end_s'] + 1
    assert ground.request('charge', 'c', sample, command)['accepted']
    sample['time_s'] = 10 + ground.operation['charge_at_s'] + 1
    assert ground.snapshot(sample, command)['phase'] == 'charging'
    return ground.snapshot(sample, command)


class CrewDisembarkTests(unittest.TestCase):
    def test_nobody_gets_out_before_the_cable_is_on(self):
        g, s, c = fixture()
        self.assertFalse(g.request('crew_out', 'x', s, c)['accepted'], '절차 시작 전')
        self.assertTrue(g.request('disembark', 'd', s, c)['accepted'])
        for phase_time, why in ((10.5, 'opening'), (10 + g.operation['alighting_end_s'] - 1, 'alighting')):
            s['time_s'] = phase_time
            answer = g.request('crew_out', f'x{phase_time}', s, c)
            self.assertFalse(answer['accepted'], why)
            self.assertIn('충전', answer['message'])
        self.assertFalse(g.crew_outside)

    def test_charging_is_when_the_door_is_yours(self):
        g, s, c = fixture()
        state = to_charging(g, s, c)
        self.assertTrue(state['crew_can_leave'])
        self.assertFalse(state['crew_outside'])
        self.assertTrue(g.request('crew_out', 'o', s, c)['accepted'])
        self.assertTrue(g.crew_outside)
        after = g.snapshot(s, c)
        self.assertTrue(after['crew_outside'])
        self.assertFalse(after['crew_can_leave'], '이미 나가 있으면 다시 나갈 것이 없다')
        self.assertIn('데크에 내려 있음', after['label'])
        # The stick stays dead the whole time, which is what makes it safe.
        self.assertTrue(after['locked'])

    def test_the_door_says_where_to_step_down(self):
        g, s, c = fixture()
        state = to_charging(g, s, c)
        # Read from the airframe rather than invented here, so an aircraft with
        # its door on the other side puts the pilot on the other side.
        self.assertEqual(state['crew_door_m'], dict(g.door))
        self.assertTrue(all(k in state['crew_door_m'] for k in ('forward_m', 'right_m')))

    def test_the_aircraft_cannot_be_released_with_its_pilot_on_the_deck(self):
        g, s, c = fixture()
        to_charging(g, s, c)
        self.assertTrue(g.request('crew_out', 'o', s, c)['accepted'])
        refused = g.request('release', 'r', s, c)
        self.assertFalse(refused['accepted'])
        self.assertIn('조종석', refused['message'])
        # Back aboard, and it releases as it always did.
        self.assertTrue(g.request('crew_in', 'i', s, c)['accepted'])
        self.assertFalse(g.crew_outside)
        self.assertTrue(g.request('release', 'r2', s, c)['accepted'])

    def test_coming_back_when_you_never_left_is_refused_rather_than_silently_fine(self):
        g, s, c = fixture()
        to_charging(g, s, c)
        self.assertFalse(g.request('crew_in', 'i', s, c)['accepted'])

    def test_an_aircraft_that_strays_does_not_leave_a_pilot_marked_outside_it(self):
        # The procedure ends when the aircraft leaves its stand. The flag lives
        # on the operation, so it goes with it rather than outliving it.
        g, s, c = fixture()
        to_charging(g, s, c)
        self.assertTrue(g.request('crew_out', 'o', s, c)['accepted'])
        s['position']['longitude'] = 127.01
        state = g.snapshot(s, c)
        self.assertEqual(state['phase'], 'idle')
        self.assertFalse(g.crew_outside)

    def test_a_deck_with_no_charger_still_lets_the_pilot_out(self):
        # 'complete' is the same standing-on-a-stand state, reached where the
        # gate has no socket. Refusing there would strand a pilot for a reason
        # that has nothing to do with them.
        g, s, c = fixture()
        g.records['VP1']['layout']['chargers'] = []
        self.assertTrue(g.request('disembark', 'd', s, c)['accepted'])
        s['time_s'] = 10 + g.operation['alighting_end_s'] + 1
        self.assertEqual(g.snapshot(s, c)['phase'], 'complete')
        self.assertTrue(g.request('crew_out', 'o', s, c)['accepted'])
