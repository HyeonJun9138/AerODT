"""Score a delivered trajectory-prediction model against flights we already have.

A learned model arrives with weights and a note. Neither says whether it is any
good on our motion, and the only honest way to find out is to run it over
flights whose future is already recorded and measure the distance between what
it said and what happened. Our own UAM flight runs are 5 Hz, which is the rate
the GRU model was trained at, so a run is a stream of ready-made questions with
their answers attached.

    python project_support/tools/evaluate_prediction_model.py
    python project_support/tools/evaluate_prediction_model.py --run <run_id> --windows 200
    python project_support/tools/evaluate_prediction_model.py --search-scale

`--search-scale` is for a model whose normalization did not arrive: it reports
which scale and head activation would fit our flights best. That is a
measurement to send back to whoever trained it, not a substitute for the real
value - the network is being fed inputs normalised by a guess, so a good score
would be luck and a bad one proves nothing.
"""
import argparse
import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import numpy as np   # noqa: E402

from digital_twin.live_twin import gru_prediction as gru   # noqa: E402
from digital_twin.model_library import prediction_catalog as catalog   # noqa: E402

METRES_PER_DEGREE = 111320.0
RUNS = ROOT / "data/workspace/simulation/runs"


def flight_enu(states):
    """A run's states as local ENU metres about its first point, and their times."""
    first = states[0]
    cos_lat = math.cos(math.radians(first["latitude"]))
    positions = np.array([[(row["longitude"] - first["longitude"]) * METRES_PER_DEGREE * cos_lat,
                           (row["latitude"] - first["latitude"]) * METRES_PER_DEGREE,
                           row["altitude_m"]] for row in states])
    return positions, np.array([row["t"] for row in states]), np.array([row.get("speed_mps", 0.0) for row in states])


def load_run(run_id=None):
    runs = sorted(RUNS.glob("*/states.jsonl"), key=lambda path: path.stat().st_mtime)
    if run_id:
        runs = [path for path in runs if path.parent.name == run_id]
    if not runs:
        raise SystemExit(f"no flight run found in {RUNS}")
    path = runs[-1]
    states = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    return path.parent.name, states


def windows(positions, times, speed, count, moving_mps=5.0):
    """Slices of history-plus-future where the aircraft is actually flying."""
    span = gru.INPUT_POINTS + gru.OUTPUT_POINTS
    starts = [index for index in range(0, len(positions) - span, 5)
              if speed[index:index + span].mean() > moving_mps]
    if not starts:
        raise SystemExit("this run never moves faster than the threshold")
    stride = max(1, len(starts) // count)
    return starts[::stride][:count]


def score(model, positions, times, starts):
    """Average and final displacement error over the 15 s, in metres."""
    history = np.stack([positions[index:index + gru.INPUT_POINTS] for index in starts])
    future = np.stack([positions[index + gru.INPUT_POINTS:index + gru.INPUT_POINTS + gru.OUTPUT_POINTS]
                       for index in starts])
    anchor = history[:, -1][:, None, :]
    relative_times = np.stack([times[index:index + gru.INPUT_POINTS] - times[index + gru.INPUT_POINTS - 1]
                               for index in starts])
    predicted = model.predict_relative(history - anchor, relative_times)
    error = np.linalg.norm(predicted - (future - anchor), axis=2)
    return {"ade_m": float(error.mean()), "fde_m": float(error[:, -1].mean()),
            "worst_m": float(error.max()), "windows": len(starts)}


def constant_velocity(positions, times, starts):
    """The same windows carried forward at the velocity of the last second."""
    history = np.stack([positions[index:index + gru.INPUT_POINTS] for index in starts])
    future = np.stack([positions[index + gru.INPUT_POINTS:index + gru.INPUT_POINTS + gru.OUTPUT_POINTS]
                       for index in starts])
    anchor = history[:, -1][:, None, :]
    velocity = (history[:, -1] - history[:, -6]) / (5 * gru.STEP_SECONDS)
    horizon = np.arange(1, gru.OUTPUT_POINTS + 1) * gru.STEP_SECONDS
    predicted = velocity[:, None, :] * horizon[None, :, None]
    error = np.linalg.norm(predicted - (future - anchor), axis=2)
    return {"ade_m": float(error.mean()), "fde_m": float(error[:, -1].mean()),
            "worst_m": float(error.max()), "windows": len(starts)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", default="gru_direct_v1_1")
    parser.add_argument("--run", default=None, help="a flight run id; the newest by default")
    parser.add_argument("--windows", type=int, default=120)
    parser.add_argument("--search-scale", action="store_true",
                        help="report the scale and activation that would fit this flight, for a model whose normalization is missing")
    args = parser.parse_args(argv)

    described = catalog.find_model(args.model)
    if described is None:
        raise SystemExit(f"unknown model {args.model}")
    run_id, states = load_run(args.run)
    positions, times, speed = flight_enu(states)
    starts = windows(positions, times, speed, args.windows)
    print(f"model {described['model_id']} ({described['label']})")
    print(f"flight {run_id}: {len(states)} states over {times[-1]:.0f} s, "
          f"{speed.max():.0f} m/s top speed, {positions[:, 2].max():.0f} m ceiling")
    print(f"{len(starts)} windows of {gru.INPUT_POINTS} points history and {gru.OUTPUT_POINTS} points future")
    straight = constant_velocity(positions, times, starts)
    print(f"\nconstant velocity   ADE {straight['ade_m']:7.1f} m   FDE {straight['fde_m']:7.1f} m   worst {straight['worst_m']:7.1f} m")

    if described["ready"]:
        model = gru.GruTrajectoryModel.from_model(described)
        result = score(model, positions, times, starts)
        print(f"{described['model_id']:<18}  ADE {result['ade_m']:7.1f} m   FDE {result['fde_m']:7.1f} m   worst {result['worst_m']:7.1f} m")
        print(f"\nnormalization in use: {described['normalization']}")
        return 0

    print(f"\n{described['model_id']} cannot be run: {described['reason']}")
    if not args.search_scale:
        print("pass --search-scale to measure what its missing normalization would have to be")
        return 1

    weights = gru.load_weights(described["weights"])
    print("\nsearching for the scale and head activation that fit this flight")
    print(f"{'scale_m':>9}" + "".join(f"{name:>9}" for name in catalog.ACTIVATIONS))
    table = {}
    for scale in (100, 150, 200, 250, 300, 350, 400, 500, 650, 800, 1000):
        row = []
        for name in catalog.ACTIVATIONS:
            model = gru.GruTrajectoryModel(weights, {"scale_m": float(scale), "time_scale_s": 3.0,
                                                     "head_activation": name})
            value = score(model, positions, times, starts)["ade_m"]
            table[(scale, name)] = value
            row.append(value)
        print(f"{scale:9d}" + "".join(f"{value:9.1f}" for value in row))
    best_scale, best_activation = min(table, key=table.get)
    print(f"\nbest fit here: {best_activation} at scale_m {best_scale} -> ADE {table[(best_scale, best_activation)]:.1f} m")
    print(f"constant velocity on the same windows: ADE {straight['ade_m']:.1f} m")
    print("This is a fit to our flights, not the training run's value. Ask for normalization.json.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
