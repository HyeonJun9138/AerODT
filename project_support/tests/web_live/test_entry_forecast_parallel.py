"""The entry forecasts for a whole day are rehearsed at once, not in a row.

Loading a hundred-aircraft day showed "기체 예측 준비" for minutes: each
aircraft's first leg was flown by an independent native pilot until it reached
its descent, one after another on one thread, while the physics pool sat idle.
The rehearsals share nothing but the cache they fill, so they can run together;
and two aircraft with the same route from the same heading need one rehearsal.
"""
import threading
import time

from user_application.uam_mission import scenario_pilots
from user_application.uam_mission.scenario_pilots import ScenarioPilots


class Phase:
    def __init__(self, stage, points, speed=30.):
        self.stage, self.points, self.speed_mps = stage, points, speed
        self.duration_s = 60.

    def at_fraction(self, fraction):
        # (lat, lon, alt, heading) at a point along the phase; the warm-up reads
        # the heading at the end of the taxi out.
        return (*self.points[-1], 45.)


class Route:
    """An airborne route whose descent is the last phase."""
    def __init__(self, tag):
        self.phases = [Phase('gate_out', [(37.5, 127.0, 0.), (37.5, 127.001, 0.)], 3.),
                       Phase('climb', [(37.5, 127.001, 0.), (37.51, 127.001, 300.)]),
                       Phase('cruise', [(37.51, 127.001, 300.), (37.5 + tag, 127.05, 300.)]),
                       Phase('descent', [(37.5 + tag, 127.05, 300.), (37.5 + tag, 127.05, 0.)])]
        self.descent_index = 3
        self.duration_s = 240.


class SlowForecast:
    """Stands in for the native rehearsal: a fixed wall cost per flight."""
    def __init__(self, cost_s, answers, active):
        self.cost_s, self.answers, self.active = cost_s, answers, active
        self.calls, self.peak, self.lock = [], 0, threading.Lock()

    def __call__(self, route, heading):
        with self.lock:
            self.active[0] += 1
            self.peak = max(self.peak, self.active[0])
            self.calls.append((id(route), heading))
        try:
            time.sleep(self.cost_s)
            answer = self.answers(route, heading)
            if isinstance(answer, Exception):
                raise answer
            return answer
        finally:
            with self.lock:
                self.active[0] -= 1


def pilots(monkeypatch, cost_s=.05, answers=lambda route, heading: 120., workers=8):
    p = ScenarioPilots(library=object(), workers=workers)
    forecast = SlowForecast(cost_s, answers, [0])
    monkeypatch.setattr(p, '_forecast_entry', forecast)
    return p, forecast


def test_many_requests_are_rehearsed_together_and_report_real_completions(monkeypatch):
    p, forecast = pilots(monkeypatch, cost_s=.08)
    routes = [Route(i * .001) for i in range(8)]
    progress = []
    started = time.perf_counter()
    answers = p.estimate_many([(r, 90.) for r in routes], on_progress=lambda d, t: progress.append((d, t)))
    wall = time.perf_counter() - started
    assert answers == [120.] * 8
    assert progress == [(i, 8) for i in range(0, 9)], 'zero then one update per completed native rehearsal'
    assert forecast.peak >= 4, f'rehearsals must overlap; peak concurrency was {forecast.peak}'
    assert wall < .08 * 8 * .6, f'eight rehearsals of 80 ms took {wall:.2f} s: not parallel'


def test_identical_requests_fly_once_and_the_cache_answers_the_rest(monkeypatch):
    p, forecast = pilots(monkeypatch)
    same = Route(.01)
    answers = p.estimate_many([(same, 45.), (same, 45.), (same, 45.0004), (Route(.02), 45.)])
    assert answers == [120., 120., 120., 120.]
    # Two keys: equal geometry shares, and heading is intentionally rounded.
    assert len(forecast.calls) == 2, forecast.calls
    # And the single-request path reads the same cache afterwards.
    forecast.calls.clear()
    assert p.estimate_to_entry(same, 45.) == 120.
    assert forecast.calls == []


def test_arrival_fato_suffixes_share_the_forecast_that_stops_before_descent(monkeypatch):
    p, forecast = pilots(monkeypatch)
    first, second = Route(.01), Route(.01)
    second.phases[3] = Phase('descent', [(37.51, 127.05, 300.), (37.52, 127.06, 35.)])
    progress = []
    answers = p.estimate_many([(first, 45.), (second, 45.)],
                              on_progress=lambda done, total: progress.append((done, total)))
    assert answers == [120., 120.]
    assert len(forecast.calls) == 1, 'arrival geometry begins after the forecast has already ended'
    assert progress == [(0, 1), (1, 1)], 'the screen counts the one real rehearsal, not two FATO choices'


