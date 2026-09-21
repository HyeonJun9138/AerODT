"""Audit safe UAM inference against a specifically trusted original delivery.

This offline tool is the only place (besides the importer) that executes the
delivery's pickle-backed PyTorch model. The web runtime uses NumPy and verified
safetensors only. Strict 0.1 mm and fixed 2 mm platform-compatibility outcomes
are reported separately, never replaced or dynamically loosened.
"""
import argparse
import hashlib
import json
import platform
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import numpy as np

from ai_pnp.domains.uam.uam_route_model import (IMPLEMENTATION_FILE, IMPLEMENTATION_SHA256,
                                    RUNTIME_CONTRACT, UamRouteModel, _encode_route, contract_sha256)

STRICT_TOLERANCE_M = 0.0001
COMPATIBILITY_TOLERANCE_M = 0.002
MODEL_HASHES = {
    "short": "808822005bc0e0f13212f06f2fddc54ff785f2c0ccced9c5a5917500cb9abde4",
    "mid": "bf90b2775d3c405a1a4c7692ee4ef5471cb8a7f99e968ae1c1676853bc4bdf4a",
    "long": "abb6122f691a850c8fd79c9611e8867fe899f23074b2d81a6d0af240dc39fba7",
}
SOURCE_FILES = ("portable_inference.py", "backend/ml/models.py", "backend/ml/route_features.py",
                "backend/ml/feature_schema.py", "backend/ml/scaling.py", "backend/api/prediction.py",
                "requirements.txt", "verify_package.py")
OUTPUT_FIELDS = ("prediction_body_m", "prediction_enu_m", "prediction_absolute_enu_m")


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            value.update(block)
    return value.hexdigest()


def output_errors(actual, expected):
    if actual["model"] != expected["model"] or actual["route_context"] != expected["route_context"]:
        raise AssertionError("model/route metadata does not match the original runner")
    np.testing.assert_allclose(actual["times_s"], expected["times_s"], rtol=0, atol=STRICT_TOLERANCE_M)
    errors = {}
    for field in OUTPUT_FIELDS:
        a, e = np.asarray(actual[field]), np.asarray(expected[field])
        if a.shape != (25, 3) or e.shape != (25, 3) or not np.isfinite(a).all() or not np.isfinite(e).all():
            raise AssertionError(f"invalid output shape/values: {field}")
        errors[field] = float(np.max(np.abs(a - e)))
    return errors


