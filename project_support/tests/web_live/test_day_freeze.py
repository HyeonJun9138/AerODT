"""A loaded day is moved out of the cyclic collector's reach while it is
loaded, and back into it (and collected) when it is unloaded; while it runs,
the tick sweeps what has piled up behind the freeze and, rarely, thaws and
collects the whole day."""
import gc

from user_application.uam_mission import scenario_session as session_module
from project_support.tests.web_live.test_scenario_session import make, CSV


def test_loading_freezes_the_day_and_clearing_thaws_it(tmp_path):
    gc.unfreeze()
    session, clock = make(tmp_path)
    try:
        assert gc.get_freeze_count() == 0
        session.load(CSV)
        frozen = gc.get_freeze_count()
        assert frozen > 0, 'everything alive after the load is out of the collector\'s reach'
        assert session.engine is not None and session.state == 'ready'
        # Ticks make and drop objects: those are collected as usual, and the
        # frozen count does not grow with them. Frozen objects that die by
        # reference count leave the count; nothing the ticks made joins it.
        session.play(); clock.tick(5); session.tick()
        gc.collect()
        assert 0 < gc.get_freeze_count() <= frozen
        session.load(CSV)
        assert gc.get_freeze_count() > 0, 'a day loaded over another is frozen in turn'
        session.clear()
        assert gc.get_freeze_count() == 0, 'unloading gives the day back to the collector'
    finally:
        session.close()
        gc.unfreeze()


def test_the_tick_sweeps_every_half_minute_and_thaws_the_whole_day_every_quarter_hour(tmp_path, monkeypatch):
    wall = [1000.0]
    monkeypatch.setattr(session_module.time, 'monotonic', lambda: wall[0])
    calls = []
    monkeypatch.setattr(session_module.gc, 'collect', lambda *a, **k: calls.append('collect') or 0)
    monkeypatch.setattr(session_module.gc, 'freeze', lambda: calls.append('freeze'))
    monkeypatch.setattr(session_module.gc, 'unfreeze', lambda: calls.append('unfreeze'))
    session, clock = make(tmp_path)
    try:
        session.load(CSV)
        assert calls == ['unfreeze', 'collect', 'freeze'], 'loading thaws whatever was frozen, collects, freezes'
        calls.clear()
        session.play()
        for _ in range(5):
            clock.tick(1); session.tick()
        assert calls == [], 'nothing within the first half minute'
        wall[0] += session_module.GC_SWEEP_S
        clock.tick(1); session.tick()
        assert calls == ['collect', 'freeze'], 'a sweep: what piled up since the freeze, then frozen'
        calls.clear()
        wall[0] += 1
        clock.tick(1); session.tick()
        assert calls == [], 'not again until the next half minute'
        wall[0] += session_module.GC_FULL_S
        clock.tick(1); session.tick()
        assert calls == ['unfreeze', 'collect', 'freeze'], 'the quarter-hour pass thaws the whole day first'
        calls.clear()
        session.pause()
        wall[0] += session_module.GC_SWEEP_S
        session.tick()
        assert calls == ['collect', 'freeze'], 'a paused day, still flown by hand, is still swept'
        calls.clear()
        session.clear()
        assert calls == ['unfreeze', 'collect']
    finally:
        session.close()
        gc.unfreeze()
