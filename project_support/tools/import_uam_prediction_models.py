"""Take the delivered UAM trajectory checkpoints into the workspace.

The three files are PyTorch pickles of 57 MB each: too large for the repository
and, being pickles, not something to open anywhere the dashboard runs. So they
are read once here — with torch, which only this tool needs — and written into
the workspace as safetensors beside a manifest of everything the checkpoint
carried about how to feed them.

Run it once after the files arrive:

    <anaconda python> project_support/tools/import_uam_prediction_models.py \
        "임시폴더/UAM_Prediction" --into data/workspace/prediction/uam_route_mlp

Nothing downstream needs torch afterwards. What the dashboard reads is the
manifest and the tensors, and neither is a pickle.
"""
import argparse
import hashlib
import json
import struct
from pathlib import Path

# The three horizons the delivery ships, and what each is for. The seconds are
# checked against the checkpoint rather than trusted from here.
HORIZONS = {
    "short_model.pt": {"model_id": "uam_route_mlp_short", "label": "UAM 단기 (10초)",
                       "note": "최근 9.6초의 비행 상태와 남은 경로로 앞 10초를 0.4초 간격으로 예측합니다."},
    "mid_model.pt": {"model_id": "uam_route_mlp_mid", "label": "UAM 중기 (90초)",
                     "note": "최근 28.8초의 비행 상태와 남은 경로로 앞 90초를 3.6초 간격으로 예측합니다."},
    "long_model.pt": {"model_id": "uam_route_mlp_long", "label": "UAM 장기 (240초)",
                      "note": "최근 28.8초의 비행 상태와 남은 경로로 앞 240초를 9.6초 간격으로 예측합니다."},
}
# What the manifest keeps out of the checkpoint. Everything here is needed to
# feed the model or to say what it is; the training hyperparameters are not.
CONTRACT_KEYS = (
    "task", "model_type", "model_class", "controller_id", "input_size", "output_size",
    "hidden_size", "num_layers", "dropout", "input_steps", "future_steps",
    "input_dt", "output_dt", "input_seconds", "future_seconds",
    "effective_input_dt", "effective_output_dt", "effective_input_seconds", "effective_future_seconds",
    "feature_columns", "label_columns", "label_frame", "feature_position_reference",
    "route_feature_columns", "route_feature_size", "route_hidden_size", "route_input_schema",
    "route_max_segments", "route_crop_mode", "route_cursor_column", "requires_route_context",
)


def digest(path):
    reader = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            reader.update(block)
    return reader.hexdigest()


def save_safetensors(tensors, path):
    """The state dict as safetensors, so nothing downstream opens a pickle."""
    header, offset, blobs = {}, 0, []
    for name in sorted(tensors):
        array = tensors[name].detach().cpu().numpy().astype("float32")
        blob = array.tobytes(order="C")
        header[name] = {"dtype": "F32", "shape": list(array.shape),
                        "data_offsets": [offset, offset + len(blob)]}
        offset += len(blob)
        blobs.append(blob)
    encoded = json.dumps(header, separators=(",", ":")).encode("utf-8")
    padding = (8 - (len(encoded) % 8)) % 8
    encoded += b" " * padding
    with open(path, "wb") as handle:
        handle.write(struct.pack("<Q", len(encoded)))
        handle.write(encoded)
        for blob in blobs:
            handle.write(blob)
    return path


def scaler(value):
    """A checkpoint scaler as plain lists, whatever it was stored as."""
    if value is None:
        return None
    if isinstance(value, dict):
        return {key: scaler(item) for key, item in value.items()}
    if hasattr(value, "tolist"):
        return value.tolist()
    if isinstance(value, (list, tuple)):
        return [scaler(item) for item in value]
    return value


def read(path):
    import torch  # Only this tool needs it.
    checkpoint = torch.load(path, map_location="cpu", weights_only=False)
    state = checkpoint["model_state_dict"]
    contract = {key: scaler(checkpoint.get(key)) for key in CONTRACT_KEYS if key in checkpoint}
    return checkpoint, state, contract


def convert(source, into):
    source, into = Path(source), Path(into)
    into.mkdir(parents=True, exist_ok=True)
    models = []
    for filename, described in HORIZONS.items():
        path = source / filename
        if not path.exists():
            print(f"  missing: {filename}")
            continue
        checkpoint, state, contract = read(path)
        folder = into / described["model_id"]
        folder.mkdir(parents=True, exist_ok=True)
        save_safetensors(state, folder / "model.safetensors")
        manifest = {
            "schema_version": 1,
            "model_id": described["model_id"],
            "label": described["label"],
            "note": described["note"],
            "source": {"file": filename, "sha256": digest(path), "bytes": path.stat().st_size,
                       "delivered": "UAM_Prediction (MODEL_INPUT_OUTPUT.md)"},
            "contract": contract,
            "scalers": {"feature": scaler(checkpoint.get("feature_scaler")),
                        "label": scaler(checkpoint.get("label_scaler")),
                        "route": scaler(checkpoint.get("route_scaler"))},
            "tensors": {name: list(tensor.shape) for name, tensor in sorted(state.items())},
            "metrics": scaler(checkpoint.get("metrics")),
        }
        (folder / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1),
                                              encoding="utf-8")
        models.append({"model_id": described["model_id"], "label": described["label"],
                       "future_seconds": contract.get("effective_future_seconds"),
                       "parameters": sum(int(tensor.numel()) for tensor in state.values())})
        print(f"  {described['model_id']}: {len(state)} tensors, "
              f"{sum(int(t.numel()) for t in state.values()):,} parameters, "
              f"future {contract.get('effective_future_seconds')} s")
    (into / "package.json").write_text(json.dumps({
        "schema_version": 1, "kind": "aerodt.uam_prediction_package",
        "source": "UAM_Prediction", "models": models}, ensure_ascii=False, indent=1), encoding="utf-8")
    return models


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", help="the delivered folder with the three .pt files")
    parser.add_argument("--into", default="data/workspace/prediction/uam_route_mlp")
    arguments = parser.parse_args()
    print(f"reading {arguments.source}")
    models = convert(arguments.source, arguments.into)
    print(f"wrote {len(models)} models into {arguments.into}")


if __name__ == "__main__":
    main()
