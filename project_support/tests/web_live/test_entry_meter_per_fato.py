"""Arrivals are metered per landing pad, so a port with two of them takes two.

The entry meter spaces predicted terminal arrivals before an aircraft leaves
its stand. It used to key that spacing by the destination port alone, so a
vertiport laid out with F2 and F4 both for landing still admitted one arrival
every `entry_spacing_s` - the extra pad changed nothing. Keyed by the pad, two
arrivals to different pads go in side by side; two to the same pad are spaced
as before, and the pad timeline and adjacent-pad check still decide whether
the landing itself is safe.
"""
from digital_twin.simulation import decision_policy
from digital_twin.simulation.scenario_engine import ScenarioEngine
from project_support.tests.web_live.test_scenario_engine import schedule_of, row, VERTIPORTS, NETWORK


def engine(policy=None):
    return ScenarioEngine(schedule_of(row('F', 'A', 'VP1', 'VP2', '06:30:00'),
                                      row('G', 'B', 'VP1', 'VP2', '06:30:00', stand='G3', arrival_stand='G4')),
                          vertiports=VERTIPORTS, network=NETWORK, elevation=lambda lon, lat: 0, policy=policy)


def two_pads(e):
    a, b = e.aircraft.values()
    f, g = e.flights.values()
    first, second = e.route(f), e.route(g)
    # The second flight was allocated the port's other landing pad.
    second.arrival = dict(second.arrival or {}, fato='F4')
    return a, b, f, g, first, second


def test_two_arrivals_to_two_landing_pads_go_in_side_by_side():
    e = engine()
    try:
        a, b, f, g, first, second = two_pads(e)
        assert e._meter_arrival_entry(a, f, first, e.time_s)
        assert e._meter_arrival_entry(b, g, second, e.time_s), 'a different pad is a different queue'
        assert e._entry_forecasts['F']['key'] == ('VP2', 'F2')
        assert e._entry_forecasts['G']['key'] == ('VP2', 'F4')
    finally:
        e.close()


def test_two_arrivals_to_the_same_pad_are_still_spaced():
    e = engine()
    try:
        a, b = e.aircraft.values()
        f, g = e.flights.values()
        first, second = e.route(f), e.route(g)
        assert e._meter_arrival_entry(a, f, first, e.time_s)
        assert not e._meter_arrival_entry(b, g, second, e.time_s), 'same pad: the second waits its interval'
        spacing = max(e.policy['psu']['entry_spacing_s'], 2 * e.policy['psu']['approach_headway_s'])
        assert e._entry_forecasts['G']['entry_s'] - e._entry_forecasts['F']['entry_s'] >= spacing - 1e-6
    finally:
        e.close()


def test_the_switch_puts_the_whole_port_back_in_one_queue():
    e = engine(policy=decision_policy.validate({'psu': {'entry_per_fato': False}}))
    try:
        a, b, f, g, first, second = two_pads(e)
        assert e._meter_arrival_entry(a, f, first, e.time_s)
        assert not e._meter_arrival_entry(b, g, second, e.time_s), 'one queue per port, as it was'
        assert e._entry_forecasts['F']['key'] == ('VP2',)
    finally:
        e.close()


def test_the_switch_sits_on_the_entry_meter_and_defaults_on():
    psu = next(chart for chart in decision_policy.CHARTS if chart['id'] == 'psu')
    entry = next(p for p in psu['parameters'] if p['id'] == 'entry_per_fato')
    assert entry['default'] is True and entry['kind'] == 'toggle' and entry['node'] == 'entry_meter'
    assert decision_policy.validate({'psu': {'entry_per_fato': False}})['psu']['entry_per_fato'] is False


def test_pads_a_deck_apart_are_adjacent_only_within_the_psu_distance():
    """Found live: the adjacency test borrowed the pilot's 120 m en-route
    distance, so on a four-FATO deck laid out 36 m apart every pad closed every
    other and nothing could happen twice at once."""
    e = engine()
    vp = 'VP2'
    layout = e._layout(vp)
    # The layout is the fixture's own object; its pads go back afterwards.
    original = layout.get('fatos')
    try:
        layout['fatos'] = [{'id': 'F1', 'center_m': [0., 0.]}, {'id': 'F2', 'center_m': [36., 0.]},
                           {'id': 'F3', 'center_m': [72., 0.]}, {'id': 'F4', 'center_m': [108., 0.]}]
        e.policy['pilot']['traffic_horizontal_m'] = 120.
        e.policy['psu']['pad_adjacency_m'] = 50.
        assert e._nearby_pads(vp, 'F1', 'F1')
        assert e._nearby_pads(vp, 'F1', 'F2'), '36 m: one pad in use closes its neighbour'
        assert not e._nearby_pads(vp, 'F1', 'F3'), '72 m: the far pair may work together'
        assert not e._nearby_pads(vp, 'F2', 'F4')
        # Without the PSU number the old borrowed one still applies.
        del e.policy['psu']['pad_adjacency_m']
        assert e._nearby_pads(vp, 'F1', 'F4'), '108 m is inside the pilot\'s 120 m'
    finally:
        layout['fatos'] = original
        e.close()


def test_the_adjacency_distance_is_on_the_psu_chart():
    psu = next(chart for chart in decision_policy.CHARTS if chart['id'] == 'psu')
    entry = next(p for p in psu['parameters'] if p['id'] == 'pad_adjacency_m')
    assert entry['default'] == 50. and entry['node'] == 'land'
    assert decision_policy.validate({'psu': {'pad_adjacency_m': 5}})['psu']['pad_adjacency_m'] == 10, 'clamped to its floor'