def test_a_failed_rehearsal_is_none_for_that_flight_and_stops_nothing_else(monkeypatch):
    bad = Route(.03)
    p, forecast = pilots(monkeypatch,
        answers=lambda route, heading: RuntimeError('native down') if route is bad else 90.)
    # The native failure is caught inside the rehearsal, as it is on one thread.
    real = ScenarioPilots._forecast_entry
    def rehearsal(route, heading):
        try:
            return forecast(route, heading)
        except RuntimeError:
            return None
    monkeypatch.setattr(p, '_forecast_entry', rehearsal)
    answers = p.estimate_many([(Route(.01), 0.), (bad, 0.), (Route(.02), 0.)])
    assert answers == [90., None, 90.]
    assert p.estimate_to_entry(bad, 0.) is None, 'the failure is remembered, not retried on every departure'


def test_cached_duplicates_report_the_one_unique_rehearsal_as_done(monkeypatch):
    p, forecast = pilots(monkeypatch)
    route = Route(.05)
    p.estimate_to_entry(route, 10.)
    progress = []
    assert p.estimate_many([(route, 10.), (route, 10.)], on_progress=lambda d, t: progress.append((d, t))) == [120., 120.]
    assert progress == [(1, 1)]
    assert len(forecast.calls) == 1
    assert p.estimate_many([]) == []


def test_the_engine_warms_the_day_through_the_batch_and_reports_forecast_routes(monkeypatch):
    from digital_twin.simulation.scenario_engine import ScenarioEngine
    routes = {}
    class Pilots:
        def __init__(self):
            self.batches = []
        def estimate_to_entry(self, route, heading):
            raise AssertionError('the batch path must be used when it exists')
        def estimate_many(self, requests, on_progress=None):
            requests = list(requests)
            self.batches.append(requests)
            for index in range(1, len(requests) + 1):
                if on_progress:
                    on_progress(index, len(requests))
            return [100.] * len(requests)
    class Aircraft:
        def __init__(self, identifier, flights, stand):
            self.aircraft_id, self.flights, self.stand, self.heading = identifier, flights, stand, 0.
    engine = ScenarioEngine.__new__(ScenarioEngine)
    engine.pilots = Pilots()
    engine.flights = {'F1': {'flight_id': 'F1'}, 'F2': {'flight_id': 'F2'}, 'F3': {'flight_id': 'F3'}}
    engine.aircraft = {'A': Aircraft('A', ['F1'], 'S1'), 'B': Aircraft('B', ['F2'], 'S2'),
                       'C': Aircraft('C', ['F3'], 'S3'), 'D': Aircraft('D', [], 'S4')}
    def route(flight):
        r = Route(.01)
        if flight['flight_id'] == 'F3':
            r.descent_index = None   # nothing to forecast for this one
        routes[flight['flight_id']] = r
        return r
    engine.route = route
    events = []
    engine._warm_entry_estimates(lambda phase, done, total: events.append((phase, done, total)))
    assert len(engine.pilots.batches) == 1 and len(engine.pilots.batches[0]) == 2
    # Two real forecast routes are reported.  The aircraft with no descent is
    # not presented as completed work, and the count cannot finish early.
    assert events == [('forecast', 1, 2), ('forecast', 2, 2)]


def test_the_single_forecast_still_works_and_caps_its_cache(monkeypatch):
    p, forecast = pilots(monkeypatch)
    p._entry_estimates = {('k%d' % i,): 1. for i in range(1024)}
    assert p.estimate_to_entry(Route(.07), 0.) == 120.
    assert len(p._entry_estimates) == 1, 'a full cache is cleared before the new entry'


def test_cached_entry_lookup_never_starts_a_rehearsal(monkeypatch):
    p, forecast=pilots(monkeypatch,cost_s=0)
    route=Route(.01)
    try:
        assert p.cached_entry_estimate(route,45) is None
        assert not forecast.calls
        assert p.estimate_to_entry(route,45)==120
        assert p.cached_entry_estimate(route,45)==120
        assert len(forecast.calls)==1
    finally:
        p.close()


# ---------------------------------------------------------------- play must not wait for a rehearsal
#
# Found on a 4,761-flight day: the first step after play took 42 seconds under
# the session lock. The warm-up had rehearsed the pad pair each plan named, the
# departure chose another pair, and every miss was a native rehearsal flown in
# the step. Two rules now: the warm-up rehearses every pair the departure may
# choose, and a step never rehearses - it starts the forecast beside the day
# and the aircraft waits one step at its stand.


