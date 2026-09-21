"""Trained trajectory-prediction models the twin can be given, and whether each
one can actually be run.

A delivered model is not the same thing as a usable one. These are learned
models: the weights alone do not say what units their inputs and outputs are in,
and reading them back in metres needs the normalization the training run
produced. A model whose normalization is missing is listed here with the reason,
so the display can say "this exists but cannot be used yet" instead of drawing
a path in the wrong units.

Pure declaration and file reading. No inference, no tensors, no numpy: the
runtime that actually evaluates a model lives in the Live Twin, and this module
is what tells it, and the operator, what is available.
"""
import hashlib
import json
import math
from pathlib import Path

MODELS_DIRECTORY = Path(__file__).resolve().parent / "prediction_models"
NORMALIZATION_FILE = "normalization.json"
MANIFEST_FILE = "manifest.json"
WEIGHTS_FILE = "model.safetensors"
# The activations the runtime can evaluate; the delivery did not say which.
ACTIVATIONS = ("relu", "gelu", "silu", "tanh")


def _read_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return None


def normalization_of(directory):
    """The training run's normalization, or None. Missing values count as missing:
    a file with `scale_m: null` is the example file, not an answer."""
    values = _read_json(Path(directory) / NORMALIZATION_FILE)
    if not isinstance(values, dict):
        return None
    numbers = (int, float)
    scale_raw = values.get("scale_m")
    time_raw = values.get("time_scale_s", 3.0)
    # A number, written as one: a quoted "400" is a note to somebody, not a
    # value the training run produced.
    if isinstance(scale_raw, bool) or isinstance(time_raw, bool):
        return None
    if not (isinstance(scale_raw, numbers) and isinstance(time_raw, numbers)):
        return None
    scale, time_scale = float(scale_raw), float(time_raw)
    if not (math.isfinite(scale) and math.isfinite(time_scale)):
        return None
    activation = str(values.get("head_activation") or "").strip().lower()
    if not (scale > 0 and time_scale > 0) or activation not in ACTIVATIONS:
        return None
    return {"scale_m": scale, "time_scale_s": time_scale, "head_activation": activation}


def describe_model(directory):
    """One model: what it is, what it needs, and whether it can be run."""
    directory = Path(directory)
    manifest = _read_json(directory / MANIFEST_FILE) or {}
    weights = directory / (manifest.get("weights", {}).get("file") or WEIGHTS_FILE)
    normalization = normalization_of(directory)
    missing = []
    if not weights.is_file():
        missing.append("가중치 파일")
    if normalization is None:
        missing.append("정규화 값 (normalization.json: scale_m, head_activation)")
    return {
        "model_id": manifest.get("model_id", directory.name),
        "label": manifest.get("label", directory.name),
        "note": manifest.get("note", ""),
        "contract": manifest.get("contract", {}),
        "directory": str(directory),
        "weights": str(weights),
        "normalization": normalization,
        "ready": not missing,
        "missing": missing,
        "reason": "" if not missing else f"{', '.join(missing)}이 없어 예측을 실행하지 않습니다.",
    }


def describe_models(root=MODELS_DIRECTORY):
    root = Path(root)
    if not root.is_dir():
        return []
    return [describe_model(child) for child in sorted(root.iterdir()) if child.is_dir()]


def find_model(model_id, root=MODELS_DIRECTORY):
    return next((model for model in describe_models(root) if model["model_id"] == model_id), None)


def weights_digest(path):
    """SHA-256 of a weights file, for recording which checkpoint was run."""
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()
