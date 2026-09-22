"""Candidate geometry reuse must never cache live ground authority."""
from types import SimpleNamespace

from digital_twin.model_library import scheduled_route
from digital_twin.simulation import fato_assignment
from project_support.tests.web_live.test_fato_assignment import multi_engine


def test_resolved_alternative_paths_are_reused_on_next_review(monkeypatch):
    engine, flight = multi_engine()
    try:
        flight['route_path'] = ['fato:VP1:F1', 'WP1', 'WP2', 'fato:VP2:F2']
        engine._supplied_routes[tuple(flight['route_path'])] = scheduled_route.resolve(
            engine._network, flight['route_path'], flight['route_path'][0], flight['route_path'][-1])
        resolve = scheduled_route.resolve
        calls = []
        def counted(*args, **kwargs):
            calls.append(args[1])
            return resolve(*args, **kwargs)
        monkeypatch.setattr(scheduled_route, 'resolve', counted)
        first, rejected = fato_assignment.options(engine, flight)
        assert len(first) == 16 and not rejected and len(calls) == 15
        calls.clear()
        second, rejected = fato_assignment.options(engine, flight)
        assert not calls and not rejected
        assert [f for f, _ in second] == [f for f, _ in first]
        assert all(r1 is r2 for (_, r1), (_, r2) in zip(first, second))
    finally:
        engine.close()


def test_ground_review_once_per_departure_pad_but_fresh_on_each_call(monkeypatch):
    engine, flight = multi_engine()
    try:
        calls = []
        blockers = ['other-aircraft']
        monkeypatch.setattr(engine, 'ground_control', SimpleNamespace(propose_routes=True))
        def proposals(candidate):
            calls.append(candidate['departure_fato'])
            return ({'route_id': candidate['departure_fato'], 'blocked_by': list(blockers)},)
        monkeypatch.setattr(engine, '_departure_ground_proposals', proposals)
        monkeypatch.setattr(engine, 'route', lambda candidate: candidate['_departure_ground_route'])
        first, rejected = fato_assignment.options(engine, flight)
        assert len(first) == 16 and not rejected
        assert len(calls) == 4 and len(set(calls)) == 4
        assert all(r['blocked_by'] == ['other-aircraft'] for _, r in first)
        calls.clear()
        blockers.clear()
        second, rejected = fato_assignment.options(engine, flight)
        assert len(calls) == 4 and not rejected
        assert all(not r['blocked_by'] for _, r in second)
        assert all(r['blocked_by'] == ['other-aircraft'] for _, r in first)
    finally:
        engine.close()
