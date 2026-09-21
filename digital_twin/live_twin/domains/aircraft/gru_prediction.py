"""Running a delivered GRU trajectory model inside the twin's Data Alignment step.

The model takes the last 3 seconds of one object's position at 5 Hz and answers
the next 15 seconds in one shot. It is evaluated here in numpy rather than
through PyTorch: the network is two GRU layers of 128 and a two-layer head, a
megabyte of weights, and the dashboard should not carry a deep-learning runtime
to multiply it. The forward pass is the one PyTorch defines, checked against it.

Two things the delivery did not carry are needed before any output means metres:
the scale the training run normalised positions by, and which activation sits in
the head. Both come from the model library's normalization file. Without them
this module refuses to predict rather than returning numbers in unknown units.

Nothing here decides *when* to predict or what to draw. It is given a history
and answers a path, in the same local ENU metres it was given.
"""
import json
import math
import struct

# The contract the delivered model was trained to; it is fixed, not a setting.
INPUT_POINTS = 16
OUTPUT_POINTS = 75
STEP_SECONDS = 0.2
INPUT_FEATURES = 4
HIDDEN = 128
# How far apart two observations may be and still count as one 5 Hz stream.
STEP_TOLERANCE_S = 1e-3
HORIZON_S = tuple(round(STEP_SECONDS * (index + 1), 6) for index in range(OUTPUT_POINTS))


def load_weights(path):
    """The tensors of a safetensors file, as a name -> numpy array mapping.

    The format is a little-endian length, a JSON header of dtypes, shapes and
    byte ranges, then the raw tensor bytes; reading it takes no dependency.
    """
    import numpy as np

    raw = open(path, "rb").read()
    if len(raw) < 8:
        raise ValueError("weights: file too small")
    length = struct.unpack("<Q", raw[:8])[0]
    if length <= 0 or 8 + length > len(raw):
        raise ValueError("weights: header does not fit the file")
    header = json.loads(raw[8:8 + length])
    header.pop("__metadata__", None)
    kinds = {"F32": np.float32, "F64": np.float64, "F16": np.float16}
    body = memoryview(raw)[8 + length:]
    tensors = {}
    for name, entry in header.items():
        dtype = kinds.get(entry.get("dtype"))
        if dtype is None:
            raise ValueError(f"weights: unsupported dtype for {name}")
        start, end = entry["data_offsets"]
        tensors[name] = np.frombuffer(body[start:end], dtype=dtype).reshape(entry["shape"]).astype(np.float64)
    return tensors


def _sigmoid(x):
    import numpy as np

    return 1.0 / (1.0 + np.exp(-x))


def activation(name):
    """The head activation by name, as PyTorch defines it."""
    import numpy as np
    from math import erf

    if name == "relu":
        return lambda v: np.maximum(v, 0.0)
    if name == "gelu":   # torch's default GELU is the exact erf form
        erf_all = np.vectorize(erf)
        return lambda v: 0.5 * v * (1.0 + erf_all(v / math.sqrt(2.0)))
    if name == "silu":
        return lambda v: v * _sigmoid(v)
    if name == "tanh":
        return np.tanh
    raise ValueError(f"head_activation: relu, gelu, silu or tanh expected, not {name!r}")


def gru_layer(sequence, weight_ih, weight_hh, bias_ih, bias_hh, hidden=HIDDEN):
    """One PyTorch GRU layer over [batch, steps, features] -> [batch, steps, hidden]."""
    import numpy as np

    batch, steps, _ = sequence.shape
    state = np.zeros((batch, hidden))
    gates_in = sequence @ weight_ih.T + bias_ih
    output = np.empty((batch, steps, hidden))
    for step in range(steps):
        gi = gates_in[:, step]
        gh = state @ weight_hh.T + bias_hh
        reset = _sigmoid(gi[:, :hidden] + gh[:, :hidden])
        update = _sigmoid(gi[:, hidden:2 * hidden] + gh[:, hidden:2 * hidden])
        candidate = np.tanh(gi[:, 2 * hidden:] + reset * gh[:, 2 * hidden:])
        state = (1 - update) * candidate + update * state
        output[:, step] = state
    return output


