"""Two things the day's tick no longer does itself: it hands the pool a few
aircraft per task instead of one, and it hands the recorder's writing to a
writer thread. Both must leave every answer and every file exactly as before."""
import json
import threading
from types import SimpleNamespace

import pytest

from digital_twin.simulation import scenario_engine
from user_application.uam_mission.scenario_pilots import ScenarioPilots, BatchResult
from user_application.uam_mission.scenario_session import ScenarioRecorder
from project_support.tests.web_live.test_scenario_engine import engine_of, row


def pilots_of(workers):
    pilots = ScenarioPilots(SimpleNamespace(tunable=False), workers=workers)
    seen = []
    def advance(aircraft_id, seconds, hold=None):
        seen.append((aircraft_id, threading.current_thread().name))
        if aircraft_id == 'broken':
            raise RuntimeError('물리 실패 ' + aircraft_id)
        return {'aircraft_id': aircraft_id, 'seconds': seconds, 'hold': hold}
    pilots.advance = advance
    return pilots, seen


def test_submit_many_answers_each_aircraft_as_submit_would_with_far_fewer_tasks():
    pilots, seen = pilots_of(3)
    tasks = []
    original_pool = pilots._pool
    class Pool:
        def submit(self, fn, *args):
            tasks.append(args)
            from concurrent.futures import Future
            answer = Future(); answer.set_result(fn(*args)); return answer
    pilots._pool = Pool()
    requests = [('a', 1.2, None), ('broken', 1.2, (1, 2, 3)), ('c', 1.2, None)]
    answers = pilots.submit_many(requests)
    assert len(tasks) == 1 and len(answers) == 3 and all(isinstance(a, BatchResult) for a in answers)
    assert answers[0].result() == {'aircraft_id': 'a', 'seconds': 1.2, 'hold': None}
    assert answers[2].result()['aircraft_id'] == 'c' and answers[2].done()
    with pytest.raises(RuntimeError, match='broken'):
        answers[1].result()
    assert [name for name, _thread in seen] == ['a', 'broken', 'c'], 'flown in the order given'
    assert pilots.submit_many([]) == []
    pilots._pool = original_pool
    # One worker flies inline, as `submit` does.
    single, _seen = pilots_of(1)
    inline = single.submit_many([('a', .5, None), ('broken', .5, None)])
    assert inline[0].result()['aircraft_id'] == 'a'
    with pytest.raises(RuntimeError):
        inline[1].result()
    pilots.close(); single.close()


def test_engine_fills_pool_tasks_a_chunk_at_a_time_and_reads_answers_back_in_place():
    engine = engine_of(row('F1', 'A1', 'VP1', 'VP2', '06:30:00'))
    calls = []
    class Answer:
        def __init__(self, request): self.request = request
        def done(self): return True
        def result(self, timeout=None):
            if self.request[0] == 'broken': raise ValueError('bad')
            return ('flown', *self.request)
    class Pilots:
        workers = 2
        def submit(self, *request): calls.append(('submit', request)); return Answer(request)
        def submit_many(self, requests): calls.append(('many', list(requests))); return [Answer(r) for r in requests]
    engine.pilots = Pilots()
    engine._native_batch, engine._native_pending, engine._native_chunk = [], [], 2
    slots = [engine._submit_native(name, 1.2, None) for name in ('a', 'b', 'broken', 'd', 'e')]
    assert [kind for kind, _ in calls] == ['many', 'many'], 'two full chunks went as they filled'
    assert calls[0][1] == [('a', 1.2, None), ('b', 1.2, None)]
    assert not slots[4].done(), 'the remainder waits for the barrier'
    engine._flush_native()
    assert [kind for kind, _ in calls] == ['many', 'many', 'many'] and calls[2][1] == [('e', 1.2, None)]
    assert slots[0].result() == ('flown', 'a', 1.2, None) and slots[4].result() == ('flown', 'e', 1.2, None)
    with pytest.raises(ValueError):
        slots[2].result()
    engine._flush_native()
    assert len(calls) == 3, 'an empty flush asks nothing'
    # A pilot without submit_many is asked one aircraft at a time, as before.
    engine._native_chunk = 0
    assert engine._submit_native('z', 1.2, None).result() == ('flown', 'z', 1.2, None)
    assert calls[-1][0] == 'submit'
    unbound = scenario_engine._NativeSlot()
    with pytest.raises(RuntimeError):
        unbound.result()


