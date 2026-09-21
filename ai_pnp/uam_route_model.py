"""Safe inference for the delivered ctrl_00 RouteMlpTrajectoryRegressor.

Only the audited state LSTM, shared segment MLP, route GRU and attention are
ported here. No simulator, controller or pickle is imported. Inputs and outputs
follow the delivery's portable_inference.py contract; this model owns no live
state and never decides whether a flight should execute its prediction.
"""
import hashlib
import json
import math
import struct
from collections.abc import Mapping
from pathlib import Path

import numpy as np

RUNTIME_CONTRACT = "aerodt.uam_route_mlp.numpy.v1"
IMPLEMENTATION_FILE = "ai_pnp/uam_route_model.py"
# Bind the implementation actually imported by this process, not newer source
# bytes that might appear on disk while an old web worker is still running.
IMPLEMENTATION_SHA256 = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
STATE_COLUMNS = ("t", "x", "y", "z", "roll", "pitch", "yaw", "u", "v", "w",
                 "p", "q", "r", "wind_body_u", "wind_body_v", "wind_body_w",
                 "active_speed_target_mps", "cross_track_error_m", "wp1_rel_x", "wp1_rel_y", "wp1_rel_z")
ROUTE_COLUMNS = ("end_body_forward_m", "end_body_right_m", "end_body_up_m",
                 "direction_body_forward", "direction_body_right", "direction_body_up",
                 "segment_length_m", "path_start_m", "path_end_m", "turn_after_sin",
                 "turn_after_cos", "turn_after_valid", "terminal")


def contract_sha256(manifest):
    """Stable proof for input/output contracts and all three scalers.

    Catalog readers can implement this JSON/UTF-8 rule without importing the
    inference layer. Object key order and formatting are not semantic changes.
    """
    encoded = json.dumps({"contract": manifest["contract"], "scalers": manifest["scalers"]},
                         sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                         allow_nan=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _finite(value, name):
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError):
        raise ValueError(f"{name} must be numeric") from None
    if not math.isfinite(result):
        raise ValueError(f"{name} must be finite")
    return result


def _point(value, name):
    if isinstance(value, Mapping):
        values = [value.get(axis) for axis in ("x", "y", "z")]
    else:
        try:
            if len(value) != 3:
                raise ValueError
            values = value
        except (TypeError, ValueError):
            raise ValueError(f"{name} must be an x/y/z point") from None
    return np.asarray([_finite(v, name) for v in values], dtype=np.float64)


def _load_weights(path, expected):
    raw = path.read_bytes()
    if len(raw) < 8:
        raise ValueError("weights file is truncated")
    size = struct.unpack("<Q", raw[:8])[0]
    if size > 1 << 20 or size <= 0 or 8 + size > len(raw):
        raise ValueError("weights header is invalid")
    header = json.loads(raw[8:8 + size])
    body = memoryview(raw)[8 + size:]
    result, ranges = {}, []
    if set(header) - {"__metadata__"} != set(expected):
        raise ValueError("weights tensor names do not match the model")
    for name, shape in expected.items():
        entry = header[name]
        if entry.get("dtype") != "F32" or entry.get("shape") != list(shape):
            raise ValueError(f"weights shape/dtype is invalid: {name}")
        start, end = entry["data_offsets"]
        if (not isinstance(start, int) or not isinstance(end, int) or start < 0
                or end > len(body) or end - start != math.prod(shape) * 4):
            raise ValueError(f"weights byte range is invalid: {name}")
        value = np.frombuffer(body[start:end], dtype="<f4").reshape(shape)
        if not np.isfinite(value).all():
            raise ValueError(f"weights must be finite: {name}")
        # Float64 accumulation avoids dependence on float32 BLAS reduction
        # order. The checkpoint storage and portable input/output stay F32.
        result[name] = value.astype(np.float64)
        result[name].setflags(write=False)
        ranges.append((start, end))
    ranges.sort()
    if ranges[0][0] != 0 or ranges[-1][1] != len(body) or any(a[1] != b[0] for a, b in zip(ranges, ranges[1:])):
        raise ValueError("weights ranges must cover the file without overlap")
    return result, hashlib.sha256(raw).hexdigest()