class GruTrajectoryModel:
    """The delivered network, ready to be handed relative metres and seconds."""

    def __init__(self, weights, normalization):
        self.weights = weights
        self.scale_m = float(normalization["scale_m"])
        self.time_scale_s = float(normalization["time_scale_s"])
        self.activation_name = normalization["head_activation"]
        self._activation = activation(self.activation_name)
        for name in ("gru.weight_ih_l0", "gru.weight_hh_l0", "gru.bias_ih_l0", "gru.bias_hh_l0",
                     "gru.weight_ih_l1", "gru.weight_hh_l1", "gru.bias_ih_l1", "gru.bias_hh_l1",
                     "head.0.weight", "head.0.bias", "head.3.weight", "head.3.bias"):
            if name not in weights:
                raise ValueError(f"weights: {name} missing")
        if weights["head.3.weight"].shape[0] != OUTPUT_POINTS * 3:
            raise ValueError("weights: the head does not answer 75 points of three axes")

    @classmethod
    def from_model(cls, model):
        """From a prediction_catalog entry; raises when it is not ready."""
        if not model.get("ready"):
            raise ValueError(model.get("reason") or "model not ready")
        return cls(load_weights(model["weights"]), model["normalization"])

    def predict_relative(self, relative_positions_m, relative_times_s):
        """[B,16,3] metres from the last observation and [B,16] seconds before it
        -> [B,75,3] metres from that same last observation."""
        import numpy as np

        positions = np.asarray(relative_positions_m, dtype=np.float64)
        times = np.asarray(relative_times_s, dtype=np.float64)
        if positions.ndim != 3 or positions.shape[1:] != (INPUT_POINTS, 3):
            raise ValueError(f"positions: [B,{INPUT_POINTS},3] expected, got {positions.shape}")
        if times.shape != positions.shape[:2]:
            raise ValueError(f"times: [B,{INPUT_POINTS}] expected, got {times.shape}")
        if not (np.isfinite(positions).all() and np.isfinite(times).all()):
            raise ValueError("positions/times: every value must be finite")
        features = np.concatenate([positions / self.scale_m,
                                   (times / self.time_scale_s)[:, :, None]], axis=2)
        first = gru_layer(features, self.weights["gru.weight_ih_l0"], self.weights["gru.weight_hh_l0"],
                          self.weights["gru.bias_ih_l0"], self.weights["gru.bias_hh_l0"])
        second = gru_layer(first, self.weights["gru.weight_ih_l1"], self.weights["gru.weight_hh_l1"],
                           self.weights["gru.bias_ih_l1"], self.weights["gru.bias_hh_l1"])
        hidden = self._activation(second[:, -1] @ self.weights["head.0.weight"].T + self.weights["head.0.bias"])
        flat = hidden @ self.weights["head.3.weight"].T + self.weights["head.3.bias"]
        return flat.reshape(-1, OUTPUT_POINTS, 3) * self.scale_m


def validate_history(positions_m, times_s):
    """The 16 observations as the model needs them, or ValueError('field: reason').

    Oldest first, exactly 0.2 s apart, all finite. A stream that does not meet
    this is not resampled here: interpolating an aircraft's position to invent
    a 5 Hz history would feed the model something no sensor reported.
    """
    import numpy as np

    positions = np.asarray(positions_m, dtype=np.float64)
    times = np.asarray(times_s, dtype=np.float64)
    if positions.shape != (INPUT_POINTS, 3):
        raise ValueError(f"positions: {INPUT_POINTS} points of three axes expected, got {positions.shape}")
    if times.shape != (INPUT_POINTS,):
        raise ValueError(f"times: {INPUT_POINTS} values expected, got {times.shape}")
    if not (np.isfinite(positions).all() and np.isfinite(times).all()):
        raise ValueError("positions: every value must be finite")
    steps = np.diff(times)
    if np.any(np.abs(steps - STEP_SECONDS) > STEP_TOLERANCE_S):
        worst = float(np.max(np.abs(steps - STEP_SECONDS)))
        raise ValueError(f"times: 5 Hz expected; the spacing is off by up to {worst:.3f} s")
    return positions, times


class TrackHistory:
    """The last 16 observations of each object, ready when a full 3 s has arrived.

    A gap, a jump in time or a bad value clears the object's history rather than
    bridging it: the model was given real observations in training and is not
    told which of ours were invented.
    """

    def __init__(self, points=INPUT_POINTS, step_seconds=STEP_SECONDS, tolerance=STEP_TOLERANCE_S):
        self.points = points
        self.step_seconds = step_seconds
        self.tolerance = tolerance
        self._tracks = {}

    def forget(self, object_id):
        self._tracks.pop(object_id, None)

    def keep(self, object_ids):
        """Drop every object not in `object_ids`."""
        keep = set(object_ids)
        self._tracks = {key: value for key, value in self._tracks.items() if key in keep}

    def observe(self, object_id, position_enu_m, time_s):
        """Add one observation; answer the full history when there is one, else None."""
        point = tuple(float(value) for value in position_enu_m)
        moment = float(time_s)
        if len(point) != 3 or not all(math.isfinite(value) for value in point) or not math.isfinite(moment):
            self.forget(object_id)
            return None
        track = self._tracks.setdefault(object_id, [])
        if track and abs(moment - track[-1][0] - self.step_seconds) > self.tolerance:
            track.clear()
        track.append((moment, point))
        del track[:-self.points]
        if len(track) < self.points:
            return None
        return ([value[1] for value in track], [value[0] for value in track])


def predict_path(model, positions_m, times_s):
    """One object's next 15 seconds from its last 16 observations.

    `positions_m` are local ENU metres and `times_s` their observation times.
    Returns absolute ENU positions, the times they belong to, and the relative
    displacements the model actually produced.
    """
    import numpy as np

    positions, times = validate_history(positions_m, times_s)
    anchor, anchor_time = positions[-1], times[-1]
    relative = model.predict_relative((positions - anchor)[None], (times - anchor_time)[None])[0]
    return {
        "anchor_time_s": float(anchor_time),
        "times_s": [float(anchor_time + step) for step in HORIZON_S],
        "position_enu_m": (anchor + relative).tolist(),
        "relative_position_m": relative.tolist(),
        "horizon_s": list(HORIZON_S),
    }
