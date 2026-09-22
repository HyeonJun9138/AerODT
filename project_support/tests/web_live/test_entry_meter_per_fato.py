"""Arrivals are metered per landing pad, so a port with two of them takes two.

The entry meter spaces predicted terminal arrivals before an aircraft leaves
its stand. It used to key that spacing by the destination port alone, so a
vertiport laid out with F2 and F4 both for landing still admitted one arrival
every `entry_spacing_s` - the extra pad changed nothing. Keyed by the pad, two
arrivals to different pads go in side by side; two to the same pad are spaced
as before, and each pad's own timeline still decides whether the landing
itself is safe.
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


def test_separate_fatos_never_share_physical_occupancy_by_distance():
    e = engine()
    vp = 'VP2'
    layout = e._layout(vp)
    original = layout.get('fatos')
    try:
        layout['fatos'] = [{'id': 'F1', 'center_m': [0., 0.]},
                           {'id': 'F2', 'center_m': [.01, 0.]}]
        assert e._same_fato(vp, 'F1', 'F1')
        assert not e._same_fato(vp, 'F1', 'F2'), 'distance cannot merge distinct resources'
    finally:
        layout['fatos'] = original
        e.close()


def test_the_removed_adjacency_distance_is_not_on_the_psu_chart():
    psu = next(chart for chart in decision_policy.CHARTS if chart['id'] == 'psu')
    assert 'pad_adjacency_m' not in {p['id'] for p in psu['parameters']}
    assert 'pad_adjacency_m' not in decision_policy.validate({'psu': {'pad_adjacency_m': 5}})['psu']


def test_mixed_fato_departure_reserve_is_visible_and_controllable_on_the_psu_chart():
    psu = next(chart for chart in decision_policy.CHARTS if chart['id'] == 'psu')
    values = {item['id']:item for item in psu['parameters']}
    assert values['protect_departure_capacity']['default'] is True
    assert values['departure_fato_reserve_ratio']['default'] == .5
    assert values['departure_reserve_lookahead_s']['default'] == 300.
    validated=decision_policy.validate({'psu':{
        'protect_departure_capacity':False,
        'departure_fato_reserve_ratio':2,
        'departure_reserve_lookahead_s':10}})['psu']
    assert validated['protect_departure_capacity'] is False
    assert validated['departure_fato_reserve_ratio']==1
    assert validated['departure_reserve_lookahead_s']==30
