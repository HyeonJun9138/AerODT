"""The delivered GRU trajectory model: what the twin runs, and what it refuses
to run without.

The first delivery was weights alone. The run folder that followed carries the
scale the training run normalised by; the head activation was in neither, and is
measured rather than guessed (manifest.json records how). These tests pin three
things: the forward pass is the one PyTorch would compute, the model is only
offered for prediction once its normalization is answered, and the checkpoint on
disk is the one that was measured.
"""
import json
import math
import struct
from pathlib import Path

import numpy as np
import pytest

from digital_twin.live_twin import gru_prediction as gru
from digital_twin.model_library import prediction_catalog as catalog

MODEL_ID = "gru_direct_v1_1"
# The installed checkpoint, so a swapped file is noticed rather than assumed.
# It is the run's own checkpoints/best/model.safetensors, and run/manifest.csv
# names this hash for it.
SHA256 = "ffca2350df720813f2e6e7e025fb2b75b80421347b2f1d7dc31ab365f407e02e"
# Computed with torch 2.5.1 nn.GRU and nn.Linear on these weights: an eastward
# 20 m/s run, scale_m 400, time scale 3 s, exact-erf GELU head. Recomputed when
# the run folder arrived and replaced the first checkpoint.
TORCH_FIRST = (3.079914, 0.653706, -0.841503)
TORCH_LAST = (385.77313, 1.47488, 47.295563)
TORCH_SUM = 15429.051933
NORMALIZATION = {"scale_m": 400.0, "time_scale_s": 3.0, "head_activation": "gelu"}


@pytest.fixture(scope="module")
def delivered():
    model = catalog.find_model(MODEL_ID)
    assert model is not None, "the delivered model is in the model library"
    return model


def history(speed_mps=20.0, heading_deg=90.0, climb_mps=0.0, start=100.0):
    times = start + np.arange(gru.INPUT_POINTS) * gru.STEP_SECONDS
    along = times - times[-1]
    east = math.sin(math.radians(heading_deg)) * speed_mps
    north = math.cos(math.radians(heading_deg)) * speed_mps
    positions = np.column_stack([1000 + east * along, -2000 + north * along, 300 + climb_mps * along])
    return positions, times


# ------------------------------------------------------------------ what is delivered

def test_the_model_is_in_the_library_with_its_contract_and_is_ready_to_run(delivered):
    assert delivered["label"] == "GRU 직접예측 v1.1"
    contract = delivered["contract"]
    assert contract["rate_hz"] == 5.0 and contract["input_points"] == 16 and contract["output_points"] == 75
    assert contract["input_seconds"] == 3.0 and contract["output_seconds"] == 15.0
    assert contract["frame"] == "local_enu_m"
    assert catalog.weights_digest(delivered["weights"]) == SHA256, "the measured checkpoint, unchanged"
    # The run folder answered the normalization, so it can be asked to predict.
    assert delivered["ready"] is True
    assert delivered["missing"] == []
    assert delivered["reason"] == ""
    assert delivered["normalization"] == {"scale_m": 406.9305780134473, "time_scale_s": 3.0,
                                          "head_activation": "gelu"}
    model = gru.GruTrajectoryModel.from_model(delivered)
    positions, times = history()
    answer = model.predict_relative((positions - positions[-1])[None], (times - times[-1])[None])
    assert answer.shape == (1, gru.OUTPUT_POINTS, 3)
    # 15 s at 20 m/s eastward: whatever the model says, it must be in metres and
    # in the right hemisphere of the frame it was given.
    assert 100.0 < float(answer[0][-1][0]) < 600.0


def test_the_installed_weights_are_the_ones_the_run_manifest_names(delivered):
    """A checkpoint copied out of a delivery is worth nothing if it is not the
    one the run vouched for; the run's own manifest is the thing to check it
    against, not the folder it arrived in."""
    run = Path(delivered["directory"]) / "run"
    rows = [line.split(",") for line in (run / "manifest.csv").read_text(encoding="utf-8").splitlines()[1:] if line]
    claimed = {row[2]: row[3] for row in rows if len(row) >= 4}
    assert claimed["checkpoints/best/model.safetensors"] == SHA256
    assert json.loads((run / "run.json").read_text(encoding="utf-8"))["plugin_id"] == MODEL_ID
    assert json.loads((run / "status.json").read_text(encoding="utf-8"))["status"] in ("completed", "stopped")
    # The scale is the run's, carried across unchanged rather than refitted.
    assert json.loads((run / "normalization.json").read_text(encoding="utf-8"))["scale_m"] == \
        delivered["normalization"]["scale_m"]