def test_the_warm_up_rehearses_every_pad_pair_a_departure_may_choose():
    from types import SimpleNamespace
    from project_support.tests.web_live.test_fato_assignment import multi_engine
    from digital_twin.simulation import fato_assignment
    engine, flight = multi_engine()
    batches = []
    engine.pilots = SimpleNamespace(estimate_many=lambda requests, on_progress=None: (batches.append(list(requests)), [500.] * len(requests))[1],
                                    estimate_to_entry=lambda *args: (_ for _ in ()).throw(AssertionError('a rehearsal inside the day')))
    try:
        engine._warm_entry_estimates()
        aircraft = engine.aircraft[flight['aircraft_id']]
        available, _ = fato_assignment.options(engine, dict(flight, departure_stand=aircraft.stand))
        assert len(available) > 1, 'four shared pads at each end give the departure a choice'
        rehearsed = {id(route) for route, _heading in batches[0]}
        assert all(id(route) in rehearsed for _candidate, route in
                   engine._assignment_options[(flight['flight_id'], aircraft.stand)][0]), \
            'every pair the departure will look at was rehearsed, and the same route objects are kept for it'
        assert len(batches[0]) >= len(available)
    finally:
        engine.pilots = None
        engine.close()


def test_a_first_departure_after_the_warm_up_never_rehearses_in_the_step():
    from types import SimpleNamespace
    from project_support.tests.web_live.test_fato_assignment import multi_engine
    engine, flight = multi_engine()
    prepared = set()
    def estimate_many(requests, on_progress=None):
        requests = list(requests)
        prepared.update(id(route) for route, _ in requests)
        return [500.] * len(requests)
    engine.pilots = SimpleNamespace(estimate_many=estimate_many,
                                    prepare_entry_estimate=lambda route, heading: id(route) in prepared,
                                    cached_entry_estimate=lambda route, heading: 500. if id(route) in prepared else None,
                                    estimate_to_entry=lambda *args: (_ for _ in ()).throw(AssertionError('a rehearsal inside the day')))
    try:
        engine._warm_entry_estimates()
        aircraft = engine.aircraft[flight['aircraft_id']]
        chosen, route = engine._select_fatos(dict(flight, departure_stand=aircraft.stand), 23460)
        assert engine._meter_arrival_entry(aircraft, chosen, route, 23460), 'metered from the prepared estimate, no wait'
    finally:
        engine.pilots = None
        engine.close()


def test_an_estimate_not_yet_prepared_holds_the_aircraft_one_step_instead_of_the_whole_twin():
    from types import SimpleNamespace
    from project_support.tests.web_live.test_fato_assignment import multi_engine
    engine, flight = multi_engine()
    ready = {'now': False}
    asked = []
    def prepare(route, heading):
        asked.append(id(route))
        return ready['now']
    engine.pilots = SimpleNamespace(prepare_entry_estimate=prepare,
                                    cached_entry_estimate=lambda route, heading: 500. if ready['now'] else None,
                                    estimate_to_entry=lambda *args: (_ for _ in ()).throw(AssertionError('a rehearsal inside the day')))
    try:
        aircraft = engine.aircraft[flight['aircraft_id']]
        chosen, route = engine._select_fatos(dict(flight, departure_stand=aircraft.stand), 23460)
        assert engine._meter_arrival_entry(aircraft, chosen, route, 23460) is False
        assert '예측 준비' in aircraft.instruction['reason']
        assert chosen['flight_id'] not in engine._entry_forecasts, 'nothing is booked on a guess'
        ready['now'] = True
        assert engine._meter_arrival_entry(aircraft, chosen, route, 23462) is True
        assert chosen['flight_id'] in engine._entry_forecasts
        assert asked, 'the forecast was asked for, not flown here'
    finally:
        engine.pilots = None
        engine.close()


def test_prepare_starts_the_rehearsal_beside_the_day_and_answers_once_it_lands(monkeypatch):
    p, forecast = pilots(monkeypatch, cost_s=.05)
    route = Route(.03)
    try:
        assert p.prepare_entry_estimate(route, 45.) is False, 'not prepared yet: started, not flown here'
        assert p.cached_entry_estimate(route, 45.) is None
        deadline = time.time() + 3
        while not p.prepare_entry_estimate(route, 45.) and time.time() < deadline:
            time.sleep(.01)
        assert p.prepare_entry_estimate(route, 45.) is True
        assert p.cached_entry_estimate(route, 45.) == 120.
        assert len(forecast.calls) == 1, 'asked many times, flown once'
    finally:
        p.close()