def verify(source, packages, *, write_manifests=False, repetitions=10):
    """Caller must review/trust source first; hashes pin the three pickles."""
    source, packages = Path(source).resolve(), Path(packages).resolve()
    for horizon, expected in MODEL_HASHES.items():
        if digest(source / f"{horizon}_model.pt") != expected:
            raise ValueError(f"unrecognized checkpoint hash: {horizon}")
    sys.path.insert(0, str(source))
    import torch
    from portable_inference import load_checkpoint_model, predict as reference_predict
    from backend.ml.route_features import encode_route_segments

    source_hashes = {name: digest(source / name) for name in SOURCE_FILES}
    implementation_hash = digest(ROOT / IMPLEMENTATION_FILE)
    if implementation_hash != IMPLEMENTATION_SHA256:
        raise ValueError("implementation changed after this verifier process imported it; start a fresh process")
    report = {"schema_version": 1, "runtime_contract": RUNTIME_CONTRACT,
              "python": platform.python_version(), "numpy": np.__version__, "torch": torch.__version__,
              "source_hashes": source_hashes, "implementation_file": IMPLEMENTATION_FILE,
              "implementation_sha256": implementation_hash, "models": []}
    for horizon in MODEL_HASHES:
        payload = json.loads((source / f"examples/example_input_{horizon}.json").read_text(encoding="utf-8"))
        golden = json.loads((source / f"examples/expected_output_{horizon}.json").read_text(encoding="utf-8"))
        model = UamRouteModel(packages / f"uam_route_mlp_{horizon}")
        actual = model.predict(**payload)
        original = reference_predict(source / f"{horizon}_model.pt", payload)
        golden_errors = output_errors(actual, golden)
        original_errors = output_errors(original, golden)
        reference_errors = output_errors(actual, original)

        checkpoint, reference, feature_scaler, label_scaler = load_checkpoint_model(source / f"{horizon}_model.pt")
        raw = np.asarray([[row[key] for key in checkpoint["feature_columns"]] for row in payload["state_history"]], dtype=np.float32)
        normalized = (raw - model.feature_mean) / model.feature_std
        np.testing.assert_array_equal(normalized, feature_scaler.transform(raw))
        arguments = dict(position=raw[-1, 1:4].astype(np.float64), yaw_deg=float(raw[-1, 6]),
                         route=payload["route"], target_point_index=payload["target_point_index"],
                         current_target=payload.get("current_target"), horizon_s=checkpoint["future_seconds"],
                         reference_speed_mps=float(raw[-1, 16]), max_segments=48)
        encoded = encode_route_segments(**arguments)
        tokens, mask, _ = _encode_route(arguments["position"], arguments["yaw_deg"], payload["route"],
                                       payload["target_point_index"], payload.get("current_target"),
                                       checkpoint["future_seconds"], arguments["reference_speed_mps"])
        np.testing.assert_array_equal(tokens, encoded.tokens)
        np.testing.assert_array_equal(mask, encoded.mask)
        np.testing.assert_array_equal(model.label_mean, label_scaler.mean)
        np.testing.assert_array_equal(model.label_std, label_scaler.std)
        for name, tensor in reference.state_dict().items():
            np.testing.assert_array_equal(model.weights[name], tensor.numpy())

        # Reconstruct the identical original forward in double precision. This
        # distinguishes a wrong gate/order/attention port from float32 BLAS and
        # MKLDNN reduction differences; it is not a replacement golden output.
        reference.double()
        with torch.inference_mode():
            double_normalized = reference(torch.from_numpy(normalized[None]).double(),
                                          torch.from_numpy(tokens[None]).double(),
                                          torch.from_numpy(mask[None]).double()).numpy().reshape(25, 3)
        safe_normalized = model._forward(normalized, tokens, mask)
        double_error = float(np.max(np.abs(safe_normalized - double_normalized)))
        np.testing.assert_allclose(safe_normalized, double_normalized, rtol=0, atol=1e-10)
        double_body_error = float(np.max(np.abs(label_scaler.inverse(double_normalized) - np.asarray(actual["prediction_body_m"]))))
        if double_body_error > STRICT_TOLERANCE_M:
            raise AssertionError("float64 original model disagrees in metres")

        model.predict(**payload)
        durations = []
        for _ in range(repetitions):
            started = time.perf_counter()
            model.predict(**payload)
            durations.append((time.perf_counter() - started) * 1000)
        maximum = max(golden_errors.values())
        reference_maximum = max(reference_errors.values())
        compatible = maximum <= COMPATIBILITY_TOLERANCE_M and reference_maximum <= COMPATIBILITY_TOLERANCE_M
        validation = {
            "status": "passed" if compatible else "failed",
            "basis": "original_forward_route_scaler_float64_equivalence_and_fixed_2mm_platform_compatibility",
            "strict_passed": maximum <= STRICT_TOLERANCE_M,
            "strict_tolerance_m": STRICT_TOLERANCE_M,
            "compatibility_tolerance_m": COMPATIBILITY_TOLERANCE_M,
            "max_absolute_error_m": maximum,
            "golden_errors_m": golden_errors,
            "original_runner_golden_errors_m": original_errors,
            "original_runner_strict_passed": max(original_errors.values()) <= STRICT_TOLERANCE_M,
            "current_original_reference_errors_m": reference_errors,
            "float64_forward_max_absolute_error": double_error,
            "float64_body_max_absolute_error_m": double_body_error,
            "route_scaler_tensors_exact": True,
            "source_sha256": MODEL_HASHES[horizon], "weights_sha256": model.weights_sha256,
            "source_hashes": source_hashes, "implementation_file": IMPLEMENTATION_FILE,
            "implementation_sha256": implementation_hash,
            "contract_sha256": contract_sha256(model.manifest),
            "example_input_sha256": digest(source / f"examples/example_input_{horizon}.json"),
            "expected_output_sha256": digest(source / f"examples/expected_output_{horizon}.json"),
            "warm_inference_ms": {"median": statistics.median(durations), "max": max(durations), "samples": repetitions},
            "limitations": ["2 mm compatibility is numerical portability, not live-flight prediction accuracy.",
                            "The original float32 runner also exceeds 0.1 mm on this host for some models.",
                            "Live ctrl_00 feature approximations are not validated by these examples."],
        }
        if write_manifests:
            manifest = model.manifest
            manifest["runtime_contract"] = RUNTIME_CONTRACT
            manifest["validation"] = validation
            (packages / f"uam_route_mlp_{horizon}/manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
        report["models"].append({"model_id": f"uam_route_mlp_{horizon}", **validation})
        print(f"{horizon}: compatibility={compatible}; strict={validation['strict_passed']}; golden={maximum:.9f} m; reference={reference_maximum:.9f} m; double={double_error:.3g}; warm={statistics.median(durations):.1f} ms")
    report["status"] = "passed" if all(m["status"] == "passed" for m in report["models"]) else "failed"
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--trusted-source", type=Path, required=True, help="Reviewed, trusted original delivery; executes its pickle/code offline")
    parser.add_argument("--packages", type=Path, default=ROOT / "data/workspace/prediction/uam_route_mlp")
    parser.add_argument("--write-manifests", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    report = verify(args.trusted_source, args.packages, write_manifests=args.write_manifests)
    output = args.output or args.packages / "verification.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