def test_a_model_whose_normalization_is_missing_is_listed_but_never_asked(tmp_path):
    """The refusal that guarded this model before its run folder arrived, kept
    because the next delivered model will arrive the same way."""
    (tmp_path / "manifest.json").write_text(json.dumps({"model_id": "unanswered", "label": "미도착"}), encoding="utf-8")
    (tmp_path / "model.safetensors").write_bytes(b"")
    described = catalog.describe_model(tmp_path)
    assert described["ready"] is False
    assert any("정규화" in item for item in described["missing"])
    assert "normalization.json" in described["reason"]
    with pytest.raises(ValueError, match="정규화"):
        gru.GruTrajectoryModel.from_model(described)


def test_an_unanswered_normalization_file_is_not_an_answer(tmp_path):
    blanks = {"scale_m": None, "time_scale_s": 3.0, "head_activation": None}
    (tmp_path / "normalization.json").write_text(json.dumps(blanks), encoding="utf-8")
    assert catalog.normalization_of(tmp_path) is None, "the example file with its blanks left in"
    for bad in ({"scale_m": 0.0, "head_activation": "gelu"},
                {"scale_m": 400.0, "head_activation": "swish"},
                {"scale_m": "400", "head_activation": "gelu"},
                {"head_activation": "gelu"},
                {"scale_m": 400.0, "time_scale_s": 0, "head_activation": "gelu"}):
        (tmp_path / "normalization.json").write_text(json.dumps(bad), encoding="utf-8")
        assert catalog.normalization_of(tmp_path) is None, bad
    (tmp_path / "normalization.json").write_text(json.dumps(NORMALIZATION), encoding="utf-8")
    assert catalog.normalization_of(tmp_path) == NORMALIZATION
    assert catalog.normalization_of(tmp_path / "nowhere") is None


def test_the_example_file_shipped_beside_the_weights_is_blank_on_purpose(delivered):
    example = json.loads((Path(delivered["directory"]) / "normalization.example.json").read_text(encoding="utf-8"))
    assert example["scale_m"] is None and example["head_activation"] is None
    assert example["time_scale_s"] == 3.0, "the one value the delivery note does state"


# ------------------------------------------------------------------ the forward pass

def test_the_numpy_forward_pass_is_the_one_pytorch_computes(delivered):
    """Pinned against torch.nn.GRU on these weights, so the dashboard needs no
    deep-learning runtime to evaluate a megabyte of GRU."""
    model = gru.GruTrajectoryModel(gru.load_weights(delivered["weights"]), NORMALIZATION)
    positions, times = history()
    answer = model.predict_relative((positions - positions[-1])[None], (times - times[-1])[None])
    assert answer.shape == (1, 75, 3)
    path = answer[0]
    assert path[0] == pytest.approx(TORCH_FIRST, abs=2e-4)
    assert path[-1] == pytest.approx(TORCH_LAST, abs=2e-4)
    assert float(path.sum()) == pytest.approx(TORCH_SUM, rel=1e-6)


def test_every_activation_the_runtime_offers_can_be_evaluated(delivered):
    weights = gru.load_weights(delivered["weights"])
    positions, times = history()
    seen = {}
    for name in catalog.ACTIVATIONS:
        model = gru.GruTrajectoryModel(weights, {**NORMALIZATION, "head_activation": name})
        seen[name] = model.predict_relative((positions - positions[-1])[None], (times - times[-1])[None])[0]
        assert np.isfinite(seen[name]).all()
    assert not np.allclose(seen["relu"], seen["gelu"]), "which activation was trained matters and is unknown"
    with pytest.raises(ValueError, match="head_activation"):
        gru.GruTrajectoryModel(weights, {**NORMALIZATION, "head_activation": "mish"})


