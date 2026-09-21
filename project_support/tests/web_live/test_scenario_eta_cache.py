"""Per-step ETA memoization must never cross an observation boundary."""
from types import SimpleNamespace
from digital_twin.simulation.scenario_engine import ScenarioEngine

def test_eta_reuses_only_identical_inputs_inside_one_step():
    e=object.__new__(ScenarioEngine);e.policy={'pilot':{'approach_horizontal_speed_mps':10.,'landing_rate_mps':2.5,'descent_rate_mps':2.5,'climb_rate_mps':3.}}
    a=SimpleNamespace(route=object(),index=1,latitude=37.,longitude=127.,altitude=100.,telemetry={'segment_index':2})
    calls=[]
    e._compute_remaining_native=lambda a:calls.append(a.altitude) or a.altitude
    e._remaining_step_cache={}
    assert e._remaining_native(a)==100.;assert e._remaining_native(a)==100.;assert calls==[100.]
    a.altitude=99.;assert e._remaining_native(a)==99.;assert calls==[100.,99.]
    a.telemetry['segment_index']=3;e._remaining_native(a);assert len(calls)==3
    a.route=object();e._remaining_native(a);assert len(calls)==4
    e.policy['pilot']['descent_rate_mps']=2.;e._remaining_native(a);assert len(calls)==5
    e._remaining_step_cache=None;e._remaining_native(a);e._remaining_native(a);assert len(calls)==7

def test_step_discards_eta_cache_even_when_calculation_fails():
    import pytest
    e=object.__new__(ScenarioEngine)
    def body(now,step):
        assert e._remaining_step_cache=={}
        e._remaining_step_cache['test']=1
        raise RuntimeError('failed')
    e._step_observations=body
    with pytest.raises(RuntimeError):e._step(10.,.1)
    assert e._remaining_step_cache is None