def test_a_step_sizes_its_chunks_from_the_airborne_count_and_the_pool():
    engine = engine_of(row('F1', 'A1', 'VP1', 'VP2', '06:30:00'))
    class Pilots:
        workers = 4
        def submit(self, *request): raise AssertionError('not used')
        def submit_many(self, requests): return []
        def set_traffic(self, *args): pass
        def close(self): pass
    engine.pilots = Pilots()
    engine.advance(engine.time_s + 1)
    assert engine._native_chunk >= 1
    assert engine._native_pending == []


def test_recorder_writes_on_its_own_thread_in_order_and_counts_at_once(tmp_path, monkeypatch):
    from data.simulation import proximity_records
    order = []
    monkeypatch.setattr(proximity_records.ProximityRecords, 'observe', lambda self, moment, states: order.append(('observe', moment, [s['aircraft_id'] for s in states], threading.current_thread().name)))
    monkeypatch.setattr(proximity_records.ProximityRecords, 'event', lambda self, event: order.append(('event', event['kind'], threading.current_thread().name)))
    recorder = ScenarioRecorder(tmp_path, 'day-1', workspace=tmp_path)
    state = lambda name, flight='F1': {'aircraft_id': name, 'flight_id': flight, 'phase': 'cruise', 'latitude_deg': 37.5, 'longitude_deg': 127.0,
                                       'altitude_m': 300.0, 'heading_deg': 90.0, 'speed_mps': 40.0, 'holding': False, 'battery_pct': 80.0}
    recorder.track(1.0, [state('A1'), state('A2', flight=None)])
    event = {'kind': 'takeoff', 'flight_id': 'F1', 'time_s': 1.0}
    recorder.event(event)
    event['kind'] = 'edited after the fact'
    recorder.track(2.0, [state('A1')])
    recorder.diagnostic({'diagnostic_sequence': 1, 'note': 'x'})
    assert recorder.rows == 2 and recorder.events == 1, 'counted when asked, not when written'
    recorder._wait()
    recorder._tracks.flush()  # tracks are flushed by finish/close, as before; read them now
    assert [entry[:2] for entry in order] == [('observe', 1.0), ('event', 'takeoff'), ('observe', 2.0)]
    assert {entry[-1] for entry in order} == {'scenario-recorder'}, 'never on the caller'
    tracks = [json.loads(line) for line in (tmp_path / 'day-1' / 'tracks.jsonl').read_text(encoding='utf-8').splitlines()]
    assert [(r['t'], r['aircraft_id']) for r in tracks] == [(1.0, 'A1'), (2.0, 'A1')], 'flying rows only, in order'
    events = [json.loads(line) for line in (tmp_path / 'day-1' / 'events.jsonl').read_text(encoding='utf-8').splitlines()]
    assert events == [{'kind': 'takeoff', 'flight_id': 'F1', 'time_s': 1.0}], 'written as it was asked'
    assert json.loads((tmp_path / 'day-1' / 'diagnostics.jsonl').read_text(encoding='utf-8')) == {'diagnostic_sequence': 1, 'note': 'x'}
    # A record that cannot be encoded is logged and skipped; the next one still lands.
    recorder.diagnostic({'bad': object()})
    recorder.diagnostic({'diagnostic_sequence': 2})
    recorder._wait()
    lines = (tmp_path / 'day-1' / 'diagnostics.jsonl').read_text(encoding='utf-8').splitlines()
    assert [json.loads(line)['diagnostic_sequence'] for line in lines] == [1, 2]
    writer = recorder._writer
    recorder.close()
    writer.join(timeout=5)
    assert not writer.is_alive() and recorder._writer is None
