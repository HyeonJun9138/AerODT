import math
from dataclasses import replace

import numpy as np
import pytest

from digital_twin.live_twin.provider_gru import corrected_window, provider_trajectory
from digital_twin.live_twin.gru_prediction import validate_history
from test_motion_continuity import Flight
from data.ingestion.aircraft_prediction_history import AircraftPredictionHistory


def sample(t):
    return (t, (6378137., t * 100., 0.), (0., 100., 0.))


def test_corrected_window_interpolates_then_extrapolates_without_changing_reports():
    reports = (sample(100), sample(130))
    positions, times = corrected_window(reports, 131, max_age=45)
    validate_history(positions, times)
    assert len(times) == 16
    assert times[0] == 128 and times[-1] == 131
    assert np.allclose(np.asarray(positions)[:, 1], np.asarray(times) * 100)
    assert reports == (sample(100), sample(130))


@pytest.mark.parametrize('target', [99, 102, 146, float('nan')])
def test_no_pre_observation_backfill_or_unbounded_extrapolation(target):
    assert corrected_window((sample(100),), target, max_age=45) is None


class StraightModel:
    def predict_relative(self, positions, times):
        return np.array([[[20 * (i+1), 0, 0] for i in range(75)]])


def test_path_is_enu_to_ecef_and_identifies_corrected_input():
    f = Flight()
    f.observe(100, 100)
    entity = f.tick(105)
    reports = ((100, entity.position_ecef_m, entity.velocity_ecef_mps),)
    path = provider_trajectory(entity, reports, StraightModel(), 105, 45, 15)
    assert path['kind'] == 'aircraft' and len(path['points']) == 76
    assert '보정 입력' in path['note']
    assert path['points'][0][0] == 105 and path['points'][-1][0] == 120
    assert math.dist(path['points'][0][1:], path['points'][-1][1:]) == pytest.approx(1500)
    assert provider_trajectory(replace(entity, quality='stale'), reports, StraightModel(), 105, 45, 15) is None


def test_selected_gru_runs_on_provider_and_preserves_twin_state():
    f = Flight(estimation={'prediction': True, 'prediction_model': 'gru_direct_v1_1'},
               prediction_history=AircraftPredictionHistory())
    f.observe(100, 100)
    entity = f.tick(105)
    path = f.sync.trajectory(entity)
    assert path is not None
    assert path['summary']['model'] == 'gru_direct_v1_1'
    assert path['points'][0][0] == 105
    assert entity == f.previous[0]
    assert f.sync.trajectory(replace(entity, state_time=1000), 1000) is None


def test_history_deduplicates_late_reports_and_restarts_after_long_gap():
    h = AircraftPredictionHistory()
    for t in (100,100,99,130):
        h.observe('a', *sample(t))
    assert len(h.read('a')) == 2
    h.observe('a', *sample(200))
    assert len(h.read('a')) == 1
    assert corrected_window(h.read('a'), 202) is None
    assert corrected_window(h.read('a'), 203) is not None
    h.keep(())
    assert h.read('a') == ()


def test_time_rewind_and_position_discontinuity_do_not_bridge_history():
    h = AircraftPredictionHistory()
    f = Flight(prediction_history=h)
    f.observe(100,100)
    f.tick(105)
    f.observe(130,130, longitude=-120)
    entity = f.tick(130)
    assert entity.discontinuity
    assert len(h.read(entity.entity_id)) == 1
    assert corrected_window(h.read(entity.entity_id),130) is None
    f.tick(90)
    assert not h.read(entity.entity_id)
