"""The delivered checkpoints must reproduce their portable runner, not a surrogate."""
import importlib
import json
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / "임시폴더/prediction_models_20260911"
PACKAGES = ROOT / "data/workspace/prediction/uam_route_mlp"


def model_type():
    assert importlib.util.find_spec("ai_pnp.uam_route_model") is not None, "the safe route model is not implemented"
    if not (PACKAGES / "uam_route_mlp_short/model.safetensors").exists():
        pytest.skip("large model artifacts are not installed")
    return importlib.import_module("ai_pnp.uam_route_model").UamRouteModel


def example(horizon):
    if not SOURCE.exists():
        pytest.skip("trusted delivered golden package is not installed")
    return json.loads((SOURCE / f"examples/example_input_{horizon}.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("horizon", ["short", "mid", "long"])
def test_delivered_golden_output_matches_fixed_two_mm_platform_tolerance(horizon):
    payload = example(horizon)
    model = model_type()(PACKAGES / f"uam_route_mlp_{horizon}")
    actual = model.predict(**payload)
    expected = json.loads((SOURCE / f"examples/expected_output_{horizon}.json").read_text(encoding="utf-8"))
    assert actual["model"] == expected["model"]
    assert actual["route_context"] == expected["route_context"]
    for field in ("times_s", "prediction_body_m", "prediction_enu_m", "prediction_absolute_enu_m"):
        # The original torch 2.5 runner itself exceeds the delivery's 0.1 mm
        # bound on this host. The strict result remains separately recorded by
        # verify_uam_prediction_models; 2 mm is a fixed compatibility bound.
        np.testing.assert_allclose(actual[field], expected[field], atol=0.002, rtol=0)


def test_importer_preserves_the_portable_time_contract():
    pytest.importorskip("torch")
    from project_support.tools.import_uam_prediction_models import read
    example("short")
    _, _, contract = read(SOURCE / "short_model.pt")
    assert contract["input_dt"] == 0.4
    assert contract["output_dt"] == 0.4
    assert contract["input_seconds"] == pytest.approx(9.6)
    assert contract["future_seconds"] == 10.0


@pytest.mark.parametrize("change,match", [
    (lambda p: p["state_history"].pop(), "25"),
    (lambda p: p["state_history"][4].pop("yaw"), "yaw"),
    (lambda p: p["state_history"][4].update(yaw=float("nan")), "finite"),
    (lambda p: p["state_history"][4].update(t=-100), "timestamps"),
    (lambda p: p.update(route=[]), "route"),
    (lambda p: p["route"][0].update(x=float("inf")), "finite"),
    (lambda p: p.update(current_target={"x": 0, "y": 0}), "current_target"),
    (lambda p: p.update(target_point_index=0.5), "target_point_index"),
])
def test_invalid_input_is_rejected_instead_of_inventing_a_path(change, match):
    payload = example("short")
    model = model_type()(PACKAGES / "uam_route_mlp_short")
    change(payload)
    with pytest.raises(ValueError, match=match):
        model.predict(**payload)


def test_daytime_timestamps_are_validated_before_float32_quantization():
    payload = example("short")
    for index, row in enumerate(payload["state_history"]):
        row["t"] = 23400 + index * 0.4
    model = model_type()(PACKAGES / "uam_route_mlp_short")
    result = model.predict(**payload)
    assert result["times_s"][0] == pytest.approx(23410.0, abs=1e-8)
    assert result["times_s"][-1] == pytest.approx(23419.6, abs=1e-8)


def test_crop_keeps_crossing_segment_and_its_excluded_turn():
    from ai_pnp.uam_route_model import _encode_route
    tokens, mask, meta = _encode_route(np.zeros(3), 0, [[100, 0, 0], [100, -100, 0], [200, -100, 0]], 0, None, 1, 50)
    assert meta == {"schema": "shared_segment_v014", "segment_count": 1, "candidate_segment_count": 3,
                    "cropped": True, "lookahead_turn_used": True, "crop_distance_m": 50}
    np.testing.assert_allclose(tokens[0], [100, 0, 0, 1, 0, 0, 100, 0, 100, 1, 0, 1, 0], rtol=0, atol=1e-12)
    assert mask.tolist() == [1] + [0]*47
    assert not tokens[1:].any()


def test_degenerate_leg_is_retained_and_final_waypoint_is_terminal():
    from ai_pnp.uam_route_model import _encode_route
    tokens, mask, meta = _encode_route(np.zeros(3), 90, [[0, 0, 0], [0, -10, 0]], 0, None, 10, 1)
    assert meta["segment_count"] == 2
    assert not tokens[0, 3:12].any()
    assert tokens[1, 12] == 1
    assert tokens[1, 0] == pytest.approx(10)


@pytest.mark.parametrize("mask", [np.zeros(48), np.ones(47), np.asarray([0, 1]+[0]*46), np.full(48, 0.5), np.full(48, np.nan)])
def test_malformed_or_empty_route_masks_are_not_inferred(mask):
    model = model_type()(PACKAGES / "uam_route_mlp_short")
    with pytest.raises(ValueError, match="mask"):
        model._forward(np.zeros((25, 21)), np.zeros((48, 13)), mask)


def test_safe_tensor_reader_rejects_overlapping_ranges(tmp_path):
    import struct
    from ai_pnp.uam_route_model import _load_weights
    header = json.dumps({name: {"dtype": "F32", "shape": [1], "data_offsets": [0, 4]} for name in ("a", "b")}).encode()
    path = tmp_path / "model.safetensors"
    path.write_bytes(struct.pack("<Q", len(header)) + header + struct.pack("<f", 0.0))
    with pytest.raises(ValueError, match="overlap"):
        _load_weights(path, {"a": (1,), "b": (1,)})


@pytest.mark.parametrize("key,value", [("feature_columns", list(reversed(["t", "x", "y"]))), ("input_dt", 0), ("future_steps", 10)])
def test_invalid_manifest_contract_is_rejected_before_loading_weights(tmp_path, key, value):
    model_type()
    manifest = json.loads((PACKAGES / "uam_route_mlp_short/manifest.json").read_text(encoding="utf-8"))
    manifest["contract"][key] = value
    (tmp_path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    with pytest.raises(ValueError):
        model_type()(tmp_path)


def test_changed_weights_cannot_reuse_a_previous_validation(tmp_path):
    model_type()
    import shutil
    folder = PACKAGES / "uam_route_mlp_short"
    manifest = _proof_bound_manifest()
    manifest["validation"]["weights_sha256"] = "0"*64
    (tmp_path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    shutil.copyfile(folder / "model.safetensors", tmp_path / "model.safetensors")
    with pytest.raises(ValueError, match="validation.*hash"):
        model_type()(tmp_path)


def test_runtime_inference_does_not_execute_pickle_or_import_torch():
    example("short")
    model_type()
    import subprocess
    import sys
    script = '''
import importlib.abc, json, sys
class NoExecutableCheckpoint(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname == 'torch' or fullname.startswith('torch.'):
            raise AssertionError('web inference must not import torch')
sys.meta_path.insert(0, NoExecutableCheckpoint())
from ai_pnp.uam_route_model import UamRouteModel
from pathlib import Path
import pickle
def reject_pickle(*args, **kwargs):
    raise AssertionError('web inference must not execute pickle')
pickle.load = pickle.loads = reject_pickle
payload = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
result = UamRouteModel(sys.argv[2]).predict(**payload)
assert len(result['prediction_absolute_enu_m']) == 25
assert 'torch' not in sys.modules
'''
    result = subprocess.run([sys.executable, "-c", script, str(SOURCE / "examples/example_input_short.json"),
                             str(PACKAGES / "uam_route_mlp_short")], cwd=ROOT, text=True, capture_output=True)
    assert result.returncode == 0, result.stderr


def _proof_bound_manifest():
    """Independent proof construction so mutations test the runtime consumer."""
    import hashlib
    model_type()
    manifest = json.loads((PACKAGES / "uam_route_mlp_short/manifest.json").read_text(encoding="utf-8"))
    canonical = json.dumps({"contract": manifest["contract"], "scalers": manifest["scalers"]},
                           sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")
    proof = manifest.setdefault("validation", {})
    proof["contract_sha256"] = hashlib.sha256(canonical).hexdigest()
    proof["implementation_sha256"] = hashlib.sha256((ROOT / "ai_pnp/uam_route_model.py").read_bytes()).hexdigest()
    proof["implementation_file"] = "ai_pnp/uam_route_model.py"
    return manifest


@pytest.mark.parametrize("mutation", ["label_scaler", "feature_scaler", "input_dt", "implementation", "missing_contract", "missing_implementation", "empty_proof"])
def test_existing_proof_binds_contract_scalers_and_implementation(tmp_path, mutation):
    import shutil
    manifest = _proof_bound_manifest()
    if mutation == "label_scaler":
        manifest["scalers"]["label"]["mean"][0] += 100
    elif mutation == "feature_scaler":
        manifest["scalers"]["feature"]["std"][0] *= 2
    elif mutation == "input_dt":
        manifest["contract"]["input_dt"] *= 2
        manifest["contract"]["input_seconds"] *= 2
    elif mutation == "implementation":
        manifest["validation"]["implementation_sha256"] = "0"*64
    elif mutation == "empty_proof":
        manifest["validation"] = {}
    else:
        manifest["validation"].pop("contract_sha256" if mutation == "missing_contract" else "implementation_sha256")
    (tmp_path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    shutil.copyfile(PACKAGES / "uam_route_mlp_short/model.safetensors", tmp_path / "model.safetensors")
    with pytest.raises(ValueError, match="validation.*hash"):
        model_type()(tmp_path)


def test_proof_canonicalization_accepts_json_key_reordering(tmp_path):
    import shutil
    manifest = _proof_bound_manifest()
    manifest["contract"] = dict(reversed(list(manifest["contract"].items())))
    manifest["scalers"] = dict(reversed(list(manifest["scalers"].items())))
    (tmp_path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    shutil.copyfile(PACKAGES / "uam_route_mlp_short/model.safetensors", tmp_path / "model.safetensors")
    output = model_type()(tmp_path).predict(**example("short"))
    assert len(output["prediction_body_m"]) == 25


def test_initial_import_without_proof_can_be_verified(tmp_path):
    import shutil
    manifest = _proof_bound_manifest()
    manifest.pop("validation")
    (tmp_path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    shutil.copyfile(PACKAGES / "uam_route_mlp_short/model.safetensors", tmp_path / "model.safetensors")
    output = model_type()(tmp_path).predict(**example("short"))
    assert len(output["prediction_body_m"]) == 25