def test_the_weight_file_is_read_without_a_tensor_library(delivered, tmp_path):
    weights = gru.load_weights(delivered["weights"])
    assert weights["gru.weight_ih_l0"].shape == (3 * gru.HIDDEN, gru.INPUT_FEATURES)
    assert weights["gru.weight_hh_l1"].shape == (3 * gru.HIDDEN, gru.HIDDEN)
    assert weights["head.3.weight"].shape == (gru.OUTPUT_POINTS * 3, 256)
    assert weights["behavior_head.weight"].shape == (19, gru.HIDDEN), "training only; not evaluated"
    # A file that is not one is refused rather than half-read.
    for name, content in (("empty.safetensors", b""),
                          ("short.safetensors", bytes(4)),
                          ("overlong.safetensors", struct.pack("<Q", 1 << 40) + b"{}")):
        path = tmp_path / name
        path.write_bytes(content)
        with pytest.raises(ValueError, match="weights"):
            gru.load_weights(path)
    empty_header = tmp_path / "headerless.safetensors"
    empty_header.write_bytes(struct.pack("<Q", 2) + b"{}")
    assert gru.load_weights(empty_header) == {}, "a header with no tensors reads as no tensors"
    # A checkpoint missing a layer is refused before it is asked to predict.
    with pytest.raises(ValueError, match="head.3.weight"):
        gru.GruTrajectoryModel({k: v for k, v in weights.items() if k != "head.3.weight"}, NORMALIZATION)


# ------------------------------------------------------------------ the input contract

def test_the_history_must_be_sixteen_points_at_five_hertz():
    positions, times = history()
    kept_positions, kept_times = gru.validate_history(positions, times)
    assert kept_positions.shape == (16, 3) and kept_times.shape == (16,)
    with pytest.raises(ValueError, match="positions"):
        gru.validate_history(positions[:15], times[:15])
    with pytest.raises(ValueError, match="times"):
        gru.validate_history(positions, times[:15])
    gap = times.copy()
    gap[8:] += 1.0            # a second missing in the middle
    with pytest.raises(ValueError, match="5 Hz"):
        gru.validate_history(positions, gap)
    # What a surveillance feed actually delivers: one observation every second
    # or worse. It is refused rather than resampled into something nobody saw.
    with pytest.raises(ValueError, match="5 Hz"):
        gru.validate_history(positions, 100.0 + np.arange(16) * 1.0)
    broken = positions.copy()
    broken[3, 1] = np.nan
    with pytest.raises(ValueError, match="finite"):
        gru.validate_history(broken, times)


def test_a_track_collects_a_history_and_starts_again_after_a_gap():
    track = gru.TrackHistory()
    positions, times = history()
    for index in range(15):
        assert track.observe("uam-1", positions[index], times[index]) is None, "not three seconds yet"
    full = track.observe("uam-1", positions[15], times[15])
    assert full is not None and len(full[0]) == 16 and full[1][-1] == times[15]
    # A missed second is a new history, not a bridged one.
    assert track.observe("uam-1", positions[15], times[15] + 1.0) is None
    # Objects do not share a history, and one that goes is forgotten.
    track.observe("uam-2", positions[0], times[0])
    assert track.observe("uam-1", positions[0], times[0] + 1.2) is None
    track.keep(["uam-2"])
    assert set(track._tracks) == {"uam-2"}
    track.forget("uam-2")
    assert track._tracks == {}
    # A bad value clears rather than poisons.
    track.observe("uam-3", positions[0], times[0])
    assert track.observe("uam-3", (1.0, float("nan"), 3.0), times[1]) is None
    assert "uam-3" not in track._tracks


def test_a_predicted_path_hangs_off_the_last_observation(delivered):
    model = gru.GruTrajectoryModel(gru.load_weights(delivered["weights"]), NORMALIZATION)
    positions, times = history(speed_mps=15.0, heading_deg=45.0, climb_mps=2.0)
    path = gru.predict_path(model, positions, times)
    assert path["anchor_time_s"] == times[-1]
    assert len(path["position_enu_m"]) == 75 and len(path["times_s"]) == 75
    assert path["horizon_s"][0] == 0.2 and path["horizon_s"][-1] == 15.0
    assert path["times_s"][0] == pytest.approx(times[-1] + 0.2)
    assert path["times_s"][-1] == pytest.approx(times[-1] + 15.0)
    first = np.array(path["position_enu_m"][0])
    assert np.linalg.norm(first - positions[-1]) < 60, "the path starts near where the object is, not at the origin"
    relative = np.array(path["relative_position_m"])
    assert np.allclose(np.array(path["position_enu_m"]) - positions[-1], relative)
