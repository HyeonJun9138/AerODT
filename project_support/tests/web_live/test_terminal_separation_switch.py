"""Crossing-route pre-blocking can be switched off without touching the rest.

"이륙 경로와 접근 경로 분리 대기" is this one check: a departure owns the volume
its climb passes through, and an arrival whose approach crosses it waits - not
for the pad, not for a stand, but for the route. On a deck whose two FATOs sit
close together it fires constantly, and the hold it produces looks exactly like
every other hold on the screen. Turning it off leaves pad occupancy, landing
headway and stand egress deciding, so what is left can be read for what it is.
"""
from digital_twin.simulation import decision_policy
from digital_twin.simulation.terminal_reservations import TerminalReservations


def flight(identifier, origin='VP015', destination='VP001', departure='F1', arrival='F2'):
    return {'flight_id': identifier, 'origin': origin, 'destination': destination,
            'departure_fato': departure, 'arrival_fato': arrival}


class Phase:
    def __init__(self, stage, points):
        self.stage, self.points = stage, points


class Route:
    """Enough of a route for the reservation service: the volume it passes.

    Only the climb-out and the descent are protected volumes, so those are the
    stages the stub carries.
    """
    def __init__(self, stage, points):
        self.phases = [Phase(stage, points)]
        self.key = (stage, tuple(points))


def crossing():
    """A departure climbing out of VP015 F1 and an arrival descending across it."""
    up = Route('climb', [(37.5200, 127.0000, 0.0), (37.5210, 127.0000, 300.0)])
    across = Route('descent', [(37.5205, 126.9990, 320.0), (37.5205, 127.0010, 60.0)])
    return up, across


def test_a_crossing_climb_and_approach_block_each_other_while_it_is_on():
    up, across = crossing()
    book = TerminalReservations(120.0, 45.0)
    book.acquire(flight('OUT'), up, 'departure')
    blocked = book.blockers(flight('IN', origin='VP001', destination='VP015',
                                   departure='F1', arrival='F2'), across, 'arrival')
    assert blocked, 'the behaviour the switch is turned off from'
    assert blocked[0]['flight_id'] == 'OUT'
    assert blocked[0]['operation'] == 'departure'


def test_with_it_off_nothing_is_held_for_crossing_a_route():
    up, across = crossing()
    book = TerminalReservations(120.0, 45.0, enabled=False)
    book.acquire(flight('OUT'), up, 'departure')
    assert book.blockers(flight('IN', origin='VP001', destination='VP015',
                                departure='F1', arrival='F2'), across, 'arrival') == []
    # The claim is still made and can still be released, so nothing leaks and
    # the geometry stays available to whatever else reads it.
    assert book.claims, 'movements are still recorded, they just stop blocking'
    assert book.release('OUT', 'departure')
    assert not book.claims


def test_the_distances_still_describe_the_volume_they_always_did():
    # The two distances are only consulted while it is on, but they remain what
    # the holding-bay geometry elsewhere reads, so turning the check off must
    # not blank them.
    book = TerminalReservations(120.0, 45.0, enabled=False)
    assert (book.horizontal_m, book.vertical_m) == (120.0, 45.0)


def test_the_switch_is_on_the_psu_chart_at_the_branch_that_produces_the_wait():
    psu = next(chart for chart in decision_policy.CHARTS if chart['id'] == 'psu')
    entry = next(p for p in psu['parameters'] if p['id'] == 'terminal_separation')
    assert entry['default'] is True, 'a switch must not change the day by existing'
    assert entry['kind'] == 'toggle' and entry['scope'] == 'live'
    # The node it hangs on is the one whose "no" branch is the wait in question.
    branch = next(node for node in psu['nodes'] if node['id'] == entry['node'])
    assert branch['no'] == 'terminal_hold'
    assert decision_policy.validate({'psu': {'terminal_separation': False}})['psu']['terminal_separation'] is False


def test_turning_it_off_leaves_every_other_psu_rule_where_it_was():
    values = decision_policy.validate({'psu': {'terminal_separation': False}})['psu']
    defaults = decision_policy.defaults()['psu']
    moved = {k for k in defaults if values[k] != defaults[k]}
    assert moved == {'terminal_separation'}, f'only this one may move: {moved}'


def test_right_hand_research_assumption_skips_only_mixed_airborne_route_overlap():
    up, across = crossing()
    book = TerminalReservations(120,45,assume_mixed_separated=True)
    book.acquire(flight('OUT'),up,'departure')
    incoming=flight('IN',origin='VP001',destination='VP015')
    assert book.blockers(incoming,across,'arrival') == []
    assert book.overlap(up,'departure',across,'arrival') is None
    assert book.blockers(flight('OUT2'),up,'departure'), 'same-direction conflicts remain'
    assert book.claims and book.release('OUT','departure')


def test_engine_defaults_to_explicit_right_hand_assumption_without_disabling_pad_checks():
    from project_support.tests.web_live.test_fato_assignment import multi_engine
    engine, flight_plan = multi_engine()
    try:
        assert engine.policy['psu']['assume_mixed_separated'] is True
        assert engine._terminal.assume_mixed_separated is True
        engine._active_pads[(flight_plan['origin'],flight_plan['departure_fato'])]='occupied'
        assert any(b.get('reason')=='pad_occupied' for b in engine._departure_blockers(flight_plan,engine.route(flight_plan)))
    finally:
        engine.close()


def test_distinct_fatos_can_share_an_approach_wp_but_same_pad_still_queues():
    up, _ = crossing()
    book=TerminalReservations(120,45,assume_distinct_fatos_separated=True)
    book.acquire(flight('A',departure='F1'),up,'departure')
    assert book.blockers(flight('B',departure='F3'),up,'departure') == []
    assert book.blockers(flight('C',departure='F1'),up,'departure')
    assert book.blockers(flight('D',origin='OTHER',departure='F3'),up,'departure'), 'unrelated ports do not share this assumption'