def _scaler(manifest, name, size):
    try:
        scaler = manifest["scalers"][name]
        mean, std = (np.asarray(scaler[key], dtype=np.float32) for key in ("mean", "std"))
    except (KeyError, TypeError, ValueError):
        raise ValueError(f"{name} scaler is invalid") from None
    if mean.shape != (size,) or std.shape != (size,) or not np.isfinite(mean).all() or not np.isfinite(std).all() or np.any(std <= 0):
        raise ValueError(f"{name} scaler shape/values are invalid")
    return mean, std


def _sigmoid(value):
    return 1.0 / (1.0 + np.exp(-np.clip(value, -88, 88)))


def _leaky(value):
    return np.where(value >= 0, value, value * 0.05)


def _body_xy(dx, dy, yaw):
    return (dx * math.cos(yaw) - dy * math.sin(yaw),
            -dx * math.sin(yaw) - dy * math.cos(yaw))


def _encode_route(position, yaw_deg, route, target_index, current_target, horizon, speed):
    """shared_segment_v014: current leg, crossing leg and excluded-leg turn."""
    if not isinstance(route, (list, tuple)) or not route:
        raise ValueError("route must be a non-empty list of x/y/z points")
    points = [_point(point, f"route[{i}]") for i, point in enumerate(route)]
    numeric_index = _finite(target_index, "target_point_index")
    if numeric_index != int(numeric_index):
        raise ValueError("target_point_index must be an integer")
    index = min(max(0, int(numeric_index)), len(points) - 1)
    target = points[index] if current_target is None else _point(current_target, "current_target")
    endpoints = [target, *points[index + 1:]]
    starts = [position, *endpoints[:-1]]
    vectors = [end - start for start, end in zip(starts, endpoints)]
    yaw = math.radians(yaw_deg)
    horizontal = [np.asarray(_body_xy(v[0], v[1], yaw)) for v in vectors]
    lengths = np.asarray([float(np.linalg.norm(v)) for v in vectors])
    path_starts = np.concatenate(([0.0], np.cumsum(lengths[:-1])))
    crop = horizon * max(0.0, speed)
    count = min(48, 1 + sum(float(s) <= crop + 1e-6 for s in path_starts[1:]))
    tokens, mask = np.zeros((48, 13), dtype=np.float32), np.zeros(48, dtype=np.float32)
    for i in range(count):
        relative = endpoints[i] - position
        tokens[i, :3] = (*_body_xy(relative[0], relative[1], yaw), relative[2])
        if lengths[i] > 1e-9:
            unit = vectors[i] / lengths[i]
            tokens[i, 3:6] = (*_body_xy(unit[0], unit[1], yaw), unit[2])
        tokens[i, 6:9] = (lengths[i], path_starts[i], path_starts[i] + lengths[i])
        if i + 1 < len(vectors):
            incoming, outgoing = horizontal[i:i + 2]
            a, b = float(np.linalg.norm(incoming)), float(np.linalg.norm(outgoing))
            if a > 1e-9 and b > 1e-9:
                incoming, outgoing = incoming / a, outgoing / b
                tokens[i, 9:12] = (incoming[0] * outgoing[1] - incoming[1] * outgoing[0],
                                   np.clip(np.dot(incoming, outgoing), -1, 1), 1)
        tokens[i, 12] = float(i == len(endpoints) - 1)
        mask[i] = 1
    return tokens, mask, {"schema": "shared_segment_v014", "segment_count": count,
                         "candidate_segment_count": len(endpoints), "cropped": count < len(endpoints),
                         "lookahead_turn_used": count < len(endpoints), "crop_distance_m": crop}


