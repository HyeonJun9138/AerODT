"""Route building keeps what does not change: the air graph of a network and
the taxi profile of a path. Kept exactly: what callers may write into is a copy."""
from digital_twin.model_library import flight_plan, ground_motion, scheduled_route
from project_support.tests.web_live.test_scenario_engine import NETWORK


def test_air_graph_is_built_once_per_network_and_provisional_nodes_do_not_leak(monkeypatch):
    built = []
    original = flight_plan._air_graph
    monkeypatch.setattr(flight_plan, '_air_graph', lambda network: (built.append(id(network)), original(network))[1])
    flight_plan._AIR_GRAPHS.clear()
    first = flight_plan.air_graph(NETWORK)
    second = flight_plan.air_graph(NETWORK)
    assert built == [id(NETWORK)]
    assert first[0] == second[0] and first[2] == second[2] and first[1] is second[1]
    assert first[0] is not second[0] and first[2] is not second[2]
    # What one caller adds is its own.
    first[0]['provisional:x'] = (0., 0.)
    assert 'provisional:x' not in flight_plan.air_graph(NETWORK)[0]
    # A different network object is a different graph.
    other = dict(NETWORK)
    flight_plan.air_graph(other)
    assert built == [id(NETWORK), id(other)]
    # The same route resolves the same way through the kept graph.
    start, end = 'fato:VP1:F1', 'fato:VP2:F2'
    path = flight_plan.air_path(NETWORK, start, end)
    assert path is not None and path['nodes'][0] == start and path['nodes'][-1] == end
    assert flight_plan.air_path(NETWORK, start, end) == path


def test_taxi_profile_is_built_once_per_path_and_aligned_copies_stay_apart(monkeypatch):
    built = []
    original = ground_motion._prepare
    monkeypatch.setattr(ground_motion, '_prepare', lambda *args: (built.append(args), original(*args))[1])
    ground_motion._PROFILES.clear()
    points = [(37.5, 126.9), (37.5003, 126.9), (37.5003, 126.9004)]
    a = ground_motion.prepare(points, 4.0, 30.0)
    b = ground_motion.prepare(list(points), 4.0, 30.0)
    assert len(built) == 1
    assert a[0] == b[0] and a[1] == b[1] and a[2] == b[2] and a[3] == b[3]
    assert a[0] is not b[0] and a[1] is not b[1]
    leg = {'ground_motion': a[1], 'duration_s': a[3]}
    ground_motion.align_start(leg, 90.0)
    assert 'heading_alignment' in a[1] and 'heading_alignment' not in b[1]
    # Writing into one profile's lists reaches neither the other nor the next.
    a[1]['times_s'][0] = -1.0
    a[1]['headings_deg'][0] = -1.0
    fresh = ground_motion.prepare(points, 4.0, 30.0)[1]
    assert b[1]['times_s'][0] == 15.0 == fresh['times_s'][0] and b[1]['headings_deg'][0] == fresh['headings_deg'][0] != -1.0
    # Another speed is another profile; a degenerate path is answered as before.
    ground_motion.prepare(points, 2.0, 30.0)
    assert len(built) == 2
    assert ground_motion.prepare([(37.5, 126.9)], 4.0, 30.0) == ([(37.5, 126.9)], None, 0.0, 30.0)

