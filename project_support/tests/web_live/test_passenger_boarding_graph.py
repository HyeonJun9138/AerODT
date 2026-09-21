"""The passengers' walk across a deck is worked out once per deck, not per flight.

Profiling a 306-pair day put 81 of 81 seconds in this module: every plan
rebuilt the whole visibility graph of the deck's shelters and cabinets - tens
of thousands of segment tests - although the deck is the same for every flight
that uses it. The graph is now per deck geometry and the finished walk per
deck, stand and approach; a plan only ever joins its own two ends to a graph
that already exists. The answers are the same, to the metre and the second.
"""
import math
import time

from digital_twin.model_library import passenger_boarding as pb


def brute_route(start, end, obstacles, bounds):
    """The original algorithm, kept here as the oracle."""
    import heapq
    def inside(p):
        return bounds[0] <= p[0] <= bounds[2] and bounds[1] <= p[1] <= bounds[3]
    points = [start, end]
    for x, y, X, Y in obstacles:
        points.extend(p for p in ((x, y), (x, Y), (X, y), (X, Y)) if inside(p))
    edges = [[] for _ in points]
    for i, a in enumerate(points):
        for j in range(i):
            b = points[j]
            if not any(pb.crosses(a, b, box) for box in obstacles):
                distance = math.dist(a, b)
                edges[i].append((j, distance)); edges[j].append((i, distance))
    queue, best, parents = [(0, 0)], {0: 0}, {}
    while queue:
        cost, i = heapq.heappop(queue)
        if cost > best[i]:
            continue
        if i == 1:
            ids = [1]
            while ids[-1] != 0:
                ids.append(parents[ids[-1]])
            return [points[k] for k in reversed(ids)]
        for j, step in edges[i]:
            if cost + step < best.get(j, math.inf):
                best[j], parents[j] = cost + step, i
                heapq.heappush(queue, (cost + step, j))
    raise ValueError('no path')


def length(points):
    return sum(math.dist(a, b) for a, b in zip(points, points[1:]))


def deck(count=12):
    """A deck with `count` shelters and cabinets scattered on it."""
    obstacles = []
    for k in range(count):
        x, y = -40 + (k % 4) * 26, -30 + (k // 4) * 24
        obstacles.append((x - 2.2, y - 1.7, x + 2.2, y + 1.7))          # shelter
        obstacles.append((x + 6 - 1.2, y - 1.2, x + 6 + 1.2, y + 1.2))  # cabinet
    return obstacles, (-60.0, -45.0, 60.0, 45.0)


def test_the_graph_route_finds_the_same_length_walk_as_the_full_search():
    obstacles, bounds = deck()
    pb._GRAPHS.clear()
    for start, end in [((-55., -40.), (55., 40.)), ((-55., 0.), (0., 42.)), ((10., -44.), (-58., 30.)), ((0., 0.), (1., 1.))]:
        expected = brute_route(start, end, obstacles, bounds)
        got = pb.route(start, end, obstacles, bounds)
        assert got[0] == start and got[-1] == end
        assert abs(length(got) - length(expected)) < 1e-9, f'{length(got)} vs {length(expected)}'
        # And it never cuts through anything.
        for a, b in zip(got, got[1:]):
            assert not any(pb.crosses(a, b, box) for box in obstacles)


def test_the_deck_graph_is_built_once_and_a_walk_then_costs_only_its_own_two_ends():
    obstacles, bounds = deck()
    pb._GRAPHS.clear()
    calls = {'n': 0}
    original = pb.crosses
    def counting(a, b, box):
        calls['n'] += 1
        return original(a, b, box)
    pb.crosses = counting
    try:
        pb.route((-55., -40.), (55., 40.), obstacles, bounds)
        first = calls['n']
        calls['n'] = 0
        pb.route((-50., 30.), (50., -30.), obstacles, bounds)
        second = calls['n']
    finally:
        pb.crosses = original
    assert len(pb._GRAPHS) == 1
    # Two ends against every corner is a small fraction of every corner
    # against every other corner.
    assert second < first / 8, f'{second} tests after the graph exists, {first} to build it'


def test_out_of_bounds_ends_are_refused_before_any_graph_is_built():
    obstacles, bounds = deck()
    pb._GRAPHS.clear()
    try:
        pb.route((-100., 0.), (0., 0.), obstacles, bounds)
    except ValueError as error:
        assert '데크를 벗어' in str(error)
    else:
        raise AssertionError('accepted a walk off the deck')
    assert not pb._GRAPHS


def test_graphs_and_walks_are_bounded_caches():
    pb._GRAPHS.clear()
    for k in range(pb._GRAPH_LIMIT + 5):
        pb.deck_graph([(k, 0., k + 1., 1.)], (-10., -10., 100., 10.))
    assert len(pb._GRAPHS) == pb._GRAPH_LIMIT
    assert pb._WALK_LIMIT >= 256, 'a day of flights between a couple of dozen decks fits'