class UamRouteModel:
    """Reusable, read-only weights; independent recurrent state for each call."""

    def __init__(self, package_dir):
        folder = Path(package_dir)
        self.manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
        validation = self.manifest.get("validation")
        if "validation" in self.manifest:
            if not isinstance(validation, Mapping) or validation.get("contract_sha256") != contract_sha256(self.manifest):
                raise ValueError("validation contract/scalers hash does not match the manifest")
            if (validation.get("implementation_file") != IMPLEMENTATION_FILE
                    or validation.get("implementation_sha256") != IMPLEMENTATION_SHA256):
                raise ValueError("validation implementation hash does not match the loaded runtime")
        self.contract = c = self.manifest["contract"]
        fixed = {"model_type": "route_mlp", "model_class": "RouteMlpTrajectoryRegressor",
                 "task": "future_trajectory_sequence_prediction", "input_size": 21,
                 "output_size": 75, "input_steps": 25, "future_steps": 25,
                 "route_feature_size": 13, "route_max_segments": 48,
                 "route_input_schema": "shared_segment_v014", "label_frame": "body_x_y_z"}
        for key, value in fixed.items():
            if c.get(key) != value:
                raise ValueError(f"unsupported model contract: {key}")
        if tuple(c["feature_columns"]) != STATE_COLUMNS or tuple(c["route_feature_columns"]) != ROUTE_COLUMNS:
            raise ValueError("unsupported feature column order")
        for key in ("input_dt", "output_dt", "input_seconds", "future_seconds"):
            if _finite(c.get(key), key) <= 0:
                raise ValueError(f"{key} must be positive")
        if not math.isclose(c["input_seconds"], 24 * c["input_dt"], abs_tol=1e-8) or not math.isclose(c["future_seconds"], 25 * c["output_dt"], abs_tol=1e-8):
            raise ValueError("inconsistent model timestamps")
        h, r, layers = (c[key] for key in ("hidden_size", "route_hidden_size", "num_layers"))
        if (h, r, layers) != (1024, 128, 2):
            raise ValueError("unsupported recurrent model shape")
        shapes = {"route_feature_mean": (13,), "route_feature_std": (13,), "future_queries": (25, r)}
        for layer in range(layers):
            prefix = "state_encoder."
            shapes.update({prefix + f"weight_ih_l{layer}": (4*h, 21 if layer == 0 else h),
                           prefix + f"weight_hh_l{layer}": (4*h, h),
                           prefix + f"bias_ih_l{layer}": (4*h,), prefix + f"bias_hh_l{layer}": (4*h,)})
        shapes.update({"route_encoder.weight_ih_l0": (3*r, r), "route_encoder.weight_hh_l0": (3*r, r),
                       "route_encoder.bias_ih_l0": (3*r,), "route_encoder.bias_hh_l0": (3*r,)})
        for name, rows, cols in (("segment_mlp.0", r, 13), ("segment_mlp.2", r, r),
                                 ("state_query", r, h), ("output_head.0", h, h+2*r), ("output_head.3", 3, h)):
            shapes[name + ".weight"], shapes[name + ".bias"] = (rows, cols), (rows,)
        self.weights, self.weights_sha256 = _load_weights(folder / "model.safetensors", shapes)
        if validation is not None and validation.get("weights_sha256") != self.weights_sha256:
            raise ValueError("validation weights hash does not match the loaded checkpoint")
        self.feature_mean, self.feature_std = _scaler(self.manifest, "feature", 21)
        self.label_mean, self.label_std = _scaler(self.manifest, "label", 3)
        route_mean, route_std = _scaler(self.manifest, "route", 13)
        if not np.array_equal(self.weights["route_feature_mean"], route_mean) or not np.array_equal(self.weights["route_feature_std"], np.maximum(route_std, 1e-6)):
            raise ValueError("route scaler differs from the checkpoint buffers")

    def _linear(self, values, name):
        return values @ self.weights[name + ".weight"].T + self.weights[name + ".bias"]

    def _forward(self, state, tokens, mask):
        if state.shape != (25, 21) or tokens.shape != (48, 13) or mask.shape != (48,):
            raise ValueError("invalid state/route/mask shape")
        if not all(np.isfinite(v).all() for v in (state, tokens, mask)):
            raise ValueError("state/route/mask must be finite")
        n = int(mask.sum())
        if n < 1 or not np.array_equal(mask, np.asarray([1]*n + [0]*(48-n))):
            raise ValueError("route mask must contain a non-empty valid prefix")
        w = self.weights
        sequence = state
        for layer in range(2):
            suffix = f"_l{layer}"
            gates = sequence @ w["state_encoder.weight_ih" + suffix].T + w["state_encoder.bias_ih" + suffix]
            hidden, cell = np.zeros(1024, dtype=np.float64), np.zeros(1024, dtype=np.float64)
            output = np.empty((25, 1024), dtype=np.float64)
            for step in range(25):
                gate = gates[step] + (hidden @ w["state_encoder.weight_hh" + suffix].T + w["state_encoder.bias_hh" + suffix])
                i, f, g, o = np.split(gate, 4)
                cell = _sigmoid(f) * cell + _sigmoid(i) * np.tanh(g)
                hidden = _sigmoid(o) * np.tanh(cell)
                output[step] = hidden
            sequence = output
        state_context = sequence[-1]
        query = self._linear(state_context, "state_query") + w["future_queries"]
        segments = (tokens[:n] - w["route_feature_mean"]) / w["route_feature_std"]
        embeddings = _leaky(self._linear(_leaky(self._linear(segments, "segment_mlp.0")), "segment_mlp.2"))
        incoming = embeddings @ w["route_encoder.weight_ih_l0"].T + w["route_encoder.bias_ih_l0"]
        hidden = np.zeros(128, dtype=np.float64)
        memory = np.empty((n, 128), dtype=np.float64)
        for step in range(n):
            gi = incoming[step]
            gh = hidden @ w["route_encoder.weight_hh_l0"].T + w["route_encoder.bias_hh_l0"]
            reset, update = _sigmoid(gi[:128] + gh[:128]), _sigmoid(gi[128:256] + gh[128:256])
            candidate = np.tanh(gi[256:] + reset * gh[256:])
            hidden = (1 - update) * candidate + update * hidden
            memory[step] = hidden
        scores = (query @ memory.T) * (128 ** -0.5)
        attention = np.exp(scores - scores.max(axis=1, keepdims=True))
        attention /= attention.sum(axis=1, keepdims=True)
        attention /= attention.sum(axis=1, keepdims=True)
        context = attention @ memory
        head = np.concatenate((np.broadcast_to(state_context, (25, 1024)), query, context), axis=1)
        return self._linear(_leaky(self._linear(head, "output_head.0")), "output_head.3")

    def predict(self, state_history, route, target_point_index=0, current_target=None):
        if not isinstance(state_history, (list, tuple)) or len(state_history) != 25:
            raise ValueError("state_history must contain exactly 25 rows")
        rows = []
        for index, row in enumerate(state_history):
            if not isinstance(row, Mapping):
                raise ValueError(f"state_history[{index}] must be an object")
            for key in STATE_COLUMNS:
                if key not in row:
                    raise ValueError(f"state_history[{index}] is missing {key}")
            rows.append([_finite(row[key], f"state_history[{index}].{key}") for key in STATE_COLUMNS])
        timestamps = np.asarray([row[0] for row in rows], dtype=np.float64)
        raw = np.asarray(rows, dtype=np.float32)
        if not np.isfinite(raw).all():
            raise ValueError("state_history must remain finite in float32")
        c = self.contract
        if not np.allclose(np.diff(timestamps), c["input_dt"], rtol=0, atol=1e-4):
            raise ValueError(f"state_history timestamps must be spaced by input_dt={c['input_dt']}")
        current = raw[-1]
        position = current[1:4].astype(np.float64)
        yaw, pitch = float(current[6]), float(current[5])
        tokens, mask, route_context = _encode_route(position, yaw, route, target_point_index, current_target, c["future_seconds"], float(current[16]))
        normalized = self._forward((raw - self.feature_mean) / self.feature_std, tokens, mask)
        body = (normalized * self.label_std + self.label_mean).astype(np.float32)
        y, p = math.radians(yaw), math.radians(pitch)
        forward = np.asarray([math.cos(p)*math.cos(y), -math.cos(p)*math.sin(y), math.sin(p)], dtype=np.float32)
        right = np.asarray([-math.sin(y), -math.cos(y), 0], dtype=np.float32)
        up = np.asarray([-math.sin(p)*math.cos(y), math.sin(p)*math.sin(y), math.cos(p)], dtype=np.float32)
        enu = (body[:, 0:1]*forward + body[:, 1:2]*right + body[:, 2:3]*up).astype(np.float32)
        absolute = enu + current[1:4]
        if not all(np.isfinite(v).all() for v in (body, enu, absolute)):
            raise ValueError("model output must be finite")
        metadata = {key: c[key] for key in ("task", "controller_id", "model_type", "input_steps", "input_size", "input_dt", "input_seconds", "future_steps", "output_dt", "future_seconds")}
        metadata["file"] = self.manifest["source"]["file"]
        return {"model": metadata, "route_context": route_context,
                "times_s": [float(timestamps[-1]) + (i+1)*c["output_dt"] for i in range(25)],
                "prediction_body_m": body.tolist(), "prediction_enu_m": enu.tolist(),
                "prediction_absolute_enu_m": absolute.tolist()}
