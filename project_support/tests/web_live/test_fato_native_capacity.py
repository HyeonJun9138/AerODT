"""Same four departures on real one/four-FATO layouts in an isolated native run."""
import json
from collections import Counter
import pytest
from communication.python.native_pilot import NativePilotLibrary
from user_application.uam_mission.scenario_pilots import ScenarioPilots
from project_support.tests.web_live.test_fato_admission_capacity import capacity_engine


def run_capacity(count):
    try:
        library=NativePilotLibrary()
    except (OSError,RuntimeError):
        pytest.skip('Native pilot library unavailable')
    engine=capacity_engine(count,flights=4,pilots=ScenarioPilots(library,workers=2))
    try:
        for _ in range(3000):
            engine.advance(engine.time_s+2)
            assert not any(a.failed for a in engine.aircraft.values()), engine.problems
            if all(a.completed for a in engine.aircraft.values()):break
        result={'fato_count':count,'completed':sum(a.completed for a in engine.aircraft.values()),
            'simulated_s':round(engine.time_s-engine.opens_s,1),
            'mean_airborne_hold_s':sum(a.hold_seconds for a in engine.aircraft.values())/4,
            'touchdowns_per_pad':dict(Counter(e.get('arrival_fato','unknown') for e in engine.events if e['kind']=='touchdown'))}
        assert result['completed']==4
        assert not engine._terminal.claims and not engine._active_pads
        return result
    finally:
        engine.close()


@pytest.mark.parametrize('count',[1,4])
def test_native_one_and_four_fato_flights_complete_and_release_resources(count):
    print(json.dumps(run_capacity(count),ensure_ascii=False))
